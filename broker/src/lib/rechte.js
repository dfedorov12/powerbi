"use strict";

/* Auswertung der Zugriffsregeln – bewusst ohne Seiteneffekte, damit sie
   vollständig testbar ist. Wer speichert, steht in speicher.js.

   Eine Regel ordnet einem **Prinzipal** Berichte zu:

     typ "benutzer"  wert = E-Mail/UPN            (z. B. fedorov@dihag.com)
     typ "gruppe"    wert = Objekt-Id der Gruppe  (Sicherheits-, Microsoft-365-,
                                                   Verteiler- oder dynamische Gruppe)
     typ "domaene"   wert = E-Mail-Domäne         (z. B. dihag.com)

   `berichte` ist entweder ["*"] oder eine Liste von Schlüsseln aus PBI_BERICHTE.
   `admin: true` erlaubt zusätzlich das Verwalten der Regeln.

   Gruppen werden über die Objekt-Id verglichen, nicht über den Namen: Namen
   ändern sich, Ids nicht – und ein umbenannter Anzeigename darf keine
   Berechtigung still verschieben.                                          */

const TYPEN = ["benutzer", "gruppe", "domaene"];

const klein = v => String(v || "").trim().toLowerCase();

/** Eine Regel prüfen und in die gespeicherte Form bringen.
 *  @throws {Error} mit sprechendem Text, wenn etwas fehlt */
function normalisiere(roh, i = 0) {
  const stelle = `Regel ${i + 1}`;
  const typ = klein(roh?.typ);
  if (!TYPEN.includes(typ)) {
    throw new Error(`${stelle}: unbekannter Typ „${roh?.typ}“ `
      + `(erlaubt: ${TYPEN.join(", ")})`);
  }

  let wert = klein(roh?.wert);
  if (!wert) throw new Error(`${stelle}: Wert fehlt`);

  if (typ === "benutzer" && !wert.includes("@")) {
    throw new Error(`${stelle}: „${wert}“ ist keine E-Mail-Adresse`);
  }
  if (typ === "domaene") {
    wert = wert.replace(/^@/, "");
    if (!wert.includes(".") || wert.includes("@")) {
      throw new Error(`${stelle}: „${roh.wert}“ ist keine Domäne `
        + `(erwartet z. B. dihag.com)`);
    }
  }
  if (typ === "gruppe" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wert)) {
    throw new Error(`${stelle}: „${roh.wert}“ ist keine Objekt-Id. `
      + `Die Id steht in Entra unter „Gruppen → <Gruppe> → Objekt-ID“.`);
  }

  const berichte = Array.isArray(roh?.berichte)
    ? [...new Set(roh.berichte.map(b => String(b).trim()).filter(Boolean))]
    : [];
  if (!berichte.length) {
    throw new Error(`${stelle}: kein Bericht ausgewählt `
      + `(„*“ steht für alle)`);
  }

  return {
    id: String(roh?.id || "").trim() || neueId(),
    typ,
    wert,
    name: String(roh?.name || "").trim(),
    berichte,
    admin: roh?.admin === true,
    aktiv: roh?.aktiv !== false,
    notiz: String(roh?.notiz || "").trim()
  };
}

const neueId = () =>
  "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Trifft die Regel auf diese Person zu? */
function passt(regel, wer) {
  if (!regel || regel.aktiv === false) return false;
  const upn = klein(wer?.upn);
  switch (regel.typ) {
    case "benutzer":
      return upn === regel.wert || klein(wer?.oid) === regel.wert;
    case "gruppe":
      return (wer?.gruppen || []).some(g => klein(g) === regel.wert);
    case "domaene":
      return upn.endsWith("@" + regel.wert);
    default:
      return false;
  }
}

/** Alles, was diese Person darf.
 *  @param {object[]} regeln
 *  @param {{upn:string, oid?:string, gruppen?:string[]}} wer
 *  @param {{hauptAdmins?:string[], standardDomaenen?:string[]}} [opt]
 *  @returns {{admin:boolean, alleBerichte:boolean, berichte:string[],
 *             quelle:"hauptadmin"|"regeln"|"standard"|"keiner", treffer:object[]}}
 */
function auswerten(regeln, wer, opt = {}) {
  const upn = klein(wer?.upn);

  // Haupt-Administratoren stehen in der Umgebung und koennen sich nicht selbst
  // aussperren - sonst waere die App nach einer unglücklichen Regel tot.
  if ((opt.hauptAdmins || []).map(klein).includes(upn)) {
    return { admin: true, alleBerichte: true, berichte: [],
             quelle: "hauptadmin", treffer: [] };
  }

  const treffer = (regeln || []).filter(r => passt(r, wer));

  if (!treffer.length) {
    // Noch keine Regel angelegt? Dann gilt die bisherige Regelung aus der
    // Umgebung: wer aus einer erlaubten Domäne kommt, sieht alles. Sobald die
    // erste Regel existiert, gilt ausschließlich sie.
    const nochKeineRegeln = !(regeln || []).length;
    const domaeneOk = (opt.standardDomaenen || []).some(d => upn.endsWith("@" + klein(d)));
    if (nochKeineRegeln && domaeneOk) {
      return { admin: false, alleBerichte: true, berichte: [],
               quelle: "standard", treffer: [] };
    }
    return { admin: false, alleBerichte: false, berichte: [],
             quelle: "keiner", treffer: [] };
  }

  const admin = treffer.some(r => r.admin === true);
  const alleBerichte = treffer.some(r => r.berichte.includes("*"));
  const berichte = [...new Set(treffer.flatMap(r => r.berichte).filter(b => b !== "*"))];
  return { admin, alleBerichte, berichte, quelle: "regeln", treffer };
}

/** Darf diese Auswertung den Bericht sehen? */
const darfBericht = (a, key) =>
  Boolean(a) && (a.alleBerichte || (a.berichte || []).includes(key));

/** Welche der freigegebenen Berichte darf die Person sehen? */
const sichtbareBerichte = (a, alleSchluessel) =>
  a?.alleBerichte ? [...alleSchluessel] : (alleSchluessel || []).filter(k => darfBericht(a, k));

module.exports = { TYPEN, normalisiere, passt, auswerten, darfBericht,
                   sichtbareBerichte, neueId };
