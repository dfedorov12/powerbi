"use strict";

/* Prüft die Ausweiskontrolle des Brokers gegen selbst erzeugte Schlüssel –
   ohne Netz und ohne Mandanten. Genau diese Fälle entscheiden darüber, ob
   jemand Fremdes ein Einbettungs-Token bekommt.                            */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KID = "testschluessel";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");

function baueToken(nutz, opt = {}) {
  const kopf = { alg: opt.alg || "RS256", kid: opt.kid || KID, typ: "JWT" };
  const daten = `${b64u(kopf)}.${b64u(nutz)}`;
  const s = crypto.createSign("RSA-SHA256");
  s.update(daten);
  s.end();
  const sig = (opt.schluessel || privateKey);
  return `${daten}.${s.sign(sig).toString("base64url")}`;
}

const jetzt = () => Math.floor(Date.now() / 1000);

const gueltigeNutzlast = (ueber = {}) => ({
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  aud: CLIENT,
  tid: TENANT,
  exp: jetzt() + 3600,
  nbf: jetzt() - 60,
  scp: "Berichte.Lesen",
  upn: "denis@dihag.com",
  name: "Denis Fedorov",
  oid: "99999999-0000-0000-0000-000000000000",
  ...ueber
});

// Entra-Abrufe abfangen: OpenID-Konfiguration und Schlüsselsatz.
global.fetch = async url => {
  const s = String(url);
  if (s.includes("openid-configuration")) {
    return { ok: true, json: async () => ({ jwks_uri: "https://example.test/keys" }) };
  }
  if (s.includes("/keys")) {
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  }
  throw new Error("unerwarteter Abruf: " + s);
};

const { pruefe } = require("../src/lib/entra");
const CFG = { tenantId: TENANT, clientId: CLIENT, scope: "Berichte.Lesen" };

const kopf = t => "Bearer " + t;

test("gültiges Token wird angenommen", async () => {
  const wer = await pruefe(kopf(baueToken(gueltigeNutzlast())), CFG);
  assert.strictEqual(wer.upn, "denis@dihag.com");
  assert.ok(wer.scopes.includes("Berichte.Lesen"));
});

test("Zielgruppe api://<clientId> wird ebenfalls angenommen", async () => {
  const wer = await pruefe(kopf(baueToken(gueltigeNutzlast({ aud: "api://" + CLIENT }))), CFG);
  assert.strictEqual(wer.upn, "denis@dihag.com");
});

test("v1-Aussteller (sts.windows.net) wird angenommen", async () => {
  const wer = await pruefe(kopf(baueToken(gueltigeNutzlast({
    iss: `https://sts.windows.net/${TENANT}/`
  }))), CFG);
  assert.strictEqual(wer.upn, "denis@dihag.com");
});

test("fremde Zielgruppe wird abgelehnt", async () => {
  await assert.rejects(
    () => pruefe(kopf(baueToken(gueltigeNutzlast({ aud: "00000003-0000-0000-c000-000000000000" }))), CFG),
    /anderen Dienst/);
});

test("fremder Mandant wird abgelehnt", async () => {
  await assert.rejects(
    () => pruefe(kopf(baueToken(gueltigeNutzlast({ tid: "99999999-9999-9999-9999-999999999999" }))), CFG),
    /Mandant/);
});

test("abgelaufenes Token wird abgelehnt", async () => {
  await assert.rejects(
    () => pruefe(kopf(baueToken(gueltigeNutzlast({ exp: jetzt() - 600 }))), CFG),
    /abgelaufen/);
});

test("fehlender Bereich wird abgelehnt", async () => {
  await assert.rejects(
    () => pruefe(kopf(baueToken(gueltigeNutzlast({ scp: "User.Read" }))), CFG),
    /Bereich/);
});

test("mit fremdem Schlüssel signiertes Token wird abgelehnt", async () => {
  const fremd = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(
    () => pruefe(kopf(baueToken(gueltigeNutzlast(), { schluessel: fremd.privateKey })), CFG),
    /Signatur/);
});

test("nachträglich veränderte Nutzlast wird abgelehnt", async () => {
  const t = baueToken(gueltigeNutzlast());
  const [h, , s] = t.split(".");
  const gefaelscht = `${h}.${b64u(gueltigeNutzlast({ upn: "fremd@example.com" }))}.${s}`;
  await assert.rejects(() => pruefe(kopf(gefaelscht), CFG), /Signatur/);
});

test("alg none wird abgelehnt", async () => {
  const nutz = gueltigeNutzlast();
  const t = `${b64u({ alg: "none", kid: KID, typ: "JWT" })}.${b64u(nutz)}.`;
  await assert.rejects(() => pruefe(kopf(t), CFG), /Signaturverfahren/);
});

test("fehlender Kopf wird abgelehnt", async () => {
  await assert.rejects(() => pruefe("", CFG), /Kein Ausweis/);
});
