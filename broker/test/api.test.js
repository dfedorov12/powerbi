"use strict";

/* Endpunkte des Brokers – vollständig durchgespielt, ohne Azure, ohne Netz
   und ohne Mandanten.

   Aufbau: `@azure/functions` wird durch eine Attrappe ersetzt, die die
   registrierten Handler nur einsammelt. `fetch` beantwortet die Aufrufe an
   Entra und Power BI. Damit lässt sich genau das prüfen, worauf es
   sicherheitsseitig ankommt:
     - ohne gültigen Ausweis gibt es kein Token
     - IDs kommen ausschließlich aus der Freigabeliste, nie vom Aufrufer
     - ausgestellt wird ausschließlich accessLevel "View"                    */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const Module = require("node:module");

/* ── Schlüssel und Token wie in entra.test.js ────────────────────────── */

const TENANT   = "11111111-2222-3333-4444-555555555555";
const FRONTEND = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KID = "testschluessel";
const WS  = "ws-1111";
const RID = "rep-2222";
const DS  = "ds-3333";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(ueber = {}) {
  const jetzt = Math.floor(Date.now() / 1000);
  const nutz = {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: FRONTEND, tid: TENANT,
    exp: jetzt + 3600, nbf: jetzt - 60,
    scp: "Berichte.Lesen",
    upn: "denis@dihag.com", name: "Denis Fedorov",
    ...ueber
  };
  const daten = `${b64u({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64u(nutz)}`;
  const s = crypto.createSign("RSA-SHA256");
  s.update(daten); s.end();
  return `${daten}.${s.sign(privateKey).toString("base64url")}`;
}

/* ── Umgebung ────────────────────────────────────────────────────────── */

process.env.PBI_TENANT_ID      = TENANT;
process.env.PBI_CLIENT_ID      = "dienst-app-id";
process.env.PBI_CLIENT_SECRET  = "streng-geheim";
process.env.FRONTEND_CLIENT_ID = FRONTEND;
process.env.FRONTEND_SCOPE     = "Berichte.Lesen";
process.env.PBI_BERICHTE       = JSON.stringify([
  { key: "bericht1", workspaceId: WS, reportId: RID }
]);
process.env.ALLOWED_ORIGINS   = "https://dfedorov12.github.io";
process.env.ERLAUBTE_DOMAENEN = "dihag.com";
process.env.ADMIN_UPNS        = "administrator@dihag.com";

/* ── Antworten von Entra und Power BI ────────────────────────────────── */

let pbiFehler = null;          // setzt einzelne Tests auf eine Fehlermeldung
const aufrufe = [];            // Protokoll: was ging an Power BI?

const antwort = (koerper, ok = true, status = 200) => {
  const text = typeof koerper === "string" ? koerper : JSON.stringify(koerper);
  return { ok, status, statusText: ok ? "OK" : "Fehler",
           json: async () => JSON.parse(text), text: async () => text };
};

global.fetch = async (url, opts = {}) => {
  const s = String(url);

  if (s.includes("openid-configuration"))
    return antwort({ jwks_uri: "https://example.test/keys" });
  if (s.includes("example.test/keys"))
    return antwort({ keys: [jwk] });
  if (s.includes("/oauth2/v2.0/token"))
    return antwort({ access_token: "dienstuser-token", expires_in: 3600 });

  if (s.includes("api.powerbi.com")) {
    aufrufe.push({ url: s, method: opts.method || "GET", body: opts.body });
    if (pbiFehler)
      return antwort({ error: { message: pbiFehler } }, false, 403);

    if (s.endsWith("/GenerateToken"))
      return antwort({ token: "einbettungs-token",
                       expiration: new Date(Date.now() + 3600000).toISOString() });
    if (/\/reports\/[^/]+$/.test(s))
      return antwort({ id: RID, name: "Kennzahlen",
                       embedUrl: "https://app.powerbi.com/reportEmbed?reportId=" + RID,
                       datasetId: DS });
    if (s.endsWith("/reports"))
      return antwort({ value: [{ id: RID, name: "Kennzahlen" },
                               { id: "rep-4444", name: "Nicht freigegeben" }] });
    if (s.endsWith("/groups"))
      return antwort({ value: [{ id: WS, name: "Controlling" }] });
  }
  throw new Error("unerwarteter Abruf: " + s);
};

