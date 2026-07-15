# Architektur & Entwicklerdokumentation — DATEV MCP-Server

Dieses Dokument richtet sich an **Entwickler**, die den Code verstehen, warten
oder erweitern wollen. Es erklärt **was** gebaut wurde, **warum** so entschieden
wurde und **wie** der Code aufgebaut ist.

> Andere Dokumente im Projekt:
>
> - **[../ANLEITUNG.md](../ANLEITUNG.md)** — für Anwender/die Kanzlei (nicht-technisch).
> - **[DATEV-PORTAL-NOTIZEN.md](DATEV-PORTAL-NOTIZEN.md)** — verifizierte API-/OAuth-Fakten.
> - **[ONBOARDING-PRODUKTION.md](ONBOARDING-PRODUKTION.md)** — Checkliste für den Echtbetrieb.
> - **[../README.md](../README.md)** — Schnellstart und Funktionsübersicht.

---

## 1. Ziel & Überblick

**Problem:** Eine Steuerkanzlei möchte Fragen zu ihren DATEV-Buchhaltungsdaten in
natürlicher Sprache an Claude stellen („Wie ist der Saldo auf Konto 1200?",
„Welche Kunden schulden uns Geld?") — statt Daten manuell zu exportieren und
händisch zu durchsuchen.

**Lösung:** Ein **MCP-Server** (Model Context Protocol) als Übersetzer zwischen
Claude und DATEV. Er stellt Claude eine Reihe von **Tools** bereit; Claude wählt
je nach Frage das passende Tool, der Server holt/berechnet die Daten und liefert
sie strukturiert zurück, damit Claude in normalem Deutsch antworten kann.

Der Server bedient **zwei Datenquellen** über dasselbe interne Modell:

1. **EXTF-Exportdatei** — offline, ohne DATEV-Login (sofort nutzbar).
2. **DATEV-Cloud** (Accounting Data Exchange + accounting-clients) — live, per
   OAuth-Login mit dem DATEV-Konto.

Technisch: TypeScript, Node ≥ 20, offizielles `@modelcontextprotocol/sdk`,
`zod` (Eingabevalidierung), `iconv-lite` + `csv-parse` (Dateiparser). Transport:
stdio (Claude Desktop). Kein externer Zustand, keine Datenbank — geladene Daten
leben nur im Prozessspeicher.

---

## 2. Was wir getan haben & warum (Entscheidungslog)

### 2.1 Bestandsanalyse der DATEV-Unterlagen

Im Repository lagen DATEV-API-Spezifikationen (OpenAPI), Postman/Bruno-Collections
und vier Portal-PDFs. Ergebnis: Es gibt **zwei API-Welten** — Cloud/Online-APIs
(`*.api.datev.de`, OAuth) und Desktop-APIs (DATEVconnect, nur lokal auf dem
Kanzlei-Server). Für das Ziel „live in die Daten einwählen und fragen" ist die
**Cloud-API** der richtige Weg; die Buchungsdaten liefert der Dienst **Accounting
Data Exchange**. (Details siehe [DATEV-PORTAL-NOTIZEN.md](DATEV-PORTAL-NOTIZEN.md).)

### 2.2 Prüfung zweier fremder Projekte

Der Nutzer fand zwei existierende Projekte. Beide wurden geprüft:

- **FinRobotics `datev-mcp-server`** (MIT-Lizenz): sauberer, kleiner
  TypeScript-MCP-Server mit EXTF-Parser und fünf Analyse-Tools. Im Praxistest
  beantwortete er die beworbenen Fragen korrekt — **aber nur aus Exportdateien**;
  der Quellcode enthielt keine einzige Netzwerk-/DATEV-Verbindung (die Live-Anbindung
  war dort ausdrücklich offene „Phase 2").
  → **Entscheidung: als Fundament übernehmen.** Sein Datenmodell und seine
  Analyse-Tools sind wiederverwendbar; wir sparen uns deren Neubau.

- **AnythingMCP** (AGPL): generisches „API-zu-MCP"-Gateway mit DATEV-Adapter.
  Code-Tiefenprüfung ergab: Der Adapter hat **exakt 6 Metadaten-Tools**
  (Mandanten, Belegtypen, DUO-Version) und **keinen Zugriff auf Buchungsdaten,
  Salden oder offene Posten** — die eigene Doku listet die Buchungsdaten-API
  ausdrücklich als „außerhalb des Scopes". Zudem fehlt die Technik für das
  asynchrone Job-Muster und für Mengenbegrenzung großer Bestände.
  → **Entscheidung: nicht verwenden** (die Werbebeispiele sind mit dem
  veröffentlichten Code nicht umsetzbar). Die DATEV-**Erkenntnisse** aus dem
  Adapter (OAuth-Details, Pflicht-Header, ID-Formate) flossen aber in unseren Bau
  ein. Das AGPL-Zip wurde nach Auswertung wieder entfernt.

**Grundsatzentscheidung (vom Nutzer bestätigt): eigener, maßgeschneiderter
Server auf FinRobotics-Basis.** Nur so bekommen wir echten Buchungsdaten-Zugriff
mit korrekter Behandlung des Job-Musters und der Datenmengen.

### 2.3 Wesentliche Umsetzungsentscheidungen

| Entscheidung                                                                    | Begründung                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Eine Codebasis, zwei Quellen** (Datei + Cloud) speisen ein gemeinsames Modell | Die bewährten Analyse-Tools funktionieren unverändert auf beiden Quellen; kein doppelter Code.                                        |
| **Start in der Sandbox**                                                        | DATEV bietet eine Übungsumgebung mit Testzugang; kein Risiko mit Mandantendaten, sofort testbar.                                      |
| **stdio-Transport zuerst**                                                      | Der Weg für Claude Desktop; kein Hosting nötig. Remote (HTTP) ist als spätere Phase vorgesehen, die Tool-Logik bleibt gleich.         |
| **Antworten mit deutschen Schlüsseln, Fehler auf Deutsch**                      | Die Ausgaben landen direkt bei Claude/Nutzer; handlungsleitende Meldungen statt roher Statuscodes.                                    |
| **Zeilen-Cap + serverseitige Filterung**                                        | Ein Buchungsdaten-Job liefert das ganze Wirtschaftsjahr (potenziell zehntausende Zeilen); ungefiltert würde das den Kontext sprengen. |

---

## 3. Architektur & Datenfluss

```
                +-------------------+
   Nutzerfrage  |   Claude Desktop  |
  ────────────► |   (MCP-Client)    |
                +---------+---------+
                          │ MCP über stdio (JSON-RPC)
                          ▼
        ┌─────────────────────────────────────────────┐
        │              DATEV MCP-Server                │
        │                                              │
        │  server.ts  ── registriert Tools+Ressource   │
        │      │                                       │
        │      ├── Datei-Tools ──► parser/extf.ts       │
        │      │                                       │
        │      └── Cloud-Tools ──► tools/cloud.ts       │
        │                             │                 │
        │            auth/*  ◄────────┤ (Login/Token)   │
        │            datev/* ◄────────┘ (HTTP/Jobs/Map) │
        │                                              │
        │          store/memory.ts (aktiver Datensatz) │
        └───────────────┬───────────────┬──────────────┘
                        │               │
             Exportdatei│               │HTTPS + OAuth
            (EXTF/DTVF) │               ▼
                        │        api.datev.de
                        ▼        (Accounting Data Exchange,
              gemeinsames                accounting-clients)
              DatevBooking-Modell
```

**Kernidee:** Egal ob eine EXTF-Datei geparst (`parser/extf.ts`) oder Cloud-Daten
gemappt werden (`datev/mapper.ts`) — es entsteht immer ein `DatevDataset` mit
`DatevBooking[]` (siehe `src/parser/types.ts`). Dieser Datensatz landet im
`store` als **aktiver Datensatz**. Die fünf Analyse-Tools (`get_account_balance`,
`get_open_items`, `list_bookings`, `search_documents` und implizit `load`) arbeiten
ausschließlich auf diesem Modell und sind damit **quellenunabhängig**.

**Ausnahme Kontosaldo (Verlässlichkeit vor Bequemlichkeit):** `get_account_balance`
bezieht bei **Cloud-Daten** die verbindliche Zahl direkt aus DATEVs
Summen-/Saldenliste (`sums-and-balances`, identisch zum DATEV-Kontoblatt) und
verprobt sie gegen eine deterministische Kontrollrechnung aus den geladenen
Buchungen (`computeAccountBalance`). Grund: Der Saldo darf **nie** vom Sprachmodell
freihändig aus tausenden Buchungen summiert werden (Rechenfehler). Der verbindliche
SuSa-Eintrag wird per **exakter** Kontonummer gewählt — die SuSa mischt 4-stellige
Sachkonten und 5-stellige Personenkonten, sodass eine tolerante Zuordnung `1200`
fälschlich als Debitor `12000` ausgeben könnte. Der tolerante Abgleich der zwei
Konto-Schreibweisen (Kurzform `1200` vs. technisch `12000000`, `accountMatches`)
bleibt ausschließlich der Kontrollrechnung vorbehalten. Weicht die Kontrolle vom
DATEV-Saldo ab, gibt das Feld `verprobung.warnung` das explizit aus. Im
**Datei-Modus** (keine SuSa verfügbar) wird exakt aus dem Stapel gerechnet.

**Sicherheitsgrenzen (Verschwiegenheitspflicht, § 203 StGB):**

- **Dateizugriff eingeschränkt:** `load_datev_file` lädt ausschließlich Dateien aus
  einem freigegebenen Import-Ordner (`config.importBaseDir`, Standard
  `~/.datev-mcp/import`, per `DATEV_IMPORT_DIR` änderbar). `resolveImportPath`
  (in `src/tools/load.ts`) löst Pfade auf, prüft die Zugehörigkeit zum Ordner und
  folgt keinen Symlinks nach außen — damit kann eine (ggf. per Prompt-Injection aus
  Buchungsdaten eingeschleuste) Anweisung weder die Token-Datei noch den Export
  eines anderen Mandanten lesen.
- **Nur Lese-Werkzeuge:** Keines der Tools verändert, löscht oder lädt Daten nach
  DATEV hoch; `datev_login` startet nur den lokalen PKCE-Flow.
- **Tokens & Geheimnisse:** Tokens liegen mit `0600`/`0700` lokal, werden atomar
  geschrieben und nie an das Modell zurückgegeben; das Client-Secret geht nur als
  `Authorization: Basic`-Header an den DATEV-Token-Endpunkt. Der Login-Callback
  lauscht ausschließlich auf `127.0.0.1` und maskiert alle in die Browser-Seite
  eingesetzten Werte (kein reflektiertes XSS).

---

## 4. Modul-für-Modul

### `src/config.ts` — Konfiguration

Leitet aus Umgebungsvariablen die `DatevConfig` ab (Sandbox vs. Produktion,
OAuth-Endpunkte, API-Basis-URLs, Token-Ablageort). `loadConfig(env)` ist
testbar (Env injizierbar); `config` ist die prozessweite Instanz. Fehlende
Zugangsdaten sind **kein** Fehler — der Dateimodus läuft ohne Login.

### `src/auth/` — Anmeldung (OAuth 2.0, Authorization Code + PKCE)

- **`oauth.ts`** — zustandslose Bausteine: `createPkcePair()`, `buildAuthorizeUrl()`,
  `exchangeAuthorizationCode()`, `refreshAccessToken()`. `FetchLike` macht `fetch`
  injizierbar (Tests). DATEV unterstützt **kein** `client_credentials`; jeder
  Zugriff erfolgt im Namen eines echten Nutzers.
- **`loopback.ts`** — startet für den Login einen kurzlebigen lokalen
  HTTP-Server auf `localhost:<port>`, empfängt genau einen Callback, tauscht den
  Code gegen Tokens und beendet sich. Der Status liegt modulweit
  (`getLoginState()`), weil `datev_login` und ein späteres `datev_status`
  getrennte, kurzlebige Tool-Aufrufe sind.
- **`token-store.ts`** — `FileTokenStore` persistiert Tokens unter
  `~/.datev-mcp/tokens-<env>.json` mit Rechten **0600**. Tokens verlassen den
  Rechner nie.
- **`token-manager.ts`** — `getAccessToken()` liefert immer ein gültiges Token
  und erneuert es 60 s vor Ablauf. Zwei wichtige Feinheiten:
  ```ts
  // Single-Flight: parallele Tool-Aufrufe teilen sich EINEN Refresh —
  // sonst würde die Token-Rotation von DATEV alle bis auf einen ungültig machen.
  this.refreshInFlight ??= refreshAccessToken(...).then((fresh) => {
    const merged = { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
    this.store.save(merged); // Rotiertes Refresh-Token SOFORT persistieren.
    return merged;
  });
  ```
  Bei `invalid_grant` wird der Speicher geleert und `NotLoggedInError` geworfen
  (sauberer Neu-Login).

### `src/datev/` — Cloud-Zugriff

- **`http.ts`** — `DatevHttpClient` kapselt jeden Aufruf: gültiges Token holen,
  Pflicht-Header setzen und 429/503 begrenzt wiederholen. **Wichtig:** DATEV
  verlangt bei _jedem_ Call zwei Nachweise gemeinsam:
  ```ts
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'X-DATEV-Client-Id': this.config.clientId, // zusätzlich zum Bearer Pflicht!
  }
  ```
  `getNdjson()`/`parseNdjson()` behandeln das NDJSON-Format der DATEV-Listen
  (ein JSON-Objekt pro Zeile; JSON-Arrays werden toleriert).
- **`errors.ts`** — übersetzt RFC-7807-Fehler in deutsche, handlungsleitende
  Meldungen (401 → „datev_login ausführen", 403 → „Freischaltung prüfen").
- **`jobs.ts`** — das asynchrone Job-Muster (siehe Abschnitt 6).
- **`mapper.ts`** — `mapAccountPosting()`/`buildCloudDataset()` überführen
  Cloud-Buchungen in `DatevBooking`. Soll/Haben ergibt sich daraus, ob
  `amountDebit` oder `amountCredit` gesetzt ist.
- **`types.ts`** — nur die tatsächlich genutzten Felder der DATEV-Antworten
  (vollständige Schemas: `docs/openapi/cloud/`).

### `src/parser/` — Dateiimport

- **`extf.ts`** — Parser für DATEV-Buchungsstapel. Erkennt am Kennzeichen in
  Zeile 1 automatisch das **offizielle EXTF/DTVF-Format** (positionaler Header,
  Spaltenüberschriften in Zeile 2) oder das **vereinfachte Testformat**. Zwei
  DATEV-Eigenheiten werden hier gelöst: Latin-1-Dekodierung (sonst kaputte
  Umlaute) und das `TTMM`-Belegdatum (Jahr wird über den Wirtschaftsjahresbeginn
  ergänzt, inkl. abweichendem Wirtschaftsjahr).
- **`types.ts`** — das **gemeinsame Datenmodell** (`DatevHeader`, `DatevBooking`,
  `DatevDataset`, `OpenItem`, `BookingFilter`).

### `src/store/memory.ts` — Datenhaltung

`InMemoryDatevStore` hält mehrere Datensätze (verschiedene Dateien/Cloud-Jahre)
und merkt sich den **aktiven**. Schlüssel ist der Dateipfad bzw.
`clientId:fiscalYearId`. Bewusst keine Datenbank — die Daten bleiben flüchtig im
Prozess.

### `src/tools/` — die eigentlichen Werkzeuge

- **Analyse-Tools** (quellenunabhängig): `balance.ts`, `openItems.ts`,
  `bookings.ts`, `search.ts`, `load.ts`. Beispiel für dokumentierte Fachlogik —
  die Saldo-Vorzeichenregel in `balance.ts`:
  ```ts
  // Aus Sicht des gefragten Kontos: im account-Feld wirkt Soll +, Haben −;
  // steht das Konto im Gegenkonto, kehrt sich die Wirkung um.
  if (account === bookingAccount) return direction === 'S' ? amount : -amount;
  if (account === contraAccount) return direction === 'S' ? -amount : amount;
  ```
- **Cloud-Tools** (`cloud.ts`): Klasse `CloudTools` mit `status`, `login`,
  `listClients`, `listFiscalYears`, `loadFromCloud`, `getSumsAndBalances`. Sie
  bündelt `TokenManager`, `DatevHttpClient` und `AccountPostingsJobRunner`.
  Zod-Schemas nutzen `.describe()`, damit Claude die Parameter korrekt füllt
  (z. B. `clientId`-Format oder `fiscalYearId` als `JJJJMMTT`).

### `src/server.ts` + `src/index.ts` — Verdrahtung & Start

`createServer()` registriert alle Tools (mit deutscher Beschreibung + Schema) und
die Ressource `datev://help`. Jeder Handler läuft durch `safe()`, das Fehler in
sauberen MCP-Fehlerinhalt verwandelt, statt den Server zu stören. `index.ts`
verbindet den Server mit dem stdio-Transport.

---

## 5. OAuth-Ablauf (Schritt für Schritt)

```
datev_login ─► startLoginFlow()
   1. PKCE-Paar + state erzeugen
   2. lokalen Callback-Server auf localhost:53682 starten
   3. Authorize-URL zurückgeben ──► Nutzer öffnet sie im Browser
                                     └─► DATEV-Login (Sandbox: "Test6")
   4. DATEV leitet auf localhost:53682/callback zurück
   5. Code + PKCE-Verifier ──► exchangeAuthorizationCode() ──► Tokens
   6. FileTokenStore.save()  (0600),  Server schließt sich
datev_status ─► liest getLoginState() + isLoggedIn()
```

- **Sandbox vs. Produktion** unterscheiden sich nur in den Endpunkten/Basispfaden
  (`config.ts`): `openidsandbox`/`sandbox-api`/`platform-sandbox` gegenüber den
  Live-Varianten. Umstellung per `DATEV_ENV`.
- **Refresh/Rotation:** Der `TokenManager` erneuert proaktiv und persistiert das
  rotierte Refresh-Token sofort (Single-Flight verhindert Doppel-Refresh).
- **Kein `client_credentials`:** DATEV erlaubt nur nutzergebundene Zugriffe
  (SmartLogin/SmartCard). Deshalb der interaktive Browser-Login.

---

## 6. Async-Job-Muster (Buchungsdaten)

DATEV liefert Buchungssätze **nicht direkt**, sondern über einen Auftrag
(`AccountPostingsJobRunner.run()` in `datev/jobs.ts`):

```
POST  …/account-postings            ──► 202 { jobId }
GET   …/jobs/{jobId}/state          ──► PENDING | RUNNING | COMPLETED | FAILED
  (pollen mit wachsender Wartezeit 1s,2s,3s,5s… bis zum Zeitbudget ~45s)
GET   …/account-postings-jobs/{id}?page=N  ──► NDJSON-Seiten (bis x-total-pages)
```

Warum eigens gebaut:

- **Zeitbudget:** MCP-Tool-Aufrufe dürfen nicht beliebig lange blockieren. Läuft
  der Job länger, liefert das Tool `status: in_arbeit` samt `jobId` und dem
  Hinweis, die Frage in ~30 s zu wiederholen. Ein erneuter Aufruf **setzt
  denselben Job fort** (`pendingJobs`-Map), statt einen neuen zu starten.
- **Datenmenge:** Der Job liefert das ganze Wirtschaftsjahr. Ein Zeilen-Cap
  (`MAX_ROWS`) schützt Speicher/Kontext; die Tools filtern zusätzlich clientseitig.

Genau diese zwei Punkte fehlen den generischen Gateways — der Grund für den
eigenen Server.

---

## 7. Tests & Verifikation

`npm test` (Vitest) — **25 Tests**, gemocktes `fetch` (keine echten Netzaufrufe):

| Datei                      | Prüft                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/cloud.test.ts`       | Token-Refresh inkl. Rotation & Single-Flight; Fehler-Mapping (401/403/404/429); NDJSON; Pflicht-Header; Job-Polling inkl. Timeout/Resume und FAILED; Mapper. |
| `test/parser.test.ts`      | Beide EXTF-Formate (Header, Umlaute, TTMM-Belegdatum).                                                                                                       |
| `test/tools.test.ts`       | Alle MCP-Tools registriert; Analyse-Tools auf einem geladenen Datensatz.                                                                                     |
| `test/integration.test.ts` | Laden und Abfragen im selben Prozess.                                                                                                                        |

Weitere Prüfungen:

- `npm run build` (Kompilat), `npm run typecheck` (strenge Typprüfung inkl. Tests),
  `npm run lint`, `npm run format`.
- **MCP-Rauchtest:** Server per stdio starten und `tools/list` / `tools/call`
  senden (z. B. `datev_status`, `load_datev_file`, `get_account_balance`).
- **Sandbox-E2E:** nach einmaligem `datev_login` (Test6/Mandant 455148-1) die
  Kette `list_clients → list_fiscal_years → load_from_cloud → Fragen` durchspielen.

---

## 8. Erweiterungsleitfaden

**Ein neues Cloud-Tool hinzufügen** (Muster am Beispiel bestehender Tools):

1. In `src/datev/types.ts` die genutzten Antwortfelder typisieren (nur was
   gebraucht wird).
2. In `src/tools/cloud.ts` ein Zod-`*Schema` mit `.describe()` sowie eine
   Methode auf `CloudTools` ergänzen; für Listen `http.getNdjson`, für Objekte
   `http.getJson` nutzen; Ergebnis mit deutschen Schlüsseln und Zeilen-Cap
   zurückgeben.
3. In `src/server.ts` das Tool per `server.registerTool(name, {title,
description, inputSchema}, handler)` registrieren und den Handler in `safe()`
   kapseln.
4. Test in `test/cloud.test.ts` mit gemocktem `fetch` ergänzen.

**Roadmap (noch nicht umgesetzt):**

- Remote-Betrieb (Streamable HTTP + Bearer/HTTPS) für claude.ai — nur ein
  zweites Transport; Tools bleiben gleich.
- Belege hochladen (`accounting-documents`) — erste schreibende Operation.
- DATEVconnect-Desktop-Modul (Basic Auth, lokal im Kanzleinetz) für OPOS,
  Stammdaten, DMS. **Vorlage:** die aus DATEV-Specs abgeleitete Ressourcen-
  Landkarte in [reference/KLARDATEN-ANALYSE.md](reference/KLARDATEN-ANALYSE.md).
  Wichtig: DATEVconnect ist **synchron/lokal** — dort ist **kein** Async-Job-
  Muster nötig (das gilt nur für die Cloud-ADE). Ein generischer Resource-URI-
  Ansatz (wie bei Klardaten) ist hier eine Option, unser aufgabenorientierter
  Stil eine andere.
- Weitere Cloud-Dienste (Lohn/Payroll, Tax) — Specs teils nur als Postman-Collection.

Details zu den Nutzer-/Organisationsaufgaben stehen in
[ONBOARDING-PRODUKTION.md](ONBOARDING-PRODUKTION.md).

---

## 9. Glossar

| Begriff                            | Bedeutung                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **MCP**                            | Model Context Protocol — Standard, über den Claude externe Tools/Ressourcen nutzt.                            |
| **Tool**                           | Eine von Claude aufrufbare Funktion mit Namen, Beschreibung und Eingabeschema.                                |
| **EXTF/DTVF**                      | DATEV-Austauschformat für Buchungsstapel (CSV, Latin-1, `;`-getrennt).                                        |
| **Accounting Data Exchange (ADE)** | Cloud-API für lesenden Zugriff auf Buchungsdaten, Salden, Sachkonten.                                         |
| **clientId**                       | Mandant im Format `Beraternummer-Mandantennummer` (z. B. `455148-1`) — **nicht** die OAuth-Client-ID der App. |
| **fiscalYearId**                   | Wirtschaftsjahr als Zahl `JJJJMMTT` (Beginn), z. B. `20260101`.                                               |
| **PKCE**                           | Proof Key for Code Exchange — Absicherung des OAuth-Authorization-Code-Flows.                                 |
| **Refresh-Token**                  | Langlebiges Token (~2 Jahre) zum Erneuern des kurzlebigen Zugriffstokens.                                     |
| **NDJSON**                         | „Newline-delimited JSON": ein JSON-Objekt pro Zeile — Listenformat der DATEV-APIs.                            |
| **Soll/Haben**                     | Buchungsrichtung; `S` = Soll, `H` = Haben. Saldo = Summe Soll − Summe Haben.                                  |
| **SKR03/SKR04**                    | Standardkontenrahmen; Sachkonten 4-stellig, Personenkonten 5-stellig.                                         |
| **Debitor/Kreditor**               | Kunde (Forderung) bzw. Lieferant (Verbindlichkeit); Kontenbereiche 10000–69999 / 70000–99999.                 |
| **Offener Posten**                 | Noch nicht ausgeglichene Forderung/Verbindlichkeit auf einem Personenkonto.                                   |
| **Sandbox**                        | DATEV-Übungsumgebung mit Testzugang (Nutzer „Test6", Mandant 455148-1).                                       |
