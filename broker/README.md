# Token-Broker

Kleine Azure Function (Node 24, Flex-Verbrauchsplan). Sie hält das Geheimnis des Dienstusers und gibt
für freigegebene Berichte kurzlebige **Einbettungs-Token** aus.

Warum es sie geben muss: Ein statisches Frontend auf GitHub Pages kann kein
Geheimnis aufbewahren – alles, was dort liegt, ist öffentlich lesbar. Das
Einbettungs-Token darf deshalb nur serverseitig entstehen.

---

## Endpunkte

| Endpunkt | Anmeldung | Zweck |
|---|---|---|
| `GET /api/health` | keine | Lebenszeichen: ist alles konfiguriert, wie viele Regeln? |
| `GET /api/embed-token?bericht=<key>` | Entra-Token des Betrachters | Einbettungs-Token, nur lesend (`allowEdit: false`) |
| `GET /api/zugriff` | Entra-Token | Was darf ich sehen, darf ich verwalten? |
| `GET /api/rechte` | Entra-Token, Verwaltungsrecht | Zugriffsregeln lesen |
| `PUT /api/rechte` | Entra-Token, Verwaltungsrecht | Regelmenge vollständig ersetzen |
| `GET /api/berichte` | Entra-Token, Verwaltungsrecht | Was der Dienstuser sieht (Hilfe beim Einrichten) |

Der Broker prüft jedes Aufrufer-Token vollständig selbst: Signatur gegen die
öffentlichen Schlüssel von Entra, Aussteller, Mandant, Zielgruppe, Laufzeit und
den Bereich `Berichte.Lesen`. Ohne gültigen Ausweis gibt es kein Token.

**Arbeitsbereichs- und Bericht-IDs kommen niemals vom Aufrufer**, sondern
ausschließlich aus der Freigabeliste `PBI_BERICHTE`. Auch wer das Frontend in
der Entwicklerkonsole manipuliert, kommt damit an keinen weiteren Bericht.

Über der Freigabeliste liegt die **Zugriffsregel**: Selbst für einen
freigegebenen Bericht gibt es nur dann ein Token, wenn eine Regel den Aufrufer
trifft (Benutzer, Gruppe oder Domäne). Auch das entscheidet sich hier und nicht
im Frontend.

### Zugriffsregeln

Gespeichert in **Azure Table Storage** (Tabelle `Rechte`, eine Partition) im
Speicherkonto der Function App – nicht in einer SharePoint-Liste wie in den
übrigen DIHAG-Apps. Grund: Die Regeln müssen dort gelten, wo die Token
entstehen. Läge die Liste in SharePoint, bräuchte der Broker dafür
Graph-Berechtigungen, und die Regeln wären nur so verbindlich wie das Frontend.

```json
{ "typ": "gruppe",              // benutzer | gruppe | domaene
  "wert": "<Objekt-Id / E-Mail / Domäne>",
  "name": "Controlling",         // nur zur Anzeige
  "berichte": ["bericht1"],      // oder ["*"]
  "admin": false,                // darf die Regeln verwalten
  "aktiv": true }
```

Gruppenmitgliedschaften liest der Broker aus dem **Token** (`groups`-Anspruch);
die Frontend-Registrierung muss dafür `groupMembershipClaims = "All"` haben –
das schließt Verteiler- und Microsoft-365-Gruppen ein. Bei sehr vielen
Mitgliedschaften lässt Entra den Anspruch weg; der Broker meldet das als
`gruppenUeberlauf`, statt es als „keine Gruppen" auszulegen.

Zwei Sicherungen gegen das Aussperren: Die Konten in `ADMIN_UPNS` dürfen immer
verwalten, und wer nur über eine Regel Administrator ist, kann sich diese Regel
nicht selbst entziehen (HTTP 400 `aussperrung`). Das greift auch, wenn man die
Regelmenge leeren will – dann erst über `ADMIN_UPNS` gehen.

---

## Anwendungseinstellungen

Im Portal unter *Function App → Einstellungen → Umgebungsvariablen*:

| Name | Beispiel | Bedeutung |
|---|---|---|
| `PBI_TENANT_ID` | `fdb70646-…` | Mandant |
| `PBI_CLIENT_ID` | `…` | Registrierung des **Dienstusers** |
| `PBI_CLIENT_SECRET` | `…` | dessen Geheimnis |
| `FRONTEND_CLIENT_ID` | `…` | Registrierung des **Frontends** (Zielgruppe der Aufrufer-Token) |
| `FRONTEND_SCOPE` | `Berichte.Lesen` | erwarteter Bereich |
| `PBI_BERICHTE` | `[{"key":"bericht1","workspaceId":"…","reportId":"…"}]` | Freigabeliste |
| `ALLOWED_ORIGINS` | `https://dfedorov12.github.io` | erlaubte Herkunft des Frontends |
| `ERLAUBTE_DOMAENEN` | `dihag.com` | optional: nur diese E-Mail-Domänen |
| `ADMIN_UPNS` | `administrator@dihag.com` | darf immer verwalten, kann sich nicht aussperren |
| `RECHTE_STORAGE` | – | optional: eigenes Speicherkonto für die Regeln; sonst `AzureWebJobsStorage` |

