"use strict";

/* Anmeldung – OAuth2 Authorization Code Flow mit PKCE (ohne MSAL),
   übernommen aus „Rund um den Job“ und um einen Punkt erweitert:

   Diese App braucht Token für ZWEI Zielgruppen (Audiences):
     1. Microsoft Graph   – wer ist angemeldet, welche Rolle
     2. der eigene Broker – api://<clientId>/Berichte.Lesen

   Entra lässt pro Anmelde-Redirect nur EINE Zielgruppe zu. Deshalb wird beim
   Anmelden zusätzlich `offline_access` angefordert; das dabei ausgestellte
   Aktualisierungs-Token wird anschließend gegen Token für die jeweils andere
   Zielgruppe eingetauscht. Genau so arbeitet auch MSAL.

   Ablauf beim Seitenstart:
     1. Passendes Token im Speicher?          -> sofort weiter
     2. Sonst stiller SSO-Versuch (prompt=none) über einen Redirect
     3. Schlägt der fehl -> automatisch interaktive Anmeldung
     4. Erst wenn auch die fehlschlägt -> Schaltfläche                       */

const AUTH = (() => {

  const C   = PBI_CONFIG;
  const TID = C.tenantId;
  const CID = C.clientId;
  const AU  = `https://login.microsoftonline.com/${TID}/oauth2/v2.0/authorize`;
  const TU  = `https://login.microsoftonline.com/${TID}/oauth2/v2.0/token`;

  // Immer mitgeforderte Bereiche. `offline_access` ist die Voraussetzung für
  // den Zielgruppenwechsel weiter unten.
  const BASIS = ["openid", "profile", "offline_access"];

  /** Redirect-URI aus der aufgerufenen Adresse ableiten, damit dieselbe
   *  Auslieferung unter mehreren Hosts funktioniert (github.io und später
   *  eine eigene Domäne). „index.html“ wird abgeschnitten, ein Schrägstrich
   *  am Ende erzwungen – sonst passt die Adresse nicht zur Registrierung in
   *  Entra und die Anmeldung bricht mit AADSTS50011 ab. */
  const RURI = (() => {
    let p = location.pathname.replace(/index\.html?$/i, "");
    if (!p.endsWith("/")) p += "/";
    return location.origin + p;
  })();

  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: k => { try { sessionStorage.removeItem(k); } catch {} }
  };

  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  async function mkPKCE() {
    const v = b64(crypto.getRandomValues(new Uint8Array(32)));
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    return { v, c: b64(d) };
  }

  /* ── Tokenspeicher, getrennt nach Zielgruppe ─────────────────────── */

  const TOK_KEY = "pbi_tok";
  const RT_KEY  = "pbi_rt";

  /** Ein Satz Bereiche -> stabiler Schlüssel im Speicher. */
  const schluessel = scopes => [...scopes].map(s => String(s).toLowerCase()).sort().join(" ");

  let _toks = {};   // Schlüssel -> { t: Zugriffstoken, exp: Ablauf in ms }
  try { _toks = JSON.parse(ss.get(TOK_KEY) || "{}") || {}; } catch { _toks = {}; }

  const tokSpeichern = () => ss.set(TOK_KEY, JSON.stringify(_toks));

  function tokAusSpeicher(k) {
    const e = _toks[k];
    // 60 s Sicherheitspuffer vor Ablauf
    if (e && Date.now() < e.exp - 60000) return e.t;
    return null;
  }

  const rtLesen  = () => ss.get(RT_KEY);
  const rtSetzen = v => { if (v) ss.set(RT_KEY, v); };

  /** Nutzlast eines Tokens auslesen (nur zur Anzeige/Diagnose – die Signatur
   *  prüfen die Dienste, nicht der Browser). */
  function claims(token) {
    if (!token) return null;
    try {
      const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(atob(p + "=".repeat((4 - p.length % 4) % 4))
        .split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
      return JSON.parse(json);
    } catch { return null; }
  }

  /* ── Zielgruppenwechsel über das Aktualisierungs-Token ─────────────
     Entra gibt bei jedem Einlösen ein neues Aktualisierungs-Token aus und
     verwirft das alte. Zwei gleichzeitige Einlösungen würden sich deshalb
     gegenseitig ungültig machen – darum laufen sie hier hintereinander. */

  let _kette = Promise.resolve();
  const nacheinander = fn => (_kette = _kette.then(fn, fn));

  async function einloesen(scopes) {
    const rt = rtLesen();
    if (!rt) return { fehler: "kein_refresh" };
    const r = await fetch(TU, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CID,
        grant_type: "refresh_token",
        refresh_token: rt,
        scope: [...new Set([...scopes, ...BASIS])].join(" ")
      }).toString()
    });
    const d = await r.json().catch(() => ({ error: "unlesbar" }));
    if (d.error) return { fehler: d.error, text: d.error_description || d.error };
    rtSetzen(d.refresh_token);
    _toks[schluessel(scopes)] = {
      t: d.access_token,
      exp: Date.now() + (d.expires_in || 3600) * 1000
    };
    tokSpeichern();
    return { token: d.access_token };
  }

  /** Fehler, die nur eine erneute Anmeldung mit Zustimmung lösen kann. */
  const brauchtAnmeldung = f =>
    ["kein_refresh", "invalid_grant", "interaction_required", "consent_required",
     "login_required"].includes(f);

  /** Zugriffstoken für einen Satz Bereiche. Holt es bei Bedarf über das
   *  Aktualisierungs-Token; ist auch das nicht möglich, wird die Anmeldung
   *  für genau diese Zielgruppe neu gestartet (Redirect).
   *  @param {string[]} [scopes] Standard: die Graph-Bereiche aus der Konfiguration
   *  @returns {Promise<string>} */
  async function getToken(scopes) {
    const s = scopes && scopes.length ? scopes : C.scopes;
    const k = schluessel(s);
    const vorhanden = tokAusSpeicher(k);
    if (vorhanden) return vorhanden;

    const r = await nacheinander(async () => {
      // Während des Wartens kann ein anderer Aufruf es schon geholt haben.
      const nochmal = tokAusSpeicher(k);
      if (nochmal) return { token: nochmal };
      return einloesen(s);
    });

    if (r && r.token) return r.token;
    if (r && brauchtAnmeldung(r.fehler)) {
      await startLogin("none", s);
      throw new Error("Anmeldung wird erneuert");
    }
    throw new Error((r && r.text) || "Token konnte nicht geholt werden");
  }

  /** Token für den eigenen Broker. */
  const getApiToken = () => getToken([C.apiScope]);

  /* ── Anmelde-Redirect ─────────────────────────────────────────────── */

  /** @param {"none"|"select_account"|"consent"} promptMode
   *  @param {string[]} [scopes] Zielgruppe dieser Anmeldung (Standard: Graph) */
  async function startLogin(promptMode, scopes) {
    const s = scopes && scopes.length ? scopes : C.scopes;
    const { v, c } = await mkPKCE();
    const state = b64(crypto.getRandomValues(new Uint8Array(16)));
    ss.set("pbi_pv", v);
    ss.set("pbi_ps", state);
    ss.set("pbi_pm", promptMode);
    ss.set("pbi_pc", JSON.stringify(s));
    const p = new URLSearchParams({
      client_id: CID,
      response_type: "code",
      redirect_uri: RURI,
      scope: [...new Set([...s, ...BASIS])].join(" "),
      state,
      code_challenge: c,
      code_challenge_method: "S256",
      prompt: promptMode
    });
    location.href = AU + "?" + p.toString();
  }

  /** Rückkehr vom Anmelde-Redirect auswerten.
   *  @returns {Promise<"ok"|"none"|"redirecting"|{error:string}>} */
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    const code = p.get("code");
    const err  = p.get("error");
    const still = ss.get("pbi_pm") === "none";
    let scopes = C.scopes;
    try { scopes = JSON.parse(ss.get("pbi_pc") || "null") || C.scopes; } catch {}

    const aufraeumen = () => {
      history.replaceState({}, document.title, location.pathname);
      ss.del("pbi_pv"); ss.del("pbi_ps"); ss.del("pbi_pm"); ss.del("pbi_pc");
    };

    if (err) {
      const beschreibung = p.get("error_description") || err;
      aufraeumen();
      // Stiller Versuch gescheitert -> interaktiv nachlegen, gleiche Zielgruppe.
      if (still) { await startLogin("select_account", scopes); return "redirecting"; }
      return { error: beschreibung };
    }

    if (!code) return "none";

    if (p.get("state") !== ss.get("pbi_ps")) {
      aufraeumen();
      return { error: "Ungültiger State – bitte die Seite neu laden." };
    }
    const v = ss.get("pbi_pv");
    if (!v) {
      aufraeumen();
      return { error: "PKCE-Verifier fehlt – bitte die Seite neu laden." };
    }

    const r = await fetch(TU, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CID,
        grant_type: "authorization_code",
        code,
        redirect_uri: RURI,
        code_verifier: v
      }).toString()
    });
    const d = await r.json().catch(() => ({ error: "Antwort nicht lesbar" }));
    aufraeumen();

    if (d.error) {
      if (still) { await startLogin("select_account", scopes); return "redirecting"; }
      return { error: d.error_description || d.error };
    }

    rtSetzen(d.refresh_token);
    _toks[schluessel(scopes)] = {
      t: d.access_token,
      exp: Date.now() + (d.expires_in || 3600) * 1000
    };
    tokSpeichern();
    return "ok";
  }

  /** Kompletter Anmelde-Ablauf beim Seitenstart.
   *  @returns {Promise<"ok"|"redirecting"|{error:string}>} */
  async function signIn() {
    if (location.search.includes("code=") || location.search.includes("error=")) {
      const r = await handleRedirect();
      if (r !== "none") return r;
    }
    if (tokAusSpeicher(schluessel(C.scopes)) || rtLesen()) return "ok";
    await startLogin("none");
    return "redirecting";
  }

  /** Angemeldete Person aus dem Token – ohne Graph-Aufruf. */
  function wer() {
    const t = tokAusSpeicher(schluessel(C.scopes))
           || Object.values(_toks).map(e => e.t)[0];
    const c = claims(t);
    if (!c) return null;
    return {
      email: String(c.upn || c.preferred_username || c.unique_name || "").toLowerCase(),
      name: c.name || "",
      tenant: c.tid || "",
      scopes: String(c.scp || "").split(" ").filter(Boolean),
      exp: c.exp ? new Date(c.exp * 1000) : null
    };
  }

  /** Übersicht aller vorhandenen Token – für den Diagnosebereich. */
  const tokenUebersicht = () => Object.entries(_toks).map(([k, e]) => ({
    zielgruppe: k,
    laeuftAb: new Date(e.exp),
    gueltig: Date.now() < e.exp - 60000
  }));

  function logout() {
    try { sessionStorage.clear(); } catch {}
    _toks = {};
    location.href = `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout`
      + `?post_logout_redirect_uri=${encodeURIComponent(RURI)}`;
  }

  return { signIn, startLogin, getToken, getApiToken, wer, claims,
           tokenUebersicht, logout, redirectUri: RURI };
})();
