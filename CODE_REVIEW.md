# Kritischer Code-Review

**Stand:** 16. Juli 2026  
**Schwerpunkt:** Architekturentscheidungen, Sicherheit und Datenintegrität  
**Review-Umfang:** aktueller Stand des Branches `claude/datev-mcp-server-analysis-dprntt`

## Zusammenfassung

Die Codebasis ist insgesamt gut strukturiert, verständlich dokumentiert und durch Tests solide abgesichert. Typecheck, ESLint und alle 64 Tests liefen ohne Fehler; `npm audit --omit=dev` meldete keine bekannten Schwachstellen.

Vor einem Produktionseinsatz sollten jedoch insbesondere drei Punkte behoben werden:

1. Der globale, implizit aktive Datensatz ist nicht mandanten- oder sitzungsgebunden.
2. Unvollständige beziehungsweise beschädigte Cloud-Daten können als belastbare Daten weiterverarbeitet werden.
3. Der dokumentierte Schutz der OAuth-Tokens durch POSIX-Dateimodi greift unter Windows nicht zuverlässig.

## Findings

### [P1] Globaler „aktiver Datensatz“ ist nicht mandanten- oder sitzungsgebunden

**Betroffene Stellen:**

- `src/store/memory.ts:35–37`
- `src/store/memory.ts:46–58`
- `src/tools/balance.ts:154`
- `src/tools/bookings.ts:89`
- `src/tools/openItems.ts:107`
- `src/tools/search.ts:27`

Jeder Ladeaufruf überschreibt den prozessweiten `activeKey`. Alle Analyse-Tools greifen anschließend implizit auf den zuletzt aktivierten Datensatz zu. Parallele Tool-Aufrufe können dadurch Ergebnisse des falschen Mandanten oder Wirtschaftsjahres liefern.

Schon beim heutigen stdio-Betrieb besteht dieses Integritätsrisiko, weil MCP-Tool-Aufrufe parallel stattfinden können. Bei dem in der Roadmap vorgesehenen Remote-Betrieb würden zusätzlich mehrere Benutzer oder Verbindungen denselben globalen Zustand teilen. Die dokumentierte Annahme, Remote-Betrieb benötige lediglich einen anderen Transport und die Tools könnten unverändert bleiben, ist daher nicht tragfähig.

**Empfehlung:**

- Datensätze durch eine explizite `datasetId`, Mandanten-ID und Wirtschaftsjahr adressieren.
- Analyse-Tools nicht von einem impliziten globalen Zustand abhängig machen.
- Stores und OAuth-Zustände pro MCP-Verbindung beziehungsweise Benutzeridentität isolieren.
- Für Remote-Betrieb eine eigene Authentifizierungs-, Autorisierungs- und Session-Architektur vorsehen.

### [P1] Unvollständige Cloud-Daten werden als vollständiger Datensatz weiterverwendet

**Betroffene Stellen:**

- `src/datev/jobs.ts:147–167`
- `src/tools/cloud.ts:359–377`
- `src/parser/types.ts:62–71`
- `src/datev/http.ts:152–179`
- `test/cloud.test.ts:196–202`

Cloud-Buchungen werden bei 50.000 Zeilen abgeschnitten. Das Feld `truncated` wird nur in der unmittelbaren Antwort von `datev_load_from_cloud` ausgegeben, aber nicht dauerhaft im `DatevDataset` gespeichert. Nachfolgende Aufrufe von `list_bookings`, `search_documents` oder `get_open_items` können deshalb Vollständigkeit suggerieren, obwohl nur ein Teilbestand vorliegt.

Zusätzlich verwirft `parseNdjson` beschädigte NDJSON-Zeilen still. Ein defektes JSON-Array wird sogar als leere Liste behandelt. Damit sind „keine Daten vorhanden“ und „Datenübertragung oder Parsing fehlgeschlagen“ nicht unterscheidbar. Dieses Fail-open-Verhalten ist derzeit explizit im Test festgeschrieben.

**Empfehlung:**

- Im Datensatz dauerhaft Provenienz und Vollständigkeit speichern, etwa `complete`, `partial`, `expectedCount`, `loadedCount` und `parseErrors`.
- Unvollständige Daten in jeder nachfolgenden Tool-Antwort sichtbar machen.
- Auswertungen, die Vollständigkeit voraussetzen, bei partiellen Daten blockieren.
- DATEV-Antworten anhand von Runtime-Schemas validieren.
- Bei beschädigten Zeilen fail-closed reagieren oder das Ergebnis zwingend als partiell kennzeichnen.
- Header-Zählwerte gegen die tatsächlich geparsten Zeilen prüfen.

