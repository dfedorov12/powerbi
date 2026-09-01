"use strict";

/* Benutzerkontext, Rolle und Sichtbarkeit der Berichte.

   Wichtig zur Einordnung: Diese Ebene entscheidet nur, WAS jemand in der
   Oberfläche angeboten bekommt. Die verbindliche Prüfung passiert im Broker –
   er gibt ein Einbettungs-Token nur für Berichte aus seiner eigenen Freigabe-
   liste heraus und nur an Aufrufer mit gültigem Token dieses Tenants. Ein
   manipuliertes Frontend kommt damit an keinen zusätzlichen Bericht.        */

const DATA = (() => {

  const C = PBI_CONFIG;
  const RANK = { none: 0, viewer: 1, editor: 2, admin: 3 };

  /** @type {{email:string,name:string,domain:string,role:string}} */
  const ctx = { email: "", name: "", domain: "", role: C.defaultRole };

  const domainOf = addr => {
    const s = String(addr || "").toLowerCase().trim();
    const i = s.lastIndexOf("@");
    return i < 0 ? "" : s.slice(i + 1);
  };

  /** "a.de; b.de , *" -> ["a.de","b.de","*"] */
  const parseList = v => String(v || "")
    .split(/[;,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);

  const isHauptAdmin = mail =>
    (C.hauptAdmins || []).map(s => String(s).toLowerCase())
      .includes(String(mail || "").toLowerCase());

  /** Woher die Rolle stammt – beantwortet „warum sehe ich nur das?“
   *  ohne im Code zu suchen. Wird im Diagnosebereich angezeigt. */
  const roleInfo = { quelle: "standard", fehler: null, zeilen: 0, treffer: 0 };

  /* ── Benutzer + Rolle ────────────────────────────────────────────── */

  async function loadUser() {
    // Name und Adresse stehen bereits im Token – ein Graph-Aufruf ist dafür
    // nicht nötig. /me liefert zusätzlich Abteilung/Gesellschaft und dient
    // gleichzeitig als Probe, ob das Token wirklich trägt.
    const t = AUTH.wer() || {};
    ctx.email = t.email || "";
    ctx.name  = t.name || ctx.email;

    try {
      const me = await GRAPH.call("/me?$select=displayName,mail,userPrincipalName,"
        + "jobTitle,department,companyName");
      ctx.email = String(me.mail || me.userPrincipalName || ctx.email).toLowerCase();
      ctx.name  = me.displayName || ctx.name;
      ctx.abteilung = me.department || "";
      ctx.gesellschaft = me.companyName || "";
    } catch (e) {
      // Nicht schlimm: die Anzeige fällt auf die Token-Angaben zurück.
      roleInfo.fehler = roleInfo.fehler || ("Profil nicht lesbar: " + e.message);
    }

    ctx.domain = domainOf(ctx.email);
    ctx.role   = await loadRole();
    return ctx;
  }

  /** Rolle aus der zentralen Liste `AppPermissions` – genau wie in den
   *  übrigen DIHAG-Apps. Ist keine Liste konfiguriert oder ist sie nicht
   *  lesbar, gilt die Standardrolle; die Seite funktioniert dann trotzdem. */
  async function loadRole() {
    if (isHauptAdmin(ctx.email)) { roleInfo.quelle = "hauptadmin"; return "admin"; }
    if (!C.permList) { roleInfo.quelle = "standard"; return C.defaultRole; }

    try {
      const sid = await GRAPH.siteId(C.permSite);
      if (!sid) throw new Error("Site " + C.permSite + " nicht lesbar");
      const lid = await GRAPH.listId(sid, C.permList);
      if (!lid) throw new Error("Liste " + C.permList + " nicht gefunden");

      const rows = await GRAPH.listItems(sid, lid);
      roleInfo.zeilen = rows.length;

      const meine = rows.filter(r =>
        String(r.Benutzer || r.Email || r.Title || "").toLowerCase() === ctx.email);
      roleInfo.treffer = meine.length;

      const passend = meine.filter(r => {
        const app = String(r.App || "*").toLowerCase();
        return app === "*" || app === String(C.appKey).toLowerCase();
      });

      if (!passend.length) { roleInfo.quelle = "standard"; return C.defaultRole; }

      // Höchste vergebene Rolle gewinnt.
      const beste = passend
        .map(r => String(r.Rolle || r.Role || "").toLowerCase())
        .filter(r => RANK[r] !== undefined)
        .sort((a, b) => RANK[b] - RANK[a])[0];

      roleInfo.quelle = "liste";
      return beste || C.defaultRole;
    } catch (e) {
      roleInfo.quelle = "standard";
      roleInfo.fehler = e.message;
      return C.defaultRole;
    }
  }

  /* ── Sichtbarkeit ────────────────────────────────────────────────── */

  /** Kernstück: Ist dieser Bericht für den aktuellen Nutzer sichtbar?
   *  Exportiert, damit tests/test-sichtbarkeit.mjs dieselbe Logik prüft. */
  function istSichtbar(b, rolle = ctx.role, domain = ctx.domain) {
    if (!b || b.aktiv === false) return false;
    const min = String(b.minRolle || "viewer").toLowerCase();
    if ((RANK[rolle] ?? 0) < (RANK[min] ?? 1)) return false;
    const doms = parseList(b.domains);
    if (!doms.length || doms.includes("*")) return true;
    return doms.includes(String(domain || "").toLowerCase());
  }

  const sichtbareBerichte = () => (C.berichte || [])
    .filter(b => istSichtbar(b))
    .sort((a, b) => (a.reihenfolge ?? 999) - (b.reihenfolge ?? 999)
                 || String(a.name).localeCompare(String(b.name), "de"));

  const istAdmin = () => ctx.role === "admin";

  return { ctx, roleInfo, loadUser, loadRole, istSichtbar, sichtbareBerichte,
           istAdmin, domainOf, parseList };
})();
