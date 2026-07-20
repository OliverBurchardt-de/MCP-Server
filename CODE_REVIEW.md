# Kritischer Code-Review

**Stand:** 20. Juli 2026
**Schwerpunkt:** Technischer Reifegrad, Sicherheit und Weg zum Remote-Mehrbenutzerbetrieb
**Review-Umfang:** Branch `claude/datev-mcp-server-analysis-dprntt` einschließlich der noch nicht eingecheckten Security-Härtungen
**Zielbild:** Öffentlich erreichbarer DATEV-MCP-Connector für eine Kanzlei und mehrere berechtigte Mitarbeitende; ein späterer zentraler SaaS-Betrieb bleibt eine weitere Ausbaustufe.

## Kurzurteil

Die Codebasis ist ein guter, sicher gehärteter lokaler Einzelbenutzer-Pilot. Die Fachlogik, DATEV-Anbindung und lokale Sicherheitsbasis sind weit fortgeschritten. Für das dokumentierte Ziel eines öffentlich erreichbaren Connectors ist der Stand jedoch noch nicht produktionsreif.

Der entscheidende nächste Schritt ist kein weiterer punktueller Security-Fix und auch kein reiner Austausch des Transports. Erforderlich ist die Einführung einer verbindlichen Identitäts-, Autorisierungs- und Mandantentrennung für jede Anfrage. Der aktuelle Code besitzt weiterhin einen globalen DATEV-Login, einen globalen Datensatzspeicher und einen globalen Login-Zustand.

## Technischer Reifegrad

| Zielstufe                            | Einschätzung                                                                |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Lokale Sandbox, Einzelbenutzer       | Pilotbereit                                                                 |
| Lokaler Betrieb mit Echtdaten        | Bedingt bereit; sicherer Token-Speicher sowie DATEV-/DSGVO-Freigaben fehlen |
| Remote, eine Kanzlei, mehrere Nutzer | Architekturumbau erforderlich                                               |
| Zentraler SaaS-/Mehrkanzleibetrieb   | Konzeptionell vorgesehen, technisch noch nicht begonnen                     |

## Findings

### [P0] Remote-Transport und eingehender Zugriffsschutz fehlen

**Betroffene Stellen:**

- `src/index.ts:9–14`
- `src/server.ts:125–334`

Der Entrypoint startet ausschließlich `StdioServerTransport`. Es existiert weder ein Streamable-HTTP-Endpunkt noch eine Authentifizierung eingehender MCP-Anfragen. Ebenfalls fehlen Origin-Allowlist, HTTP-Body-Limits, Rate-Limits und eine Trennung zwischen öffentlichem MCP-Endpunkt und internen Betriebsendpunkten.

Das installierte `@modelcontextprotocol/sdk` enthält bereits `StreamableHTTPServerTransport`; ein Frameworkwechsel ist dafür nicht erforderlich.

**Notwendige Änderungen:**

- Separaten Remote-Entrypoint mit Streamable HTTP (`/mcp`) einführen.
- Jede Anfrage vor Ausführung eines Tools authentifizieren und autorisieren.
- `Origin` validieren, Request-Größe und Parallelität begrenzen und Rate-Limits anwenden.
- TLS am Dienst oder an einem vertrauenswürdig konfigurierten Reverse Proxy terminieren.
- Lokalen stdio-Betrieb als ausdrücklich getrennten Betriebsmodus beibehalten.

### [P0] Datensätze und aktiver Mandant sind prozessglobal

**Betroffene Stellen:**

- `src/store/memory.ts:51–136`
- `src/store/memory.ts:90`
- `src/tools/cloud.ts:172–188`
- `src/server.ts:131`

`datevStore` ist ein prozessweiter Singleton mit globalem `activeKey`. `datev_status` listet alle geladenen Datensätze, und Fehlermeldungen nennen die verfügbaren Schlüssel. Bei mehreren Nutzern oder Verbindungen könnte dadurch ein Nutzer Datensätze, Mandantennamen oder Schlüssel eines anderen Nutzers sehen beziehungsweise versehentlich dessen aktiven Datensatz abfragen.

