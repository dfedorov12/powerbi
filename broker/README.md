# Token-Broker

Kleine Azure Function (Node 20). Sie hält das Geheimnis des Dienstusers und gibt
für freigegebene Berichte kurzlebige **Einbettungs-Token** aus.

Warum es sie geben muss: Ein statisches Frontend auf GitHub Pages kann kein
Geheimnis aufbewahren – alles, was dort liegt, ist öffentlich lesbar. Das
Einbettungs-Token darf deshalb nur serverseitig entstehen.

---

## Endpunkte

| Endpunkt | Anmeldung | Zweck |
|---|---|---|
| `GET /api/health` | keine | Lebenszeichen: ist alles konfiguriert? |
| `GET /api/embed-token?bericht=<key>` | Entra-Token des Betrachters | Einbettungs-Token, `accessLevel: View` |
| `GET /api/berichte` | Entra-Token, UPN in `ADMIN_UPNS` | Was der Dienstuser sieht (Hilfe beim Einrichten) |

Der Broker prüft jedes Aufrufer-Token vollständig selbst: Signatur gegen die
öffentlichen Schlüssel von Entra, Aussteller, Mandant, Zielgruppe, Laufzeit und
den Bereich `Berichte.Lesen`. Ohne gültigen Ausweis gibt es kein Token.

**Arbeitsbereichs- und Bericht-IDs kommen niemals vom Aufrufer**, sondern
ausschließlich aus der Freigabeliste `PBI_BERICHTE`. Auch wer das Frontend in
der Entwicklerkonsole manipuliert, kommt damit an keinen weiteren Bericht.

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
| `ADMIN_UPNS` | `administrator@dihag.com` | wer `/api/berichte` sehen darf |

> Die Einstellung **CORS** der Function App im Portal muss **leer** bleiben –
> der Broker setzt die Kopfzeilen selbst, sonst kämen sie doppelt und der
> Browser lehnt die Antwort ab.

Das Geheimnis lässt sich später durch ein Zertifikat oder eine verwaltete
Identität ersetzen; Microsoft empfiehlt das für den Dauerbetrieb.

---

## In Azure aufbauen

`setup-broker.ps1` legt Ressourcengruppe, Speicherkonto und Function App an,
trägt alle Einstellungen ein und **leert die Plattform-CORS-Liste**:

```powershell
az login
./setup-broker.ps1 -DienstClientId "..." -FrontendClientId "..." -WorkspaceId "..." -ReportId "..." -DienstSecret (Read-Host -AsSecureString "Geheimnis") -GithubGeheimnis
```

Das Geheimnis wird nur als `SecureString` entgegengenommen, nie ausgegeben und
nirgends in eine Datei geschrieben. `-GithubGeheimnis` holt zusätzlich das
Veröffentlichungsprofil und hinterlegt es als Repository-Geheimnis
`AZURE_FUNCTIONAPP_PUBLISH_PROFILE` – danach veröffentlicht jeder Push auf
`main`, der `broker/` berührt, über
[deploy-broker.yml](../.github/workflows/deploy-broker.yml).

Voraussetzung ist die Azure CLI (`winget install Microsoft.AzureCLI`). Wer die
Ressourcen lieber im Portal anlegt: Function App mit **Node 20, Linux,
Verbrauchsplan**, dann die Einstellungen aus der Tabelle oben eintragen.

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

26 Tests, ohne Netz, ohne Azure, ohne Mandanten:

- **Endpunkte** (`test/api.test.js`): `@azure/functions` und `fetch` sind
  Attrappen, die Handler laufen echt. Geprüft werden unter anderem: ohne
  Ausweis kein Token, fremde Zielgruppe abgewiesen, fremde Domäne abgewiesen,
  unbekannter Schlüssel abgewiesen, **untergeschobene `workspaceId`/`reportId`
  im Aufruf ändern nichts**, ausgestellt wird ausschließlich
  `accessLevel: View`, das Token des Dienstusers taucht in keiner Antwort auf,
  CORS nur für erlaubte Herkunft.
- **Ausweiskontrolle** (`test/entra.test.js`): gegen selbst erzeugte Schlüssel –
  fremd signiert, nachträglich verändert, `alg: none`, abgelaufen, fremder
  Mandant, fehlender Bereich.
