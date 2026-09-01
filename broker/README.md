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

## Örtlich starten

```bash
npm install
cp local.settings.json.example local.settings.json   # Werte eintragen
npm start
```

Voraussetzung sind die *Azure Functions Core Tools* (`npm i -g azure-functions-core-tools@4`).
Der Broker läuft dann auf `http://localhost:7071/api/…`; in `js/config.js`
zeigt `brokerUrl` für den örtlichen Test auf diese Adresse.

## Bereitstellen

Über den Workflow [.github/workflows/deploy-broker.yml](../.github/workflows/deploy-broker.yml):
Veröffentlichungsprofil der Function App als Repository-Geheimnis
`AZURE_FUNCTIONAPP_PUBLISH_PROFILE` hinterlegen, `APP_NAME` im Workflow
anpassen – jeder Push auf `main`, der `broker/` berührt, veröffentlicht dann.

## Tests

```bash
npm test
```

Prüft die Freigabelogik und die Token-Prüfung gegen selbst erzeugte Schlüssel
(kein Netz, kein Mandant nötig).
