"use strict";

/* Token-Broker – die einzige Stelle, an der das Geheimnis des Dienstusers
   liegt. Drei Endpunkte:

     GET /api/health        Lebenszeichen, ohne Anmeldung
     GET /api/embed-token   Einbettungs-Token für einen freigegebenen Bericht
     GET /api/berichte      Was der Dienstuser sieht (nur Administratoren)

   Grundregeln:
     - Aufrufer müssen ein gültiges Entra-Token dieses Mandanten für die
       Zielgruppe der Frontend-Registrierung vorlegen.
     - Es gibt Token NUR für Berichte aus PBI_BERICHTE. Arbeitsbereichs- und
       Bericht-IDs kommen niemals vom Aufrufer, sondern immer aus dieser
       Freigabeliste – sonst könnte man sich über die Entwicklerkonsole ein
       Token für einen beliebigen Bericht des Dienstusers ausstellen lassen.
     - Ausgegeben wird ausschließlich accessLevel "View".                    */

const { app } = require("@azure/functions");
const { pruefe, TokenFehler } = require("../lib/entra");
const PBI = require("../lib/powerbi");

/* ── Einstellungen aus der Umgebung ───────────────────────────────── */

const cfg = () => ({
  tenantId:     process.env.PBI_TENANT_ID || "",
  clientId:     process.env.PBI_CLIENT_ID || "",
  clientSecret: process.env.PBI_CLIENT_SECRET || ""
});

const frontendCfg = () => ({
  tenantId: process.env.PBI_TENANT_ID || "",
  clientId: process.env.FRONTEND_CLIENT_ID || "",
  scope:    process.env.FRONTEND_SCOPE || "Berichte.Lesen"
});

/** Freigabeliste: [{ key, workspaceId, reportId }] */
function freigaben() {
  try { return JSON.parse(process.env.PBI_BERICHTE || "[]"); }
  catch { return []; }
}

const liste = v => String(v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

/* ── CORS ─────────────────────────────────────────────────────────────
   Die Function-App-Einstellung „CORS“ im Portal bleibt leer, sonst kämen
   die Kopfzeilen doppelt. ALLOWED_ORIGINS enthält die Adressen des
   Frontends, z. B. https://dfedorov12.github.io                         */

function corsKopf(request) {
  const erlaubt = liste(process.env.ALLOWED_ORIGINS);
  const herkunft = request.headers.get("origin") || "";
  const h = {
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
  if (herkunft && (erlaubt.includes("*") || erlaubt.includes(herkunft.toLowerCase()))) {
    h["Access-Control-Allow-Origin"] = herkunft;
    h["Access-Control-Allow-Headers"] = "authorization,content-type";
    h["Access-Control-Allow-Methods"] = "GET,OPTIONS";
    h["Access-Control-Max-Age"] = "3600";
  }
  return h;
}

const antwort = (request, status, koerper) => ({
  status,
  headers: { ...corsKopf(request), "Content-Type": "application/json; charset=utf-8" },
  jsonBody: koerper
});

const vorabfrage = request => ({ status: 204, headers: corsKopf(request) });

/** Aufrufer prüfen; wirft TokenFehler (401) oder liefert die Angaben. */
async function aufrufer(request) {
  const f = frontendCfg();
  if (!f.clientId) {
    const e = new TokenFehler("FRONTEND_CLIENT_ID ist nicht gesetzt", "einrichtung");
    e.status = 500;
    throw e;
  }
  const wer = await pruefe(request.headers.get("authorization"), f);

  const domaenen = liste(process.env.ERLAUBTE_DOMAENEN);
  if (domaenen.length) {
    const d = wer.upn.split("@").pop();
    if (!domaenen.includes(d)) {
      const e = new TokenFehler("Diese Domäne ist nicht freigegeben", "domaene");
      e.status = 403;
      throw e;
    }
  }
  return wer;
}

function fehlerAntwort(request, e, context) {
  const status = e.status || 500;
  if (status >= 500) context.error(e.message, e.detail || "");
  else context.warn(e.message);
  return antwort(request, status, {
    fehler: e.message,
    art: e.art || "fehler",
    detail: e.detail || ""
  });
}

/* ── /api/health ──────────────────────────────────────────────────── */

app.http("health", {
  route: "health",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async request => {
    if (request.method === "OPTIONS") return vorabfrage(request);
    const c = cfg();
    return antwort(request, 200, {
      status: "ok",
      eingerichtet: Boolean(c.tenantId && c.clientId && c.clientSecret
        && frontendCfg().clientId),
      berichte: freigaben().map(b => b.key),
      zeit: new Date().toISOString()
    });
  }
});

/* ── /api/embed-token?bericht=<key> ───────────────────────────────── */

app.http("embedToken", {
  route: "embed-token",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return vorabfrage(request);
    try {
      const wer = await aufrufer(request);

      const key = request.query.get("bericht") || "";
      const frei = freigaben().find(b => b.key === key);
      if (!frei) {
        const e = new Error("Unbekannter Bericht: " + key);
        e.status = 404;
        e.art = "unbekannter_bericht";
        throw e;
      }

      const c = cfg();
      // Der Bericht liefert embedUrl und die Id des Semantikmodells. Letztere
      // braucht der V2-Token – das Modell kann in einem anderen Arbeitsbereich
      // liegen als der Bericht.
      const b = await PBI.bericht(c, frei.workspaceId, frei.reportId);
      const t = await PBI.einbettungsToken(c, frei.workspaceId, frei.reportId, b.datasetId);

      context.log(`Einbettungs-Token für ${key} an ${wer.upn}`);

      return antwort(request, 200, {
        key,
        name: b.name,
        reportId: b.id,
        embedUrl: b.embedUrl,
        token: t.token,
        expiration: t.expiration
      });
    } catch (e) {
      return fehlerAntwort(request, e, context);
    }
  }
});

/* ── /api/berichte ────────────────────────────────────────────────── */

app.http("berichte", {
  route: "berichte",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return vorabfrage(request);
    try {
      const wer = await aufrufer(request);
      const admins = liste(process.env.ADMIN_UPNS);
      if (!admins.includes(wer.upn)) {
        const e = new Error("Diese Übersicht ist Administratoren vorbehalten");
        e.status = 403;
        e.art = "kein_admin";
        throw e;
      }

      const alle = await PBI.alleBerichte(cfg());
      const frei = freigaben();
      const mitSchluessel = alle.map(r => ({
        ...r,
        key: frei.find(f => f.workspaceId === r.workspaceId && f.reportId === r.reportId)?.key || ""
      }));

      return antwort(request, 200, { berichte: mitSchluessel });
    } catch (e) {
      return fehlerAntwort(request, e, context);
    }
  }
});
