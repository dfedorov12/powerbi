"use strict";

/* Benutzerkontext und Sichtbarkeit der Berichte.

   Wer welchen Bericht sehen darf, entscheidet **der Broker**. Diese Ebene
   holt das Ergebnis über /api/zugriff ab und richtet die Oberfläche danach
   aus. Sie ist damit reine Anzeige-Logik – die verbindliche Prüfung passiert
   noch einmal bei jedem Einbettungs-Token. Ein manipuliertes Frontend kommt
   an keinen zusätzlichen Bericht.                                          */

const DATA = (() => {

  const C = PBI_CONFIG;

  /** @type {{email:string,name:string,domain:string,abteilung:string,
   *          gesellschaft:string,admin:boolean,erlaubt:string[],
   *          quelle:string,gruppen:number,gruppenUeberlauf:boolean}} */
  const ctx = {
    email: "", name: "", domain: "", abteilung: "", gesellschaft: "",
    admin: false, erlaubt: [], quelle: "", gruppen: 0, gruppenUeberlauf: false
  };

  /** Protokoll der Zugriffsermittlung – beantwortet „warum sehe ich nichts?“
   *  ohne im Code zu suchen. Wird im Diagnosebereich angezeigt. */
  const info = { fehler: null, geladen: false };

  const domainOf = addr => {
    const s = String(addr || "").toLowerCase().trim();
    const i = s.lastIndexOf("@");
    return i < 0 ? "" : s.slice(i + 1);
  };

  async function loadUser() {
    // Name und Adresse stehen bereits im Token – dafür braucht es Graph nicht.
    const t = AUTH.wer() || {};
    ctx.email = t.email || "";
    ctx.name  = t.name || ctx.email;

    // /me liefert zusätzlich Abteilung und Gesellschaft für die Kopfzeile und
    // ist zugleich die Probe, ob das Graph-Token trägt.
    try {
      const me = await GRAPH.call("/me?$select=displayName,mail,userPrincipalName,"
        + "jobTitle,department,companyName");
      ctx.email = String(me.mail || me.userPrincipalName || ctx.email).toLowerCase();
      ctx.name  = me.displayName || ctx.name;
      ctx.abteilung = me.department || "";
      ctx.gesellschaft = me.companyName || "";
    } catch (e) {
      info.fehler = "Profil nicht lesbar: " + e.message;
    }
    ctx.domain = domainOf(ctx.email);

    await ladeZugriff();
    return ctx;
  }

  /** Zugriffsrechte beim Broker abholen. */
  async function ladeZugriff() {
    try {
      const z = await EMBED.holeZugriff();
      ctx.admin = z.admin === true;
      ctx.erlaubt = Array.isArray(z.berichte) ? z.berichte : [];
      ctx.quelle = z.quelle || "";
      ctx.gruppen = z.gruppen || 0;
      ctx.gruppenUeberlauf = z.gruppenUeberlauf === true;
      info.geladen = true;
      if (z.upn) ctx.email = z.upn;
    } catch (e) {
      // Ohne Antwort des Brokers wird nichts angezeigt – lieber leer als
      // etwas zeigen, das die Person nicht öffnen kann.
      ctx.admin = false;
      ctx.erlaubt = [];
      ctx.quelle = "fehler";
      info.fehler = e.message;
      throw e;
    }
    return ctx;
  }

  /** Ist dieser Bericht für den aktuellen Nutzer sichtbar?
   *  Exportiert, damit tests/test-sichtbarkeit.mjs dieselbe Logik prüft. */
  function istSichtbar(b, erlaubt = ctx.erlaubt) {
    if (!b || b.aktiv === false) return false;
    return (erlaubt || []).includes(b.key);
  }

  const sichtbareBerichte = () => (C.berichte || [])
    .filter(b => istSichtbar(b))
    .sort((a, b) => (a.reihenfolge ?? 999) - (b.reihenfolge ?? 999)
                 || String(a.name).localeCompare(String(b.name), "de"));

  /** Anzeigename eines Berichtsschlüssels – für die Einstellungen. */
  const nameVon = key =>
    (C.berichte || []).find(b => b.key === key)?.name || key;

  const istAdmin = () => ctx.admin === true;

  return { ctx, info, loadUser, ladeZugriff, istSichtbar, sichtbareBerichte,
           nameVon, istAdmin, domainOf };
})();
