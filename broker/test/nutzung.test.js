"use strict";

/* Nutzungszählung und CU-Abfrage – ohne Azure, ohne Fabric.

   `@azure/data-tables` wird durch eine Attrappe ersetzt, die sich wie eine
   sehr kleine Tabelle verhält; `fetch` beantwortet die Metrik-Abfrage.       */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

/* ── Tabellen-Attrappe ───────────────────────────────────────────────── */

const tabellen = new Map();   // Name -> Array von Entitäten
let schreibfehler = false;    // erzwingt einen Speicherausfall

function fakeClient(name) {
  // Der Client wird im Modul zwischengespeichert, die Tabelle aber zwischen
  // den Tests geleert - deshalb bei jedem Zugriff sicherstellen, dass es sie gibt.
  const zeilen = () => {
    if (!Array.isArray(tabellen.get(name))) tabellen.set(name, []);
    return tabellen.get(name);
  };
  return {
    createTable: async () => {},
    createEntity: async e => {
      if (schreibfehler) throw new Error("Speicher nicht erreichbar");
      zeilen().push({ ...e });
    },
    listEntities: ({ queryOptions } = {}) => {
      const f = queryOptions?.filter || "";
      let raus = zeilen();
      let m = f.match(/PartitionKey ge '([^']+)'/);
      if (m) raus = raus.filter(e => e.partitionKey >= m[1]);
      m = f.match(/PartitionKey lt '([^']+)'/);
      if (m) raus = raus.filter(e => e.partitionKey < m[1]);
      return (async function* () { for (const e of raus) yield e; })();
    },
    submitTransaction: async aktionen => {
      for (const [op, e] of aktionen) {
        if (op === "delete") {
          const l = zeilen();
          const i = l.findIndex(x => x.partitionKey === e.partitionKey && x.rowKey === e.rowKey);
          if (i >= 0) l.splice(i, 1);
        }
      }
    }
  };
}

const echtesLaden = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === "@azure/data-tables") {
    return { TableClient: { fromConnectionString: (_cs, name) => fakeClient(name) } };
  }
  return echtesLaden.call(this, anfrage, ...rest);
};
process.env.AzureWebJobsStorage = "UseDevelopmentStorage=true";
const NUTZUNG = require("../src/lib/nutzung");
const METRIKEN = require("../src/lib/metriken");
Module._load = echtesLaden;

const tag = v => new Date(Date.now() + v * 86400000).toISOString().slice(0, 10);

test.beforeEach(() => {
  tabellen.clear();
  schreibfehler = false;
  delete process.env.NUTZUNG_ANONYM;
  process.env.NUTZUNG_TAGE = "90";
});

/* ── Zählung ─────────────────────────────────────────────────────────── */

test("Öffnungen und Erneuerungen werden getrennt gezählt", async () => {
  await NUTZUNG.zaehlen("bericht1", "a@dihag.com", "oeffnen");
  await NUTZUNG.zaehlen("bericht1", "a@dihag.com", "erneuern");
  await NUTZUNG.zaehlen("bericht1", "b@dihag.com", "oeffnen");
  const a = await NUTZUNG.auswertung(30);
  assert.strictEqual(a.gesamt.oeffnen, 2);
  assert.strictEqual(a.gesamt.erneuern, 1);
  assert.strictEqual(a.gesamt.personen, 2);
  assert.strictEqual(a.jeBericht[0].schluessel, "bericht1");
});

test("unbekannte Art zählt als Öffnung, nicht als Erneuerung", async () => {
  await NUTZUNG.zaehlen("bericht1", "a@dihag.com", "quatsch");
  const a = await NUTZUNG.auswertung(30);
  assert.strictEqual(a.gesamt.oeffnen, 1);
  assert.strictEqual(a.gesamt.erneuern, 0);
});

test("dieselbe Person an mehreren Tagen ist eine Person", async () => {
  tabellen.set("Nutzung", [
    { partitionKey: tag(-1), rowKey: "1", bericht: "b1", person: "a@dihag.com", art: "oeffnen" },
    { partitionKey: tag(0),  rowKey: "2", bericht: "b1", person: "a@dihag.com", art: "oeffnen" }
  ]);
  const a = await NUTZUNG.auswertung(30);
  assert.strictEqual(a.gesamt.oeffnen, 2);
  assert.strictEqual(a.gesamt.personen, 1);
});

test("ältere Einträge als der Zeitraum zählen nicht mit", async () => {
  tabellen.set("Nutzung", [
    { partitionKey: tag(-40), rowKey: "1", bericht: "b1", person: "a@dihag.com", art: "oeffnen" },
    { partitionKey: tag(0),   rowKey: "2", bericht: "b1", person: "a@dihag.com", art: "oeffnen" }
  ]);
  const a = await NUTZUNG.auswertung(7);
  assert.strictEqual(a.gesamt.oeffnen, 1);
});

