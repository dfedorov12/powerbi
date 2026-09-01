"use strict";

/* Prüfung des Ausweises, den das Frontend mitschickt.

   Das Frontend meldet sich mit einem Token der eigenen Zielgruppe
   (api://<Frontend-ClientId>/Berichte.Lesen). Der Broker prüft es hier
   vollständig selbst: Signatur gegen die öffentlichen Schlüssel von Entra,
   Aussteller, Zielgruppe, Laufzeit und Bereich.

   Bewusst ohne Fremdbibliothek – Node bringt alles mit, und jede eingesparte
   Abhängigkeit ist eine Abhängigkeit weniger, die gepflegt werden muss.     */

const crypto = require("crypto");

const b64u = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const json = s => JSON.parse(b64u(s).toString("utf8"));

/* ── Öffentliche Schlüssel (JWKS) ───────────────────────────────────
   Entra tauscht die Schlüssel selten, aber regelmäßig. Zwischenspeicher mit
   Ablauf; ein unbekannter kid erzwingt sofort ein erneutes Laden.          */

let _jwks = { keys: [], geladen: 0 };
const JWKS_TTL = 12 * 60 * 60 * 1000;

async function schluessel(tenantId, kid, frisch = false) {
  const alt = Date.now() - _jwks.geladen > JWKS_TTL;
  if (frisch || alt || !_jwks.keys.length) {
    const cfgRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`);
    if (!cfgRes.ok) throw new Error("OpenID-Konfiguration nicht abrufbar");
    const cfg = await cfgRes.json();
    const jwksRes = await fetch(cfg.jwks_uri);
    if (!jwksRes.ok) throw new Error("Signaturschlüssel nicht abrufbar");
    const d = await jwksRes.json();
    _jwks = { keys: d.keys || [], geladen: Date.now() };
  }
  const k = _jwks.keys.find(x => x.kid === kid);
  if (!k && !frisch) return schluessel(tenantId, kid, true);
  return k || null;
}

class TokenFehler extends Error {
  constructor(text, art = "token") { super(text); this.art = art; this.status = 401; }
}

/** Token prüfen und die Angaben zurückgeben.
 *  @param {string} authHeader  Inhalt des Authorization-Kopfes
 *  @param {{tenantId:string, clientId:string, scope:string}} cfg
 *  @returns {Promise<{upn:string, name:string, oid:string, scopes:string[]}>}
 */
async function pruefe(authHeader, cfg) {
  const roh = String(authHeader || "");
  if (!/^Bearer\s+/i.test(roh)) throw new TokenFehler("Kein Ausweis mitgeschickt");
  const token = roh.replace(/^Bearer\s+/i, "").trim();

  const teile = token.split(".");
  if (teile.length !== 3) throw new TokenFehler("Ausweis ist kein JWT");
  const [h, p, s] = teile;

  let kopf, nutz;
  try { kopf = json(h); nutz = json(p); }
  catch { throw new TokenFehler("Ausweis nicht lesbar"); }

  if (kopf.alg !== "RS256") throw new TokenFehler("Unerwartetes Signaturverfahren");

  const jwk = await schluessel(cfg.tenantId, kopf.kid);
  if (!jwk) throw new TokenFehler("Signaturschlüssel unbekannt");

  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const v = crypto.createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  v.end();
  if (!v.verify(pub, b64u(s))) throw new TokenFehler("Signatur stimmt nicht");

  // Aussteller: v2.0-Token nennen .../v2.0, v1-Token sts.windows.net.
  const aussteller = [
    `https://login.microsoftonline.com/${cfg.tenantId}/v2.0`,
    `https://sts.windows.net/${cfg.tenantId}/`
  ];
  if (!aussteller.includes(nutz.iss)) throw new TokenFehler("Fremder Aussteller");
  if (nutz.tid && nutz.tid !== cfg.tenantId) throw new TokenFehler("Fremder Mandant");

  // Zielgruppe: je nach Token-Version die reine ID oder api://<ID>.
  const zielgruppen = [cfg.clientId, `api://${cfg.clientId}`];
  if (!zielgruppen.includes(nutz.aud))
    throw new TokenFehler("Ausweis ist für einen anderen Dienst ausgestellt");

  const jetzt = Math.floor(Date.now() / 1000);
  const puffer = 120;   // Toleranz für Uhrenabweichung
  if (nutz.exp && jetzt > nutz.exp + puffer) throw new TokenFehler("Ausweis abgelaufen");
  if (nutz.nbf && jetzt + puffer < nutz.nbf) throw new TokenFehler("Ausweis noch nicht gültig");

  const scopes = String(nutz.scp || "").split(" ").filter(Boolean);
  if (cfg.scope && !scopes.includes(cfg.scope))
    throw new TokenFehler(`Der Bereich ${cfg.scope} fehlt im Ausweis`);

  return {
    upn: String(nutz.upn || nutz.preferred_username || nutz.unique_name || "").toLowerCase(),
    name: nutz.name || "",
    oid: nutz.oid || "",
    scopes
  };
}

module.exports = { pruefe, TokenFehler };
