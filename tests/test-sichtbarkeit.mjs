/* Prüft die Sichtbarkeitslogik aus js/data.js gegen js/config.js.
   Aufruf:  node tests/test-sichtbarkeit.mjs

   Die Browserdateien sind reine Skripte ohne Modulsystem; sie werden hier
   gelesen und in einer Funktion ausgewertet. So testet der Lauf genau den
   Code, der auch ausgeliefert wird – keine Kopie davon.                   */

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

const b = (ueber = {}) => ({
  key: "x", name: "X", domains: "*", minRolle: "viewer", aktiv: true, ...ueber
});

test("Standardbericht ist für viewer sichtbar", () => {
  assert.strictEqual(DATA.istSichtbar(b(), "viewer", "dihag.com"), true);
});

test("inaktiver Bericht ist für niemanden sichtbar", () => {
  assert.strictEqual(DATA.istSichtbar(b({ aktiv: false }), "admin", "dihag.com"), false);
});

test("Mindestrolle wird beachtet", () => {
  const e = b({ minRolle: "editor" });
  assert.strictEqual(DATA.istSichtbar(e, "viewer", "dihag.com"), false);
  assert.strictEqual(DATA.istSichtbar(e, "editor", "dihag.com"), true);
  assert.strictEqual(DATA.istSichtbar(e, "admin", "dihag.com"), true);
});

test("Domänenliste schließt fremde Domänen aus", () => {
  const e = b({ domains: "dihag.com; gienanth.de" });
  assert.strictEqual(DATA.istSichtbar(e, "viewer", "dihag.com"), true);
  assert.strictEqual(DATA.istSichtbar(e, "viewer", "gienanth.de"), true);
  assert.strictEqual(DATA.istSichtbar(e, "viewer", "example.com"), false);
});

test("Sternchen und leere Liste bedeuten: alle Domänen", () => {
  assert.strictEqual(DATA.istSichtbar(b({ domains: "*" }), "viewer", "example.com"), true);
  assert.strictEqual(DATA.istSichtbar(b({ domains: "" }), "viewer", "example.com"), true);
});

test("unbekannte Rolle sieht nichts", () => {
  assert.strictEqual(DATA.istSichtbar(b(), "gast", "dihag.com"), false);
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