Der optionale `dataset`-Parameter reduziert Fehlbedienungen im lokalen Betrieb, stellt aber keine Autorisierungsgrenze dar.

**Notwendige Änderungen:**

- Einen serverseitig erzeugten `RequestContext` mit mindestens `principalId`, `organizationId`, erlaubten DATEV-Mandanten, Token-Referenz und Request-ID einführen.
- Datensätze immer einem Eigentümer beziehungsweise einer Kanzlei zuordnen.
- `datasetId` bei allen Analyse-Tools verpflichtend machen oder eindeutig aus einem autorisierten Kontext ableiten.
- Dataset-Zugriffe serverseitig auf Eigentümerschaft und Mandantenfreigabe prüfen.
- Status- und Fehlermeldungen ausschließlich auf den aktuellen Principal filtern.
- Den impliziten globalen `activeKey` aus dem Remote-Pfad entfernen.

### [P0] DATEV-OAuth ist noch keine Authentifizierung des MCP-Clients

**Betroffene Stellen:**

- `src/auth/oauth.ts:96–115`
- `src/auth/loopback.ts:29–41`
- `src/auth/token-manager.ts:37–55`
- `src/tools/cloud.ts:197–211`

Der vorhandene OAuth-Flow authentifiziert den Server gegenüber DATEV und verschafft ihm Zugriff auf DATEV-Daten. Er authentifiziert jedoch keinen eingehenden MCP-Client gegenüber dem MCP-Server. Das ID-Token wird ausdrücklich verworfen; Signatur, Issuer, Audience und Nonce werden nicht geprüft. Der Server stellt außerdem keine eigenen, auf den MCP-Server gebundenen Zugriffstokens aus.

Eingehendes MCP-Token und ausgehendes DATEV-Token sind zwei getrennte Sicherheitsdomänen und dürfen nicht als dasselbe Token behandelt oder durchgereicht werden.

**Notwendige Änderungen:**

- Eingehende MCP-Authentifizierung als eigenen Baustein implementieren, bevorzugt über einen etablierten Identity Provider wie Microsoft Entra ID.
- DATEV-OAuth weiterhin separat und benutzergebunden für den Datenzugriff verwenden.
- Falls DATEV der einzige sichtbare Login bleiben soll: OIDC-ID-Token vollständig validieren, Zustimmung pro MCP-Client speichern und anschließend ein separates MCP-Access-Token mit korrekter Audience ausstellen.
- Autorisierung nicht an `Mcp-Session-Id` oder andere vom Client gelieferte Session-IDs binden.
- Pro Tool beziehungsweise Fähigkeit möglichst kleine Scopes definieren und serverseitig prüfen.

### [P1] Token-Speicher ist weder mehrbenutzerfähig noch für einen Internetdienst ausreichend geschützt

**Betroffene Stellen:**

- `src/auth/token-store.ts:24–87`
- `src/auth/token-manager.ts:49–69`
- `src/config.ts:172–176`

Der Server speichert genau einen Satz Access-/Refresh-Tokens pro Umgebung als Klartext-JSON-Datei. Unter Windows bieten die gesetzten POSIX-Modi keine verlässliche Zugriffstrennung. Es fehlen Benutzer-/Kanzleizuweisung, Verschlüsselung mit verwaltetem Schlüssel, Versionierung, Revocation und ein nutzerseitig erreichbarer Logout-Pfad. `clearTokens()` ist vorhanden, wird aber von keinem Tool oder Remote-Endpunkt angeboten.

Bei mehreren Serverinstanzen reicht die prozesslokale Single-Flight-Sperre für Refresh-Token-Rotation nicht aus; parallele Prozesse könnten gegeneinander rotieren.

**Notwendige Änderungen:**

