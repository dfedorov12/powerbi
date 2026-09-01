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
