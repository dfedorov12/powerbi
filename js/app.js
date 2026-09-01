"use strict";

/* Oberfläche: Anmeldung, Berichtsauswahl, Einbettung, Diagnose. */

(() => {

  const C = PBI_CONFIG;
  const $ = id => document.getElementById(id);

  const boot     = $("boot");
  const bootTxt  = $("bootTxt");
  const bootErr  = $("bootErr");
  const bootBtn  = $("bootBtn");
  const bootSpin = $("bootSpin");
  const noAccess = $("noAccess");
  const app      = $("app");
  const tabBar   = $("tabBar");
  const rahmen   = $("berichtRahmen");
  const status   = $("berichtStatus");

  let aktuell = null;   // gerade angezeigter Bericht

  /* ── Startbildschirm ──────────────────────────────────────────────── */

  function bootFehler(text, mitKnopf = true) {
    bootSpin.hidden = true;
    bootTxt.hidden = true;
    bootErr.hidden = false;
    bootErr.textContent = text;
    bootBtn.hidden = !mitKnopf;
  }

  /* ── Kopfbereich ──────────────────────────────────────────────────── */

  function kopfFuellen() {
    const c = DATA.ctx;
    $("uName").textContent = c.name || c.email;
    $("uMeta").textContent = [c.abteilung, c.gesellschaft].filter(Boolean).join(" · ")
      || c.email;
    $("uAvatar").textContent = (c.name || c.email || "?")
      .split(/[ .]/).filter(Boolean).slice(0, 2).map(s => s[0]).join("").toUpperCase();
    $("btnDiagnose").hidden = !DATA.istAdmin();
  }

  /* ── Reiterleiste der Berichte ────────────────────────────────────── */

  function reiterZeichnen(berichte) {
    tabBar.innerHTML = "";
    // Bei nur einem Bericht wäre eine Reiterleiste nur Zierde.
    tabBar.hidden = berichte.length < 2;
    berichte.forEach(b => {
      const el = document.createElement("button");
      el.className = "tab" + (b.key === aktuell?.key ? " on" : "");
      el.textContent = b.name;
      el.title = b.beschreibung || b.name;
      el.onclick = () => waehle(b);
      tabBar.appendChild(el);
    });
  }

  function melden(zustand, text) {
    status.hidden = zustand === "bereit";
    status.className = "bericht-status" + (zustand === "fehler" ? " fehler" : "");
    if (zustand === "fehler") {
      status.innerHTML = "";
      const h = document.createElement("div");
      h.className = "st-titel";
      h.textContent = "Der Bericht konnte nicht geladen werden";
      const p = document.createElement("p");
      p.textContent = text || "";
      const a = document.createElement("a");
      a.href = "mailto:" + C.itMail + "?subject="
        + encodeURIComponent("Power-BI-Bericht wird nicht angezeigt")
        + "&body=" + encodeURIComponent((text || "") + "\n\nBericht: "
        + (aktuell?.name || "") + "\nAngemeldet: " + DATA.ctx.email);
      a.textContent = "Der IT melden";
      status.append(h, p, a);
    } else {
      status.textContent = text || "";
    }
  }

  async function waehle(b) {
    aktuell = b;
    reiterZeichnen(DATA.sichtbareBerichte());
    $("berichtName").textContent = b.name;
    $("berichtInfo").textContent = b.beschreibung || "";
    try {
      await EMBED.zeigeBericht(rahmen, b, melden);
    } catch (e) {
      melden("fehler", EMBED.fehlerText(e));
    }
  }

  /* ── Diagnose (nur Administratoren) ───────────────────────────────── */

  function zeile(k, v) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    return [dt, dd];
  }

  async function diagnose() {
    const box = $("diagBody");
    box.innerHTML = "";
    const dl = document.createElement("dl");

    dl.append(...zeile("Angemeldet", DATA.ctx.email));
    dl.append(...zeile("Rolle", DATA.ctx.role + " (Quelle: " + DATA.roleInfo.quelle + ")"));
    if (DATA.roleInfo.fehler) dl.append(...zeile("Hinweis", DATA.roleInfo.fehler));
    dl.append(...zeile("Redirect-URI", AUTH.redirectUri));
    dl.append(...zeile("Broker", C.brokerUrl));
    AUTH.tokenUebersicht().forEach(t => dl.append(...zeile(
      "Token " + t.zielgruppe,
      (t.gueltig ? "gültig bis " : "abgelaufen ") + t.laeuftAb.toLocaleTimeString("de-DE"))));
    box.appendChild(dl);

    const h = document.createElement("h4");
    h.textContent = "Berichte, die der Dienstuser sieht";
    box.appendChild(h);
    const p = document.createElement("p");
    p.textContent = "wird geladen …";
    box.appendChild(p);

    try {
      const d = await EMBED.holeBerichtsliste();
      p.remove();
      const t = document.createElement("table");
      t.className = "diag-tab";
      t.innerHTML = "<thead><tr><th>Arbeitsbereich</th><th>Bericht</th>"
        + "<th>workspaceId</th><th>reportId</th><th>freigegeben als</th></tr></thead>";
      const tb = document.createElement("tbody");
      (d.berichte || []).forEach(r => {
        const tr = document.createElement("tr");
        [r.arbeitsbereich, r.name, r.workspaceId, r.reportId, r.key || "–"]
          .forEach(w => { const td = document.createElement("td"); td.textContent = w; tr.appendChild(td); });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      box.appendChild(t);
      const hinweis = document.createElement("p");
      hinweis.className = "diag-hinweis";
      hinweis.textContent = "Die Spalte „freigegeben als“ zeigt den Schlüssel aus "
        + "PBI_BERICHTE. Nur freigegebene Berichte lassen sich einbetten.";
      box.appendChild(hinweis);
    } catch (e) {
      p.className = "fehler";
      p.textContent = EMBED.fehlerText(e);
    }
    $("diag").hidden = false;
  }

  /* ── Start ────────────────────────────────────────────────────────── */

  async function start() {
    if (String(C.clientId).startsWith("TODO")) {
      bootFehler("Die App ist noch nicht eingerichtet: In js/config.js fehlen "
        + "clientId, apiScope und brokerUrl. Siehe README.md.", false);
      return;
    }

    const r = await AUTH.signIn();
    if (r === "redirecting") return;
    if (r !== "ok") {
      bootFehler("Anmeldung fehlgeschlagen: " + (r.error || "unbekannt"));
      return;
    }

    bootTxt.textContent = "Profil wird geladen …";
    try {
      await DATA.loadUser();
    } catch (e) {
      bootFehler("Profil konnte nicht geladen werden: " + e.message);
      return;
    }

    kopfFuellen();

    const berichte = DATA.sichtbareBerichte();
    if (!berichte.length) {
      boot.hidden = true;
      noAccess.hidden = false;
      $("naMsg").textContent = "Für Ihr Konto (" + DATA.ctx.email + ", Rolle "
        + DATA.ctx.role + ") ist derzeit kein Bericht freigegeben.";
      return;
    }

    boot.hidden = true;
    app.hidden = false;
    await waehle(berichte[0]);
  }

  /* ── Schaltflächen ────────────────────────────────────────────────── */

  bootBtn.onclick = () => AUTH.startLogin("select_account");
  $("btnLogout").onclick = () => AUTH.logout();
  $("naOut").onclick = () => AUTH.logout();
  $("btnVollbild").onclick = () => EMBED.vollbild(rahmen);
  $("btnAktualisieren").onclick = async () => {
    melden("laedt", "Daten werden neu geladen …");
    try { await EMBED.neuLaden(rahmen); melden("bereit"); }
    catch (e) { melden("fehler", EMBED.fehlerText(e)); }
  };
  $("btnDiagnose").onclick = diagnose;
  $("diagZu").onclick = () => { $("diag").hidden = true; };

  window.addEventListener("error", ev => {
    if (!boot.hidden && ev?.error) bootFehler("Fehler: " + ev.error.message);
  });

  start().catch(e => bootFehler("Unerwarteter Fehler: " + e.message));
})();