/* ── Handler einsammeln ──────────────────────────────────────────────── */

const registriert = new Map();

// Regelspeicher als Attrappe: die echte Ablage liegt in Azure Table Storage,
// die Auswertung soll hier trotzdem vollstaendig durchlaufen.
const ablage = { regeln: [] };
const speicherAttrappe = {
  lesen: async () => ablage.regeln,
  schreiben: async (regeln) => { ablage.regeln = regeln; return regeln; }
};

// Nutzungszählung und Metriken haben eigene Tests (nutzung.test.js); hier
// interessiert nur, dass die Endpunkte sie richtig ansprechen.
const gezaehlt = [];
const nutzungAttrappe = {
  zaehlen: async (key, upn, art) => { gezaehlt.push({ key, upn, art }); },
  auswertung: async tage => ({
    von: "2026-01-01", bis: "2026-01-30", aufbewahrungTage: 90, anonym: false, tage,
    gesamt: { oeffnen: 0, erneuern: 0, personen: 0 }, jeBericht: [], jeTag: []
  })
};
const kostenAttrappe = {
  kosten: async (_cfg, frisch) => ({ verfuegbar: true, frisch: frisch === true,
    laufenderMonat: { summe: 49.9, kapazitaet: 49.78, uebrige: 0.12, waehrung: "EUR", jeGruppe: [] },
    vormonat: { summe: 310.9, kapazitaet: 310.5, uebrige: 0.4, waehrung: "EUR", jeGruppe: [] },
    stand: new Date().toISOString() })
};
const metrikenAttrappe = {
  verbrauch: async () => ({ verfuegbar: false, grund: "nicht_eingerichtet" }),
  cfg: () => ({ workspace: "", dataset: "", kapazitaet: "",
                bericht: "https://app.powerbi.com/groups/x/reports/y" })
};

const echtesLaden = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === "@azure/functions") {
    return { app: { http: (name, opt) => registriert.set(opt.route || name, opt) } };
  }
  if (anfrage === "../lib/speicher") return speicherAttrappe;
  if (anfrage === "../lib/nutzung") return nutzungAttrappe;
  if (anfrage === "../lib/metriken") return metrikenAttrappe;
  if (anfrage === "../lib/kosten") return kostenAttrappe;
  return echtesLaden.call(this, anfrage, ...rest);
};
require("../src/functions/api");
Module._load = echtesLaden;

const kontext = { log: () => {}, warn: () => {}, error: () => {} };

function ruf(route, { method = "GET", ausweis = null,
                      herkunft = "https://dfedorov12.github.io", query = {},
                      koerper = null } = {}) {
  const kopf = new Headers();
  if (ausweis) kopf.set("authorization", "Bearer " + ausweis);
  if (herkunft) kopf.set("origin", herkunft);
  const request = {
    method, headers: kopf, query: new URLSearchParams(query),
    json: async () => { if (koerper === null) throw new Error("kein Koerper"); return koerper; }
  };
  return registriert.get(route).handler(request, kontext);
}

const GRUPPE = "8f14e45f-ceea-467a-9b2c-6f0e2c1a3b4d";

test.beforeEach(() => {
  pbiFehler = null; aufrufe.length = 0; ablage.regeln = []; gezaehlt.length = 0;
});

/* ── health ──────────────────────────────────────────────────────────── */

test("health antwortet ohne Anmeldung und meldet die Einrichtung", async () => {
  const r = await ruf("health");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.jsonBody.eingerichtet, true);
  assert.deepStrictEqual(r.jsonBody.berichte, ["bericht1"]);
});

test("health verrät keine Geheimnisse", async () => {
  const r = await ruf("health");
  assert.ok(!JSON.stringify(r.jsonBody).includes("streng-geheim"));
});

/* ── CORS ────────────────────────────────────────────────────────────── */

test("Vorabfrage der erlaubten Herkunft wird beantwortet", async () => {
  const r = await ruf("embed-token", { method: "OPTIONS" });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers["Access-Control-Allow-Origin"],
    "https://dfedorov12.github.io");
  assert.ok(r.headers["Access-Control-Allow-Headers"].includes("authorization"));
});

