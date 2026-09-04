"use strict";

/* Einstellungen → Verbrauch (nur für Administratoren).

   Zwei Quellen, bewusst getrennt ausgewiesen:

     **Öffnungen** zählt der Broker selbst. Jedes Einbettungs-Token geht durch
     ihn, die Zahl ist exakt. Getrennt gezählt werden echte Aufrufe und
     Token-Erneuerungen (ein Dashboard, das stundenlang offen steht, holt sich
     jede Stunde ein neues Token und kostet dabei weiter Kapazität).

     **CU** (Capacity Units) kommen aus der App „Microsoft Fabric Capacity
     Metrics". Ist sie nicht angebunden, steht hier, was fehlt – geschätzte
     Kapazitätswerte wären wertlos.                                          */

const NUTZUNG_UI = (() => {

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const zahl = n => Number(n || 0).toLocaleString("de-DE");
  const cu = n => Number(n || 0).toLocaleString("de-DE",
    { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  let tage = 30;

  async function oeffnen() {
    $("nutzungBody").innerHTML = `<p class="hinweis">Zahlen werden geholt …</p>`;
    try {
      const d = await EMBED.holeNutzung(tage);
      zeichnen(d);
    } catch (e) {
      $("nutzungBody").innerHTML = `<div class="warn">${esc(EMBED.fehlerText(e))}</div>`;
    }
  }

  function zeichnen(d) {
    const z = d.zaehlung;
    const spitze = Math.max(1, ...z.jeTag.map(t => t.oeffnen + t.erneuern));

    $("nutzungBody").innerHTML = `
      <div class="karte">
        <div class="karte-kopf">
          <h4>📈 Aufrufe</h4>
          <div class="row">
            ${[7, 30, 90].map(t => `<button class="btn ${t === tage ? "" : "sec "}sm"
              data-tage="${t}">${t} Tage</button>`).join("")}
          </div>
        </div>
        <p class="hinweis">Zeitraum ${esc(z.von)} bis ${esc(z.bis)}. Diese Zahlen zählt
          der Token-Dienst selbst – jeder Aufruf geht durch ihn.</p>

        <div class="kacheln">
          <div class="kachel"><b>${zahl(z.gesamt.oeffnen)}</b><span>Öffnungen</span></div>
          <div class="kachel"><b>${zahl(z.gesamt.erneuern)}</b><span>Token-Erneuerungen</span></div>
          <div class="kachel"><b>${zahl(z.gesamt.personen)}</b><span>Personen</span></div>
        </div>

        ${z.jeTag.length ? `
        <div class="verlauf">
          ${z.jeTag.map(t => `<div class="balken" title="${esc(t.schluessel)}: ${t.oeffnen} Öffnungen, ${t.erneuern} Erneuerungen">
             <div class="stab" style="height:${Math.round((t.oeffnen + t.erneuern) / spitze * 100)}%"></div>
           </div>`).join("")}
        </div>
        <p class="hinweis" style="margin-top:6px">Aufrufe je Tag (höchster Tag = ${zahl(spitze)}).</p>
        ` : `<p class="hinweis">Im Zeitraum wurde noch kein Bericht geöffnet.</p>`}
      </div>

      <div class="karte">
        <h4>📊 Je Bericht</h4>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Bericht</th><th class="rechts">Öffnungen</th>
            <th class="rechts">Erneuerungen</th><th class="rechts">Personen</th>
            <th class="rechts">CU</th><th class="rechts">CU je Öffnung</th>
          </tr></thead>
          <tbody>
            ${z.jeBericht.map(b => {
              const c = d.cu.jeBericht?.[b.schluessel];
              const gesamtAufrufe = b.oeffnen + b.erneuern;
              return `<tr>
                <td>${esc(DATA.nameVon(b.schluessel))}<br><small>${esc(b.schluessel)}</small></td>
                <td class="rechts">${zahl(b.oeffnen)}</td>
                <td class="rechts">${zahl(b.erneuern)}</td>
                <td class="rechts">${zahl(b.personen)}</td>
                <td class="rechts">${c ? cu(c.cu) : "–"}</td>
                <td class="rechts">${c && gesamtAufrufe ? cu(c.cu / gesamtAufrufe) : "–"}</td>
              </tr>`;
            }).join("") ||
            `<tr><td colspan="6" class="leer">Keine Aufrufe im Zeitraum.</td></tr>`}
          </tbody>
        </table></div>
        <p class="hinweis" style="margin-top:10px">„CU je Öffnung“ teilt den gemessenen
          Verbrauch durch Öffnungen <b>und</b> Erneuerungen – ein Dashboard, das den ganzen
          Tag offen steht, verbraucht schließlich weiter.</p>
      </div>

      ${cuHinweis(d.cu)}

      <div class="karte">
        <h4>🔒 Was gespeichert wird</h4>
        <p class="hinweis">Je Aufruf: Zeitpunkt, Berichtsschlüssel und
          ${z.anonym ? "eine <b>täglich wechselnde Pseudonym-Kennung</b>"
                     : "die <b>E-Mail-Adresse</b>"} – mehr nicht.
          Einträge werden nach <b>${zahl(z.aufbewahrungTage)} Tagen</b> automatisch gelöscht.
          ${z.anonym ? "" : `Wer ganz ohne Personenbezug auskommen will, setzt in der
          Function App <code>NUTZUNG_ANONYM=1</code>; Nutzerzahlen bleiben dann zählbar,
          einzelne Personen aber nicht mehr nachvollziehbar.`}</p>
      </div>`;

    $("nutzungBody").querySelectorAll("[data-tage]").forEach(b =>
      b.onclick = () => { tage = Number(b.dataset.tage); oeffnen(); });
  }

  /** Sagt beim Fehlen der CU-Zahlen, was genau fehlt – statt einfach „–“. */
  function cuHinweis(c) {
    if (c.verfuegbar && Object.keys(c.jeBericht || {}).length) {
      return `<div class="karte"><h4>⚙️ Herkunft der CU-Zahlen</h4>
        <p class="hinweis">Aus dem Semantikmodell der App „Microsoft Fabric Capacity
        Metrics“, zusammengefasst über Bericht <b>und</b> zugehöriges Semantikmodell –
        der größere Teil des Verbrauchs entsteht beim Modell.</p></div>`;
    }
    const texte = {
      nicht_eingerichtet: `Die Metrik-App ist nicht angebunden. Dafür braucht die Function
        App die Einstellungen <code>METRIK_WORKSPACE</code> und <code>METRIK_DATASET</code>
        (Arbeitsbereich und Semantikmodell der App „Microsoft Fabric Capacity Metrics“).`,
      kein_zugriff: `Der Dienstuser darf das Semantikmodell der Metrik-App nicht lesen.
        Er braucht dort Lesezugriff, und die Mandanteneinstellung
        <b>„Dataset Execute Queries REST API“</b> muss aktiv sein.`,
      anmeldung_fehlt: `Das Semantikmodell der Metrik-App hat keine gültige Anmeldung
        für seine Datenquelle. Einmalig im Power-BI-Portal setzen: Arbeitsbereich
        „Microsoft Fabric Capacity Metrics“ → Semantikmodell „Fabric Capacity Metrics“
        → <b>Einstellungen → Datenquellen-Anmeldeinformationen → Anmelden</b>, mit einem
        Konto, das <b>Kapazitätsadministrator</b> ist. Danach erscheinen die Zahlen hier
        von selbst.`,
      keine_daten: `Die Metrik-App ist angebunden, liefert für diese Berichte aber noch
        keine Zeilen. Das ist direkt nach dem Einrichten normal – das Modell muss erst
        aktualisiert werden.`,
      nicht_erreichbar: `Die Metrik-App war nicht erreichbar.`,
      abfrage_fehler: `Die Abfrage an das Metrikmodell wurde abgelehnt.`
    };
    return `<div class="warn">
      <b>Keine CU-Zahlen verfügbar.</b>
      ${texte[c.grund] || "Grund unbekannt."}
      ${c.detail ? `<br><small>${esc(c.detail)}</small>` : ""}
      <br><br>Bis dahin stehen oben nur die Aufrufzahlen – die sind exakt.
      Geschätzte Kapazitätswerte gibt es hier bewusst nicht.
    </div>`;
  }

  return { oeffnen };
})();
