"use strict";

/* Token-Broker – die einzige Stelle, an der das Geheimnis des Dienstusers
   liegt. Endpunkte:

     GET     /api/health       Lebenszeichen, ohne Anmeldung
     GET     /api/embed-token  Einbettungs-Token für einen freigegebenen Bericht
     GET     /api/zugriff      Was darf ich sehen, bin ich Administrator?
     GET/PUT /api/rechte       Zugriffsregeln lesen und ersetzen (Administratoren)
     GET     /api/berichte     Was der Dienstuser sieht (Administratoren)

   Grundregeln:
     - Aufrufer müssen ein gültiges Entra-Token dieses Mandanten für die
       Zielgruppe der Frontend-Registrierung vorlegen.
     - Es gibt Token NUR für Berichte aus PBI_BERICHTE. Arbeitsbereichs- und
       Bericht-IDs kommen niemals vom Aufrufer, sondern immer aus dieser
       Freigabeliste – sonst könnte man sich über die Entwicklerkonsole ein
       Token für einen beliebigen Bericht des Dienstusers ausstellen lassen.
     - Zusätzlich muss eine Zugriffsregel greifen (Benutzer, Gruppe oder
       Domäne). Diese Prüfung gehört hierher und nicht ins Frontend: dort
       wäre sie nur Anzeige, hier ist sie verbindlich.
     - Ausgegeben wird ausschließlich lesender Zugriff (allowEdit: false).   */

const { app } = require("@azure/functions");
const { pruefe, TokenFehler } = require("../lib/entra");
const PBI = require("../lib/powerbi");
const RECHTE = require("../lib/rechte");
const SPEICHER = require("../lib/speicher");

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
   Zwei Stellen, und beide werden gebraucht – nachgemessen:

   1. Die **Plattform-CORS-Liste** der Function App muss die Adressen des
      Frontends enthalten. Der Functions-Host beantwortet `OPTIONS` selbst
      und lässt die Vorabfrage gar nicht bis hierher durch; ist seine Liste
      leer, antwortet er 204 ganz ohne Kopfzeilen und der Browser bricht ab,
      bevor die eigentliche Anfrage überhaupt gestellt wird.
   2. `ALLOWED_ORIGINS` hier, für die echten Antworten.

   Die Kopfzeilen doppeln sich dabei nicht: die Plattform setzt sie nur auf
   der Vorabfrage, dieser Code nur auf den übrigen Antworten.             */

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
    h["Access-Control-Allow-Methods"] = "GET,PUT,OPTIONS";
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

/** Was diese Person darf – aus den gespeicherten Regeln.
 *  Solange noch keine Regel existiert, gilt die bisherige Regelung über
 *  ERLAUBTE_DOMAENEN (siehe rechte.js), damit die Umstellung niemanden
 *  aussperrt. */
async function zugriffFuer(wer) {
  const regeln = await SPEICHER.lesen();
  return RECHTE.auswerten(regeln, wer, {
    hauptAdmins: liste(process.env.ADMIN_UPNS),
    standardDomaenen: liste(process.env.ERLAUBTE_DOMAENEN)
  });
}

