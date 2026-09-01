"use strict";

/* Zugriff auf Power BI als Dienstuser (Dienstprinzipal).

   Der Dienstuser ist Mitglied des Arbeitsbereichs; die Betrachter sind es
   nicht und müssen es auch nicht sein. Für jede Anzeige erzeugt Power BI hier
   ein kurzlebiges Einbettungs-Token mit accessLevel "View".

   Voraussetzungen im Mandanten (Power-BI-Administrationsportal):
     - „Dienstprinzipale dürfen Power-BI-APIs verwenden“  aktiv
     - „Inhalte in Apps einbetten“                        aktiv
     - Dienstuser als Mitglied/Administrator im Arbeitsbereich
   Für den Dauerbetrieb zusätzlich: der Arbeitsbereich liegt auf einer
   Kapazität (F/A/EM/P). Ohne Kapazität stellt Microsoft nur eine begrenzte
   Zahl kostenloser Test-Token aus.                                          */

const API = "https://api.powerbi.com/v1.0/myorg";

let _tok = { wert: null, exp: 0 };

/** Token des Dienstusers (client_credentials), zwischengespeichert. */
async function appToken(cfg) {
  if (_tok.wert && Date.now() < _tok.exp - 5 * 60000) return _tok.wert;
  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: "https://analysis.windows.net/powerbi/api/.default",
        grant_type: "client_credentials"
      }).toString()
    });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    const e = new Error("Anmeldung des Dienstusers fehlgeschlagen: "
      + (d.error_description || d.error || res.statusText));
    e.art = "dienstuser";
    e.status = 500;
    throw e;
  }
  _tok = { wert: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return _tok.wert;
}

async function pbi(cfg, pfad, opts = {}) {
  const token = await appToken(cfg);
  const res = await fetch(API + pfad, {
    ...opts,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch { /* Power BI antwortet nicht immer JSON */ }
  if (!res.ok) {
    const msg = d?.error?.message || d?.error?.code || text || res.statusText;
    const e = new Error(`Power BI: ${msg}`);
    e.status = res.status === 401 || res.status === 403 ? 502 : 502;
    e.art = "powerbi";
    e.detail = `${opts.method || "GET"} ${pfad} -> HTTP ${res.status}`;
    throw e;
  }
  return d;
}

/** Stammdaten eines Berichts (u. a. embedUrl und datasetId). */
const bericht = (cfg, workspaceId, reportId) =>
  pbi(cfg, `/groups/${workspaceId}/reports/${reportId}`);

/** Einbettungs-Token, ausschließlich lesend. */
const einbettungsToken = (cfg, workspaceId, reportId) =>
  pbi(cfg, `/groups/${workspaceId}/reports/${reportId}/GenerateToken`, {
    method: "POST",
    body: JSON.stringify({ accessLevel: "View" })
  });

/** Alle Arbeitsbereiche und Berichte, die der Dienstuser sieht –
 *  Hilfe für die Einrichtung (Diagnosebereich der App). */
async function alleBerichte(cfg) {
  const gruppen = await pbi(cfg, "/groups");
  const out = [];
  for (const g of (gruppen?.value || [])) {
    let r = null;
    try { r = await pbi(cfg, `/groups/${g.id}/reports`); }
    catch { continue; }   // einzelner Arbeitsbereich ohne Leserecht
    for (const b of (r?.value || [])) {
      out.push({
        arbeitsbereich: g.name,
        workspaceId: g.id,
        name: b.name,
        reportId: b.id
      });
    }
  }
  return out;
}

module.exports = { bericht, einbettungsToken, alleBerichte, appToken };
