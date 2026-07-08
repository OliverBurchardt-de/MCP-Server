# DATEV-Anbindung für Claude — Anleitung für die Kanzlei

Diese Anleitung erklärt ohne Technik-Vorwissen, wie Sie Claude mit Ihren
DATEV-Daten sprechen lassen. Das Programm in diesem Projekt ist der
„Übersetzer" zwischen Claude und DATEV: Sie stellen Fragen in normalem
Deutsch, der Übersetzer holt die Zahlen aus DATEV.

## Was Sie fragen können (Beispiele)

- „Welche Mandanten sehe ich in DATEV?"
- „Wie ist der Saldo auf Konto 1200?"
- „Zeig mir alle Buchungen über 1.000 € im Februar."
- „Welche Kunden schulden uns noch Geld?"
- „Suche die Rechnung RE-2026-0089."
- „Wie lautet die Summen- und Saldenliste für 2026?"

## Zwei Wege zu den Daten

**Weg 1 — Exportdatei (sofort nutzbar, keine Freischaltung nötig):**
Sie exportieren in DATEV einen Buchungsstapel (DATEV-Format, EXTF-Datei)
und sagen Claude: „Lade die DATEV-Datei C:\\Pfad\\zur\\Datei.csv". Danach
beantwortet Claude alle Fragen zu diesem Buchungsstapel.

**Weg 2 — Live aus der DATEV-Cloud (das eigentliche Ziel):**
Claude meldet sich mit Ihrem DATEV-Konto an und holt die Buchungsdaten
direkt aus der DATEV-Cloud — ohne manuellen Export. Dafür ist einmalig
die Registrierung einer „App" im DATEV-Entwicklerportal nötig (unten).

## Einrichtung in Claude Desktop (einmalig)

1. Voraussetzung: Node.js ab Version 20 ist installiert (nodejs.org).
2. In diesem Projektordner einmal ausführen: `npm install` und `npm run build`.
3. In Claude Desktop die Konfigurationsdatei öffnen
   (Einstellungen → Entwickler → Konfiguration bearbeiten) und eintragen:

```json
{
  "mcpServers": {
    "datev": {
      "command": "node",
      "args": ["<ABSOLUTER-PFAD-ZUM-PROJEKT>/dist/index.js"],
      "env": {
        "DATEV_ENV": "sandbox",
        "DATEV_CLIENT_ID": "<aus dem DATEV-Entwicklerportal>",
        "DATEV_CLIENT_SECRET": "<aus dem DATEV-Entwicklerportal>"
      }
    }
  }
}
```

4. Claude Desktop neu starten. Fragen Sie zum Test: „Führe datev_status aus."

## App bei DATEV registrieren (Ihre Aufgabe, einmalig)

Ohne diese Registrierung funktioniert nur Weg 1 (Exportdatei).

1. Auf https://developer.datev.de anmelden bzw. registrieren.
2. Eine neue App anlegen mit genau diesen Einstellungen:
   - **Authorization Flow:** OpenID Connect Authorization Code Flow (nicht „Hybrid")
   - **Client-Typ:** Confidential (wichtig — nur so bleibt die Anmeldung
     zwei Jahre gültig, sonst müssten Sie sich ständig neu anmelden)
   - **Redirect-URL:** `http://localhost:53682/callback` (exakt so)
3. Die angezeigte **Client-ID** und das **Client-Secret** notieren und wie
   oben gezeigt in die Claude-Konfiguration eintragen.
4. Das API-Produkt **accounting-clients** und **Accounting Data Exchange**
   abonnieren (Produktseite im Portal, Button „Subscribe").

Neue Apps starten automatisch in der **Sandbox** — einer Übungsumgebung
von DATEV mit Testdaten (Testmandant 455148-1). Da kann nichts kaputtgehen.
Für den Zugriff auf Ihre echten Daten siehe `docs/ONBOARDING-PRODUKTION.md`.

## Die erste Live-Sitzung (Sandbox)

1. Fragen Sie Claude: „Melde mich bei DATEV an" (Tool: datev_login).
2. Claude zeigt eine Internetadresse. Öffnen Sie sie im Browser und melden
   Sie sich an — in der Sandbox mit dem DATEV-Testbenutzer (Test6).
3. Zurück in Claude: „Welche Mandanten sehe ich?" → der Testmandant 455148-1.
4. „Welche Wirtschaftsjahre gibt es für 455148-1?"
5. „Lade die Buchungen von 455148-1 für das Wirtschaftsjahr 20260101."
   (DATEV bereitet die Daten kurz auf — falls Claude „in Arbeit" meldet,
   einfach nach einer halben Minute noch einmal fragen.)
6. Jetzt frei fragen: Salden, offene Posten, Buchungssuche.

## Wichtig: Datenschutz und Verschwiegenheit

Wenn Claude Fragen zu Buchungsdaten beantwortet, werden diese Daten an den
KI-Dienst (Anthropic) übertragen. **Vor dem Einsatz mit echten
Mandantendaten** muss die Kanzlei prüfen und freigeben, ob das mit der
berufsrechtlichen Verschwiegenheitspflicht (§ 203 StGB) und der DSGVO
vereinbar ist (Stichworte: Auftragsverarbeitung, Anthropic-DPA,
Einwilligungen). Die Sandbox mit Testdaten ist davon nicht betroffen.

## Wenn etwas nicht funktioniert

- **„Nicht angemeldet"** → „Führe datev_login aus" und den Browser-Schritt
  wiederholen.
- **„Kein Zugriff / Freischaltung prüfen"** → Das API-Abo im
  Entwicklerportal fehlt, oder der Datenservice ist für den Mandanten nicht
  freigeschaltet.
- **„DATEV bereitet die Daten noch auf"** → Normal bei großen Beständen;
  dieselbe Frage nach ~30 Sekunden wiederholen.
- **Anmeldefenster erscheint nicht** → Die Adresse aus der Claude-Antwort
  von Hand in den Browser kopieren.
