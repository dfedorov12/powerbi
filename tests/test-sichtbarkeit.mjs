/* Prüft die Sichtbarkeitslogik aus js/data.js gegen js/config.js.
   Aufruf:  node tests/test-sichtbarkeit.mjs

   Die Browserdateien sind reine Skripte ohne Modulsystem; sie werden hier
   gelesen und in einer Funktion ausgewertet. So testet der Lauf genau den
   Code, der auch ausgeliefert wird – keine Kopie davon.

   Wer welchen Bericht sehen darf, entscheidet der Broker; hier wird nur
   geprüft, dass die Oberfläche sich an dessen Antwort hält. Die Regellogik
   selbst hat eigene Tests in broker/test/rechte.test.js.                   */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert";

const wurzel = join(dirname(fileURLToPath(import.meta.url)), "..");
const lies = p => readFileSync(join(wurzel, p), "utf8");

// config.js legt eine Konstante an; hier wird sie eingesammelt.
const CONFIG = new Function(lies("js/config.js") + "; return PBI_CONFIG;")();
const DATA = new Function("PBI_CONFIG", lies("js/data.js") + "; return DATA;")(CONFIG);

const b = (ueber = {}) => ({ key: "x", name: "X", aktiv: true, ...ueber });

test("freigegebener Bericht ist sichtbar", () => {
  assert.strictEqual(DATA.istSichtbar(b(), ["x"]), true);
});

test("nicht freigegebener Bericht ist unsichtbar", () => {
  assert.strictEqual(DATA.istSichtbar(b(), ["andere"]), false);
  assert.strictEqual(DATA.istSichtbar(b(), []), false);
});

test("inaktiver Bericht ist auch mit Freigabe unsichtbar", () => {
  assert.strictEqual(DATA.istSichtbar(b({ aktiv: false }), ["x"]), false);
});

test("die Reihenfolge steuert die Reiterleiste", () => {
  const merk = CONFIG.berichte;
  CONFIG.berichte = [
    b({ key: "spaet", name: "Spät", reihenfolge: 20 }),
    b({ key: "frueh", name: "Früh", reihenfolge: 10 }),
    b({ key: "aus",   name: "Aus",  reihenfolge: 5, aktiv: false })
  ];
  DATA.ctx.erlaubt = ["spaet", "frueh", "aus"];
  assert.deepStrictEqual(DATA.sichtbareBerichte().map(x => x.key), ["frueh", "spaet"]);
  CONFIG.berichte = merk;
  DATA.ctx.erlaubt = [];
});

test("nameVon liefert den Anzeigenamen, sonst den Schlüssel", () => {
  assert.strictEqual(DATA.nameVon(CONFIG.berichte[0].key), CONFIG.berichte[0].name);
  assert.strictEqual(DATA.nameVon("unbekannt"), "unbekannt");
});

test("jeder Bericht in der Konfiguration hat einen Schlüssel und einen Namen", () => {
  assert.ok(Array.isArray(CONFIG.berichte) && CONFIG.berichte.length,
    "In js/config.js ist kein Bericht eingetragen");
  const keys = new Set();
  for (const r of CONFIG.berichte) {
    assert.ok(r.key, "Bericht ohne key: " + JSON.stringify(r));
    assert.ok(r.name, "Bericht ohne name: " + r.key);
    assert.ok(!keys.has(r.key), "Schlüssel doppelt vergeben: " + r.key);
    keys.add(r.key);
  }
});

test("die Konfiguration enthält keine Arbeitsbereichs- oder Bericht-IDs", () => {
  // Die IDs gehören ausschließlich in die Freigabeliste des Brokers.
  const roh = JSON.stringify(CONFIG.berichte);
  assert.ok(!/workspaceid|reportid/i.test(roh),
    "In js/config.js stehen Power-BI-IDs – die gehören in PBI_BERICHTE im Broker.");
});

test("die Konfiguration enthält keine eigene Rechtelogik mehr", () => {
  // Zwei Quellen für dieselbe Frage sind eine zu viel: die Rechte liegen
  // im Broker, nicht hier.
  const roh = JSON.stringify(CONFIG);
  assert.ok(!/permlist|hauptadmins|minrolle/i.test(roh),
    "In js/config.js stehen wieder Rechte-Felder – die gehören in den Broker.");
});
