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

## 2026-09-04 (4): Rechte erteilt, Direct Lake entlarvt, Ende zu Ende gruen

**Denis:** „Gib ihm mal die Rechte und teste." (Damit ist die Entscheidung aus
(3) – erst mit Kutscher klaeren – ueberholt.)

**Vorgehen:** Direkte Arbeitsbereichsrolle statt Entra-Gruppe, weil
Gruppenmitgliedschaften in Power BI bis zu einer Viertelstunde brauchen und
der Test sofort belastbar sein sollte.

**Erster Testlauf war ungueltig** – lehrreich genug fuer einen Eintrag: die
Token-Beschaffung selbst scheiterte mit `AADSTS65001` (die Vorautorisierung der
Azure CLI war noch nicht propagiert), also lief jeder Aufruf ohne Ausweis ins
401. Das sah aus wie „Rolle reicht nicht", war aber ein Messfehler. Seitdem:
erst Token holen und pruefen, dann testen.

**Der eigentliche Befund:** Mit gueltigem Ausweis kam nicht mehr
`PowerBINotAuthorizedException`, sondern

> `Embedding a DirectLake dataset is not supported with V1 embed token`

Das Semantikmodell ist ein **Direct-Lake-Modell**. Der berichtsbezogene
Endpunkt (`/groups/…/reports/…/GenerateToken`, „V1") kann das grundsaetzlich
nicht. Broker umgestellt auf den mandantenweiten **V2-Endpunkt**
`POST /v1.0/myorg/GenerateToken` mit `datasets` + `reports`; Nur-Lesen ergibt
sich dort aus `allowEdit: false` statt `accessLevel: View`. `targetWorkspaces`
bleibt bewusst weg – das ist fuer „Bericht neu anlegen" und verlangt
Schreibrechte. Nebenbei loest V2 auch den Fall „Modell in einem anderen
Arbeitsbereich" sauber.

**Ergebnis:** HTTP 200, Einbettungs-Token mit 1905 Zeichen fuer
„Aktuelle DIHAG Geschaeftspartner", CORS-Kopf korrekt.

**Rechte auf die kleinste Stufe zurueckgedreht und nachgemessen:**
Microsoft dokumentiert *Member*; geprueft reicht in **beiden** Arbeitsbereichen
**Viewer** – `DEV_Reporting_Central` und `DEV_Semantic_Models_Central`. Beide
Male erst herabgestuft, dann getestet, nicht umgekehrt angenommen.

**Aufgeraeumt:** Die temporaere Vorautorisierung der Azure CLI ist entfernt
(nachgeprueft: nur die App selbst steht drin), das zwischengespeicherte
Test-Token geloescht.

**Nebenbefund:** Node ist hier inzwischen v24; `node --test <verzeichnis>`
funktioniert nicht mehr, deshalb `node --test test/*.test.js` im Testskript.

**Stand:** 26 Broker-Tests und 8 Sichtbarkeitstests gruen, Broker liefert echte
Token. Offen bleibt nur die OIDC-Identitaet fuer das automatische Deployen.

**Nachtrag am selben Tag – eigene Domaene und CORS:**
Denis hat waehrenddessen per GitHub-Oberflaeche eine `CNAME` fuer
**powerbi.dihag.de** angelegt. Nachgezogen: Redirect-URI in der
Frontend-Registrierung (sonst AADSTS50011, weil `auth.js` die Adresse aus dem
Aufruf ableitet) und `ALLOWED_ORIGINS` im Broker.

Dabei kam eine **falsche Annahme aus (1) ans Licht**: Dort stand, die
Plattform-CORS-Liste der Function App muesse leer bleiben, sonst gaebe es
doppelte Kopfzeilen. Gemessen stimmt das Gegenteil:

- Der Functions-Host beantwortet `OPTIONS` **selbst**; die Vorabfrage erreicht
  den Code nie. Ist seine Liste leer, antwortet er `204` voellig ohne
  Kopfzeilen – der Browser bricht ab, bevor die eigentliche Anfrage gestellt
  wird. Genau das war reproduzierbar zu sehen: GET trug die Kopfzeilen
  (aus dem Code), OPTIONS gar keine.
- Mit gefuellter Plattformliste **doppelt sich nichts**: die Plattform setzt die
  Kopfzeilen nur auf der Vorabfrage, der Code nur auf den uebrigen Antworten
  (nachgezaehlt: genau ein `Access-Control-Allow-Origin`).
- Die Liste greift erst **nach einem Neustart** der App.

`setup-broker.ps1` haette die Liste geleert und damit jede neu aufgebaute
Instanz unbrauchbar gemacht – korrigiert: es setzt die Herkuenfte jetzt und
startet die App neu. Kommentare in `api.js` und beide READMEs entsprechend.

**Abschlusstest von https://powerbi.dihag.de aus:** HTTP 200 mit
Einbettungs-Token (1901 Zeichen), `Access-Control-Allow-Origin` korrekt;
unbekannter Schluessel 404, ohne Ausweis 401. Vorautorisierung der Azure CLI
wieder entfernt (nachgeprueft).

**Nachtrag 2 – die Kette geht ueber DREI Arbeitsbereiche:**
Nach dem erfolgreichen Einbetten meldete der Bericht im Browser
*„Es konnte keine Verbindung mit der Datenquelle … hergestellt werden"* mit
einer TDS-Adresse auf `…datawarehouse.fabric.microsoft.com`. Ursache: Das
Direct-Lake-Modell greift **per SSO mit der Identitaet des Dienstusers** auf die
Daten durch. Ueber die Fabric-Admin-API liess sich die Element-Id aufloesen:
SQL-Endpunkt des Lakehouse **`lh_gold`** im Arbeitsbereich
**`DEV_Data_Engineering_Central`** (`15c16a40-…`) – ein *dritter* Arbeitsbereich.
Dort ebenfalls *Viewer* erteilt (Praezedenzfall war vorhanden: der
`MSFabricConnector Service User Dev` steht dort als Contributor).

Die Kette lautet damit: **Bericht → Semantikmodell → Lakehouse**, jeweils in
einem eigenen Arbeitsbereich, ueberall Rolle *Viewer*.

**Nachgewiesen durch echtes Rendern**, nicht nur durch den Token: temporaere
Seite `_test-embed.html` (gitignore) auf localhost:8774 mit frischem
Einbettungs-Token, powerbi-client, Ereignisprotokoll. Ergebnis: `loaded`,
`rendered`, **kein** `error` – und im Bild die vollstaendig gefuellte Tabelle.
Testseite und zwischengespeicherte Token danach geloescht, Vorautorisierung der
Azure CLI entfernt (alles nachgeprueft).

**Auf Wunsch von Denis:** Fussleiste entschlackt – „nur Ansicht", der Verweis
auf „Rund um den Job" und „Support" sind raus, es bleibt
„DIHAG Foundry Group · Berichte aus Power BI".

## 2026-09-04 (5): Rechteschicht davor

**Denis:** „Jetzt will ich eine Schicht davor, die Berechtigung in den
Einstellungen ermoeglichen als Administrator. Kannst auch abgucken, nach User,
Verteilergruppe, Sicherheitsgruppe, Domaene."

**Abgeschaut** bei `besuchermanagement`: dort werden Gruppenfreigaben ueber
`POST /me/getMemberGroups` mit `securityEnabledOnly: false` aufgeloest – das
liefert **alle** Gruppentypen transitiv (Sicherheits-, Microsoft-365-,
Verteiler-, dynamische) und kommt mit `User.Read` aus, also ohne
Administratorzustimmung. Die Oberflaeche lehnt sich an
`rundumdenjob/js/set-rechte.js` an (Karten, Tabellen, Merkmalspillen).

**Tragende Entscheidung:** Die Regeln liegen **im Broker**, nicht im Frontend
und nicht in einer SharePoint-Liste. Eine Pruefung im Frontend waere nur
Anzeige – wer die Entwicklerkonsole oeffnet, kaeme sonst an jeden Bericht der
Freigabeliste. Ablage: Azure Table Storage (`Rechte`) im ohnehin vorhandenen
Speicherkonto der Function App.

**Modell:** Regel = Prinzipal (`benutzer` | `gruppe` | `domaene`) + Berichte
(`*` oder Liste) + `admin` + `aktiv`. Gruppen werden ueber die **Objekt-Id**
verglichen, nie ueber den Namen – ein umbenannter Anzeigename darf keine
Berechtigung still verschieben. Solange keine Regel existiert, gilt die
bisherige Domaenenregelung; ab der ersten Regel gilt ausschliesslich sie.

**Neu:**
- `broker/src/lib/rechte.js` (reine Auswertung), `broker/src/lib/speicher.js`
  (Table Storage, Transaktion je 100 Vorgaenge, 30 s Zwischenspeicher).
- Endpunkte `GET /api/zugriff`, `GET/PUT /api/rechte`; Durchsetzung in
  `/api/embed-token`.
- `js/set-rechte.js` (Einstellungen), Kopf-Schaltflaeche, Formular mit
  Gruppenauswahl aus den eigenen Gruppen.
- 29 zusaetzliche Tests (jetzt 55 im Broker, 8 im Frontend).

**Aufgeraeumt:** Die alte, jetzt doppelte Rechtelogik ist raus – `AppPermissions`,
`permList`, `minRolle`, `domains`, `hauptAdmins` in `js/config.js` und der
SharePoint-Teil von `js/graph.js`. Zwei Quellen fuer dieselbe Frage sind eine
zu viel. Ein Test wacht darueber, dass sie nicht zurueckkommen.

**Live geprueft:** Token traegt 35 Gruppen (kein Ueberlauf); Schreiben, Lesen,
Eingabepruefung und eine **Gruppenregel** funktionieren gegen den echten
Broker – mit voruebergehend entferntem `ADMIN_UPNS`, damit die Regeln
ueberhaupt zum Zug kommen.

### Zwei eigene Fehler, die der Lauf aufgedeckt hat

1. **„Viewer genuegt" war falsch.** Power BI merkt sich
   Berechtigungsentscheidungen einige Minuten. Der Test direkt nach dem
   Herabstufen von *Member* auf *Viewer* lief noch gegen den alten Stand und
   meldete 200. Minuten spaeter scheiterte `GenerateToken` reproduzierbar mit
   401. Bericht und Semantikmodell brauchen **Member**; nur der
   Lakehouse-Arbeitsbereich kommt mit *Viewer* aus. Korrigiert und dokumentiert –
   nach Rechteaenderungen muss man warten und erneut pruefen.
2. **Zwei Testregeln blieben produktiv stehen.** Das Aufraeumen am Ende des
   Gruppentests schickte `regeln: []`, wurde aber vom eigenen Aussperr-Schutz
   mit 400 abgewiesen (der Aufrufer war nur ueber eine Regel Administrator) –
   und die Antwort ging nach `Out-Null`, der Fehler blieb unsichtbar. Damit war
   kurzzeitig deny-by-default aktiv. Aufgefallen ist es nur, weil
   `/api/health` seither die Regelzahl mitmeldet. Direkt in der Tabelle
   entfernt, Stand wieder 0. Lehre: Rueckgaben von Aufraeumschritten pruefen,
   nicht verwerfen.

## 2026-09-04 (6): Verbrauch sichtbar, fedorov kein Haupt-Administrator mehr

**Denis:** „fedorov@dihag.com als Admin rausnehmen. Wie viel Verbrauch entsteht
bei einem Oeffnen des Berichts haette ich gerne als admin sichtbar."

**1) Haupt-Administration:** `ADMIN_UPNS` steht jetzt nur noch auf
`administrator@dihag.com` – wie in [[project-zapp]] und [[project-rundumdenjob]],
wo Denis bewusst normaler Nutzer ist. Auch in `setup-broker.ps1` als Vorgabe
nachgezogen.

