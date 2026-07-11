# Sandbox-App bei DATEV registrieren — Klick für Klick

Diese Anleitung führt Schritt für Schritt durch die Registrierung einer App im
DATEV-Entwicklerportal. Ergebnis sind zwei Codes (**Client ID** und **Client
Secret**), die der MCP-Server für die Anmeldung braucht. Alles passiert in der
**Sandbox** (Übungsumgebung) — es sind keine echten Mandantendaten im Spiel.

> Diese Werte müssen exakt zum Programm passen (siehe `src/config.ts`):
> Redirect-URL **`http://localhost:53682/callback`**, Port **53682**.

## Voraussetzung
Du hast ein **DATEV-Konto** als Mitglied/Berater und **SmartLogin** (Handy-App)
oder **SmartCard/mIDentity** bereit.

## Schritt 1 — Am Entwicklerportal anmelden
1. **developer.datev.de** öffnen.
2. Oben rechts **„Anmelden"** → **„Login mit DATEV"**.
3. Mit dem DATEV-Konto anmelden (SmartLogin-App bestätigen bzw. SmartCard stecken).

## Schritt 2 — Organisation anlegen/beitreten
Beim ersten Mal fragt das Portal nach einer **Organisation**. Lege eure
Kanzlei-Organisation an oder tritt einer bestehenden bei. Das ist Voraussetzung,
um überhaupt Apps erstellen zu dürfen.

## Schritt 3 — App erstellen
1. Im **Dashboard** den Reiter **„Apps"** (bzw. „Meine Anwendungen") öffnen.
2. Button **„App erstellen"**.
3. **Name:** z. B. `Kanzlei DATEV MCP`.
4. **Diese Einstellungen genau so wählen:**
   - **Authorization Flow:** `OpenID Connect Authorization Code Flow` (nicht „Hybrid")
   - **Client-Typ:** `Confidential` ⚠️ — nur so gibt es das ~2-Jahres-Anmelde-Token
     (Refresh Token); sonst wäre ständiges Neu-Anmelden nötig.
   - **Redirect-URL:** exakt `http://localhost:53682/callback`
5. Speichern.

## Schritt 4 — Die zwei Codes notieren
Auf der App-Detailseite stehen jetzt **„Client ID"** und **„Client Secret"**.
- Beide sicher notieren.
- Das **Secret wird oft nur einmal angezeigt** — falls es verloren geht, einfach
  ein neues generieren.

Diese beiden Werte entsprechen den Konfigurationswerten `DATEV_CLIENT_ID` und
`DATEV_CLIENT_SECRET` (siehe `.env.example`).

## Schritt 5 — API-Produkte abonnieren
Im Portal die Produktseite öffnen und **für deine App abonnieren** („Subscribe"):
- **accounting-clients** — Mandantenliste
- **Accounting Data Exchange** — Buchungsdaten & Salden

Neue Apps starten automatisch in der **Sandbox**. (Der Beleg-Dienst
`accounting-documents` teilt sich das Abo mit `accounting-clients`; für den
reinen Lesezugriff wird er noch nicht benötigt.)

## Schritt 6 — Codes einsetzen (bitte Datenschutz beachten)
- ⚠️ **Das Client Secret NICHT in einen geteilten Chat kopieren** — es ist wie
  ein Passwort und würde damit den eigenen Rechner verlassen. Wir tragen beide
  Codes gemeinsam **lokal** in die Claude-Desktop-Konfiguration ein (siehe
  [../ANLEITUNG.md](../ANLEITUNG.md), Abschnitt „Einrichtung in Claude Desktop").
- Beim späteren Login **in der Sandbox** den Testbenutzer **„Test6"** wählen
  (nicht das echte Konto), Testmandant **455148-1**.

## Wenn etwas klemmt
- **„Redirect URI mismatch"** → die URL muss zeichengenau
  `http://localhost:53682/callback` sein (auch der Port 53682).
- **Kein „App erstellen" sichtbar** → du bist noch keiner Organisation mit
  Rechten zugeordnet (Schritt 2 nachholen).
- Die App bleibt in der **Sandbox**, bis du später aktiv die Produktionsfreigabe
  beantragst — die Schritte dazu stehen in
  [ONBOARDING-PRODUKTION.md](ONBOARDING-PRODUKTION.md).

---

> Hinweis: Die genauen Button-Bezeichnungen können sich je nach Portal-Version
> minimal unterscheiden. Die Reihenfolge bleibt gleich:
> **Anmelden → Organisation → App erstellen → Codes notieren → Produkte abonnieren.**
