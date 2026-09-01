"use strict";

/* Microsoft-Graph-Helfer – bewusst schlank.

   Diese App liest über Graph nur zwei Dinge:
     1. das eigene Profil (/me)
     2. optional die zentrale Rechteliste `AppPermissions` auf SharePoint

   Punkt 2 ist abschaltbar: steht in der Konfiguration kein `permList`, wird
   Graph gar nicht für SharePoint benutzt und die App kommt mit dem Bereich
   `User.Read` aus – der braucht keine Administratorzustimmung.            */

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

  const _cache = { siteIds: {}, listIds: {} };

  /** @returns {Promise<string|null>} null, wenn die Site nicht lesbar ist */
  async function siteId(pfad) {
    if (_cache.siteIds[pfad]) return _cache.siteIds[pfad];
    try {
      const s = await call("/sites/" + pfad);
      _cache.siteIds[pfad] = s.id;
      return s.id;
    } catch { return null; }
  }

  /** @returns {Promise<string|null>} null, wenn die Liste fehlt */
  async function listId(sid, name) {
    const k = sid + "|" + name;
    if (_cache.listIds[k]) return _cache.listIds[k];
    try {
      const l = await call(`/sites/${sid}/lists/${encodeURIComponent(name)}`);
      _cache.listIds[k] = l.id;
      return l.id;
    } catch { return null; }
  }

  /** Alle Einträge einer Liste als flache Objekte (nur die Felder). */
  async function listItems(sid, lid) {
    const rows = await callAll(
      `/sites/${sid}/lists/${lid}/items?expand=fields&$top=999`);
    return rows.map(r => ({ id: r.id, ...(r.fields || {}) }));
  }

  return { call, callAll, siteId, listId, listItems };
})();
