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
  const geld = (n, w = "EUR") => Number(n || 0).toLocaleString("de-DE",
    { style: "currency", currency: w, maximumFractionDigits: 2 });

  const AZURE_KOSTEN = "https://portal.azure.com/#view/Microsoft_Azure_CostManagement"
    + "/Menu/~/costanalysis/open/costanalysisv3/openedBy/AzurePortal";

  let tage = 30;

  async function oeffnen() {
    $("nutzungBody").innerHTML = `<p class="hinweis">Zahlen werden geholt …</p>`;
    try {
      const d = await EMBED.holeNutzung(tage);
      zeichnen(d);
      kostenLaden(d);   // laeuft nebenher: die Kosten-API ist traege
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

      <div id="kostenKarte" class="karte">
        <h4>💶 Kosten</h4>
        <p class="hinweis">werden geholt …</p>
      </div>

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
      directquery: `Die Verbrauchszahlen der Metrik-App lassen sich <b>nicht über die
        Schnittstelle abfragen</b>: Ihre Faktentabellen sind DirectQuery und lösen die
        Datenquelle über Datenschnitte des Berichts auf – diesen Zusammenhang gibt es
        außerhalb des Berichts nicht. Das liegt an der App, nicht an Anmeldung oder
        Rechten. Die Zahlen stehen im Bericht der Metrik-App; der Verweis unten führt
        direkt dorthin.`,
      keine_daten: `Die Metrik-App ist angebunden, liefert für diese Berichte aber noch
        keine Zeilen. Das ist direkt nach dem Einrichten normal – das Modell muss erst
        aktualisiert werden.`,
      nicht_erreichbar: `Die Metrik-App war nicht erreichbar.`,
      abfrage_fehler: `Die Abfrage an das Metrikmodell wurde abgelehnt.`
    };
    return `<div class="warn">
      <b>Keine CU-Zahlen an dieser Stelle.</b>
      ${texte[c.grund] || "Grund unbekannt."}
      ${c.detail ? `<br><small>${esc(c.detail)}</small>` : ""}
      <br><br>Die Aufrufzahlen oben sind davon unberührt und exakt.
      Geschätzte Kapazitätswerte gibt es hier bewusst nicht.
      ${c.metrikBericht ? `<div class="row" style="margin-top:12px">
        <a class="btn sm" href="${esc(c.metrikBericht)}" target="_blank" rel="noopener">
          📊 CU in der Metrik-App ansehen ↗</a></div>` : ""}
    </div>`;
  }

  /* ── Kosten ──────────────────────────────────────────────────────
     Aus Azure Cost Management – dieselben Zahlen wie in der Kostenanalyse
     des Portals. Bewusst nachgeladen: die API ist träge und drosselt. */

  async function kostenLaden(nutzung) {
    const ziel = $("kostenKarte");
    if (!ziel) return;
    try {
      const k = await EMBED.holeKosten();
      ziel.innerHTML = kostenInhalt(k, nutzung);
    } catch (e) {
      ziel.innerHTML = `<h4>💶 Kosten</h4>
        <p class="hinweis">${esc(EMBED.fehlerText(e))}</p>
        <div class="row"><a class="btn sec sm" href="${AZURE_KOSTEN}" target="_blank"
          rel="noopener">Kostenanalyse in Azure öffnen ↗</a></div>`;
    }
  }

  /** Öffnungen im laufenden Monat – nur die passen zeitlich zu „Monat bis heute". */
  function oeffnungenDiesenMonat(nutzung) {
    const monat = new Date().toISOString().slice(0, 7);
    return (nutzung?.zaehlung?.jeTag || [])
      .filter(t => String(t.schluessel).startsWith(monat))
      .reduce((s, t) => s + t.oeffnen + t.erneuern, 0);
  }

  function kostenInhalt(k, nutzung) {
    if (!k.verfuegbar) {
      const texte = {
        nicht_eingerichtet: `Die Kostenabfrage ist nicht eingerichtet. Dafür braucht die
          Function App <code>KOSTEN_ABO</code> und <code>KOSTEN_GRUPPEN</code>.`,
        kein_zugriff: `Der Dienstuser darf die Kosten nicht lesen – ihm fehlt die Rolle
          <b>Cost Management Reader</b> auf dem Abonnement.`,
        gedrosselt: `Azure drosselt die Kostenabfrage gerade (das tut sie regelmäßig).
          Der nächste Aufruf in einigen Minuten liefert die Zahlen – die Kostenanalyse
          im Portal geht sofort.`
      };
      return `<h4>💶 Kosten</h4>
        <p class="hinweis">${texte[k.grund] || esc(k.detail || "Kosten nicht abrufbar.")}</p>
        <div class="row"><a class="btn sec sm" href="${AZURE_KOSTEN}" target="_blank"
          rel="noopener">Kostenanalyse in Azure öffnen ↗</a></div>`;
    }

    const m = k.laufenderMonat, v = k.vormonat, w = m.waehrung || "EUR";
    const aufrufe = oeffnungenDiesenMonat(nutzung);
    const proAufruf = aufrufe ? m.summe / aufrufe : null;

    return `<div class="karte-kopf">
        <h4>💶 Kosten</h4>
        <a class="btn sec sm" href="${AZURE_KOSTEN}" target="_blank" rel="noopener">
          Kostenanalyse in Azure ↗</a>
      </div>
      <p class="hinweis">Tatsächliche Azure-Kosten der Ressourcengruppen dieser Anwendung,
        Stand ${esc(new Date(k.stand).toLocaleString("de-DE"))}.
        ${k.veraltet ? `<b>Azure drosselt die Abfrage gerade</b> – das ist der zuletzt
          abgerufene Stand, nicht der aktuelle.` : ""}</p>

      <div class="kacheln">
        <div class="kachel"><b>${geld(m.summe, w)}</b><span>laufender Monat</span></div>
        ${m.kapazitaet !== null
          ? `<div class="kachel"><b>${geld(m.kapazitaet, w)}</b><span>davon Fabric-Kapazität</span></div>
             <div class="kachel"><b>${geld(m.uebrige, w)}</b><span>übrige Ressourcen</span></div>`
          : ""}
        <div class="kachel"><b>${geld(v.summe, w)}</b><span>Vormonat</span></div>
      </div>

      <div class="tbl-wrap" style="margin-top:14px"><table class="tbl">
        <thead><tr><th>Ressourcengruppe</th>
          <th class="rechts">laufender Monat</th><th class="rechts">Vormonat</th></tr></thead>
        <tbody>
          ${m.jeGruppe.map(g => {
            const vor = (v.jeGruppe.find(x => x.gruppe === g.gruppe) || {}).betrag || 0;
            return `<tr><td>${esc(g.gruppe)}</td>
              <td class="rechts">${geld(g.betrag, w)}</td>
              <td class="rechts">${geld(vor, w)}</td></tr>`;
          }).join("") || `<tr><td colspan="3" class="leer">Keine Kosten im Zeitraum.</td></tr>`}
        </tbody>
      </table></div>

      <p class="hinweis" style="margin-top:14px">
        <b>Was eine Öffnung kostet:</b> genau genommen <b>nichts extra</b>. Die
        Fabric-Kapazität wird pro Stunde bezahlt, nicht pro Aufruf – ein Bericht mehr
        oder weniger ändert die Rechnung nicht, solange die Kapazität nicht ausgelastet
        ist. Interessant ist deshalb die Auslastung (CU), nicht der Klick.
        ${proAufruf !== null ? `Rein rechnerisch verteilen sich die
          ${geld(m.summe, w)} dieses Monats auf ${zahl(aufrufe)} Aufrufe, also
          <b>${geld(proAufruf, w)} je Aufruf</b> – eine Vollkostenzahl, keine Grenzkosten:
          Sie sinkt mit jeder weiteren Nutzung.` : ""}
      </p>`;
  }

  return { oeffnen };
})();
