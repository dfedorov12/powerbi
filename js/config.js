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
  // Wird `permList` unten gesetzt, muss "Sites.Read.All" ergänzt werden.
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

     `domains`   "*" oder Liste von E-Mail-Domänen, die den Bericht sehen
     `minRolle`  viewer | editor | admin  (siehe Rechteliste unten)
     `aktiv`     false blendet den Bericht aus, ohne ihn zu löschen        */
  berichte: [
    {
      key: "bericht1",
      name: "Aktuelle DIHAG Geschäftspartner",
      beschreibung: "Arbeitsbereich DEV_Reporting_Central",
      domains: "*",
      minRolle: "viewer",
      aktiv: true,
      reihenfolge: 10,
      // Anzeigeoptionen je Bericht
      seitennavigation: true,   // Reiterleiste der Berichtsseiten
      filterleiste: false       // Filterbereich rechts (nur Lesen, kein Speichern)
    }
  ],

  /* ── Rechteliste (optional) ───────────────────────────────────────
     Leer = jede angemeldete Person im Tenant ist `viewer` und sieht alle
     Berichte mit `minRolle: viewer`. Das kommt ohne Administratorzustimmung
     aus. Wer feiner steuern will, trägt hier die zentrale Liste ein und
     ergänzt oben "Sites.Read.All" in `scopes`. */
  permSite: "dihag.sharepoint.com:/sites/IT",
  permList: "",                 // z. B. "AppPermissions"
  appKey:   "powerbi",
  defaultRole: "viewer",

  // Haupt-Administrator: immer Rolle „admin“, unabhängig von der Rechteliste.
  // Sieht zusätzlich den Diagnosebereich.
  hauptAdmins: ["administrator@dihag.com", "fedorov@dihag.com"],

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
