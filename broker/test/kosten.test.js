"use strict";

/* Kostenabfrage – ohne Azure. `fetch` beantwortet Anmeldung und
   Cost-Management-API.

   Der Kern dieser Tests: Es darf **eine** Kostenabfrage sein, nicht zwei.
   Cost Management drosselt so hart, dass zwei Abfragen kurz hintereinander
   zuverlässig ins 429 laufen (am 04.09.2026 mit acht Sekunden Abstand
   nachgemessen).                                                            */

const test = require("node:test");
const assert = require("node:assert");

process.env.KOSTEN_WARTEMS = "1";   // keine echten Wartezeiten im Test
const KOSTEN = require("../src/lib/kosten");

const PBI = { tenantId: "t", clientId: "c", clientSecret: "s" };

const monat = v => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + v, 1))
    .toISOString().slice(0, 10) + "T00:00:00";
};

/** Antwort mit Monatsspalte, so wie sie bei granularity "Monthly" kommt.
 *  @param {Array<[string,string,number]>} zeilen  [Monat, Gruppe, Betrag] */
const antwort = zeilen => ({
  properties: {
    columns: [{ name: "Cost", type: "Number" }, { name: "BillingMonth", type: "Datetime" },
              { name: "ResourceGroupName", type: "String" }, { name: "Currency", type: "String" }],
    rows: zeilen.map(([m, g, b]) => [b, m, g, "EUR"])
  }
});

const daten = antwort([
  [monat(0),  "rg-dihag-dp-dev-westeurope", 49.78],
  [monat(0),  "rg-berichte-broker", 0.12],
  [monat(0),  "azurevm-rg", 56.66],
  [monat(-1), "rg-dihag-dp-dev-westeurope", 310.5],
  [monat(-1), "rg-berichte-broker", 0.4],
  [monat(-1), "azurevm-rg", 120]
]);

let rufe = [];          // alle URLs
let abfragen = [];      // nur die Kostenabfragen, mit ihrem Rumpf

function stelleFetch({ status = 200, daten: d = daten, drosselMal = 0 } = {}) {
  let gedrosselt = 0;
  global.fetch = async (url, opts) => {
    rufe.push(String(url));
    if (String(url).includes("/oauth2/")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
    }
    abfragen.push(JSON.parse(opts.body));
    if (gedrosselt < drosselMal) {
      gedrosselt++;
      return { ok: false, status: 429, text: async () => "Too many requests" };
    }
    if (status !== 200) return { ok: false, status, text: async () => "abgelehnt" };
    return { ok: true, status: 200, json: async () => d };
  };
}

test.beforeEach(() => {
  rufe = []; abfragen = [];
  process.env.KOSTEN_ABO = "abo-1";
  process.env.KOSTEN_GRUPPEN = "rg-dihag-dp-dev-westeurope,rg-berichte-broker";
  process.env.KOSTEN_KAPAZITAET_RG = "rg-dihag-dp-dev-westeurope";
});

test("ohne Abonnement meldet die Abfrage das offen", async () => {
  delete process.env.KOSTEN_ABO;
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(k.verfuegbar, false);
  assert.strictEqual(k.grund, "nicht_eingerichtet");
});

test("nur die eigenen Ressourcengruppen zählen mit", async () => {
  stelleFetch();
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(k.verfuegbar, true);
  // 49,78 + 0,12 – die fremde azurevm-rg gehört nicht dazu
  assert.strictEqual(Math.round(k.laufenderMonat.summe * 100) / 100, 49.90);
  assert.strictEqual(k.laufenderMonat.kapazitaet, 49.78);
  assert.strictEqual(Math.round(k.laufenderMonat.uebrige * 100) / 100, 0.12);
  assert.strictEqual(k.laufenderMonat.waehrung, "EUR");
  assert.deepStrictEqual(k.laufenderMonat.jeGruppe.map(g => g.gruppe),
    ["rg-dihag-dp-dev-westeurope", "rg-berichte-broker"], "absteigend nach Betrag");
});

test("beide Monate kommen aus einer einzigen Abfrage", async () => {
  stelleFetch();
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(Math.round(k.vormonat.summe * 100) / 100, 310.90);
  assert.strictEqual(Math.round(k.laufenderMonat.summe * 100) / 100, 49.90);
  assert.strictEqual(abfragen.length, 1, "eine zweite Abfrage läuft in die Drosselung");
  assert.strictEqual(abfragen[0].dataset.granularity, "Monthly");
  assert.ok(abfragen[0].timePeriod?.from, "Custom-Zeitraum mit Beginn im Vormonat");
});

test("fehlt die Monatsspalte, landet alles im laufenden Monat", async () => {
  // Ältere Antwortform ohne Datumsspalte: lieber ein leerer Vormonat als
  // Beträge, die im falschen Monat stehen.
  stelleFetch({ daten: {
    properties: {
      columns: [{ name: "Cost", type: "Number" }, { name: "ResourceGroupName", type: "String" },
                { name: "Currency", type: "String" }],
      rows: [[49.78, "rg-dihag-dp-dev-westeurope", "EUR"]]
    }
  } });
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(k.laufenderMonat.summe, 49.78);
  assert.strictEqual(k.vormonat.summe, 0);
});

test("Drosselung wird abgewartet, nicht als Fehler gemeldet", async () => {
  stelleFetch({ drosselMal: 2 });
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(k.verfuegbar, true, "nach der Wiederholung muss es klappen");
});

test("fehlende Leseberechtigung wird als solche benannt", async () => {
  stelleFetch({ status: 403 });
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(k.verfuegbar, false);
  assert.strictEqual(k.grund, "kein_zugriff");
  assert.match(k.detail, /Cost Management Reader/);
});

test("bei Dauerdrosselung kommt der letzte Stand statt eines Fehlers", async () => {
  stelleFetch();
  await KOSTEN.kosten(PBI, true);            // füllt den Zwischenspeicher
  stelleFetch({ drosselMal: 99 });
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(k.verfuegbar, true, "Zahlen von vorhin sind besser als keine");
  assert.strictEqual(k.veraltet, true, "aber sie müssen als alt erkennbar sein");
  assert.ok(k.stand, "mit Zeitpunkt");
  assert.match(k.hinweis, /drosselt/);
});

test("der Zwischenspeicher spart Aufrufe", async () => {
  stelleFetch();
  await KOSTEN.kosten(PBI, true);
  const nachErstem = rufe.length;
  await KOSTEN.kosten(PBI);          // ohne frisch
  assert.strictEqual(rufe.length, nachErstem, "der zweite Aufruf darf nichts holen");
});
