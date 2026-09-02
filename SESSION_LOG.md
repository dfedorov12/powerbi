# Session-Log · Berichte (Power BI)

## 2026-09-01 (1): Erstaufbau

**Denis:** Per App auf Power BI zugreifen und den Bericht bloß anzeigen lassen,
über ein GitHub-Frontend im Muster von `rundumdenjob`. Zugriff auf Power BI über
die REST-API **als einzelner Dienstuser**. Ausgangslage: eine Power-BI-Pro-Lizenz,
zunächst ein Bericht. Im Verlauf entschieden: **Fabric-Kapazität F4 wird gekauft.**

**Fachliche Klärung vorab (bestimmt die Bauart):**
Der Wunsch „ein Dienstuser, Betrachter ohne Lizenz" ist bei Microsoft die Variante
*Embed for your customers* (app owns data). Daraus folgen zwei Dinge, die sich
nicht wegdiskutieren lassen:

1. **Ein statisches Frontend allein reicht nicht.** Das Geheimnis des Dienstusers
   darf nicht auf GitHub Pages liegen, und nur mit ihm lässt sich ein
   Einbettungs-Token erzeugen. Deshalb ein Token-Broker als Azure Function.
2. **Produktiv verlangt Microsoft eine Kapazität** (F/A/EM/P-SKU). Mit reiner
   Pro-Lizenz gibt es nur begrenzte Test-Token mit Banner. Mit der gekauften
   **F4** entfällt das: keine Begrenzung, kein Banner, Betrachter ohne Lizenz.

**Umgesetzte Architektur:**

```
Browser → Entra (PKCE)  →  Broker (Azure Function, hält das Geheimnis)
                              → Power BI GenerateToken (accessLevel: View)
Browser → Power BI (Anzeige mit dem Einbettungs-Token)
```

**Dateien (neu):**
- `index.html` – Boot-Bildschirm, Kopfbereich mit Werkzeugen (Aktualisieren,
  Vollbild, Diagnose), Reiterleiste ab zwei Berichten, Berichtsrahmen mit
  Statusebene, Diagnosefenster.