- Verschlüsseltes `TokenRepository` einführen, adressiert nach Kanzlei und Benutzer.
- Schlüsselmaterial über KMS/Key Vault, DPAPI/Credential Manager oder einen vergleichbaren Secret Store verwalten.
- Refresh-Rotation transaktional beziehungsweise per Compare-and-Swap serialisieren.
- Logout, Revocation, Ablauf und Offboarding implementieren.
- Tokens niemals in Logs, Tool-Antworten oder generischen Fehlerdetails ausgeben.

### [P1] Der lokale OAuth-Callback ist bewusst nicht remote-fähig

**Betroffene Stellen:**

- `src/config.ts:90–146`
- `src/auth/loopback.ts:117–284`

Die aktuelle Härtung erlaubt ausschließlich HTTP-Loopback-Redirects auf `localhost` oder `127.0.0.1` und bindet einen kurzlebigen Listener an `127.0.0.1`. Das ist für den lokalen Betrieb korrekt und sollte nicht aufgeweicht werden. Ein auf einem Server laufender Remote-Connector benötigt jedoch einen öffentlichen HTTPS-Callback, der dem richtigen authentifizierten Benutzer und OAuth-Vorgang zugeordnet wird.

**Notwendige Änderungen:**

- Lokalen `LoopbackDatevOAuthFlow` und einen separaten `RemoteDatevOAuthController` implementieren.
- Remote-State, PKCE-Verifier, Principal, MCP-Client, Redirect-URI und Ablaufzeit serverseitig persistent und einmalig speichern.
- Callback ausschließlich über registrierte HTTPS-Redirects akzeptieren.
- Alte, wiederholte oder einem anderen Benutzer zugeordnete States strikt ablehnen.
- Bei einem OAuth-Proxy pro MCP-Client eine nachvollziehbare Zustimmung vor dem DATEV-Flow vorsehen.

### [P1] Mandantenautorisierung ist noch nicht serverseitig modelliert

**Betroffene Stellen:**

- `src/tools/cloud.ts:90–146`
- `src/tools/cloud.ts:259–389`
- `src/datev/jobs.ts:75–109`

`clientId` wird syntaktisch validiert und sicher URL-kodiert. Es wird aber nicht geprüft, ob der aktuell authentifizierte MCP-Benutzer diesen DATEV-Mandanten verwenden darf. Mit einem gemeinsam verwendeten DATEV-Token könnte jeder berechtigte MCP-Nutzer jeden für dieses Token sichtbaren Mandanten adressieren.

**Notwendige Änderungen:**

- Berechtigungsmodell `Principal → Kanzlei → erlaubte DATEV-clientId` einführen.
- Jede Cloud-Methode vor dem DATEV-Aufruf autorisieren.
- Optional die bei DATEV sichtbaren Mandanten beim Onboarding erfassen und administrativ einschränken.
- Autorisierungsentscheidungen revisionssicher, aber ohne Buchungsinhalte oder Tokens protokollieren.

### [P1] Ressourcen- und Verfügbarkeitsisolation fehlen für Remote

**Betroffene Stellen:**

- `src/parser/extf.ts:330–363`
- `src/store/memory.ts:51–136`
- `src/datev/jobs.ts:46–62`

Der Dateiimport besitzt sinnvolle Größen- und Zeilenlimits, liest und parst aber weiterhin synchron bis zu 64 MB im Hauptthread. Ein großer Import blockiert damit alle Remote-Nutzer. Der Dataset-Store besitzt keine TTL, Speicherquote oder Obergrenze für die Anzahl geladener Datensätze. Laufende DATEV-Jobs liegen nur im Prozessspeicher und gehen bei Neustart oder Instanzwechsel verloren.

**Notwendige Änderungen:**

- Dateiimport im Remote-Modus zunächst deaktivieren oder als isolierten Uploadpfad gestalten.
- Parsing über Streaming oder Worker Threads aus dem Event Loop auslagern.
- Pro Principal/Kanzlei Speicher-, Dataset-, Job- und Parallelitätsquoten einführen.
- Datasets mit TTL/LRU und explizitem Löschen versehen.
- Laufende DATEV-Jobs persistent und idempotent verwalten.
- Für horizontale Skalierung keinen sicherheitsrelevanten Zustand nur im Prozess halten.

