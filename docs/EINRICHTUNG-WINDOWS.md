# DATEV-MCP in Claude Desktop einrichten (Windows) — Klick für Klick

Diese Anleitung bringt den DATEV-MCP-Server auf einem **Windows-Rechner** in
Claude Desktop zum Laufen. Danach kannst du Claude Fragen zu deinen
DATEV-Daten stellen. Wir starten in der **Sandbox** (Übungsumgebung, keine
echten Mandantendaten).

> **Voraussetzung:** Du hast die App im DATEV-Entwicklerportal registriert und
> hast **Client ID** und **Client Secret** vorliegen (siehe
> [SANDBOX-REGISTRIERUNG.md](SANDBOX-REGISTRIERUNG.md)).

---

## Schritt 1 — Node.js installieren (einmalig)
Node.js ist die Umgebung, in der das Programm läuft.

1. **https://nodejs.org** öffnen.
2. Den großen Button **„LTS"** (empfohlene Version) herunterladen — es ist eine
   `.msi`-Datei.
3. Die heruntergeladene Datei doppelklicken und den Installer durchklicken
   (alle Vorgaben einfach übernehmen, „Next" → „Install" → „Finish").

## Schritt 2 — Das Projekt herunterladen
1. Öffne das GitHub-Repository im Browser (Branch
   `claude/datev-mcp-server-analysis-dprntt`).
2. Grüner Button **„Code" → „Download ZIP"**.
3. Die ZIP-Datei entpacken, z. B. nach **`C:\datev-mcp`**.
   (Rechtsklick auf die ZIP → „Alle extrahieren"). Merke dir diesen Ordnerpfad.

## Schritt 3 — Programm einmalig bauen
1. Öffne den Ordner `C:\datev-mcp` im **Datei-Explorer**.
2. Klicke oben in die **Adressleiste**, tippe `powershell` und drücke Enter —
   es öffnet sich ein blaues Fenster (PowerShell) direkt in diesem Ordner.
3. Tippe nacheinander diese zwei Befehle (jeweils mit Enter, jeweils abwarten):
   ```
   npm install
   npm run build
   ```
   Der erste lädt die Bausteine (dauert 1–2 Minuten), der zweite baut das
   Programm. Wenn keine roten Fehler kommen, ist alles gut.

## Schritt 4 — Claude Desktop verbinden
1. Claude Desktop öffnen → **Einstellungen** (Zahnrad) → **Entwickler** →
   **„Konfiguration bearbeiten"** (öffnet die Datei
   `%APPDATA%\Claude\claude_desktop_config.json`).
2. Trage folgenden Inhalt ein (falls schon etwas drinsteht, den `datev`-Block in
   den vorhandenen `mcpServers`-Bereich einfügen):
   ```json
   {
     "mcpServers": {
       "datev": {
         "command": "node",
         "args": ["C:\\datev-mcp\\dist\\index.js"],
         "env": {
           "DATEV_ENV": "sandbox",
           "DATEV_CLIENT_ID": "HIER-DEINE-CLIENT-ID",
           "DATEV_CLIENT_SECRET": "HIER-DEIN-CLIENT-SECRET"
         }
       }
     }
   }
   ```
   - **Pfad anpassen:** Falls du woandershin entpackt hast, den Pfad in `args`
     entsprechend ändern. Wichtig: In dieser Datei müssen **doppelte
     Backslashes** `\\` stehen (wie oben gezeigt).
   - **Client ID / Secret** aus deiner DATEV-App eintragen. Diese Datei bleibt
     auf deinem Rechner — das Secret verlässt ihn nicht.
3. Datei **speichern**.
4. Claude Desktop **komplett beenden** (Rechtsklick aufs Symbol unten rechts in
   der Taskleiste → „Beenden") und **neu starten**. Ein normales Fenster-Schließen
   reicht nicht.

## Schritt 5 — Erste Anmeldung (Sandbox)
Stelle in Claude nacheinander diese Anfragen:

1. **„Führe datev_status aus"** → sollte `umgebung: sandbox`,
   `appKonfiguriert: true`, `angemeldet: false` zeigen. (Zeigt es
   `appKonfiguriert: false`, stimmt der Client-ID/Secret-Eintrag noch nicht.)
2. **„Melde mich bei DATEV an"** (Tool `datev_login`) → Claude zeigt eine
   Internetadresse. Sie öffnet sich normalerweise automatisch im Browser; falls
   nicht, die angezeigte Adresse selbst öffnen.
3. Im Browser mit dem **Sandbox-Testbenutzer „Test6"** anmelden. Nach Erfolg
   erscheint „DATEV-Anmeldung erfolgreich" — das Fenster kannst du schließen.
4. Zur Kontrolle wieder **„Führe datev_status aus"** → jetzt `angemeldet: true`.

## Schritt 6 — Fragen stellen
Jetzt geht's los, z. B.:
- **„Welche Mandanten sehe ich in DATEV?"** → der Testmandant erscheint.
- **„Zeig mir die Wirtschaftsjahre von Mandant 455148-1"**
- **„Lade die Buchungen von 455148-1 für das Wirtschaftsjahr 20260101"**
  (bereitet DATEV die Daten noch auf, meldet Claude „in Arbeit" — dann einfach
  nach einer halben Minute nochmal fragen).
- Danach frei: **„Wie ist der Saldo auf Konto 1200?"**, **„Welche Buchungen gab
  es im Januar über 1.000 €?"**, **„Summen- und Saldenliste für das Jahr"**.

---

## Wenn etwas klemmt
- **`datev_status` zeigt `appKonfiguriert: false`** → Client ID/Secret in der
  Konfigurationsdatei prüfen; danach Claude Desktop komplett neu starten.
- **„Der DATEV-MCP-Server erscheint nicht in Claude"** → meist ein Tippfehler in
  der JSON-Datei (fehlendes Komma/Klammer) oder falscher Pfad in `args`. Der Pfad
  muss auf die tatsächlich vorhandene Datei `…\dist\index.js` zeigen (nach
  Schritt 3 vorhanden).
- **„node wird nicht gefunden"** → Node.js war noch nicht installiert, als du das
  PowerShell-Fenster geöffnet hast. Fenster schließen, Node installieren (Schritt 1),
  neues Fenster öffnen. Notfalls in der Konfiguration statt `"node"` den vollen
  Pfad `"C:\\Program Files\\nodejs\\node.exe"` eintragen.
- **Bei der Anmeldung „redirect_uri mismatch"** → die Redirect-URL in der
  DATEV-App muss exakt `http://localhost:53682/callback` sein.
- **„Kein Zugriff / Freischaltung prüfen"** → das API-Abo (accounting-clients +
  Accounting Data Exchange) für die App im Portal prüfen.

## Datenschutz-Erinnerung
In der **Sandbox** sind nur Testdaten im Spiel. Bevor du später auf **echte
Mandantendaten** umstellst, bitte den Datenschutz-/Verschwiegenheitshinweis in
[../ANLEITUNG.md](../ANLEITUNG.md) und die Schritte in
[ONBOARDING-PRODUKTION.md](ONBOARDING-PRODUKTION.md) beachten.