test("Einträge jenseits der Aufbewahrung werden gelöscht", async () => {
  process.env.NUTZUNG_TAGE = "30";
  tabellen.set("Nutzung", [
    { partitionKey: tag(-60), rowKey: "alt", bericht: "b1", person: "a@dihag.com", art: "oeffnen" },
    { partitionKey: tag(0),   rowKey: "neu", bericht: "b1", person: "a@dihag.com", art: "oeffnen" }
  ]);
  await NUTZUNG.auswertung(30);
  const rest = tabellen.get("Nutzung").map(e => e.rowKey);
  assert.deepStrictEqual(rest, ["neu"], "der alte Eintrag muss weg sein");
});

test("mit NUTZUNG_ANONYM=1 steht keine Adresse im Speicher", async () => {
  process.env.NUTZUNG_ANONYM = "1";
  await NUTZUNG.zaehlen("bericht1", "denis@dihag.com", "oeffnen");
  const roh = JSON.stringify(tabellen.get("Nutzung"));
  assert.ok(!roh.includes("denis@dihag.com"), "die Adresse darf nicht gespeichert sein");
  assert.ok(roh.includes("anon:"));
  const a = await NUTZUNG.auswertung(30);
  assert.strictEqual(a.gesamt.personen, 1, "gezählt wird trotzdem");
  assert.strictEqual(a.anonym, true);
});

test("eine gescheiterte Zählung wirft nicht", async () => {
  schreibfehler = true;
  let gewarnt = null;
  // Kein Wurf = bestanden: ein Bericht darf nie an der Statistik scheitern.
  await NUTZUNG.zaehlen("b1", "a@dihag.com", "oeffnen", { warn: t => { gewarnt = t; } });
  assert.match(gewarnt, /nicht gezählt/);
  assert.strictEqual(tabellen.get("Nutzung")?.length ?? 0, 0);
});

/* ── CU-Abfrage ──────────────────────────────────────────────────────── */

test("ohne Einrichtung meldet die CU-Abfrage das offen", async () => {
  delete process.env.METRIK_WORKSPACE;
  delete process.env.METRIK_DATASET;
  const r = await METRIKEN.verbrauch({}, async () => "t", ["item1"]);
  assert.strictEqual(r.verfuegbar, false);
  assert.strictEqual(r.grund, "nicht_eingerichtet");
});

test("fehlender Zugriff wird als solcher gemeldet, nicht als leeres Ergebnis", async () => {
  process.env.METRIK_WORKSPACE = "ws";
  process.env.METRIK_DATASET = "ds";
  global.fetch = async () => ({ status: 401, ok: false, text: async () => "" });
  const r = await METRIKEN.verbrauch({}, async () => "t", ["item1"]);
  assert.strictEqual(r.verfuegbar, false);
  assert.strictEqual(r.grund, "kein_zugriff");
});

test("CU-Zeilen werden übersetzt", async () => {
  process.env.METRIK_WORKSPACE = "ws";
  process.env.METRIK_DATASET = "ds";
  let gesendet = null;
  global.fetch = async (url, opts) => {
    gesendet = JSON.parse(opts.body).queries[0].query;
    return { status: 200, ok: true, text: async () => JSON.stringify({
      results: [{ tables: [{ rows: [{
        "MetricsByItemandOperationandDay[ItemId]": "item1",
        "MetricsByItemandOperationandDay[OperationName]": "Query",
        "[CU]": 12.5, "[Vorgaenge]": 4, "[DauerMs]": 800
      }] }] }]
    }) };
  };
  const r = await METRIKEN.verbrauch({}, async () => "t", ["item1", "item2"], 14);
  assert.strictEqual(r.verfuegbar, true);
  assert.deepStrictEqual(r.zeilen, [
    { itemId: "item1", vorgang: "Query", cu: 12.5, vorgaenge: 4, dauerMs: 800 }
  ]);
  assert.ok(gesendet.includes('"item1"') && gesendet.includes('"item2"'),
    "beide Elemente muessen in der Abfrage stehen");
  assert.ok(gesendet.includes("TODAY() - 14"), "der Zeitraum muss durchschlagen");
});

test("Anführungszeichen in Ids können die Abfrage nicht aufbrechen", async () => {
  process.env.METRIK_WORKSPACE = "ws";
  process.env.METRIK_DATASET = "ds";
  let gesendet = null;
  global.fetch = async (url, opts) => {
    gesendet = JSON.parse(opts.body).queries[0].query;
    return { status: 200, ok: true, text: async () => '{"results":[{"tables":[{"rows":[]}]}]}' };
  };
  await METRIKEN.verbrauch({}, async () => "t", ['a" , "b'], 30);
  assert.ok(gesendet.includes('"a"" , ""b"'), "Anführungszeichen werden verdoppelt");
});
