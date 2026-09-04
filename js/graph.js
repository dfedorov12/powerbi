"use strict";

/* Microsoft-Graph-Helfer – bewusst schlank.

   Diese App liest über Graph nur zwei Dinge:
     1. das eigene Profil (/me) für die Kopfzeile
     2. die eigenen Gruppen – als Auswahlhilfe im Einstellungsbereich

   Beides kommt mit dem Bereich `User.Read` aus, der keine
   Administratorzustimmung braucht. Die Rechte selbst liegen im Broker.    */

const GRAPH = (() => {

  const BASE = "https://graph.microsoft.com/v1.0";

  async function call(path, opts = {}) {
    const token = await AUTH.getToken();
    const url = path.startsWith("https://") ? path : BASE + path;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(opts.headers || {})
      }
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText || String(res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = data?.error?.code;
      err.detail = `${opts.method || "GET"} ${path.replace(BASE, "")} -> HTTP ${res.status}`
        + (err.code ? ` ${err.code}` : "") + `: ${msg}`;
      throw err;
    }
    return data;
  }

  /** Alle Seiten einer Collection einsammeln (@odata.nextLink). */
  async function callAll(path) {
    let out = [];
    let next = path;
    while (next) {
      const d = await call(next);
      out = out.concat(d?.value || []);
      next = d?.["@odata.nextLink"] || null;
    }
    return out;
  }

  /** Eigene Gruppen als Auswahlhilfe für den Einstellungsbereich.
   *
   *  `/me/getMemberGroups` mit `securityEnabledOnly: false` liefert **alle**
   *  Gruppentypen transitiv – Sicherheits-, Microsoft-365-, Verteiler- und
   *  dynamische Gruppen – und kommt mit `User.Read` aus. Es liefert allerdings
   *  nur Objekt-Ids. Die Namen holt `/me/memberOf`; schlägt das mangels
   *  Berechtigung fehl, bleiben die Ids, und die Oberfläche sagt das auch.
   *
   *  @returns {Promise<{id:string,name:string,art:string}[]>} */
  async function meineGruppen() {
    const ids = new Set();
    try {
      const r = await call("/me/getMemberGroups", {
        method: "POST",
        body: JSON.stringify({ securityEnabledOnly: false })
      });
      (r?.value || []).forEach(g => ids.add(String(g).toLowerCase()));
    } catch (e) {
      const err = new Error("Gruppen konnten nicht gelesen werden: " + e.message);
      err.status = e.status;
      throw err;
    }

    const namen = new Map();
    try {
      const roh = await callAll("/me/memberOf?$select=id,displayName,mail,"
        + "groupTypes,securityEnabled,mailEnabled&$top=999");
      for (const g of roh) {
        if (!g.id) continue;
        namen.set(String(g.id).toLowerCase(), {
          name: g.displayName || "",
          art: (g.groupTypes || []).includes("Unified") ? "Microsoft 365"
             : (g.securityEnabled && !g.mailEnabled) ? "Sicherheitsgruppe"
             : (g.mailEnabled && !g.securityEnabled) ? "Verteilergruppe"
             : g.securityEnabled ? "Sicherheitsgruppe" : "Gruppe"
        });
      }
    } catch { /* nur die Namen fehlen dann */ }

    return [...ids].map(id => ({
      id,
      name: namen.get(id)?.name || "",
      art: namen.get(id)?.art || ""
    })).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "de"));
  }

  return { call, callAll, meineGruppen };
})();
