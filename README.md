# Berichte (Power BI)

Power-BI-Berichte der **DIHAG Foundry Group** als statische Single-Page-App auf
GitHub Pages – im selben Muster wie [Rund um den Job](https://rundumdenjob.dihag.de/):
stille Anmeldung über Entra ID (PKCE, ohne MSAL), DIHAG Corporate Design,
Sichtbarkeit nach Domäne und Rolle.

**Nur Ansicht.** Niemand kann in der App etwas bearbeiten, speichern oder
exportieren – das Einbettungs-Token wird ausschließlich mit `allowEdit: false`
ausgestellt, und der Dienstuser hat in beiden Arbeitsbereichen nur die Rolle
*Viewer*.

---

## Aktueller Stand

| | |
|---|---|
| Frontend | **https://powerbi.dihag.de/** (eigene Domäne, HTTPS erzwungen) · github.io/powerbi leitet dorthin |
| Broker | https://berichte-token-broker.azurewebsites.net/api · `/health` meldet `eingerichtet: true` |
| Azure | Abonnement `sub-dihag-dp-global`, Ressourcengruppe `rg-berichte-broker`, westeurope, Flex-Verbrauchsplan, Node 24 |
| Frontend-Registrierung | `Berichte-Frontend` · `5813fded-4258-4736-8a7a-6bcc2b76325b` |
| Dienstuser | `fabric_report_service_user` · `c75f174c-1d0e-4389-9a93-cd27f25ccbcd` |
| Kapazität | `kapdihagdpwesteurope` (F4, aktiv) |
| Bericht | „Aktuelle DIHAG Geschäftspartner" in `DEV_Reporting_Central` |

**Ende zu Ende geprüft** (04.09.2026): Der Broker liefert für den Bericht ein
echtes Einbettungs-Token.

Rechte des Dienstusers – bewusst die kleinste Stufe, beides nachgemessen:

| Arbeitsbereich | Rolle | wofür |
|---|---|---|
| `DEV_Reporting_Central` | **Member** | der Bericht |
| `DEV_Semantic_Models_Central` | **Member** | das Semantikmodell dahinter |
| `DEV_Data_Engineering_Central` | **Viewer** | das Lakehouse `lh_gold`, aus dem das Modell liest |

Alle drei sind nötig: Die Kette Bericht → Semantikmodell → Lakehouse läuft über
drei Arbeitsbereiche, und das Direct-Lake-Modell greift per SSO mit der
Identität des Dienstusers auf die Daten zu.

> **Vorsicht beim Messen:** Power BI merkt sich Berechtigungsentscheidungen
> einige Minuten. Wer direkt nach einer Änderung testet, misst womöglich noch
> den alten Stand. Genau das ist hier passiert: *Viewer* auf den ersten beiden
> Arbeitsbereichen sah kurz nach dem Herabstufen aus, als würde es reichen –
> Minuten später scheiterte `GenerateToken` mit 401. **Für Bericht und
> Semantikmodell braucht es *Member*.** Nach jeder Rechteänderung also einige
> Minuten warten und erneut prüfen.

## Warum es zwei Teile gibt

| Teil | Wo | Aufgabe |
|---|---|---|
| **Frontend** | GitHub Pages | Anmeldung des Betrachters, Auswahl, Anzeige |
| **Broker** | Azure Function | hält das Geheimnis des Dienstusers, erzeugt Einbettungs-Token |

Der Zugriff auf Power BI läuft über **einen Dienstuser** (Dienstprinzipal), nicht
über das Konto des Betrachters – das ist der Fall, den Microsoft *„Embed for your
customers"* nennt. Vorteil: **Betrachter brauchen weder eine Power-BI-Lizenz noch
eine Freigabe im Arbeitsbereich.** Sie müssen nur am DIHAG-Mandanten angemeldet sein.

Der Preis dafür ist der Broker: Das Geheimnis des Dienstusers darf niemals in einer
statischen Seite liegen, denn dort ist alles öffentlich lesbar. Deshalb erzeugt eine
kleine Azure Function das kurzlebige Einbettungs-Token – siehe [broker/README.md](broker/README.md).

```
Browser ──1── Entra ID           Anmeldung des Betrachters (PKCE)
   │
   ├────2──▶ Broker              Ausweis prüfen, Bericht aus Freigabeliste
   │           │
   │           └──3──▶ Power BI  Anmeldung als Dienstuser, GenerateToken (View)
   │
   └────4──▶ Power BI            Bericht anzeigen, mit dem Einbettungs-Token
```

---

## Lizenzen und Kapazität

- Der Arbeitsbereich liegt auf einer **Fabric-Kapazität F4**. Damit ist das
  Einbetten produktiv zulässig, es gibt kein Token-Kontingent und kein
  „Free trial version"-Banner.
- **Betrachter brauchen keine Lizenz** – sie melden sich nur am Mandanten an.
- Eine Power-BI-Pro-Lizenz braucht weiterhin, wer den Bericht **erstellt und
  veröffentlicht**.
- Ohne Kapazität würde Microsoft nur eine begrenzte Zahl kostenloser Test-Token
  ausstellen; das ist ausdrücklich nur für Entwicklung und Test gedacht.

---

## Einrichtung

### 1. Entra ID

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser
Connect-MgGraph -Scopes "Application.ReadWrite.All","Group.ReadWrite.All"
./setup-powerbi.ps1
```

Das Skript legt an:

- **Frontend-Registrierung** (SPA, ohne Geheimnis) mit den Redirect-URIs und dem
  eigenen Bereich `api://<appId>/Berichte.Lesen`,
- **Dienstuser-Registrierung** mit Geheimnis (wird einmalig ausgegeben),
- **Sicherheitsgruppe** `PowerBI-Einbettung` mit dem Dienstuser als Mitglied.

Am Ende gibt es alle Werte für `js/config.js` und die Function App aus.

### 2. Power BI (von Hand, dafür gibt es keine API)

1. **Administrationsportal → Mandanteneinstellungen → Entwicklereinstellungen**
   - *Dienstprinzipale dürfen Power-BI-APIs verwenden* → aktiv für die Gruppe `PowerBI-Einbettung`
   - *Inhalte in Apps einbetten* → aktiv
2. **Arbeitsbereich → Zugriff verwalten**: den Dienstuser als **Viewer**
   eintragen – und zwar in **beiden** Arbeitsbereichen, falls das Semantikmodell
   woanders liegt als der Bericht (`datasetWorkspaceId` des Berichts prüfen).
3. **Arbeitsbereich → Einstellungen → Premium**: der **F4-Kapazität** zuweisen.
4. Arbeitsbereichs- und Bericht-Id aus der Power-BI-Adresse ablesen:
   `app.powerbi.com/groups/<workspaceId>/reports/<reportId>/…`

### 3. Broker

```powershell
az login
cd broker
./setup-broker.ps1 -DienstClientId "..." -FrontendClientId "..." -WorkspaceId "..." -ReportId "..." -DienstSecret (Read-Host -AsSecureString "Geheimnis") -GithubGeheimnis
```

Das legt Ressourcengruppe, Speicherkonto und Function App (Node 24, Linux,
Flex-Verbrauchsplan) an, trägt alle Einstellungen ein, leert die Plattform-CORS-Liste
und hinterlegt das Veröffentlichungsprofil als Repository-Geheimnis
`AZURE_FUNCTIONAPP_PUBLISH_PROFILE`. Danach veröffentlicht der Workflow
[deploy-broker.yml](.github/workflows/deploy-broker.yml) bei jedem Push auf
`main`, der `broker/` berührt. Einzelheiten: [broker/README.md](broker/README.md).

Prüfen: `https://<function-app>.azurewebsites.net/api/health` muss
`"eingerichtet": true` melden.

### 4. Frontend

In [js/config.js](js/config.js) eintragen: `clientId`, `apiScope`, `brokerUrl` und
die Berichte. **Wichtig:** In `config.js` stehen bewusst *keine* Power-BI-IDs –
die gehören in die Freigabeliste `PBI_BERICHTE` des Brokers. Das Frontend kennt
nur den Schlüssel (`key`); so kann niemand über die Entwicklerkonsole ein Token
für einen fremden Bericht anfordern.

```js
berichte: [
  { key: "bericht1", name: "Kennzahlen", domains: "*", minRolle: "viewer", aktiv: true }
]
```

Danach GitHub Pages aktivieren (Branch `main`, Ordner `/`).

---

## Berechtigungen

Wer welchen Bericht sieht, steht in **Zugriffsregeln**. Administratoren pflegen
sie in der App unter **Einstellungen → Berechtigungen**; gespeichert werden sie
im Broker (Azure Table `Rechte`), und **dort werden sie auch durchgesetzt** –
bei jedem Einbettungs-Token neu.

Eine Regel ordnet einem **Prinzipal** Berichte zu:

| Typ | Wert | greift auf |
|---|---|---|
| Benutzer | E-Mail-Adresse | genau dieses Konto |
| Gruppe | **Objekt-Id** der Gruppe | Sicherheits-, Microsoft-365-, Verteiler- und dynamische Gruppen |
| Domäne | `dihag.com` | alle Adressen dieser Domäne |

Dazu je Regel: welche Berichte (`*` oder einzelne), ob die Regel ihren
Prinzipalen auch das **Verwalten** erlaubt, und ob sie aktiv ist. Es gilt die
**Summe** aller zutreffenden Regeln.

- Gruppen werden über die **Objekt-Id** verglichen, nicht über den Namen –
  ein umbenannter Anzeigename darf keine Berechtigung still verschieben.
  Die Oberfläche bietet die eigenen Gruppen zur Auswahl an (`getMemberGroups`,
  kommt mit `User.Read` aus); fremde Gruppen trägt man über die Id ein.
- **Solange keine Regel existiert**, gilt die Übergangsregelung: Wer aus einer
  Domäne in `ERLAUBTE_DOMAENEN` kommt, sieht alles. **Ab der ersten Regel gilt
  ausschließlich sie** – wer von keiner getroffen wird, sieht nichts.
- Die Konten in der Broker-Einstellung `ADMIN_UPNS` dürfen immer verwalten und
  können sich nicht aussperren. Wer nur über eine Regel Administrator ist, wird
  vom Broker daran gehindert, sich selbst diese Regel zu entziehen.

### Woher der Broker die Gruppen kennt

Aus dem Token: Die Frontend-Registrierung hat `groupMembershipClaims = "All"`,
Entra legt die Mitgliedschaften also in den Anspruch `groups`. Bei sehr vielen
Mitgliedschaften (mehrere hundert) lässt Entra den Anspruch weg – der Broker
meldet das dann als `gruppenUeberlauf`, und gruppenbasierte Regeln greifen
nicht mehr. Das steht auch in der Diagnose.

---

## Verbrauch

Unter **Einstellungen → Verbrauch** sehen Administratoren, wie oft welcher
Bericht geöffnet wird. Zwei Quellen, bewusst getrennt ausgewiesen:

| | Herkunft | Aussage |
|---|---|---|
| **Öffnungen / Erneuerungen / Personen** | der Broker selbst | exakt – jedes Einbettungs-Token geht durch ihn |
| **CU** (Capacity Units) | App „Microsoft Fabric Capacity Metrics" | der tatsächliche Kapazitätsverbrauch |

Öffnungen und **Token-Erneuerungen** werden getrennt gezählt: Ein Dashboard,
das den ganzen Tag offen steht, holt sich jede Stunde ein neues Token und
verbraucht dabei weiter Kapazität – ohne dass jemand den Bericht neu aufruft.
„CU je Öffnung" teilt deshalb durch beides zusammen.

Die Ansicht ist **Administratoren vorbehalten** – die Schaltfläche erscheint
nur für sie, und `GET /api/nutzung` weist alle anderen mit 403 ab.

**Geschätzte CU-Werte gibt es hier bewusst nicht.** Ist die Metrik-App nicht
angebunden, steht in der Oberfläche, was genau fehlt.

### Stand der Anbindung

Angebunden ist die Instanz im Arbeitsbereich **„Microsoft Fabric Capacity
Metrics"** (`ea003234-…`, Semantikmodell `3898b87e-…`); die Function App kennt
sie über `METRIK_WORKSPACE`, `METRIK_DATASET` und `PBI_KAPAZITAET_ID`, und der
Dienstuser ist dort Contributor (für `executeQueries` reicht *Viewer* nicht).

Das Modell lief unter einem externen Berater, der seit Juli 2025 kein
Kapazitätsadministrator mehr ist – seither schlug jede Aktualisierung fehl
(*„No capacities found. You need to be a capacity admin"*). Es wurde auf
`administrator@dihag.com` übernommen und aktualisiert; **Kapazität und
Semantikmodelle sind seitdem im Modell sichtbar.**

**Ein Schritt fehlt noch, und der geht nur über die Oberfläche:** Die
Faktentabellen sind DirectQuery und brauchen eine dauerhaft hinterlegte
Anmeldung. Per API lässt sich nur ein Zugriffstoken setzen – das genügt für die
Aktualisierung der Importtabellen, nicht für DirectQuery (`Error obtaining data
location`). Einmalig im Power-BI-Portal:

> Arbeitsbereich „Microsoft Fabric Capacity Metrics" → Semantikmodell
> „Fabric Capacity Metrics" → **Einstellungen → Datenquellen-Anmeldeinformationen
> → Anmelden**, mit einem Konto, das **Kapazitätsadministrator** ist.

Danach erscheinen die CU-Zahlen von selbst; die App zeigt bis dahin
„Anmeldung fehlt" mit genau dieser Anleitung.

### Was gespeichert wird

Je Aufruf: Zeitpunkt, Berichtsschlüssel, E-Mail-Adresse – mehr nicht. Einträge
werden nach `NUTZUNG_TAGE` Tagen (Vorgabe 90) automatisch gelöscht. Mit
`NUTZUNG_ANONYM=1` steht statt der Adresse ein **täglich wechselnder
Kurz-Hash**: Nutzerzahlen bleiben zählbar, einzelne Personen sind nicht mehr
nachvollziehbar.

## Aufbau

```
index.html            Boot-Bildschirm, Kopfbereich, Berichtsrahmen, Diagnose
css/styles.css        DIHAG Corporate Design
js/config.js          einzige Stelle zum Anpassen
js/auth.js            PKCE-Anmeldung, Token fuer zwei Zielgruppen
js/graph.js           schlanker Graph-Zugriff (Profil, optional Rechteliste)
js/data.js            Benutzerkontext, Rolle, Sichtbarkeit
js/embed.js           Broker-Aufruf, powerbi-client, Token-Erneuerung
js/set-rechte.js      Einstellungen -> Berechtigungen (nur Administratoren)
js/set-nutzung.js     Einstellungen -> Verbrauch (nur Administratoren)
js/app.js             Oberflaeche
broker/               Azure Function (Token-Broker)
tests/                Sichtbarkeitslogik
setup-powerbi.ps1     Entra-Einrichtung
```

### Token für zwei Zielgruppen

Entra stellt pro Anmeldung nur Token für **eine** Zielgruppe aus. Die App
braucht zwei: Microsoft Graph (Profil, Rolle) und den eigenen Broker. Deshalb
fordert die Anmeldung zusätzlich `offline_access` an; das Aktualisierungs-Token
wird anschließend gegen ein Token der jeweils anderen Zielgruppe eingetauscht.
Genau so arbeitet auch MSAL – nur ohne die Bibliothek.

### Token-Erneuerung

Ein Einbettungs-Token gilt rund eine Stunde. Fünf Minuten vor Ablauf holt die App
im Hintergrund ein neues und reicht es an den Bericht weiter, damit ein den
ganzen Tag offenes Dashboard nicht stehen bleibt.

---

## Tests

```bash
node tests/test-sichtbarkeit.mjs
node --test broker/test/*.test.js
```

8 Tests zur Sichtbarkeit, 26 zum Broker – ohne Netz, ohne Azure, ohne Mandanten.
Der Broker-Lauf spielt die Endpunkte vollständig durch (`@azure/functions` und
`fetch` als Attrappen) und prüft die Ausweiskontrolle gegen selbst erzeugte
Schlüssel. Die wichtigsten Fälle: ohne Ausweis kein Token, fremde Zielgruppe
und fremder Mandant abgewiesen, untergeschobene IDs im Aufruf ändern nichts,
ausgestellt wird ausschließlich `accessLevel: View`.

---

## Bekannte Stolpersteine

| Symptom | Ursache |
|---|---|
| `AADSTS50011` | Redirect-URI fehlt in der Frontend-Registrierung |
| Broker meldet 401 | Zustimmung für `api://…/Berichte.Lesen` fehlt |
| Broker meldet 404 | Der Schlüssel steht nicht in `PBI_BERICHTE` |
| `PowerBINotAuthorizedException` beim GET | Dienstuser ist nicht Mitglied des Arbeitsbereichs, oder die Mandanteneinstellungen sind nicht aktiv |
| `PowerBINotAuthorizedException` nur bei `GenerateToken` | Das **Semantikmodell liegt in einem anderen Arbeitsbereich** (`datasetWorkspaceId` im Bericht prüfen). Der Dienstuser braucht auch dort Zugriff – die Dataset-Rechte-API nimmt keine Dienstprinzipale, es muss über die Arbeitsbereichsrolle gehen |
| Nach einer Rechteänderung ändert sich nichts – oder ein Test schlägt später doch fehl | Power BI merkt sich Berechtigungsentscheidungen einige Minuten. Nach Änderungen warten und erneut prüfen, nicht sofort schließen |
| Bericht plötzlich für alle gesperrt | Es existiert mindestens eine Regel, und niemand wird getroffen. Unter Einstellungen → Berechtigungen prüfen; `ADMIN_UPNS` kommt immer durch |
| `Embedding a DirectLake dataset is not supported with V1 embed token` | Der berichtsbezogene Endpunkt `/groups/…/reports/…/GenerateToken` kann keine Direct-Lake-Modelle. Der Broker nimmt deshalb den mandantenweiten `/GenerateToken` mit `datasets` + `reports` |
| Bericht wird angezeigt, aber „Es konnte keine Verbindung mit der Datenquelle … hergestellt werden" | Das Direct-Lake-Modell greift per SSO mit der Identität des Dienstusers auf das Lakehouse durch. Der braucht deshalb auch im **Arbeitsbereich des Lakehouse** die Rolle *Viewer*. Die Adresse im Fehlertext (`…datawarehouse.fabric.microsoft.com`, `database`) nennt die Element-Id – über die Fabric-Admin-API findet man Arbeitsbereich und Namen |
| Bericht bleibt leer, Konsole meldet CORS | Die **Plattform-CORS-Liste** der Function App ist leer oder unvollständig – der Host beantwortet `OPTIONS` selbst und lässt die Vorabfrage nicht zum Code durch. Beide Stellen pflegen: Plattformliste **und** `ALLOWED_ORIGINS`; die Liste greift erst nach einem Neustart |
| „Free trial version" im Bericht | Arbeitsbereich liegt auf keiner Kapazität |