### [P1] Token-Dateirechte schützen unter Windows nicht wie dokumentiert

**Betroffene Stellen:**

- `src/auth/token-store.ts:65–72`
- `test/cloud.test.ts:72–76`
- `docs/ARCHITEKTUR.md:177–181`

Der Token-Store speichert Zugriffstoken, langlebige Refresh-Tokens und das ID-Token im Klartext und versucht die Datei über `0600` sowie das Verzeichnis über `0700` zu schützen. Unter Windows setzt Node.js damit jedoch keine getrennten Lese- und Schreibrechte für Eigentümer, Gruppe und andere Benutzer durch. Der zugehörige Test überspringt die Berechtigungsprüfung auf Windows.

Ein Standardpfad innerhalb des Benutzerprofils kann durch geerbte NTFS-ACLs ausreichend geschützt sein. Der Code stellt dies aber nicht sicher, besonders wenn `DATEV_TOKEN_STORE` auf einen benutzerdefinierten oder gemeinsam verwendeten Pfad zeigt.

Referenz: [Node.js-Dokumentation zu `fs.chmod`](https://nodejs.org/api/fs.html#fschmodpath-mode-callback)

**Empfehlung:**

- Unter Windows bevorzugt Credential Manager oder DPAPI verwenden.
- Alternativ eine NTFS-DACL ausschließlich für die aktuelle Benutzer-SID setzen und anschließend validieren.
- Unsichere benutzerdefinierte Token-Speicherorte ablehnen oder deutlich warnen.
- Das derzeit ungenutzte ID-Token nicht persistieren.
- Temporäre Dateien exklusiv erstellen, um vorhandenen Dateien oder Links nicht zu folgen.

### [P2] Dateiimporte erlauben Ressourcenerschöpfung und blockieren den MCP-Prozess

**Betroffene Stellen:**

- `src/tools/load.ts:93–99`
- `src/parser/extf.ts:320–331`

Der Parser liest die komplette Datei synchron in den Speicher, dekodiert den gesamten Inhalt und materialisiert anschließend alle CSV-Zeilen sowie für jede Buchung ein zusätzliches `raw`-Objekt. Es fehlen eine Prüfung auf reguläre Dateien, eine maximale Dateigröße, ein Zeilenlimit und ein Abbruchsignal.

Große legitime DATEV-Exporte können dadurch den gesamten stdio-MCP-Prozess blockieren oder den verfügbaren Speicher erschöpfen. Die Pfadbeschränkung schützt die Vertraulichkeit, aber nicht die Verfügbarkeit.

**Empfehlung:**

- Vor dem Öffnen per `stat` prüfen, dass es sich um eine reguläre Datei handelt.
- Ein konfigurierbares, sicheres Größenlimit setzen.
- CSV-Daten gestreamt verarbeiten.
- Ein hartes Zeilen- beziehungsweise Speicherlimit verwenden.
- `raw` nur für tatsächlich benötigte Felder oder optional vorhalten.
- Timeout und Abbruchsignal durch den gesamten Importpfad reichen.

### [P2] Der Parser fällt bei unbekannten Dateien auf ein Testformat zurück

**Betroffene Stellen:**

- `src/parser/extf.ts:333–363`
- `src/parser/extf.ts:263–305`

Jede Datei ohne exakten Marker `EXTF` oder `DTVF` wird automatisch als vereinfachtes Legacy-/Testformat interpretiert. Ein beschädigter Marker oder eine fremde CSV-Datei kann dadurch als gültiger Buchungsstapel erscheinen.

Fehlende Betragsfelder werden zu `0`, fehlende oder unbekannte Soll-/Haben-Kennzeichen zu Soll. Pflichtspalten, Konten, Datumswerte und Header-Metadaten werden nicht umfassend validiert. Das kann plausible, aber fachlich falsche Ergebnisse erzeugen.

**Empfehlung:**

- Das Legacy-Format nur über eine explizite Entwicklungs- oder Testoption aktivieren.
- In Produktion ausschließlich bekannte DATEV-Formate akzeptieren.
- Pflichtspalten und Headerfelder vor dem Mapping validieren.
- Unbekannte Soll-/Haben-Werte ablehnen statt auf Soll zurückzufallen.
- Ungültige Konten, Daten und fehlende Beträge mit Zeilennummer melden.

### [P2] Buchungsinhalte bilden eine nicht ausreichend behandelte Prompt-Injection-Grenze

**Betroffene Stellen:**

- `src/server.ts:31–38`
- `src/tools/bookings.ts:94–103`
- `src/tools/search.ts:38–47`
- `src/tools/openItems.ts:55–64`
- `docs/ARCHITEKTUR.md:166–181`

Buchungstexte und Belegfelder werden unverändert zusammen mit den Servermeldungen als serialisierter Text an das Sprachmodell geliefert. Eine in Rechnungs- oder Buchungstexten enthaltene Anweisung ist für das Modell dadurch nicht technisch von vertrauenswürdigen Steuerinformationen getrennt.

Die vorhandene Sicherheitsarchitektur berücksichtigt Prompt Injection vor allem beim Dateizugriff. Sie verhindert aber nicht, dass manipulierte Buchungsinhalte weitere Cloud-Leseaufrufe, einen Mandantenwechsel oder eine unerwünschte Offenlegung im Gespräch provozieren.

**Empfehlung:**

- Fremddaten in Tool-Beschreibungen und Antworten ausdrücklich als nicht vertrauenswürdige Daten kennzeichnen.
- Nur die für die konkrete Abfrage notwendigen Felder zurückgeben.
- `structuredContent` und `outputSchema` verwenden, um Daten und Status sauber zu trennen.
- Ein Wechsel des Mandanten oder Datensatzes sollte eine explizite Nutzerabsicht erfordern.
- Autorisierung und Tool-Freigaben dürfen nicht allein von Modellentscheidungen abhängen.

Referenz: [MCP-Spezifikation für Tools und strukturierte Ergebnisse](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

### [P2] OAuth-Callback validiert `state` bei Fehlerantworten nicht

**Betroffene Stellen:**

- `src/auth/loopback.ts:134–175`
- `src/auth/oauth.ts:121–146`

Ein Callback mit `error` beendet den Login-Vorgang, bevor der zurückgegebene `state` geprüft wird. Ein lokaler Prozess oder ein geeigneter Browser-Request kann dadurch einen laufenden Login abbrechen.

Außerdem besitzt der Token-Austausch kein eigenes Timeout oder Abbruchsignal. Der zehnminütige Timer des Callback-Servers beendet zwar den Listener, bricht einen bereits laufenden Token-Request aber nicht zuverlässig ab. Ein verspäteter Request kann dadurch den Login-Zustand nachträglich verändern oder Tokens speichern.

**Empfehlung:**

- `state` vor jeder Verarbeitung eines Erfolgs- oder Fehlercallbacks validieren.
- Einen Callback atomar genau einmal konsumieren.
- Den Token-Austausch mit Timeout und `AbortSignal` versehen.
- Timeout, Server, HTTP-Request und Login-Zustand in einem gemeinsamen Lebenszyklus verwalten.

## Positive Aspekte

- Gute modulare Trennung von MCP-Registrierung, OAuth, HTTP, DATEV-Mapping, Parser, Speicher und Fachtools.
- OAuth Authorization Code Flow mit PKCE und zufälligem `state`.
- Callback-Server bindet ausschließlich an `127.0.0.1`.
- Dynamische API-Pfadsegmente werden URL-kodiert.
- DATEV-Endpunkte sind fest konfiguriert; Tool-Eingaben können keine beliebigen Zielhosts bestimmen.
- Pfad-Traversal und Symlink-Ausbruch aus dem Importordner werden grundsätzlich berücksichtigt.
- HTTP-Aufrufe besitzen Timeouts und begrenzte Retries.
- Refresh-Token-Rotation wird per Single-Flight gegen parallele Refreshes geschützt.
- Tool-Ausgaben und Cloud-Buchungszeilen besitzen grundsätzlich Mengenbegrenzungen.
- Fehlerobjekte vermeiden bewusst die Ausgabe vollständiger Konfigurationsobjekte.

## Verifikation

- `npm run typecheck`: erfolgreich
- `npm run lint`: erfolgreich
- `npm test`: 4 Testdateien, 64 Tests erfolgreich
- `npm audit --omit=dev`: 0 bekannte Schwachstellen

## Priorisierte Umsetzung

1. Expliziten, sitzungsgebundenen Datensatzkontext einführen.
2. Vollständigkeits- und Validierungsstatus als Bestandteil des Datenmodells etablieren.
3. Sicheren Windows-Token-Speicher implementieren.
4. Dateiimport auf Streaming und harte Ressourcenlimits umstellen.
5. Parser fail-closed gestalten und Legacy-Format aus dem Produktionspfad entfernen.
6. Prompt-Injection- und Autorisierungsgrenzen für sensible Lesezugriffe dokumentieren und technisch erzwingen.
7. OAuth-Callback und Token-Austausch in einem robusten Abbruch-/Timeout-Lebenszyklus zusammenführen.

Die Punkte 1 bis 3 sollten als Freigabeblocker für den Einsatz mit echten Mandantendaten behandelt werden.