test("fremde Herkunft bekommt keine CORS-Freigabe", async () => {
  const r = await ruf("embed-token", { method: "OPTIONS", herkunft: "https://boese.example" });
  assert.strictEqual(r.headers["Access-Control-Allow-Origin"], undefined);
});

/* ── embed-token ─────────────────────────────────────────────────────── */

test("ohne Ausweis gibt es kein Einbettungs-Token", async () => {
  const r = await ruf("embed-token", { query: { bericht: "bericht1" } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(aufrufe.length, 0, "Power BI darf gar nicht erst gefragt werden");
});

test("Ausweis für einen anderen Dienst wird abgewiesen", async () => {
  const r = await ruf("embed-token", {
    ausweis: token({ aud: "00000009-0000-0000-c000-000000000000" }),
    query: { bericht: "bericht1" }
  });
  assert.strictEqual(r.status, 401);
});

test("gültiger Ausweis bekommt ein Einbettungs-Token", async () => {
  const r = await ruf("embed-token", { ausweis: token(), query: { bericht: "bericht1" } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(gezaehlt, [{ key: "bericht1", upn: "denis@dihag.com", art: "oeffnen" }],
    "die Öffnung muss gezählt werden");
  assert.strictEqual(r.jsonBody.token, "einbettungs-token");
  assert.strictEqual(r.jsonBody.reportId, RID);
  assert.ok(r.jsonBody.embedUrl.startsWith("https://app.powerbi.com/"));
  assert.ok(r.jsonBody.expiration);
});

test("das Einbettungs-Token wird als V2-Token und nur lesend angefordert", async () => {
  await ruf("embed-token", { ausweis: token(), query: { bericht: "bericht1" } });
  const gen = aufrufe.find(a => a.url.endsWith("/GenerateToken"));
  assert.ok(gen, "GenerateToken wurde nicht aufgerufen");
  // Mandantenweiter Endpunkt, nicht der berichtsbezogene: der kann keine
  // Direct-Lake-Modelle ("not supported with V1 embed token").
  assert.ok(!gen.url.includes("/reports/"), "V1-Endpunkt benutzt: " + gen.url);
  const b = JSON.parse(gen.body);
  assert.deepStrictEqual(b.datasets, [{ id: DS }]);
  assert.deepStrictEqual(b.reports, [{ id: RID, allowEdit: false }]);
  assert.ok(!("targetWorkspaces" in b),
    "targetWorkspaces wuerde Schreibrechte verlangen und gehoert nicht hierher");
});

test("die Antwort enthält nicht das Token des Dienstusers", async () => {
  const r = await ruf("embed-token", { ausweis: token(), query: { bericht: "bericht1" } });
  assert.ok(!JSON.stringify(r.jsonBody).includes("dienstuser-token"));
});

test("unbekannter Schlüssel wird abgewiesen", async () => {
  const r = await ruf("embed-token", { ausweis: token(), query: { bericht: "geheim" } });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.jsonBody.art, "unbekannter_bericht");
  assert.strictEqual(aufrufe.length, 0);
});

test("untergeschobene IDs im Aufruf ändern nichts", async () => {
  // Der Kern der Absicherung: Arbeitsbereich und Bericht kommen aus der
  // Freigabeliste, niemals aus der Anfrage.
  const r = await ruf("embed-token", {
    ausweis: token(),
    query: { bericht: "bericht1", workspaceId: "fremd-ws", reportId: "fremd-rep" }
  });
  assert.strictEqual(r.status, 200);
  const alles = JSON.stringify(aufrufe);
  assert.ok(!alles.includes("fremd-ws") && !alles.includes("fremd-rep"),
    "untergeschobene IDs sind bei Power BI angekommen: " + alles);
  assert.ok(aufrufe.some(a => a.url.includes(WS) && a.url.includes(RID)),
    "der freigegebene Bericht wurde nicht abgefragt: " + alles);
});

test("fremde E-Mail-Domäne wird abgewiesen", async () => {
  const r = await ruf("embed-token", {
    ausweis: token({ upn: "jemand@fremd.example" }),
    query: { bericht: "bericht1" }
  });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.jsonBody.art, "domaene");
  assert.strictEqual(aufrufe.length, 0);
});

test("Fehler von Power BI kommen als 502 mit Klartext zurück", async () => {
  pbiFehler = "PowerBINotAuthorizedException";
  const r = await ruf("embed-token", { ausweis: token(), query: { bericht: "bericht1" } });
  assert.strictEqual(r.status, 502);
  assert.match(r.jsonBody.fehler, /PowerBINotAuthorized/);
  assert.strictEqual(r.jsonBody.art, "powerbi");
});

/* ── berichte ────────────────────────────────────────────────────────── */

test("die Übersicht ist Administratoren vorbehalten", async () => {
  const r = await ruf("berichte", { ausweis: token() });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.jsonBody.art, "kein_admin");
});

test("Administratoren sehen alle Berichte mit Freigabe-Schlüssel", async () => {
  const r = await ruf("berichte", { ausweis: token({ upn: "administrator@dihag.com" }) });
  assert.strictEqual(r.status, 200);
  const l = r.jsonBody.berichte;
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l.find(b => b.reportId === RID).key, "bericht1");
  assert.strictEqual(l.find(b => b.reportId === "rep-4444").key, "",
    "nicht freigegebene Berichte duerfen keinen Schluessel tragen");
});