### [P2] Tool-Ausgaben sind noch keine belastbare Vertrauensgrenze

**Betroffene Stellen:**

- `src/server.ts:31–65`
- `src/server.ts:108–116`
- `src/tools/bookings.ts:89–124`
- `src/tools/search.ts:38–73`

Tool-Ergebnisse werden als formatiertes JSON in einem Textblock ausgegeben. Buchungstexte und Belegfelder sind nicht vertrauenswürdige Drittdaten. Die vorhandenen Hinweise an das Modell sind sinnvoll, aber keine technische Autorisierungsgrenze und dürfen niemals einen Mandanten- oder Dataset-Zugriff freigeben.

**Notwendige Änderungen:**

- `structuredContent` und `outputSchema` nutzen und Status-/Warnfelder von Drittdaten trennen.
- Nur die für die konkrete Anfrage erforderlichen Felder zurückgeben.
- Fehler gegenüber Remote-Clients generisch halten; interne Details nur mit Korrelation-ID protokollieren.
- Mandantenwechsel und sensible Datenfreigaben ausschließlich serverseitig autorisieren.

### [P2] Produktionsbetrieb, CI und Nachweisführung fehlen

Im Repository existieren keine CI-Workflows, Deployment-/Container-Artefakte oder Infrastrukturdefinitionen. Ebenso fehlen Health-/Readiness-Endpunkte, strukturierte Audit-Logs, Metriken, Alarmierung und ein dokumentierter Backup-/Restore-Test. README und ältere Review-Texte enthielten zudem veraltete Testzahlen und bereits behobene Findings.

**Notwendige Änderungen:**

- CI für Typecheck, ESLint, Tests, Build, Dependency-Audit und Secret-Scan einführen.
- Cross-Tenant-Negativtests, OAuth-Replay-/State-Tests sowie Tests für Revocation und Refresh-Rennen ergänzen.
- Health, Readiness, strukturierte Logs, Metriken und Korrelation-IDs implementieren.
- Deployment mit nicht privilegiertem Dienstkonto, restriktivem Netzwerk und Secret-Injection beschreiben.
- Betriebs- und Architekturunterlagen nach jeder freigaberelevanten Änderung aktualisieren.

## Positive Aspekte des aktuellen Stands

- Gute modulare Trennung von MCP-Registrierung, OAuth, DATEV-HTTP, Jobs, Mapper, Parser und Fachtools.
- Ausschließlich lesende DATEV-Tools; keine Upload-, Änderungs- oder Löschoperationen.
- OAuth Authorization Code Flow mit PKCE, zufälligem `state` und Single-Flight-Refresh.
- Callback bindet nur an IPv4-Loopback und validiert `state` vor Erfolgs- und Fehlerverarbeitung.
- Redirect-URI und Port sind für den lokalen Modus strikt auf Loopback begrenzt.
- Credential-tragende HTTP-Anfragen folgen keinen Redirects.
- Bearer-Tokens dürfen nur an fest definierte DATEV-HTTPS-Hosts gesendet werden.
- Externe Antwortgrößen, Retry-Zeiten und Job-Paginierung sind begrenzt.
- Dateiimport besitzt Pfad-Confinement, Symlink-Prüfung, Formatprüfung sowie Größen- und Zeilenlimits.
- Legacy-/Testformat ist standardmäßig deaktiviert.
- Datenvollständigkeit und Parse-Fehler werden dauerhaft als Provenienz gespeichert und in Folgeantworten sichtbar gemacht.
- Buchungsinhalte werden in Tool-Beschreibungen ausdrücklich als nicht vertrauenswürdige Drittdaten gekennzeichnet.
- Keine echten Secrets im öffentlichen Repository gefunden; erkannte Werte sind Testdaten.

## Priorisierte Umsetzung

