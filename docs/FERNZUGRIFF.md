# Fernzugriff: Den DATEV-MCP-Server „von überall" nutzen

Diese Anleitung beschreibt den **Fernbetrieb** (Phase 3): Der Server läuft auf
einem Kanzlei-/ASP-Server und ist über HTTPS erreichbar — nutzbar in claude.ai
(Browser), in der Mobile-App und in Claude Desktop, für mehrere Mitarbeitende
gleichzeitig, strikt getrennt.

> Der bisherige **lokale Betrieb** (Claude Desktop + `stdio`) funktioniert
> unverändert weiter und braucht nichts hiervon.

---

## Überblick: die zwei Anmeldungen

1. **Anmeldung am Server (die „Eintrittstür"):** Beim Verbinden aus Claude
   öffnet sich die Anmeldeseite des Servers; dort gibt die Mitarbeiterin/der
   Mitarbeiter den persönlichen **Zugangsschlüssel** ein (von der Kanzlei-
   Administration ausgegeben). Ohne gültigen Schlüssel kommt niemand hinein —
   und die Kanzlei kann jeden Zugang jederzeit sperren.
2. **DATEV-Anmeldung (der Datenzugriff):** Innerhalb der Sitzung startet
   `datev_login` die normale DATEV-Anmeldung (SmartLogin, SmartCard,
   mIDentity). Jede Person nutzt ihr **eigenes** DATEV-Konto; die Tokens
   liegen verschlüsselt und je Nutzer getrennt auf dem Server.

Diese Trennung ist bewusst (Review-Vorgabe): Das DATEV-Token ist niemals
zugleich die Eintrittskarte zum Server.

---

## A. Einrichtung durch die IT (einmalig)

Voraussetzungen laut [BETRIEB-REMOTE-BRIEFING.md](BETRIEB-REMOTE-BRIEFING.md):
Server mit Node.js ≥ 20, Domain (z. B. `datev-mcp.kanzlei.de`), TLS am
Reverse Proxy (nginx/Caddy/IIS), Firewall 443 eingehend.

1. Projekt auf den Server bringen und bauen:
   `npm install && npm run build`
2. Umgebungsvariablen setzen (z. B. per systemd oder `.env`):

   | Variable | Pflicht | Beispiel / Bedeutung |
   |---|---|---|
   | `MCP_PUBLIC_URL` | ja | `https://datev-mcp.kanzlei.de` — öffentliche Basis-URL |
   | `MCP_BIND` | nein | Standard `127.0.0.1` (hinter dem Reverse Proxy lassen) |
   | `MCP_PORT` | nein | Standard `3000` |
   | `MCP_ALLOWED_ORIGINS` | empfohlen | `https://claude.ai` |
   | `DATEV_ENV` / `DATEV_CLIENT_ID` / `DATEV_CLIENT_SECRET` | ja | wie im lokalen Betrieb |
   | `DATEV_TOKEN_KEY` | empfohlen | 32-Byte-Schlüssel (Base64) aus einem Secret Store für die Token-Verschlüsselung |

3. **DATEV-Redirect-URL registrieren:** In der DATEV-App zusätzlich
   `https://<MCP_PUBLIC_URL>/oauth/datev/callback` als Redirect-URL eintragen
   (der Server gibt die exakte URL beim Start aus).
4. Reverse Proxy: `https://datev-mcp.kanzlei.de/* → http://127.0.0.1:3000/*`
   (inkl. Weiterreichen des `Authorization`-Headers; kein Puffern von
   Server-Sent Events nötig — Antworten sind reines JSON).
5. Dienst starten: `npm run start:remote` (als systemd-/Windows-Dienst mit
   automatischem Neustart einrichten).
6. Funktionsprobe: `curl https://datev-mcp.kanzlei.de/healthz` → `{"ok":true}`.

## B. Nutzerkonten verwalten (Kanzlei-Administration)

Auf dem Server:

```bash
# Konto anlegen (der Schlüssel erscheint GENAU EINMAL — sicher übergeben):
npm run add-user -- --user ob --org kanzlei-burchardt

# Optional mit Mandanten-Einschränkung (nur diese Mandanten sichtbar/abfragbar):
npm run add-user -- --user azubi --org kanzlei-burchardt --clients 455148-1

# Übersicht:
npm run add-user -- --list

# Offboarding (sperrt das Konto und widerruft alle aktiven Zugangstokens):
npm run add-user -- --disable --user azubi --org kanzlei-burchardt
```

## C. Verbinden aus Claude (jede Mitarbeiterin / jeder Mitarbeiter)

1. In claude.ai: **Einstellungen → Connectors → Custom Connector hinzufügen**
   und als URL `https://datev-mcp.kanzlei.de/mcp` eintragen.
   (Claude erkennt die Anmelde-Endpunkte automatisch über die
   OAuth-Discovery des Servers.)
2. Es öffnet sich die **Anmeldeseite des Servers** → persönlichen
   **Zugangsschlüssel** eingeben.
3. In der Unterhaltung `datev_login` ausführen → DATEV-Login im Browser
   (Sandbox: „Test6"; Produktion: SmartLogin/SmartCard/mIDentity).
4. Danach stehen alle Werkzeuge zur Verfügung — mit den Daten, die **dieser**
   Nutzer sehen darf. `datev_logout` beendet die DATEV-Verbindung des Nutzers.

## Sicherheitsmodell (Kurzfassung)

- **Eintritt nur mit Zugangsschlüssel**; gespeichert werden nur Hashes.
  Zugangstokens laufen automatisch ab (8 h) und sind widerrufbar.
- **Sitzung ⟷ Nutzer fest verbunden:** Eine Sitzungs-ID allein autorisiert
  nie; jeder Aufruf braucht das gültige Token des Sitzungs-Eigentümers.
- **DATEV-Tokens** liegen AES-256-verschlüsselt, je Nutzer getrennt;
  DATEV-Anmeldevorgänge sind einmalig konsumierbar (Replay-Schutz).
- **Mandanten-Allowlist je Konto** wird serverseitig vor jedem DATEV-Aufruf
  durchgesetzt.
- Größen-/Rate-Limits, Sicherheits-Header, generische Fehlermeldungen nach
  außen; TLS terminiert der Reverse Proxy.

## Grenzen / bewusste Restpunkte

- Der Dienst ist für **eine Kanzlei** ausgelegt (mehrere Nutzer). Der
  Mehr-Kanzlei-/SaaS-Betrieb (Modell B) bleibt eine spätere Ausbaustufe.
- Betrieb (Updates, Monitoring, Backup des `~/.datev-mcp`-Ordners) liegt bei
  der Kanzlei-IT — Checkliste im [BETRIEB-REMOTE-BRIEFING.md](BETRIEB-REMOTE-BRIEFING.md).
- Vor dem Echtbetrieb: DATEV-Produktionsfreigabe und §-203-/DSGVO-Freigabe
  (siehe [ONBOARDING-PRODUKTION.md](ONBOARDING-PRODUKTION.md)).
