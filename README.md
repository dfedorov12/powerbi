# Berichte (Power BI)

Power-BI-Berichte der **DIHAG Foundry Group** als statische Single-Page-App auf
GitHub Pages – im selben Muster wie [Rund um den Job](https://rundumdenjob.dihag.de/):
stille Anmeldung über Entra ID (PKCE, ohne MSAL), DIHAG Corporate Design,
Sichtbarkeit nach Domäne und Rolle.

**Nur Ansicht.** Niemand kann in der App etwas bearbeiten, speichern oder
exportieren – das Einbettungs-Token wird ausschließlich mit `accessLevel: View`
ausgestellt.

---

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
2. **Arbeitsbereich → Zugriff verwalten**: den Dienstuser (oder die Gruppe) als
   **Mitglied** eintragen.
3. **Arbeitsbereich → Einstellungen → Premium**: der **F4-Kapazität** zuweisen.
4. Arbeitsbereichs- und Bericht-Id aus der Power-BI-Adresse ablesen:
   `app.powerbi.com/groups/<workspaceId>/reports/<reportId>/…`

### 3. Broker

Function App anlegen (Node 20, Linux, Verbrauchsplan reicht), die
Umgebungsvariablen aus [broker/README.md](broker/README.md) setzen, dann
Veröffentlichungsprofil als Repository-Geheimnis
`AZURE_FUNCTIONAPP_PUBLISH_PROFILE` hinterlegen – der Workflow
[deploy-broker.yml](.github/workflows/deploy-broker.yml) veröffentlicht bei jedem
Push auf `main`, der `broker/` berührt.

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

## Sichtbarkeit

| Feld | Wirkung |
|---|---|
| `domains` | `*` oder Liste von E-Mail-Domänen (`dihag.com; gienanth.de`) |
| `minRolle` | `viewer` (Standard), `editor`, `admin` |
| `aktiv` | `false` blendet den Bericht aus, ohne ihn zu löschen |

Jede angemeldete Person im Mandanten ist standardmäßig `viewer`. Höhere Rollen
kommen – wenn gewünscht – aus der zentralen Liste `AppPermissions` auf
`/sites/IT`; dafür in `config.js` `permList: "AppPermissions"` setzen und
`Sites.Read.All` in `scopes` ergänzen (braucht Administratorzustimmung).
Bleibt `permList` leer, kommt die App mit `User.Read` aus und niemand muss
etwas zustimmen.

Das ist **Komfort, keine Sicherheitsgrenze**: Verbindlich ist die Freigabeliste
im Broker. Wer einen Bericht wirklich nicht sehen darf, darf ihn dort nicht
stehen haben – oder er bekommt eine eigene Freigabe über `ERLAUBTE_DOMAENEN`.

---

## Aufbau

```
index.html            Boot-Bildschirm, Kopfbereich, Berichtsrahmen, Diagnose
css/styles.css        DIHAG Corporate Design
js/config.js          einzige Stelle zum Anpassen
js/auth.js            PKCE-Anmeldung, Token fuer zwei Zielgruppen
js/graph.js           schlanker Graph-Zugriff (Profil, optional Rechteliste)
js/data.js            Benutzerkontext, Rolle, Sichtbarkeit
js/embed.js           Broker-Aufruf, powerbi-client, Token-Erneuerung
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
node --test broker/test
```

Der zweite Lauf prüft die Ausweiskontrolle des Brokers gegen selbst erzeugte
Schlüssel: fremde Zielgruppe, fremder Mandant, abgelaufen, fehlender Bereich,
fremd signiert, nachträglich verändert, `alg: none`. Kein Netz, kein Mandant nötig.

---

## Bekannte Stolpersteine

| Symptom | Ursache |
|---|---|
| `AADSTS50011` | Redirect-URI fehlt in der Frontend-Registrierung |
| Broker meldet 401 | Zustimmung für `api://…/Berichte.Lesen` fehlt |
| Broker meldet 404 | Der Schlüssel steht nicht in `PBI_BERICHTE` |
| `PowerBINotAuthorizedException` | Dienstuser ist nicht Mitglied des Arbeitsbereichs, oder die Mandanteneinstellungen sind nicht aktiv |
| Bericht bleibt leer, Konsole meldet CORS | `ALLOWED_ORIGINS` falsch, oder die CORS-Liste der Function App im Portal ist nicht leer |
| „Free trial version" im Bericht | Arbeitsbereich liegt auf keiner Kapazität |
