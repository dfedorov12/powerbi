"use strict";

/* Zentrale Konfiguration – „Berichte“ (Power BI)
   ----------------------------------------------
   Einzige Stelle, an der IDs und Adressen angepasst werden.
   Die Werte mit TODO liefert `setup-powerbi.ps1` bzw. die Bereitstellung
   des Token-Brokers (siehe broker/README.md). */

const PBI_CONFIG = {

  /* ── Entra ID / Anmeldung des Betrachters ─────────────────────────
     Die Anmeldung dient hier NUR der Frage „wer bist du und darfst du
     die Seite sehen“. Der Zugriff auf Power BI läuft ausschließlich über
     den Dienstuser im Broker – Betrachter brauchen weder eine Power-BI-
     Lizenz noch eine Freigabe im Arbeitsbereich. */
  tenantId: "fdb70646-023a-403b-a4b9-1f474a935123",

  // Frontend-Registrierung (SPA, ohne Geheimnis). setup-powerbi.ps1 legt sie
  // an und gibt die ID aus. NICHT die Registrierung des Dienstusers!
  clientId: "5813fded-4258-4736-8a7a-6bcc2b76325b",   // Registrierung "Berichte-Frontend"

  // Delegierte Berechtigungen. Bewusst nur User.Read: das erlaubt jede Person
  // im Tenant selbst zu bestätigen, es braucht keine Administratorzustimmung.
  // Reicht auch für /me/getMemberGroups – damit findet der Einstellungsbereich
  // die eigenen Gruppen, ohne dass jemand zustimmen muss.
  scopes: ["User.Read"],

  // Eigener API-Bereich der Frontend-Registrierung. Damit weist sich die Seite
  // gegenüber dem Broker aus; der Broker prüft Signatur, Aussteller, Zielgruppe
  // und diesen Bereich. Leer lassen = Broker-Aufruf ohne Ausweis (nicht erlaubt).
  apiScope: "api://5813fded-4258-4736-8a7a-6bcc2b76325b/Berichte.Lesen",

  /* ── Token-Broker ─────────────────────────────────────────────────
     Kleine Azure Function, die das Geheimnis des Dienstusers hält und das
     Einbettungs-Token erzeugt. Ohne Broker geht es nicht: ein Geheimnis
     darf niemals in einer statischen Seite liegen. Ohne abschließenden
     Schrägstrich. */
  brokerUrl: "https://berichte-token-broker.azurewebsites.net/api",

  /* ── Berichte ─────────────────────────────────────────────────────
     `key` muss mit dem Schlüssel in der Broker-Einstellung PBI_BERICHTE
     übereinstimmen – nur dort stehen Arbeitsbereichs- und Bericht-ID.
     Das Frontend kennt die IDs bewusst nicht: so kann niemand über die
     Entwicklerkonsole ein Token für einen fremden Bericht anfordern.

     Hier steht nur, wie ein Bericht **heißt und aussieht**. Wer ihn sehen
     darf, entscheiden die Regeln im Broker (siehe unten).

     `aktiv`  false blendet den Bericht für alle aus, ohne ihn zu löschen  */
  berichte: [
    {
      key: "bericht1",
      name: "Aktuelle DIHAG Geschäftspartner",
      beschreibung: "Arbeitsbereich DEV_Reporting_Central",
      aktiv: true,
      reihenfolge: 10,
      // Anzeigeoptionen je Bericht
      seitennavigation: true,   // Reiterleiste der Berichtsseiten
      filterleiste: false       // Filterbereich rechts (nur Lesen, kein Speichern)
    }
  ],

  /* ── Wer darf was? ────────────────────────────────────────────────
     Steht NICHT hier, sondern im Broker: Er beantwortet /api/zugriff und
     entscheidet bei jedem Einbettungs-Token neu. Gepflegt wird das in der
     App unter „Einstellungen → Berechtigungen" (nur für Administratoren) –
     nach Benutzer, Gruppe (Sicherheits-, Microsoft-365-, Verteiler- oder
     dynamische Gruppe) oder E-Mail-Domäne.

     Warum nicht hier oder in einer SharePoint-Liste wie in den übrigen
     DIHAG-Apps: Eine Prüfung im Frontend ist nur Anzeige. Wer die
     Entwicklerkonsole öffnet, käme sonst an jeden Bericht der Freigabeliste.
     Die Haupt-Administratoren stehen in der Broker-Einstellung ADMIN_UPNS –
     sie können sich nicht selbst aussperren.                              */

  /* ── Laufzeit ─────────────────────────────────────────────────────
     Ein Einbettungs-Token gilt rund eine Stunde. So viele Minuten vor
     Ablauf wird im Hintergrund ein neues geholt, damit ein den ganzen Tag
     offenes Dashboard nicht mit „Token expired“ stehen bleibt. */
  tokenErneuernVorAblaufMin: 5,

  itMail: "ticket@dihag.com",

  // Offizielle Power-BI-Bibliothek. Liegt versioniert im Repo unter
  // js/vendor/ – falls die Datei fehlt, wird das CDN als Ersatz geladen.
  clientLibCdn: "https://cdn.jsdelivr.net/npm/powerbi-client@2.23.1/dist/powerbi.min.js"
};