/* ── Zugriffsregeln ──────────────────────────────────────────────────── */

test("zugriff meldet ohne Regeln den Standardzugriff", async () => {
  const r = await ruf("zugriff", { ausweis: token() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.jsonBody.quelle, "standard");
  assert.strictEqual(r.jsonBody.admin, false);
  assert.deepStrictEqual(r.jsonBody.berichte, ["bericht1"]);
});

test("zugriff meldet den Haupt-Administrator als solchen", async () => {
  const r = await ruf("zugriff", { ausweis: token({ upn: "administrator@dihag.com" }) });
  assert.strictEqual(r.jsonBody.admin, true);
  assert.strictEqual(r.jsonBody.quelle, "hauptadmin");
});

test("die Regelverwaltung ist ohne Verwaltungsrecht gesperrt", async () => {
  const r = await ruf("rechte", { ausweis: token() });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.jsonBody.art, "kein_admin");
});

test("Haupt-Administrator darf die Regeln lesen", async () => {
  const r = await ruf("rechte", { ausweis: token({ upn: "administrator@dihag.com" }) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.jsonBody.berichte, ["bericht1"]);
  assert.deepStrictEqual(r.jsonBody.regeln, []);
});

test("Regeln werden gespeichert und wirken sofort", async () => {
  const p = await ruf("rechte", {
    method: "PUT", ausweis: token({ upn: "administrator@dihag.com" }),
    koerper: { regeln: [{ typ: "gruppe", wert: GRUPPE, name: "Controlling",
                          berichte: ["bericht1"] }] }
  });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.jsonBody.regeln.length, 1);

  // Ohne die Gruppe: kein Zugriff mehr, obwohl die Domaene stimmt.
  const ohne = await ruf("embed-token", { ausweis: token(), query: { bericht: "bericht1" } });
  assert.strictEqual(ohne.status, 403);
  assert.strictEqual(ohne.jsonBody.art, "keine_freigabe");
  assert.strictEqual(aufrufe.length, 0, "Power BI darf gar nicht gefragt werden");

  // Mit der Gruppe: Zugriff.
  const mit = await ruf("embed-token", {
    ausweis: token({ groups: [GRUPPE] }), query: { bericht: "bericht1" }
  });
  assert.strictEqual(mit.status, 200);
});

