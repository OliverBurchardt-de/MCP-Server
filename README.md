# DATEV MCP-Server

Ein MCP-Server ([Model Context Protocol](https://modelcontextprotocol.io/)),
der Claude Fragen zu DATEV-Buchhaltungsdaten beantworten lässt — aus
**EXTF-Exportdateien** (sofort, offline) oder **live aus der DATEV-Cloud**
(Accounting Data Exchange, OAuth mit PKCE).

### Dokumentation im Überblick

| Dokument                                                           | Zielgruppe / Inhalt                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **[ANLEITUNG.md](ANLEITUNG.md)**                                   | Anwender/Kanzlei — Einrichtung und Nutzung, ohne Technik.                                                           |
| **[docs/SANDBOX-REGISTRIERUNG.md](docs/SANDBOX-REGISTRIERUNG.md)** | Klick-für-Klick: App im DATEV-Entwicklerportal registrieren (Client ID/Secret).                                     |
| **[docs/EINRICHTUNG-WINDOWS.md](docs/EINRICHTUNG-WINDOWS.md)**     | Klick-für-Klick: DATEV-MCP unter Windows in Claude Desktop einrichten und erste Sandbox-Anmeldung.                  |
| **[docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md)**                     | Entwickler — was/warum/wie: Entscheidungen, Modul-Durchgang, OAuth- und Job-Ablauf, Erweiterungsleitfaden, Glossar. |
| **[docs/ARCHITEKTURENTSCHEIDUNGEN.md](docs/ARCHITEKTURENTSCHEIDUNGEN.md)** | Entscheidungslog — warum es so gebaut ist (inkl. Vertriebsperspektive/Modell B).                            |
| **[docs/DATEV-PORTAL-NOTIZEN.md](docs/DATEV-PORTAL-NOTIZEN.md)**   | Verifizierte API-/OAuth-Fakten als Referenz.                                                                        |
| **[docs/reference/KLARDATEN-ANALYSE.md](docs/reference/KLARDATEN-ANALYSE.md)** | Analyse des Klardaten-MCP: Ressourcen-Landkarte für das DATEVconnect-Modul, ID-Formate.                 |
| **[docs/ONBOARDING-PRODUKTION.md](docs/ONBOARDING-PRODUKTION.md)** | Checkliste für den Weg in den Echtbetrieb.                                                                          |
| **[docs/BETRIEB-REMOTE-BRIEFING.md](docs/BETRIEB-REMOTE-BRIEFING.md)** | IT-Briefing für den Fernzugriff-Betrieb (Server, Domain, TLS, Türsteher).                                       |
| **[docs/FERNZUGRIFF.md](docs/FERNZUGRIFF.md)** | Fernbetrieb einrichten und nutzen: IT-Setup, Nutzerkonten, Verbinden aus Claude.                                                        |
| **[docs/ABNAHME-PRUEFPROTOKOLL.md](docs/ABNAHME-PRUEFPROTOKOLL.md)** | Abnahme-Prüfprotokoll: automatische + Live-Sandbox-Wertprüfung.                                                   |

## Funktionsumfang

**Analyse-Tools** (arbeiten auf dem aktiven Datensatz — Datei oder Cloud):

| Tool                  | Beantwortet                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `get_account_balance` | „Wie ist der Saldo auf Konto 1200?"                                   |
| `get_open_items`      | „Welche Kunden schulden uns Geld?" (Debitoren/Kreditoren, überfällig) |
| `list_bookings`       | „Alle Buchungen über 1.000 € im Februar"                              |
| `search_documents`    | „Suche Rechnung RE-2026-0089"                                         |

**Datenquellen:**

| Tool                          | Zweck                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `load_datev_file`             | EXTF/DTVF-Buchungsstapel-Export laden (offizielles Format und vereinfachtes Testformat) |
| `datev_login`                 | DATEV-Anmeldung (OAuth 2.0 Authorization Code + PKCE, Sandbox oder Produktion)          |
| `datev_list_clients`          | Mandanten des angemeldeten Nutzers                                                      |
| `datev_list_fiscal_years`     | Wirtschaftsjahre eines Mandanten                                                        |
| `datev_load_from_cloud`       | Alle Buchungen eines Wirtschaftsjahres laden (asynchroner DATEV-Job mit Fortsetzung)    |
| `datev_get_sums_and_balances` | Summen-/Saldenliste live inkl. EB- und Monatswerten                                     |
| `datev_status`                | Umgebung, Anmeldestatus, geladene Datensätze                                            |

Dazu die MCP-Resource `datev://help` mit einer Kurzanleitung für das Modell.

## Schnellstart (Entwicklung)

```bash
npm install
npm run build     # kompiliert nach dist/
npm test          # 25 Unit-Tests (gemockte DATEV-API)
npm run dev       # startet den Server direkt aus den Quellen (stdio)
```

Konfiguration über Umgebungsvariablen — siehe [.env.example](.env.example).
Ohne `DATEV_CLIENT_ID`/`DATEV_CLIENT_SECRET` funktioniert der Dateimodus
uneingeschränkt; die Cloud-Tools verweisen dann auf die App-Registrierung.

## Claude Desktop

```json
{
  "mcpServers": {
    "datev": {
      "command": "node",
      "args": ["/pfad/zum/projekt/dist/index.js"],
      "env": {
        "DATEV_ENV": "sandbox",
        "DATEV_CLIENT_ID": "…",
        "DATEV_CLIENT_SECRET": "…"
      }
    }
  }
}
```

## Projektstruktur

```
src/
├── index.ts            # Entrypoint (stdio-Transport)
├── server.ts           # Tool-/Resource-Registrierung
├── config.ts           # Sandbox/Produktion, Endpunkte, Credentials
├── auth/               # OAuth PKCE, lokaler Login-Callback, Token-Store/-Refresh
├── datev/              # HTTP-Client, Fehlerübersetzung, Job-Runner, Mapper
├── parser/             # EXTF/DTVF-Parser (offizieller + vereinfachter Header)
├── store/              # In-Memory-Datensätze (mehrere Quellen, aktiver Datensatz)
└── tools/              # Tool-Implementierungen
docs/
├── openapi/            # DATEV-API-Spezifikationen (cloud/ + datevconnect/)
├── collections/        # Postman/Bruno-Collections inkl. Sandbox-Umgebung
├── pdf/                # DATEV-Portal-PDFs (Bild-PDFs)
├── DATEV-PORTAL-NOTIZEN.md   # verifizierte API-/Portal-Fakten
└── ONBOARDING-PRODUKTION.md  # Checkliste für den Echtbetrieb
```

## Sandbox-E2E

Nach einmaligem `datev_login` gegen die Sandbox (Testuser Test6,
Testmandant `455148-1`) lassen sich alle Cloud-Tools live durchspielen —
siehe „Die erste Live-Sitzung" in [ANLEITUNG.md](ANLEITUNG.md).

## Lizenz / Herkunft

MIT. Basiert auf dem MIT-lizenzierten
[FinRobotics datev-mcp-server](https://finrobotics.de) (EXTF-Parser,
Analyse-Tools); erweitert um das offizielle EXTF-Headerformat, den
Multi-Datensatz-Store und die komplette DATEV-Cloud-Anbindung.