> **CORS steht an zwei Stellen, beide werden gebraucht.** Die
> **Plattform-CORS-Liste** der Function App muss die Adressen des Frontends
> enthalten: Der Functions-Host beantwortet `OPTIONS` selbst und lässt die
> Vorabfrage nicht bis zum Code durch – ist seine Liste leer, antwortet er
> 204 ohne Kopfzeilen und der Browser bricht ab, bevor die eigentliche
> Anfrage gestellt wird. `ALLOWED_ORIGINS` gilt für die echten Antworten.
> Doppelte Kopfzeilen entstehen dabei nicht (nachgemessen). Die Liste greift
> erst **nach einem Neustart** der App.

Das Geheimnis lässt sich später durch ein Zertifikat oder eine verwaltete
Identität ersetzen; Microsoft empfiehlt das für den Dauerbetrieb.

### Warum der mandantenweite `GenerateToken`

Der Broker ruft `POST /v1.0/myorg/GenerateToken` auf (V2) und nicht den
berichtsbezogenen `POST /groups/…/reports/…/GenerateToken` (V1). Zwei Gründe:

- **Direct-Lake-Modelle gehen mit V1 gar nicht** – Power BI antwortet mit
  *„Embedding a DirectLake dataset is not supported with V1 embed token"*.
- V2 nimmt Bericht und Semantikmodell getrennt entgegen und kommt damit auch
  zurecht, wenn beide in verschiedenen Arbeitsbereichen liegen.

Nur-Lesen ergibt sich dort aus `allowEdit: false`; `targetWorkspaces` wird
bewusst weggelassen, das würde Schreibrechte verlangen.

---

## In Azure aufbauen

`setup-broker.ps1` legt Ressourcengruppe, Speicherkonto und Function App an,
trägt alle Einstellungen ein und **leert die Plattform-CORS-Liste**:

```powershell
az login
./setup-broker.ps1 -DienstClientId "..." -FrontendClientId "..." -WorkspaceId "..." -ReportId "..." -DienstSecret (Read-Host -AsSecureString "Geheimnis") -GithubGeheimnis
```

Das Geheimnis wird nur als `SecureString` entgegengenommen, nie ausgegeben und
nirgends in eine Datei geschrieben.

> **`-GithubGeheimnis` funktioniert im Flex-Verbrauchsplan nicht.** Dort ist die
> SCM-Basisauthentifizierung abgeschaltet, ein Veröffentlichungsprofil wird also
> abgewiesen. Der Workflow
> [deploy-broker.yml](../.github/workflows/deploy-broker.yml) meldet sich
> stattdessen per OpenID Connect an – die einmalige Einrichtung steht dort im
> Kopf der Datei. Bis dahin wird von Hand veröffentlicht:
>
> ```powershell
> az functionapp deployment source config-zip -g rg-berichte-broker -n berichte-token-broker --src broker.zip
> ```

Voraussetzung ist die Azure CLI (`winget install Microsoft.AzureCLI`). Wer die
Ressourcen lieber im Portal anlegt: Function App mit **Node 24, Linux,
Flex-Verbrauchsplan**, dann die Einstellungen aus der Tabelle oben eintragen.
(Node 20 ist seit dem 30.04.2026 EOL und wird von Azure abgelehnt; der
klassische Linux-Verbrauchsplan läuft am 30.09.2028 aus.)

Kosten: Der Verbrauchsplan enthält eine Million Aufrufe im Monat kostenfrei.
Der Broker wird beim Öffnen eines Berichts und danach einmal je Stunde und
offenem Dashboard aufgerufen – das bleibt im Freikontingent.

## Örtlich starten

```bash
npm install
cp local.settings.json.example local.settings.json   # Werte eintragen
npm start
```

Voraussetzung sind die *Azure Functions Core Tools* (`npm i -g azure-functions-core-tools@4`).
Der Broker läuft dann auf `http://localhost:7071/api/…`; in `js/config.js`
zeigt `brokerUrl` für den örtlichen Test auf diese Adresse.

## Tests

```bash
npm test
```

(Node 22+ nimmt kein Verzeichnis mehr entgegen, deshalb das Muster
`node --test test/*.test.js` im Skript.)

55 Tests, ohne Netz, ohne Azure, ohne Mandanten:

- **Regelauswertung** (`test/rechte.test.js`): Eingabeprüfung je Typ, Treffer
  über UPN/Objekt-Id/Domäne (inklusive der Falle, dass `nichtdihag.com` nicht
  auf `dihag.com` passen darf), Zusammenfassen mehrerer Treffer, und vor allem:
  ohne Regeln gilt die Domänenregelung, **ab der ersten Regel gilt nur noch sie**.

- **Endpunkte** (`test/api.test.js`): `@azure/functions` und `fetch` sind
  Attrappen, die Handler laufen echt. Geprüft werden unter anderem: ohne
  Ausweis kein Token, fremde Zielgruppe abgewiesen, fremde Domäne abgewiesen,
  unbekannter Schlüssel abgewiesen, **untergeschobene `workspaceId`/`reportId`
  im Aufruf ändern nichts**, angefordert wird der V2-Token mit
  `allowEdit: false` und ohne `targetWorkspaces`, das Token des Dienstusers
  taucht in keiner Antwort auf, CORS nur für erlaubte Herkunft.
- **Ausweiskontrolle** (`test/entra.test.js`): gegen selbst erzeugte Schlüssel –
  fremd signiert, nachträglich verändert, `alg: none`, abgelaufen, fremder
  Mandant, fehlender Bereich.

Die Endpunkt-Tests decken auch die Rechteschicht ab: Regeln greifen sofort,
eine Gruppenregel gibt frei, ohne Treffer gibt es 403 **ohne** Power BI zu
fragen, ungültige Eingaben werden abgewiesen, und der Aussperr-Schutz hält.