test("PUT weist einen unbekannten Bericht ab", async () => {
  const r = await ruf("rechte", {
    method: "PUT", ausweis: token({ upn: "administrator@dihag.com" }),
    koerper: { regeln: [{ typ: "domaene", wert: "dihag.com", berichte: ["gibtsnicht"] }] }
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.jsonBody.fehler, /unbekannter Bericht/);
});

test("PUT weist eine Gruppe ohne Objekt-Id ab", async () => {
  const r = await ruf("rechte", {
    method: "PUT", ausweis: token({ upn: "administrator@dihag.com" }),
    koerper: { regeln: [{ typ: "gruppe", wert: "Fabric_Viewer", berichte: ["*"] }] }
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.jsonBody.fehler, /Objekt-Id/);
});

test("PUT verhindert, dass man sich selbst aussperrt", async () => {
  // denis ist Administrator nur ueber eine Regel, nicht ueber ADMIN_UPNS.
  ablage.regeln = [{ id: "r1", typ: "benutzer", wert: "denis@dihag.com",
                     berichte: ["*"], admin: true, aktiv: true, name: "", notiz: "" }];
  const r = await ruf("rechte", {
    method: "PUT", ausweis: token(),
    koerper: { regeln: [{ typ: "domaene", wert: "dihag.com", berichte: ["bericht1"] }] }
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.jsonBody.art, "aussperrung");
  assert.strictEqual(ablage.regeln.length, 1, "der alte Stand bleibt unangetastet");
});

test("ein Administrator laut Regel darf die Regeln lesen", async () => {
  ablage.regeln = [{ id: "r1", typ: "domaene", wert: "dihag.com",
                     berichte: ["*"], admin: true, aktiv: true, name: "", notiz: "" }];
  const r = await ruf("rechte", { ausweis: token() });
  assert.strictEqual(r.status, 200);
});

test("PUT ohne Regelliste wird abgewiesen", async () => {
  const r = await ruf("rechte", {
    method: "PUT", ausweis: token({ upn: "administrator@dihag.com" }),
    koerper: { irgendwas: true }
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.jsonBody.art, "eingabe");
});

/* ── Verbrauch ───────────────────────────────────────────────────────── */

test("die Verbrauchszahlen sind Administratoren vorbehalten", async () => {
  const r = await ruf("nutzung", { ausweis: token() });   // denis, kein Admin
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.jsonBody.art, "kein_admin");
});

test("ohne Ausweis gibt es keine Verbrauchszahlen", async () => {
  const r = await ruf("nutzung");
  assert.strictEqual(r.status, 401);
});

test("ein Administrator laut Regel darf den Verbrauch sehen", async () => {
  ablage.regeln = [{ id: "r1", typ: "domaene", wert: "dihag.com",
                     berichte: ["*"], admin: true, aktiv: true, name: "", notiz: "" }];
  const r = await ruf("nutzung", { ausweis: token() });
  assert.strictEqual(r.status, 200);
  assert.ok(r.jsonBody.zaehlung, "die Zaehlung muss mitkommen");
  assert.ok("verfuegbar" in r.jsonBody.cu, "der CU-Zustand muss mitkommen");
  assert.match(r.jsonBody.cu.metrikBericht, /^https:\/\/app\.powerbi\.com\//,
    "der Verweis in die Metrik-App muss mitkommen");
});

test("eine Token-Erneuerung wird als solche gezählt, nicht als neue Öffnung", async () => {
  await ruf("embed-token", {
    ausweis: token(), query: { bericht: "bericht1", grund: "erneuerung" }
  });
  assert.deepStrictEqual(gezaehlt.map(g => g.art), ["erneuern"]);
});

test("abgewiesene Aufrufe werden nicht gezählt", async () => {
  await ruf("embed-token", { query: { bericht: "bericht1" } });              // ohne Ausweis
  await ruf("embed-token", { ausweis: token(), query: { bericht: "weg" } }); // unbekannt
  assert.deepStrictEqual(gezaehlt, [], "nur ausgegebene Token zählen");
});

/* ── Kosten ──────────────────────────────────────────────────────────── */

test("die Kosten sind Administratoren vorbehalten", async () => {
  const r = await ruf("kosten", { ausweis: token() });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.jsonBody.art, "kein_admin");
});

test("ohne Ausweis gibt es keine Kosten", async () => {
  const r = await ruf("kosten");
  assert.strictEqual(r.status, 401);
});

test("Administratoren bekommen laufenden Monat und Vormonat", async () => {
  const r = await ruf("kosten", { ausweis: token({ upn: "administrator@dihag.com" }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.jsonBody.laufenderMonat.kapazitaet, 49.78);
  assert.strictEqual(r.jsonBody.vormonat.summe, 310.9);
  assert.strictEqual(r.jsonBody.frisch, false, "ohne ?frisch=1 darf der Zwischenspeicher gelten");
});

test("mit ?frisch=1 wird am Zwischenspeicher vorbei geholt", async () => {
  const r = await ruf("kosten", { ausweis: token({ upn: "administrator@dihag.com" }),
                                  query: { frisch: "1" } });
  assert.strictEqual(r.jsonBody.frisch, true);
});