- `css/styles.css` – DIHAG CD (Azur #17509E, Navy #1A2644, Anthrazit #424241,
  Lichtblau #99B7CD, Orange #F08300, Exo); Berichtsrahmen mit fester Mindesthöhe,
  weil die Power-BI-Bibliothek sonst einen 0 Pixel hohen iframe rendert.
- `js/config.js` – einzige Anpassstelle. Enthält bewusst **keine** Power-BI-IDs,
  nur den Schlüssel je Bericht (siehe Broker).
- `js/auth.js` – PKCE wie in `rundumdenjob`, erweitert um **Token für zwei
  Zielgruppen**: Entra gibt pro Anmeldung nur Token für eine Zielgruppe aus, die
  App braucht Graph *und* den eigenen Broker. Gelöst über `offline_access` und
  das Einlösen des Aktualisierungs-Tokens, mit Serialisierung (Entra verwirft bei
  jedem Einlösen das alte Aktualisierungs-Token – parallele Aufrufe würden sich
  gegenseitig ungültig machen).
- `js/graph.js` – schlank: Profil, optional die Rechteliste.
- `js/data.js` – Benutzerkontext, Rolle, `istSichtbar` (Aktiv + Rolle + Domäne).
- `js/embed.js` – Broker-Aufruf, Einbettung mit `tokenType: Embed`,
  `Permissions.Read`, `ViewMode.View`; Token-Erneuerung fünf Minuten vor Ablauf;
  Fehlerübersetzung in Klartext samt nächstem Schritt.
- `js/app.js` – Oberfläche, Diagnosebereich für Administratoren.
- `broker/` – Azure Function (Node 20), **ohne Fremdbibliotheken**: die
  JWT-Prüfung (JWKS, Signatur, Aussteller, Mandant, Zielgruppe, Laufzeit,
  Bereich) ist in `src/lib/entra.js` mit Bordmitteln umgesetzt.
- `broker/test/entra.test.js` – 11 Tests gegen selbst erzeugte Schlüssel.
- `tests/test-sichtbarkeit.mjs` – 8 Tests, wertet die ausgelieferten Dateien aus.
- `setup-powerbi.ps1` – legt beide Registrierungen, den API-Bereich und die
  Sicherheitsgruppe an und gibt alle Werte aus.

**Tragende Entscheidungen (nicht aus dem Code ableitbar):**
- **Zwei getrennte Registrierungen**: Frontend (SPA, öffentlich, ohne Geheimnis)
  und Dienstuser (vertraulich, mit Geheimnis). Beides in einer Registrierung
  wäre bequemer, vermischt aber öffentliche und vertrauliche Anmeldung.
- Die Dienstuser-Registrierung bekommt **bewusst keine Graph-Berechtigungen** –
  Microsoft rät ausdrücklich davon ab; Power BI erlaubt den Zugriff über die
  Mandanteneinstellung und die Mitgliedschaft im Arbeitsbereich.
- **Arbeitsbereichs- und Bericht-IDs stehen nur im Broker** (`PBI_BERICHTE`).
  Das Frontend kennt nur einen Schlüssel. Sonst könnte man sich über die
  Entwicklerkonsole ein Token für jeden Bericht des Dienstusers ausstellen lassen.
- **Rechteliste `AppPermissions` ist abschaltbar** und standardmäßig aus: so
  kommt die App mit `User.Read` aus und braucht keine Administratorzustimmung.
  Verbindlich ist ohnehin die Freigabeliste im Broker.
- **Keine Fremdbibliothek im Broker** (keine `jose`): die JWT-Prüfung ist mit
  `node:crypto` überschaubar, und jede eingesparte Abhängigkeit ist eine
  Abhängigkeit weniger im Pfad eines Geheimnisses.
- CORS setzt der Broker selbst; die CORS-Liste der Function App im Portal bleibt
  leer, sonst kämen die Kopfzeilen doppelt.

**Manuell offen:**
1. `setup-powerbi.ps1` ausführen, Geheimnis notieren.
2. Power-BI-Administrationsportal: „Dienstprinzipale dürfen Power-BI-APIs
   verwenden" (für die Gruppe `PowerBI-Einbettung`) und „Inhalte in Apps
   einbetten" aktivieren.
3. Dienstuser als Mitglied in den Arbeitsbereich; Arbeitsbereich der F4 zuweisen.
4. Function App anlegen, Umgebungsvariablen setzen,
   `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` als Repository-Geheimnis hinterlegen.
5. `js/config.js` mit `clientId`, `apiScope`, `brokerUrl` füllen.

## 2026-09-01 (2): Token-Broker fertig gebaut

**Denis:** „Bau mir mal den Token-Broker."

Der Code lag bereits aus (1) vor; gefehlt haben der Nachweis, dass die Endpunkte
tun was sie sollen, und ein Weg, das Ganze ohne Klickerei nach Azure zu bringen.

**Neu:**
- `broker/test/api.test.js` – 15 Tests, die die Endpunkte vollständig
  durchspielen: `@azure/functions` wird durch eine Attrappe ersetzt, die die
  registrierten Handler einsammelt, `fetch` beantwortet Entra und Power BI. Damit
  laufen die echten Handler gegen echte Signaturprüfung, ohne Azure und ohne
  Mandanten. Abgesichert sind vor allem die Fälle, die zählen: ohne Ausweis kein
  Token (Power BI wird gar nicht erst gefragt), fremde Zielgruppe, fremde Domäne,
  unbekannter Schlüssel, **untergeschobene `workspaceId`/`reportId` im Aufruf
  ändern nichts**, `accessLevel` ist immer `View`, das Token des Dienstusers
  taucht in keiner Antwort auf, CORS nur für die erlaubte Herkunft.
- `broker/setup-broker.ps1` – legt Ressourcengruppe, Speicherkonto und Function
  App (Node 20, Linux, Verbrauchsplan) an, setzt alle Einstellungen, **leert die
  Plattform-CORS-Liste** und hinterlegt auf Wunsch (`-GithubGeheimnis`) das
  Veröffentlichungsprofil als Repository-Geheimnis.
- `broker/package-lock.json` – Abhängigkeiten festgezurrt (`@azure/functions` 4.8.2,
  keine weitere).

**Entscheidungen:**
- Das Geheimnis geht nur als `SecureString` ins Skript, wird nie ausgegeben und
  nirgends in eine Datei geschrieben; das Veröffentlichungsprofil wandert direkt
  in `gh secret set`, ohne Zwischendatei.
- Die Plattform-CORS-Liste wird aktiv geleert. Eine neue Function App bringt
  Portal-Herkünfte mit; stehen die Kopfzeilen doppelt, lehnt der Browser die
  Antwort ab – ein Fehlerbild, das man sonst lange sucht.
- `WEBSITE_RUN_FROM_PACKAGE=1`, weil der Workflow ein Paket veröffentlicht.
- Ort `germanywestcentral` als Vorgabe.

**Stand:** 26 Broker-Tests und 8 Sichtbarkeitstests grün. Was jetzt noch fehlt,
ist ausschließlich das, was ohne Azure-Abonnement und Power-BI-Administrator
niemand vorwegnehmen kann: `az login`, das Skript laufen lassen, die
Mandanteneinstellungen setzen, Arbeitsbereich der F4 zuweisen.

## 2026-09-02 (3): Broker steht in Azure

**Denis:** Frontend-Registrierung `Berichte-Frontend`
(`5813fded-4258-4736-8a7a-6bcc2b76325b`, Objekt `2db1c573-…`) selbst angelegt,
dazu Workspace `bc0c9d17-…` und Report `ef3cebdd-…`; Dienstuser
`fabric_report_service_user` soll erstellt werden.

**Gebaut (alles über die Azure CLI, Microsoft.Graph ist hier nicht installiert):**
- Dienstuser `fabric_report_service_user` – AppId `c75f174c-1d0e-4389-9a93-cd27f25ccbcd`,
  Dienstprinzipal `3f7eec3a-7812-4ea0-8fbe-7953da00f6d3`.
- Frontend-Registrierung ergänzt: `api://5813fded-…` als identifierUri,
  Bereich `Berichte.Lesen` (Typ *User*), Tokenversion 2, Selbst-Vorautorisierung,
  Redirect `http://localhost:8774/` für den Testserver.
- Azure: `rg-berichte-broker` in **westeurope** (dort liegt die F4), Speicherkonto
  `stberichte127222`, Function App **`berichte-token-broker`** im
  **Flex-Verbrauchsplan mit Node 24**, TLS 1.2, alle neun Einstellungen gesetzt.
  Geheimnis (2 Jahre) direkt aus `az ad app credential reset` in die App-Einstellung
  gepipet – es wurde nie ausgegeben und nie in eine Datei geschrieben.
- Code als Paket mit `node_modules` veröffentlicht (640 KB), `/api/health` meldet
  `eingerichtet: true`.
- Dienstuser als **Member** in `DEV_Reporting_Central` eingetragen.

**Auf dem Weg gelernt (Fallstricke, die im Code stehen sollten):**
1. **Node 20 ist seit 30.04.2026 EOL**, Azure lehnt `--runtime-version 20` ab.
   Jetzt Node 24 + Flex-Verbrauchsplan (der klassische läuft 2028 aus).
   `WEBSITE_RUN_FROM_PACKAGE` gibt es im Flex-Plan nicht.
2. **Graph lehnt Bereich + Vorautorisierung in einem PATCH ab**
   („Permission Id that cannot be found in the AppPermissions sets"). Erst den
   Bereich anlegen, dann vorautorisieren – und dabei `api` komplett erneut
   schicken, weil PATCH die ganze Eigenschaft ersetzt. `setup-powerbi.ps1` hatte
   genau diesen Fehler und ist korrigiert.
3. **Die Dataset-Rechte-API nimmt keine Dienstprinzipale**
   („API supported only for User or Group principal types") – Zugriff auf ein
   Semantikmodell geht nur über die Arbeitsbereichsrolle oder eine Entra-Gruppe.
4. Bei Flex-Apps liegt die Ausgabe von `az functionapp show` unter `properties.*`,
   nicht auf oberster Ebene.

**Ende-zu-Ende geprüft** (Azure CLI kurzzeitig für `Berichte.Lesen`
vorautorisiert, danach wieder entfernt): Ausweisprüfung greift, der Dienstuser
darf den Bericht lesen – aber `GenerateToken` scheitert mit
`PowerBINotAuthorizedException` (HTTP 401).

**Ursache gefunden:** `datasetWorkspaceId` des Berichts ist
`226be186-189e-4aa1-914f-773f96ea0b0b` (**`DEV_Semantic_Models_Central`**,
Modell „Aktuelle DIHAG Geschäftspartner", Besitzer kutscher@dihag.com) – ein
anderer Arbeitsbereich als der des Berichts. Beide liegen auf derselben F4.
Die Mandanteneinstellungen sind korrekt: *Embed content in apps* = True,
*Service principals can call Fabric public APIs* = True.

**Offen (Entscheidung Denis):** Wie bekommt der Dienstuser Zugriff auf
`DEV_Semantic_Models_Central` – direkt als Rolle oder über die dort übliche
Entra-Gruppe (`Fabric_WS_Semantic_Models_Central_Viewer` / `_Member`)?
Der Arbeitsbereich gehört Kutscher.

**Nachtrag:** Im Flex-Verbrauchsplan ist die SCM-Basisauthentifizierung aus
(`basicPublishingCredentialsPolicies/scm.allow = false`) – ein
Veröffentlichungsprofil wird abgewiesen. `deploy-broker.yml` meldet sich deshalb
jetzt per **OpenID Connect** an (Repository-*Variablen*, keine Geheimnisse); die
einmalige Einrichtung der föderierten Anmeldeinformation steht im Kopf der
Workflow-Datei. Bis dahin: `az functionapp deployment source config-zip`.

**Entscheidung Denis:** Zugriff auf `DEV_Semantic_Models_Central` wird erst mit
Kutscher geklärt – der Arbeitsbereich bleibt unangetastet.
