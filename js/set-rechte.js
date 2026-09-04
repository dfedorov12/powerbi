"use strict";

/* Einstellungen → Berechtigungen (nur für Administratoren).

   Gepflegt wird eine Liste von Regeln. Jede Regel ordnet einem Prinzipal –
   Benutzer, Gruppe oder E-Mail-Domäne – Berichte zu. Gespeichert wird immer
   die **ganze** Liste (PUT /api/rechte): die Menge ist klein, und so kann die
   Oberfläche keinen halben Stand hinterlassen.

   Die Oberfläche ist Komfort, nicht Sicherheit. Verbindlich prüft der Broker
   bei jedem Einbettungs-Token erneut.                                      */

const RECHTE_UI = (() => {

  const C = PBI_CONFIG;
  const $ = id => document.getElementById(id);

  const esc = s => String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TYP_TEXT = {
    benutzer: "Benutzer",
    gruppe:   "Gruppe",
    domaene:  "Domäne"
  };

  /** Arbeitskopie. Gespeichert wird erst auf Knopfdruck. */
  let regeln = [];
  let stand = { berichte: [], hauptAdmins: [], standardDomaenen: [] };
  let geaendert = false;
  let meineGruppen = null;   // erst auf Anforderung geladen

  /* ── Öffnen / Schließen ──────────────────────────────────────────── */

  async function oeffnen() {
    $("rechte").hidden = false;
    $("rechteBody").innerHTML = `<p class="hinweis">Regeln werden geladen …</p>`;
    try {
      const d = await EMBED.holeRechte();
      regeln = (d.regeln || []).map(r => ({ ...r }));
      stand = {
        berichte: d.berichte || [],
        hauptAdmins: d.hauptAdmins || [],
        standardDomaenen: d.standardDomaenen || []
      };
      geaendert = false;
      zeichnen();
    } catch (e) {
      $("rechteBody").innerHTML =
        `<div class="warn">${esc(EMBED.fehlerText(e))}</div>`;
    }
  }

  function schliessen() {
    if (geaendert && !confirm("Es gibt ungespeicherte Änderungen. Trotzdem schließen?")) return;
    $("rechte").hidden = true;
  }

  /* ── Tabelle ─────────────────────────────────────────────────────── */

  const berichteText = r => r.berichte.includes("*")
    ? "alle Berichte"
    : r.berichte.map(k => DATA.nameVon(k)).join(", ");

  function zeichnen() {
    const leer = !regeln.length;
    $("rechteBody").innerHTML = `
      ${leer ? `
        <div class="warn">
          <b>Noch keine Regel angelegt.</b> Solange die Liste leer ist, gilt die
          Übergangsregelung: Wer aus einer freigegebenen Domäne kommt
          (${esc(stand.standardDomaenen.join(", ") || "keine gesetzt")}), sieht alle
          Berichte. <b>Sobald die erste Regel existiert, gilt ausschließlich sie.</b>
          <div class="row" style="margin-top:10px">
            <button class="btn sm" id="rStart">Startregel anlegen</button>
          </div>
        </div>` : ""}

      <div class="karte">
        <div class="karte-kopf">
          <h4>🔑 Zugriffsregeln</h4>
          <div class="row">
            <button class="btn sm" id="rNeu">+ Regel</button>
            <button class="btn sec sm" id="rSpeichern"${geaendert ? "" : " disabled"}>Speichern</button>
            <button class="btn sec sm" id="rVerwerfen"${geaendert ? "" : " disabled"}>Verwerfen</button>
          </div>
        </div>
        <p class="hinweis">Eine Regel gibt einem Prinzipal Berichte frei. Es gilt die
          Summe aller zutreffenden Regeln. Wer von keiner Regel getroffen wird, sieht nichts.</p>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Typ</th><th>Wert</th><th>Bezeichnung</th><th>Berichte</th>
            <th>verwaltet</th><th>aktiv</th><th></th>
          </tr></thead>
          <tbody>
            ${regeln.map((r, i) => `
              <tr>
                <td><span class="pill ${r.typ}">${esc(TYP_TEXT[r.typ] || r.typ)}</span></td>
                <td class="brechen">${esc(r.wert)}</td>
                <td>${esc(r.name || "–")}</td>
                <td>${esc(berichteText(r))}</td>
                <td>${r.admin ? '<span class="pill orange">ja</span>' : "–"}</td>
                <td>${r.aktiv ? '<span class="pill green">ja</span>'
                              : '<span class="pill gray">nein</span>'}</td>
                <td class="rechts">
                  <button class="btn ghost2 sm" data-bearbeiten="${i}">Bearbeiten</button>
                  <button class="btn ghost2 sm" data-loeschen="${i}">Löschen</button>
                </td>
              </tr>`).join("") ||
            `<tr><td colspan="7" class="leer">Keine Regel vorhanden.</td></tr>`}
          </tbody>
        </table></div>
      </div>

      <div class="karte">
        <h4>👑 Haupt-Administration</h4>
        <p class="hinweis">Diese Konten stehen in der Broker-Einstellung
          <code>ADMIN_UPNS</code> und dürfen immer verwalten – unabhängig von den
          Regeln oben. So bleibt die App auch nach einer unglücklichen Regel
          bedienbar. Änderungen daran gehen nur über die Function App.</p>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>E-Mail</th><th>Quelle</th></tr></thead>
          <tbody>${stand.hauptAdmins.map(m => `
            <tr><td><b>${esc(m)}</b></td>
                <td><span class="pill gray">ADMIN_UPNS</span></td></tr>`).join("") ||
            `<tr><td colspan="2" class="leer">Keiner gesetzt.</td></tr>`}
          </tbody>
        </table></div>
      </div>`;

    if (leer) $("rStart").onclick = startregel;
    $("rNeu").onclick = () => bearbeiten(null);
    $("rSpeichern").onclick = speichern;
    $("rVerwerfen").onclick = oeffnen;
    $("rechteBody").querySelectorAll("[data-bearbeiten]").forEach(b =>
      b.onclick = () => bearbeiten(Number(b.dataset.bearbeiten)));
    $("rechteBody").querySelectorAll("[data-loeschen]").forEach(b =>
      b.onclick = () => loeschen(Number(b.dataset.loeschen)));
  }

  function startregel() {
    const d = stand.standardDomaenen[0] || DATA.ctx.domain;
    regeln.push({ typ: "domaene", wert: d, name: "Alle Beschäftigten",
                  berichte: ["*"], admin: false, aktiv: true, notiz: "" });
    regeln.push({ typ: "benutzer", wert: DATA.ctx.email, name: DATA.ctx.name,
                  berichte: ["*"], admin: true, aktiv: true,
                  notiz: "Darf die Berechtigungen verwalten" });
    geaendert = true;
    zeichnen();
  }

  function loeschen(i) {
    const r = regeln[i];
    if (!confirm(`Regel „${TYP_TEXT[r.typ]} ${r.wert}“ wirklich löschen?`)) return;
    regeln.splice(i, 1);
    geaendert = true;
    zeichnen();
  }

  /* ── Bearbeiten ──────────────────────────────────────────────────── */

  function bearbeiten(i) {
    const neu = i === null;
    const r = neu
      ? { typ: "benutzer", wert: "", name: "", berichte: [], admin: false, aktiv: true, notiz: "" }
      : { ...regeln[i], berichte: [...regeln[i].berichte] };

    $("rechteForm").hidden = false;
    $("rechteForm").innerHTML = `
      <div class="form-kopf"><h4>${neu ? "Neue Regel" : "Regel bearbeiten"}</h4></div>
      <div class="felder">
        <label>Typ
          <select id="fTyp">
            <option value="benutzer">Benutzer (E-Mail)</option>
            <option value="gruppe">Gruppe (Sicherheits-, Microsoft-365-, Verteilergruppe)</option>
            <option value="domaene">E-Mail-Domäne</option>
          </select>
        </label>
        <label>Wert
          <input id="fWert" value="${esc(r.wert)}" autocomplete="off" spellcheck="false">
          <small id="fHinweis"></small>
        </label>
        <div id="fGruppen" hidden>
          <button class="btn sec sm" id="fGruppenLaden" type="button">Meine Gruppen laden</button>
          <select id="fGruppenWahl" hidden></select>
          <small id="fGruppenInfo"></small>
        </div>
        <label>Bezeichnung <small>(nur zur Anzeige)</small>
          <input id="fName" value="${esc(r.name)}" autocomplete="off">
        </label>
        <fieldset>
          <legend>Berichte</legend>
          <label class="ankreuz"><input type="checkbox" id="fAlle"
            ${r.berichte.includes("*") ? "checked" : ""}> <b>Alle Berichte (*)</b></label>
          <div id="fBerichte">
            ${stand.berichte.map(k => `<label class="ankreuz">
              <input type="checkbox" data-bericht="${esc(k)}"
                ${r.berichte.includes(k) ? "checked" : ""}> ${esc(DATA.nameVon(k))}
              <small>${esc(k)}</small></label>`).join("") ||
              `<p class="hinweis">Der Broker hat keine Berichte freigegeben (PBI_BERICHTE).</p>`}
          </div>
        </fieldset>
        <label class="ankreuz"><input type="checkbox" id="fAdmin" ${r.admin ? "checked" : ""}>
          darf die Berechtigungen verwalten</label>
        <label class="ankreuz"><input type="checkbox" id="fAktiv" ${r.aktiv !== false ? "checked" : ""}>
          aktiv</label>
        <label>Notiz
          <input id="fNotiz" value="${esc(r.notiz || "")}" autocomplete="off">
        </label>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="fOk">Übernehmen</button>
        <button class="btn sec" id="fAb">Abbrechen</button>
      </div>
      <p class="fehler" id="fFehler" hidden></p>`;

    $("fTyp").value = r.typ;

    const typWechsel = () => {
      const t = $("fTyp").value;
      $("fHinweis").textContent =
        t === "benutzer" ? "Vollständige E-Mail-Adresse, z. B. vorname.nachname@dihag.com"
        : t === "domaene" ? "Nur die Domäne, z. B. dihag.com – gilt für alle Adressen darin"
        : "Objekt-Id der Gruppe (Entra → Gruppen → Übersicht → Objekt-ID)";
      $("fGruppen").hidden = t !== "gruppe";
    };
    $("fTyp").onchange = typWechsel;
    typWechsel();

    $("fGruppenLaden").onclick = gruppenLaden;
    $("fAlle").onchange = () => {
      const an = $("fAlle").checked;
      $("fBerichte").querySelectorAll("input").forEach(c => { c.disabled = an; });
    };
    $("fAlle").onchange();

    $("fAb").onclick = () => { $("rechteForm").hidden = true; };
    $("fOk").onclick = () => {
      const berichte = $("fAlle").checked
        ? ["*"]
        : [...$("fBerichte").querySelectorAll("input:checked")].map(c => c.dataset.bericht);
      const neuRegel = {
        id: r.id,
        typ: $("fTyp").value,
        wert: $("fWert").value.trim(),
        name: $("fName").value.trim(),
        berichte,
        admin: $("fAdmin").checked,
        aktiv: $("fAktiv").checked,
        notiz: $("fNotiz").value.trim()
      };
      const fehler = pruefen(neuRegel);
      if (fehler) {
        $("fFehler").hidden = false;
        $("fFehler").textContent = fehler;
        return;
      }
      if (neu) regeln.push(neuRegel); else regeln[i] = neuRegel;
      geaendert = true;
      $("rechteForm").hidden = true;
      zeichnen();
    };
  }

  /** Dieselben Prüfungen wie im Broker – hier nur, damit die Rückmeldung
   *  sofort kommt. Verbindlich ist die Prüfung dort. */
  function pruefen(r) {
    if (!r.wert) return "Bitte einen Wert eintragen.";
    if (r.typ === "benutzer" && !r.wert.includes("@"))
      return "Für einen Benutzer wird die vollständige E-Mail-Adresse gebraucht.";
    if (r.typ === "domaene" && (!r.wert.includes(".") || r.wert.includes("@")))
      return "Eine Domäne sieht so aus: dihag.com – ohne @ und ohne Namen davor.";
    if (r.typ === "gruppe" &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.wert))
      return "Für eine Gruppe wird die Objekt-Id gebraucht (Entra → Gruppen → Objekt-ID).";
    if (!r.berichte.length) return "Bitte mindestens einen Bericht auswählen.";
    return null;
  }

  async function gruppenLaden() {
    const info = $("fGruppenInfo");
    const wahl = $("fGruppenWahl");
    info.textContent = "wird geladen …";
    try {
      if (!meineGruppen) meineGruppen = await GRAPH.meineGruppen();
      if (!meineGruppen.length) { info.textContent = "Sie sind in keiner Gruppe."; return; }
      wahl.hidden = false;
      wahl.innerHTML = `<option value="">– aus meinen Gruppen wählen –</option>`
        + meineGruppen.map(g => `<option value="${esc(g.id)}" data-name="${esc(g.name)}">
             ${esc(g.name || g.id)}${g.art ? " · " + esc(g.art) : ""}</option>`).join("");
      wahl.onchange = () => {
        const o = wahl.selectedOptions[0];
        if (!o?.value) return;
        $("fWert").value = o.value;
        if (!$("fName").value) $("fName").value = o.dataset.name || "";
      };
      const ohneNamen = meineGruppen.filter(g => !g.name).length;
      info.textContent = `${meineGruppen.length} Gruppe(n)`
        + (ohneNamen ? ` – für ${ohneNamen} davon fehlt der Name, `
            + `dafür bräuchte es die Berechtigung, das Verzeichnis zu lesen.` : "")
        + " Gruppen, in denen Sie selbst nicht sind, tragen Sie über die Objekt-Id ein.";
    } catch (e) {
      info.textContent = e.message;
    }
  }

  /* ── Speichern ───────────────────────────────────────────────────── */

  async function speichern() {
    const knopf = $("rSpeichern");
    knopf.disabled = true;
    knopf.textContent = "Speichert …";
    try {
      const d = await EMBED.speichereRechte(regeln);
      regeln = (d.regeln || []).map(r => ({ ...r }));
      geaendert = false;
      zeichnen();
      // Der eigene Zugriff kann sich gerade geändert haben.
      await DATA.ladeZugriff();
      document.dispatchEvent(new CustomEvent("rechte-geaendert"));
    } catch (e) {
      zeichnen();
      const box = document.createElement("div");
      box.className = "warn";
      box.textContent = "Nicht gespeichert: " + EMBED.fehlerText(e);
      $("rechteBody").prepend(box);
    }
  }

  return { oeffnen, schliessen };
})();
