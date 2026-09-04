"use strict";

/* Regelauswertung – die Schicht, die entscheidet, wer welchen Bericht sieht.
   Reine Funktionen, deshalb ohne jede Attrappe testbar.                    */

const test = require("node:test");
const assert = require("node:assert");
const R = require("../src/lib/rechte");

const GRUPPE = "8f14e45f-ceea-467a-9b2c-6f0e2c1a3b4d";
const wer = (ueber = {}) => ({ upn: "denis@dihag.com", oid: "o-1", gruppen: [], ...ueber });

/* ── normalisieren ───────────────────────────────────────────────────── */

test("Benutzerregel wird angenommen und kleingeschrieben", () => {
  const r = R.normalisiere({ typ: "Benutzer", wert: " Denis@DIHAG.com ", berichte: ["bericht1"] });
  assert.strictEqual(r.typ, "benutzer");
  assert.strictEqual(r.wert, "denis@dihag.com");
  assert.strictEqual(r.aktiv, true);
  assert.strictEqual(r.admin, false);
  assert.ok(r.id, "es wird eine Id vergeben");
});

test("Domäne darf mit oder ohne @ eingegeben werden", () => {
  assert.strictEqual(R.normalisiere({ typ: "domaene", wert: "@dihag.com", berichte: ["*"] }).wert,
    "dihag.com");
});

test("unbekannter Typ wird abgelehnt", () => {
  assert.throws(() => R.normalisiere({ typ: "abteilung", wert: "IT", berichte: ["*"] }),
    /unbekannter Typ/);
});

test("Benutzer ohne @ wird abgelehnt", () => {
  assert.throws(() => R.normalisiere({ typ: "benutzer", wert: "denis", berichte: ["*"] }),
    /keine E-Mail-Adresse/);
});

test("Gruppe ohne Objekt-Id wird abgelehnt und erklärt, wo sie steht", () => {
  assert.throws(() => R.normalisiere({ typ: "gruppe", wert: "Fabric_Viewer", berichte: ["*"] }),
    /Objekt-Id/);
});

test("Regel ohne Bericht wird abgelehnt", () => {
  assert.throws(() => R.normalisiere({ typ: "domaene", wert: "dihag.com", berichte: [] }),
    /kein Bericht/);
});

test("doppelte Berichte werden zusammengefasst", () => {
  const r = R.normalisiere({ typ: "domaene", wert: "dihag.com", berichte: ["a", "a", "b"] });
  assert.deepStrictEqual(r.berichte, ["a", "b"]);
});

/* ── passt ───────────────────────────────────────────────────────────── */

test("Benutzerregel greift auf UPN und auf die Objekt-Id", () => {
  const r = R.normalisiere({ typ: "benutzer", wert: "denis@dihag.com", berichte: ["*"] });
  assert.ok(R.passt(r, wer()));
  assert.ok(!R.passt(r, wer({ upn: "andere@dihag.com" })));
});

test("Gruppenregel greift über die Objekt-Id, unabhängig von Groß-/Kleinschreibung", () => {
  const r = R.normalisiere({ typ: "gruppe", wert: GRUPPE.toUpperCase(), berichte: ["*"] });
  assert.ok(R.passt(r, wer({ gruppen: [GRUPPE.toUpperCase()] })));
  assert.ok(R.passt(r, wer({ gruppen: [GRUPPE] })));
  assert.ok(!R.passt(r, wer({ gruppen: ["11111111-2222-3333-4444-555555555555"] })));
});

test("Domänenregel greift nur auf die echte Endung", () => {
  const r = R.normalisiere({ typ: "domaene", wert: "dihag.com", berichte: ["*"] });
  assert.ok(R.passt(r, wer()));
  // „nichtdihag.com" darf NICHT durchrutschen
  assert.ok(!R.passt(r, wer({ upn: "x@nichtdihag.com" })));
  assert.ok(!R.passt(r, wer({ upn: "x@gienanth.de" })));
});

test("inaktive Regel greift nie", () => {
  const r = R.normalisiere({ typ: "domaene", wert: "dihag.com", berichte: ["*"], aktiv: false });
  assert.ok(!R.passt(r, wer()));
});

/* ── auswerten ───────────────────────────────────────────────────────── */

const opt = { hauptAdmins: ["administrator@dihag.com"], standardDomaenen: ["dihag.com"] };

test("Haupt-Administrator kommt immer durch, auch ohne jede Regel", () => {
  const a = R.auswerten([], wer({ upn: "administrator@dihag.com" }), opt);
  assert.strictEqual(a.admin, true);
  assert.strictEqual(a.quelle, "hauptadmin");
  assert.ok(R.darfBericht(a, "beliebig"));
});

test("ohne Regeln gilt die bisherige Domänenregelung", () => {
  const a = R.auswerten([], wer(), opt);
  assert.strictEqual(a.quelle, "standard");
  assert.ok(R.darfBericht(a, "bericht1"));
  assert.strictEqual(a.admin, false, "Standardzugriff macht niemanden zum Administrator");
});

test("sobald eine Regel existiert, gilt ausschließlich sie", () => {
  const regeln = [R.normalisiere({ typ: "benutzer", wert: "andere@dihag.com", berichte: ["*"] })];
  const a = R.auswerten(regeln, wer(), opt);
  assert.strictEqual(a.quelle, "keiner");
  assert.ok(!R.darfBericht(a, "bericht1"), "trotz passender Domäne kein Zugriff mehr");
});

test("Gruppenregel gibt genau die genannten Berichte frei", () => {
  const regeln = [R.normalisiere({ typ: "gruppe", wert: GRUPPE, berichte: ["vertrieb"] })];
  const a = R.auswerten(regeln, wer({ gruppen: [GRUPPE] }), opt);
  assert.ok(R.darfBericht(a, "vertrieb"));
  assert.ok(!R.darfBericht(a, "personal"));
});

test("mehrere Treffer werden zusammengefasst, die höhere Berechtigung gewinnt", () => {
  const regeln = [
    R.normalisiere({ typ: "domaene", wert: "dihag.com", berichte: ["vertrieb"] }),
    R.normalisiere({ typ: "gruppe", wert: GRUPPE, berichte: ["personal"], admin: true })
  ];
  const a = R.auswerten(regeln, wer({ gruppen: [GRUPPE] }), opt);
  assert.strictEqual(a.admin, true);
  assert.deepStrictEqual(a.berichte.sort(), ["personal", "vertrieb"]);
});

test("Sternchen schlägt jede Einzelaufzählung", () => {
  const regeln = [R.normalisiere({ typ: "domaene", wert: "dihag.com", berichte: ["*"] })];
  const a = R.auswerten(regeln, wer(), opt);
  assert.strictEqual(a.alleBerichte, true);
  assert.deepStrictEqual(R.sichtbareBerichte(a, ["a", "b"]), ["a", "b"]);
});

test("sichtbareBerichte filtert auf das tatsächlich Freigegebene", () => {
  const regeln = [R.normalisiere({ typ: "domaene", wert: "dihag.com", berichte: ["a", "weg"] })];
  const a = R.auswerten(regeln, wer(), opt);
  assert.deepStrictEqual(R.sichtbareBerichte(a, ["a", "b"]), ["a"]);
});

test("wer nirgends steht, sieht nichts", () => {
  const regeln = [R.normalisiere({ typ: "domaene", wert: "gienanth.de", berichte: ["*"] })];
  const a = R.auswerten(regeln, wer(), opt);
  assert.strictEqual(a.admin, false);
  assert.deepStrictEqual(R.sichtbareBerichte(a, ["a", "b"]), []);
});
