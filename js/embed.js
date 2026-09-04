"use strict";

/* Einbetten eines Power-BI-Berichts.

   Ablauf pro Bericht:
     1. Token für den eigenen Broker holen (Zielgruppe api://<clientId>/…)
     2. Broker fragen: GET /embed-token?bericht=<key>
        -> { name, reportId, embedUrl, token, expiration }
        Der Broker meldet sich dafür als Dienstuser bei Power BI an. Der
        Betrachter selbst taucht bei Power BI nie auf und braucht deshalb
        weder Lizenz noch Freigabe im Arbeitsbereich.
     3. powerbi.embed(...) mit tokenType = Embed, ausschließlich lesend
     4. Kurz vor Ablauf des Tokens im Hintergrund ein neues nachschieben,
        damit ein den ganzen Tag offenes Dashboard nicht stehen bleibt.     */

const EMBED = (() => {

  const C = PBI_CONFIG;

  /** Laufende Einbettungen: Container-Element -> { report, timer } */
  const _aktiv = new Map();

  /* ── Broker ───────────────────────────────────────────────────────── */

  async function brokerGet(pfad) {
    const token = await AUTH.getApiToken();
    const url = String(C.brokerUrl).replace(/\/+$/, "") + pfad;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    } catch (e) {
      const err = new Error("Der Token-Dienst ist nicht erreichbar (" + e.message + ").");
      err.art = "broker_offline";
      throw err;
    }
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(d?.fehler || res.statusText || ("HTTP " + res.status));
      err.status = res.status;
      err.art = d?.art || "broker";
      err.detail = d?.detail || "";
      throw err;
    }
    return d;
  }

  async function brokerPut(pfad, koerper) {
    const token = await AUTH.getApiToken();
    const url = String(C.brokerUrl).replace(/\/+$/, "") + pfad;
    let res;
    try {
      res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(koerper)
      });
    } catch (e) {
      const err = new Error("Der Token-Dienst ist nicht erreichbar (" + e.message + ").");
      err.art = "broker_offline";
      throw err;
    }
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(d?.fehler || res.statusText || ("HTTP " + res.status));
      err.status = res.status;
      err.art = d?.art || "broker";
      err.detail = d?.detail || "";
      throw err;
    }
    return d;
  }

  /** @param {"oeffnen"|"erneuerung"} grund – der Broker zählt beides getrennt,
   *  damit ein den ganzen Tag offenes Dashboard nicht als hundert Aufrufe
   *  in der Statistik landet. */
  const holeEinbettung = (key, grund = "oeffnen") =>
    brokerGet("/embed-token?bericht=" + encodeURIComponent(key)
      + "&grund=" + encodeURIComponent(grund));

  /** Nutzungszahlen und CU-Verbrauch (nur Administratoren). */
  const holeNutzung = (tage = 30) => brokerGet("/nutzung?tage=" + Number(tage));

  /** Azure-Kosten (nur Administratoren). Getrennt, weil die
   *  Cost-Management-API traege ist – die Aufrufzahlen sollen nicht warten. */
  const holeKosten = () => brokerGet("/kosten");

  /** Was darf die angemeldete Person sehen, darf sie verwalten? */
  const holeZugriff = () => brokerGet("/zugriff");

  /** Nur für Administratoren: welche Berichte sieht der Dienstuser? */
  const holeBerichtsliste = () => brokerGet("/berichte");

  /** Zugriffsregeln lesen bzw. vollständig ersetzen (nur Administratoren). */
  const holeRechte = () => brokerGet("/rechte");
  const speichereRechte = regeln => brokerPut("/rechte", { regeln });

  /* ── Bibliothek ───────────────────────────────────────────────────── */

  /** Die offizielle powerbi-client-Bibliothek liegt im Repo unter js/vendor/.
   *  Fehlt sie (frisches Repo, Datei nicht mitgeliefert), wird das CDN
   *  nachgeladen. Erst wenn beides scheitert, gibt es eine klare Meldung. */
  let _libP = null;
  function ladeBibliothek() {
    if (window.powerbi) return Promise.resolve();
    if (_libP) return _libP;
    const laden = src => new Promise((ok, fehl) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => ok();
      s.onerror = () => fehl(new Error("nicht ladbar: " + src));
      document.head.appendChild(s);
    });
    _libP = laden("js/vendor/powerbi.min.js")
      .catch(() => laden(C.clientLibCdn))
      .then(() => {
        if (!window.powerbi) throw new Error("powerbi-client nicht initialisiert");
      });
    return _libP;
  }

  /* ── Fehlertexte im Klartext ──────────────────────────────────────── */

  /** Power BI und Entra melden Fehler in Kurzform. Hier stehen die Fälle,
   *  die bei dieser Bauart tatsächlich auftreten – mit dem konkreten
   *  nächsten Schritt, damit niemand raten muss. */
  function fehlerText(e) {
    const roh = String(e?.message || e || "");
    const art = e?.art || "";
    const s = roh.toLowerCase();

    if (art === "broker_offline" || s.includes("failed to fetch"))
      return "Der Token-Dienst ist nicht erreichbar. Läuft die Azure Function, "
           + "und ist die Adresse in js/config.js (brokerUrl) richtig?";
    if (e?.status === 401)
      return "Der Token-Dienst hat die Anmeldung abgelehnt. Meist fehlt die "
           + "Zustimmung für den Bereich " + C.apiScope + ".";
    if (e?.status === 403 && art === "keine_freigabe")
      return "Für dieses Konto ist der Bericht nicht freigegeben. "
           + "Ein Administrator kann das unter „Einstellungen → Berechtigungen“ ändern."
           + (e.detail ? " (" + e.detail + ")" : "");
    if (e?.status === 403 && art === "kein_admin")
      return "Diese Ansicht ist Administratoren vorbehalten.";
    if (e?.status === 403)
      return "Für diesen Bericht ist kein Zugriff freigegeben." + (e.detail ? " " + e.detail : "");
    if (e?.status === 404 && art === "unbekannter_bericht")
      return "Dieser Bericht steht nicht in der Freigabeliste des Token-Dienstes "
           + "(Einstellung PBI_BERICHTE).";
    if (s.includes("powerbinotauthorized") || s.includes("unauthorized"))
      return "Der Dienstuser darf den Arbeitsbereich nicht lesen. Er muss dort "
           + "als Mitglied oder Administrator eingetragen sein, und in den "
           + "Power-BI-Mandanteneinstellungen müssen „Inhalte in Apps einbetten“ "
           + "und „Dienstprinzipale dürfen Power-BI-APIs verwenden“ aktiv sein.";
    if (s.includes("capacity") || s.includes("kapazit"))
      return "Power BI verlangt für diesen Vorgang eine Kapazität (F/A/EM/P-SKU). "
           + "Der Arbeitsbereich liegt derzeit auf keiner.";
    if (s.includes("token") && s.includes("expired"))
      return "Das Einbettungs-Token ist abgelaufen. Bitte die Seite neu laden.";
    if (s.includes("free") && s.includes("trial"))
      return "Das monatliche Kontingent an kostenlosen Test-Token ist erschöpft. "
           + "Für den Dauerbetrieb wird eine Kapazität benötigt.";
    return roh || "Unbekannter Fehler";
  }

  /* ── Einbetten ────────────────────────────────────────────────────── */

  /** Vorhandene Einbettung eines Containers sauber beenden. */
  function beenden(el) {
    const a = _aktiv.get(el);
    if (a) {
      clearTimeout(a.timer);
      try { window.powerbi.reset(el); } catch {}
      _aktiv.delete(el);
    }
  }

  /** Bericht in einen Container einbetten.
   *  @param {HTMLElement} el     Zielelement (bekommt die volle Höhe)
   *  @param {object} bericht     Eintrag aus PBI_CONFIG.berichte
   *  @param {(zustand:string, text?:string)=>void} [melden] Statusrückmeldung
   *  @returns {Promise<object>}  das eingebettete Report-Objekt              */
  async function zeigeBericht(el, bericht, melden = () => {}) {
    beenden(el);
    melden("laedt", "Bericht wird geladen …");

    await ladeBibliothek();
    const cfgDaten = await holeEinbettung(bericht.key);

    const models = window["powerbi-client"].models;
    const schmal = window.matchMedia("(max-width: 700px)").matches;

    const report = window.powerbi.embed(el, {
      type: "report",
      id: cfgDaten.reportId,
      embedUrl: cfgDaten.embedUrl,
      accessToken: cfgDaten.token,
      // Embed = Token des Dienstusers (nicht des Betrachters)
      tokenType: models.TokenType.Embed,
      // Nur ansehen: kein Bearbeiten, kein Speichern, kein Wechsel in den
      // Bearbeitungsmodus – weder über die Oberfläche noch über die Konsole.
      permissions: models.Permissions.Read,
      viewMode: models.ViewMode.View,
      settings: {
        layoutType: schmal ? models.LayoutType.MobilePortrait : models.LayoutType.Custom,
        customLayout: schmal ? undefined : { displayOption: models.DisplayOption.FitToWidth },
        panes: {
          filters:        { visible: bericht.filterleiste === true, expanded: false },
          pageNavigation: { visible: bericht.seitennavigation !== false }
        },
        bars: { statusBar: { visible: false } },
        background: models.BackgroundType.Transparent
      }
    });

    report.off("loaded");
    report.on("loaded", () => melden("bereit"));
    report.off("rendered");
    report.on("rendered", () => melden("bereit"));
    report.off("error");
    report.on("error", ev => {
      const d = ev?.detail || {};
      melden("fehler", fehlerText(new Error(d.detailedMessage || d.message || "")));
    });

    // Token rechtzeitig erneuern (gilt rund eine Stunde).
    const ablauf = Date.parse(cfgDaten.expiration || "");
    const vorlauf = (C.tokenErneuernVorAblaufMin || 5) * 60000;
    const wartezeit = Number.isFinite(ablauf)
      ? Math.max(60000, ablauf - Date.now() - vorlauf)
      : 50 * 60000;

    const eintrag = { report, timer: null };
    const erneuern = async () => {
      try {
        const neu = await holeEinbettung(bericht.key, "erneuerung");
        await report.setAccessToken(neu.token);
        const a2 = Date.parse(neu.expiration || "");
        eintrag.timer = setTimeout(erneuern, Number.isFinite(a2)
          ? Math.max(60000, a2 - Date.now() - vorlauf) : 50 * 60000);
      } catch (e) {
        melden("fehler", fehlerText(e));
      }
    };
    eintrag.timer = setTimeout(erneuern, wartezeit);
    _aktiv.set(el, eintrag);

    return report;
  }

  /** Vollbild des zuletzt in diesem Container eingebetteten Berichts. */
  function vollbild(el) {
    const a = _aktiv.get(el);
    if (a) try { a.report.fullscreen(); } catch {}
  }

  /** Daten neu vom Dienst holen (Aktualisieren-Schaltfläche). */
  async function neuLaden(el) {
    const a = _aktiv.get(el);
    if (a) await a.report.reload();
  }

  return { zeigeBericht, beenden, vollbild, neuLaden, fehlerText,
           holeBerichtsliste, holeEinbettung, holeZugriff,
           holeRechte, speichereRechte, holeNutzung, holeKosten };
})();