**2) Verbrauch.** Erst die Datenlage geprueft, statt drauflos zu bauen:
- **Azure Monitor** kennt fuer `Microsoft.Fabric/capacities` **keinen**
  Metrik-Namensraum (nur das alte `Microsoft.PowerBIDedicated`). Sackgasse.
- Die App **„Microsoft Fabric Capacity Metrics"** ist dreimal installiert. Eine
  Instanz ist abfragbar, aber leer („Select a capacity from dropdown"), die
  beiden befuellten antworten meinem Konto mit **401** – sie gehoeren einem
  anderen Team.

Daraus die Bauart: **zwei getrennte Quellen, ehrlich ausgewiesen.**
- *Öffnungen, Erneuerungen, Personen* zaehlt der Broker selbst (Tabelle
  `Nutzung`, Tag als Partition). Exakt, weil jedes Einbettungs-Token durch ihn
  geht. Öffnung und **Token-Erneuerung** getrennt: ein den ganzen Tag offenes
  Dashboard holt sich stuendlich ein neues Token und kostet weiter Kapazitaet,
  ist aber kein neuer Aufruf. „CU je Öffnung" teilt deshalb durch beides.
- *CU* kommt aus dem Semantikmodell der Metrik-App
  (`MetricsByItemandOperationandDay`: `sum_CU`, `count_operations`), abgefragt
  per DAX ueber `executeQueries` – zusammengefasst ueber **Bericht und
  Semantikmodell**, weil der groessere Teil beim Modell anfaellt. Fehlt der
  Zugriff, sagt die Oberflaeche **was genau fehlt**, statt „–" oder, schlimmer,
  einer Schaetzung.

**Datenschutz mitgedacht:** gespeichert werden nur Zeitpunkt, Berichtsschluessel
und Adresse; Loeschung nach `NUTZUNG_TAGE` (90) laeuft beim Lesen mit;
`NUTZUNG_ANONYM=1` ersetzt die Adresse durch einen **taeglich wechselnden**
Kurz-Hash – Nutzerzahlen bleiben zaehlbar, Personen nicht mehr nachvollziehbar.

**Neu:** `broker/src/lib/nutzung.js`, `broker/src/lib/metriken.js`,
Endpunkt `GET /api/nutzung`, `js/set-nutzung.js`, Unterreiter im
Einstellungsfenster. 11 neue Tests (66 im Broker, 8 im Frontend).

**Live geprueft:** zwei Aufrufe erzeugt (einer als Erneuerung markiert),
`/api/nutzung` meldet 1 Öffnung, 1 Erneuerung, 1 Person – und beim CU-Teil
sauber `verfuegbar: false, grund: nicht_eingerichtet`.

**Nebenbei repariert:** Der GitHub-Workflow schlug bei jedem `broker/`-Push
fehl, weil ich ihn auf OIDC umgestellt hatte, die Identitaet aber noch nicht
existiert. Er wird jetzt uebersprungen, solange die Variablen fehlen – ein rot
blinkendes Repository, das nur „noch nicht eingerichtet" meint, nuetzt niemandem.

**Beobachtung, nicht angetastet:** In der Regeltabelle steht seit 10:30 eine
Regel `benutzer fedorov@dihag.com -> bericht1` (angelegt ueber die Oberflaeche,
nicht von mir). Damit ist deny-by-default aktiv: ausser fedorov sieht derzeit
**niemand** ausser dem Haupt-Administrator den Bericht.

## 2026-09-04 (7): Kapazitaetsmetriken angebunden – bis auf einen Klick

**Denis:** „Microsoft Fabric Capacity Metrics anbinden." Spaeter praezisiert:
„eig soll ja auch nur der admin die CU sehen."

**Ausgangslage geklaert.** Drei Installationen der Metrik-App im Mandanten:
- `60a85b76…` (10.12.2025) – gehoert Mike Weber, fuer uns nicht lesbar
- `86efefab…` (23.3.2026) – ohne Mitglieder, fuer uns nicht lesbar
- `ea003234…` (ohne Datum) – **`Fabric_Administratoren` ist dort Admin**, also unsere

(Beim ersten Anlauf hatte ich Arbeitsbereiche und Semantikmodelle falsch
gepaart und daraus 401 gelesen. Mit der richtigen Zuordnung blieb es bei 401 –
die beiden sind wirklich fremd.)

**Ursache gefunden:** Unsere Instanz war seit **Juli 2025** kaputt. Der
Refresh-Fehler war eindeutig: *„No capacities found. You need to be a capacity
admin of at least one or more capacities."* Konfiguriert war sie von
`peter.zimmermann@areto.de` – einem externen Berater ohne Kapazitaetsrechte.

**Gemacht:**
1. Semantikmodell auf `administrator@dihag.com` uebernommen (`Default.TakeOver`)
   – der ist Kapazitaetsadministrator der F4.
2. Danach `ModelRefreshFailed_CredentialsNotSpecified`; Anmeldeinformationen per
   Gateway-API mit einem Power-BI-Zugriffstoken gesetzt – **angenommen**.
3. Aktualisierung: **Completed** in 18 s. Seitdem stehen `kapdihagdpwesteurope`
   (F4) und unser Semantikmodell „Aktuelle DIHAG Geschaeftspartner" im Modell.
4. Dienstuser als **Contributor** in den Metrik-Arbeitsbereich (fuer
   `executeQueries` reicht *Viewer* nicht – Build-Recht noetig).
5. `METRIK_WORKSPACE`, `METRIK_DATASET`, `PBI_KAPAZITAET_ID` in der Function App.

**Wo es haengt:** Die Faktentabellen (`MetricsByItem*`) sind DirectQuery und
antworten mit *„Internal Error: Error obtaining data location"* – die
Dimensionstabellen (Items, Capacities, TimePoints, Dates) dagegen sauber. Das per
API gesetzte Zugriffstoken reicht fuer die Aktualisierung der Importtabellen,
aber nicht fuer die DirectQuery-Aufloesung. Auch der Kapazitaetsfilter im DAX
(`TREATAS` auf `Capacities[capacityId]`, jetzt fest eingebaut) aendert daran
nichts, und `useEndUserOAuth2Credentials` lehnt der Konnektor mit 400 ab.

**Ergebnis:** Der letzte Schritt geht nur ueber die Oberflaeche – einmal
*Einstellungen → Datenquellen-Anmeldeinformationen → Anmelden* am
Semantikmodell, mit einem Kapazitaetsadministrator. Der Broker benennt genau
diesen Zustand jetzt als `anmeldung_fehlt` samt Anleitung, statt „Grund
unbekannt". Zusaetzlich neu: `keine_daten` fuer „angebunden, aber noch leer".

**Zur Rueckfrage (nur Admins sehen CU):** War bereits so – `/api/nutzung` haengt
am selben `verwalter`-Gate wie die Berechtigungen, die Schaltflaeche ist fuer
andere ausgeblendet. Es fehlten aber die **Tests** dafuer; jetzt belegt:
Nicht-Admin 403, ohne Ausweis 401, Administrator-per-Regel 200. Dabei fiel auf,
dass in `api.test.js` die Attrappen fuer Zaehlung und Metriken fehlten (der
Endpunkt lief in einen 500er) – ergaenzt und gleich mitgeprueft, dass eine
Oeffnung als `oeffnen`, eine Erneuerung als `erneuern` und ein abgewiesener
Aufruf **gar nicht** gezaehlt wird.

**Achtung:** Das per API gesetzte Token laeuft nach etwa einer Stunde ab – dann
scheitert auch die geplante Aktualisierung wieder. Die Anmeldung ueber die
Oberflaeche ersetzt es dauerhaft.

**Nachtrag zu (7): Anmeldung war da, die Grenze liegt woanders.**
Denis hat die Datenquellen-Anmeldung im Portal gesetzt (`credentialType: OAuth2`,
Besitzer `administrator@dihag.com`), eine Aktualisierung lief erneut sauber
durch – die **Faktentabellen bleiben trotzdem unabfragbar**:
*„Internal Error: Error obtaining data location."*

Durchgespielt und jedes Mal derselbe Fehler: TREATAS auf
`Capacities[capacityId]`, TREATAS auf `MetricsByItemandOperationandDay[PremiumCapacityId]`,
`CALCULATE`, `CALCULATETABLE`, sowie die Aggregattabellen `MetricsByItem` und
`MetricsByItemandDay`. Die Dimensionstabellen (`Items`, `Capacities`,
`TimePoints`, `Dates`) antworten dagegen einwandfrei. `INFO.EXPRESSIONS()` und
`INFO.PARTITIONS()` sind ueber diesen Weg nicht verfuegbar, `INFO.VIEW.*` schon.

**Schlussfolgerung:** Die Faktentabellen loesen ihre Datenquelle ueber
**dynamische M-Parameter** auf, die an Datenschnitte des Berichts gebunden sind.
Diesen Berichtskontext gibt es ueber `executeQueries` nicht – das ist eine
Eigenschaft der Metrik-App, nicht ein Fehler in Anmeldung, Rechten oder DAX.

**Konsequenz statt Verbiegen:** Neuer Zustand `directquery` mit klarer Erklaerung
und einer Schaltflaeche **„CU in der Metrik-App ansehen"**, die direkt in deren
Bericht fuehrt (`METRIK_BERICHT_URL`). Der Abfragecode bleibt: Liefert die App
eines Tages Zeilen, fuellt sich die Spalte von selbst. Getrennt davon jetzt auch
`anmeldung_fehlt` – die beiden Zustaende darf man nicht verwechseln.

## 2026-09-04 (8): Kostenanalyse; Metrik-App bleibt defekt

**Denis:** Kostenanalyse als Administrator, dazu der Screenshot der Metrik-App
mit `QueryUserError` und Cluster `wabi-germany-west-central`.

### Der Screenshot hat meine vorige Schlussfolgerung korrigiert

Ich hatte geschrieben, die CU-Zahlen seien „eine Grenze von `executeQueries`".
Der Screenshot zeigt: **Der Bericht der Metrik-App scheitert selbst** an
denselben Visuals („This might be caused by a capacity or license issue").
Es ist also kein API-Thema, sondern die DirectQuery-Verbindung dieser
Installation ist grundsaetzlich defekt.

Daraufhin geprueft und behoben, was in unserer Hand lag:
- Der Metrik-Arbeitsbereich lag auf **shared capacity**
  (`isOnDedicatedCapacity: False`) – genau das, was „capacity issue" meint.
  Der **F4 zugewiesen**; bestaetigt (`dediziert=True`).
- Trotzdem: Faktentabellen weiterhin `Error obtaining data location`,
  Dimensionstabellen weiterhin einwandfrei.

**Stand:** Uebernahme, Anmeldung, Aktualisierung, Kapazitaetszuweisung und
Dienstuser-Zugriff sind erledigt – die DirectQuery-Schicht dieser Installation
bleibt kaputt. Weitere Blindversuche waeren Zeitverschwendung; die App bringt
ihre eigene Diagnose nicht heraus. Ein sauberer Neuinstall der Metrik-App
(eigener Arbeitsbereich, Installation durch einen Kapazitaetsadministrator)
waere der naechste sinnvolle Schritt – das ist eine UI-Aktion.

### Kostenanalyse gebaut

Statt weiter an CU-Zahlen zu ziehen, die diese Installation nicht hergibt: die
**echten Kosten** aus Azure Cost Management. Die API antwortet zuverlaessig.

- `broker/src/lib/kosten.js`: `client_credentials` fuer
  `management.azure.com`, **eine** Abfrage ueber beide Monate (Custom-Zeitraum
  ab dem Ersten des Vormonats, `granularity: "Monthly"`), gruppiert nach
  Ressourcengruppe, gefiltert auf die eigenen; Aufteilung in
  „Fabric-Kapazitaet" und „uebrige".
- Endpunkt `GET /api/kosten` (nur Administratoren), eine Stunde zwischengespeichert.
- Rolle **Cost Management Reader** fuer den Dienstuser auf dem Abonnement erteilt.
- Oberflaeche: Kostenkarte in der Verbrauchsansicht mit laufendem Monat,
  Vormonat, Aufteilung je Ressourcengruppe und Verweis in die Kostenanalyse.

**Zwei Eigenheiten, die Arbeit gemacht haben:**
1. Cost Management **drosselt** viel haerter als gedacht. Erster Entwurf: beide
   Zeitraeume **parallel** – sofort im Limit. Zweiter Entwurf: nacheinander mit
   Wiederholungsleiter – gemessen am 04.09.2026 trotzdem 429, bei **acht
   Sekunden** Abstand. Keine Wartezeit holt das zuverlaessig ein, also: **eine
   einzige Abfrage** fuer beide Monate. Und wenn die gedrosselt wird, liefert
   der Broker den zuletzt bekannten Stand mit sichtbarem Zeitpunkt statt einer
   Fehlermeldung.
2. Ein **429 ist eine gute Nachricht**: Azure drosselt nur authentifizierte und
   autorisierte Aufrufe. Bei fehlender Rolle kaeme 403. Direkt als Dienstuser
   nachgemessen: `MonthToDate` = HTTP 200 mit `rg-dihag-dp-dev-westeurope`
   49,78 EUR und `rg-berichte-broker` 0,00 EUR. Der Zugriff steht also; das
   Ratenlimit war rein selbst verursacht durch das viele Testen.

**Inhaltlich wichtig – und in der Oberflaeche so gesagt:** Eine Oeffnung kostet
**nichts extra**. Die Kapazitaet wird pro Stunde bezahlt, nicht pro Aufruf. Die
ausgewiesene Zahl „je Aufruf" ist eine **Vollkostenrechnung** (Monatskosten
geteilt durch Aufrufe) und ausdruecklich keine Grenzkosten – sie sinkt mit jeder
weiteren Nutzung. Wer sparen will, schaut auf Auslastung und SKU, nicht auf
Klicks.

**Zahlen zur Einordnung** (laufender Monat, gemessen): `rg-dihag-dp-dev-westeurope`
mit der F4 **49,78 EUR**, `rg-berichte-broker` **0,00 EUR** – der Broker selbst
kostet praktisch nichts.

10 neue Tests (81 im Broker, 8 im Frontend).