### Phase 0 – Ziel und Identität verbindlich entscheiden

1. Remote-Eigenbetrieb einer Kanzlei klar vom späteren SaaS-Betrieb trennen.
2. Eingehende Identität festlegen: Kanzlei-SSO/Entra oder DATEV als OAuth-Broker.
3. Hosting, Domain, TLS, Secret Store und Datenstandort festlegen.

### Phase 1 – Identitäts- und Datenkontext isolieren

1. `RequestContext` und serverseitige Mandantenautorisierung einführen.
2. Globale Stores durch Principal-/Kanzlei-gebundene Repositories ersetzen.
3. Explizite, undurchsichtige Dataset-IDs und Eigentumsprüfung einführen.
4. Status- und Fehlerausgaben auf den aktuellen Principal beschränken.

### Phase 2 – Authentifizierung und Tokenhaltung

1. Eingehende MCP-Authentifizierung und ausgehendes DATEV-OAuth trennen.
2. Remote-OAuth-Callback mit persistentem Einmal-State implementieren.
3. Verschlüsselten, mehrbenutzerfähigen Token-Store bauen.
4. Logout, Revocation, Offboarding und sichere Refresh-Rotation ergänzen.

### Phase 3 – Remote-Transport

1. Streamable-HTTP-Entrypoint implementieren.
2. Auth-, Origin-, Größen-, Parallelitäts- und Rate-Limit-Middleware davorschalten.
3. Health-/Readiness-Endpunkte getrennt bereitstellen.
4. Lokalen stdio-Modus unabhängig weiter unterstützen.

### Phase 4 – Verfügbarkeit und Betrieb

1. Dateiimport isolieren oder im Remote-Modus deaktivieren.
2. Quoten, TTL/LRU, persistente Jobs und kontrollierte Nebenläufigkeit ergänzen.
3. CI, Cross-Tenant-Tests, Audit-Logs, Metriken und Alarmierung einführen.
4. Deployment-, Backup-, Restore- und Incident-Prozesse dokumentieren und testen.

## Freigabekriterien für Remote-Echtbetrieb

Ein Remote-Einsatz mit echten Mandantendaten sollte erst freigegeben werden, wenn mindestens folgende Punkte nachweislich erfüllt sind:

- Jede MCP-Anfrage besitzt eine validierte, für diesen Server bestimmte Identität.
- Tokens, Datasets, Jobs und OAuth-State sind pro Benutzer/Kanzlei isoliert.
- Jeder Mandanten- und Dataset-Zugriff wird serverseitig autorisiert.
- DATEV-Tokens liegen verschlüsselt und widerrufbar vor.
- Cross-Tenant-Negativtests und OAuth-Replay-Tests laufen automatisiert in CI.
- HTTP-Grenzen, Rate-Limits, Origin-Prüfung, TLS und Secret-Injection sind aktiv.
- Auditierbare, datensparsame Logs sowie Monitoring und Alarmierung sind vorhanden.
- DATEV-Produktionsfreigabe und §-203-/DSGVO-Freigabe sind dokumentiert.

## Verifikation des geprüften Stands

Die unmittelbar vor diesem Review durchgeführte Security-Prüfung ergab:

- `npm run typecheck`: erfolgreich
- `npm run lint`: erfolgreich
- `npm test`: 5 Testdateien, 81 Tests erfolgreich
- `npm run build`: erfolgreich
- `npm audit --omit=dev`: 0 bekannte Schwachstellen
- Secret-Scan: keine echten Zugangsdaten; ausschließlich Testwerte

Der Review selbst hat keine Quellcodeänderungen vorgenommen. Die noch nicht eingecheckten Security-Härtungen wurden als Bestandteil des aktuellen Arbeitsstands bewertet.

## Referenzen

- [MCP Transports – Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [Technisches Remote-Briefing](docs/BETRIEB-REMOTE-BRIEFING.md)
- [Architekturentscheidungen](docs/ARCHITEKTURENTSCHEIDUNGEN.md)
