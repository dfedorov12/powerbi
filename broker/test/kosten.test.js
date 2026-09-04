"use strict";

/* Kostenabfrage – ohne Azure. `fetch` beantwortet Anmeldung und
   Cost-Management-API.                                                      */

const test = require("node:test");
const assert = require("node:assert");

process.env.KOSTEN_WARTEMS = "1";   // keine echten Wartezeiten im Test
const KOSTEN = require("../src/lib/kosten");

const PBI = { tenantId: "t", clientId: "c", clientSecret: "s" };

const antwort = (gruppen) => ({
  properties: {
    columns: [{ name: "Cost" }, { name: "ResourceGroupName" }, { name: "Currency" }],
    rows: gruppen.map(g => [g[1], g[0], "EUR"])
  }
});

let rufe = [];
function stelleFetch({ status = 200, daten = null, drosselMal = 0 } = {}) {
  let gedrosselt = 0;
  global.fetch = async (url, opts) => {
    rufe.push(String(url));
    if (String(url).includes("/oauth2/")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
    }
    if (gedrosselt < drosselMal) {
      gedrosselt++;
      return { ok: false, status: 429, text: async () => "Too many requests" };
    }
    if (status !== 200) return { ok: false, status, text: async () => "abgelehnt" };
    const istVormonat = JSON.parse(opts.body).timeframe === "TheLastMonth";
    return { ok: true, status: 200, json: async () => (istVormonat ? daten.vormonat : daten.jetzt) };
  };
}

const daten = {
  jetzt:   antwort([["rg-dihag-dp-dev-westeurope", 49.78], ["rg-berichte-broker", 0.12],
                    ["azurevm-rg", 56.66]]),
  vormonat: antwort([["rg-dihag-dp-dev-westeurope", 310.5], ["rg-berichte-broker", 0.4],
                     ["azurevm-rg", 120]])
};

test.beforeEach(() => {
  rufe = [];
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
  stelleFetch({ daten });
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

test("der Vormonat wird getrennt abgefragt", async () => {
  stelleFetch({ daten });
  const k = await KOSTEN.kosten(PBI, true);
  assert.strictEqual(Math.round(k.vormonat.summe * 100) / 100, 310.90);
});

test("Drosselung wird abgewartet, nicht als Fehler gemeldet", async () => {
  stelleFetch({ daten, drosselMal: 2 });
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

test("der Zwischenspeicher spart Aufrufe", async () => {
  stelleFetch({ daten });
  await KOSTEN.kosten(PBI, true);
  const nachErstem = rufe.length;
  await KOSTEN.kosten(PBI);          // ohne frisch
  assert.strictEqual(rufe.length, nachErstem, "der zweite Aufruf darf nichts holen");
});