/** Aufrufer prüfen und zusätzlich verlangen, dass er die Regeln verwalten darf. */
async function verwalter(request) {
  const wer = await aufrufer(request);
  const z = await zugriffFuer(wer);
  if (!z.admin) {
    const e = new Error("Diese Ansicht ist Administratoren vorbehalten");
    e.status = 403;
    e.art = "kein_admin";
    throw e;
  }
  return { wer, zugriff: z };
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
      regeln: await SPEICHER.lesen().then(r => r.length).catch(() => null),
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

      // Zweite Hürde nach der Freigabeliste: Darf genau diese Person diesen
      // Bericht sehen? Das entscheidet sich hier und nicht im Frontend – sonst
      // käme jeder mit der Entwicklerkonsole an jeden freigegebenen Bericht.
      const z = await zugriffFuer(wer);
      if (!RECHTE.darfBericht(z, key)) {
        const e = new Error("Für diesen Bericht ist kein Zugriff freigegeben");
        e.status = 403;
        e.art = "keine_freigabe";
        if (wer.gruppenUeberlauf) {
          e.detail = "Der Gruppenanspruch fehlt im Token (zu viele "
            + "Mitgliedschaften) – gruppenbasierte Regeln greifen nicht.";
        }
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
      await verwalter(request);

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

/* ── /api/zugriff ─────────────────────────────────────────────────────
   Was darf ich sehen? Das Frontend baut daraus seine Reiterleiste und
   entscheidet, ob es den Einstellungsbereich anzeigt. Verbindlich ist die
   Prüfung in /api/embed-token – das hier ist die Anzeigeseite davon.     */

app.http("zugriff", {
  route: "zugriff",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return vorabfrage(request);
    try {
      const wer = await aufrufer(request);
      const z = await zugriffFuer(wer);
      const alle = freigaben().map(b => b.key);
      return antwort(request, 200, {
        upn: wer.upn,
        name: wer.name,
        admin: z.admin,
        quelle: z.quelle,
        berichte: RECHTE.sichtbareBerichte(z, alle),
        gruppen: wer.gruppen.length,
        gruppenUeberlauf: wer.gruppenUeberlauf
      });
    } catch (e) {
      return fehlerAntwort(request, e, context);
    }
  }
});

/* ── /api/rechte ──────────────────────────────────────────────────────
   GET  liefert alle Regeln, PUT ersetzt sie vollständig. Ein vollständiger
   Austausch statt einzelner Vorgänge: die Regelmenge ist klein, und so kann
   die Oberfläche nicht aus Versehen einen halben Stand hinterlassen.      */

app.http("rechte", {
  route: "rechte",
  methods: ["GET", "PUT", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return vorabfrage(request);
    try {
      const { wer } = await verwalter(request);

      if (request.method === "GET") {
        return antwort(request, 200, {
          regeln: await SPEICHER.lesen(true),
          berichte: freigaben().map(b => b.key),
          hauptAdmins: liste(process.env.ADMIN_UPNS),
          standardDomaenen: liste(process.env.ERLAUBTE_DOMAENEN)
        });
      }

      const koerper = await request.json().catch(() => null);
      if (!koerper || !Array.isArray(koerper.regeln)) {
        const e = new Error("Es wurde keine Regelliste mitgeschickt");
        e.status = 400;
        e.art = "eingabe";
        throw e;
      }

      const bekannt = new Set(freigaben().map(b => b.key));
      const geprueft = koerper.regeln.map((r, i) => {
        const n = RECHTE.normalisiere(r, i);
        const unbekannt = n.berichte.filter(b => b !== "*" && !bekannt.has(b));
        if (unbekannt.length) {
          const e = new Error(`Regel ${i + 1}: unbekannter Bericht `
            + `„${unbekannt.join(", ")}“ – erlaubt sind: ${[...bekannt].join(", ")} oder *`);
          e.status = 400;
          e.art = "eingabe";
          throw e;
        }
        return n;
      });

      // Sich selbst die Verwaltung zu entziehen ist fast immer ein Versehen.
      // Haupt-Administratoren aus der Umgebung bleiben ohnehin handlungsfähig.
      const hauptAdmins = liste(process.env.ADMIN_UPNS);
      if (!hauptAdmins.includes(wer.upn)) {
        const nachher = RECHTE.auswerten(geprueft, wer, { hauptAdmins });
        if (!nachher.admin) {
          const e = new Error("Mit diesen Regeln würden Sie sich selbst die "
            + "Verwaltung entziehen. Bitte eine Regel behalten, die Ihnen "
            + "„darf verwalten“ gibt.");
          e.status = 400;
          e.art = "aussperrung";
          throw e;
        }
      }

      const gespeichert = await SPEICHER.schreiben(geprueft, wer.upn);
      context.log(`Regeln gespeichert von ${wer.upn}: ${gespeichert.length}`);
      return antwort(request, 200, { regeln: gespeichert });
    } catch (e) {
      // Fehler aus normalisiere() sind Eingabefehler, keine Serverfehler.
      if (!e.status && e instanceof Error) { e.status = 400; e.art = "eingabe"; }
      return fehlerAntwort(request, e, context);
    }
  }
});
