# Architekturentscheidungen (Entscheidungslog)

**Zweck:** Dieses Dokument hält die **bewusst getroffenen Entscheidungen** fest —
jeweils mit Begründung, verworfener Alternative und Konsequenz. Es ergänzt
`ARCHITEKTUR.md` (die beschreibt, *wie* das System funktioniert); hier steht,
*warum* es so und nicht anders gebaut ist. Der letzte Abschnitt betrifft
ausdrücklich einen **möglichen späteren Vertrieb** an andere Kanzleien.

Format je Punkt: **Entscheidung · Begründung · Verworfene Alternative · Konsequenz.**

---

## 1. Grundarchitektur

### 1.1 Eigener Server auf FinRobotics-Basis
- **Entscheidung:** Einen eigenen MCP-Server auf Basis des FinRobotics-Grundgerüsts
  (MIT-Lizenz) bauen.
- **Begründung:** FinRobotics hat ein solides Fundament (Parser, Store, Tools),
  aber keine Live-Anbindung. AnythingMCP deckt nur 6 Metadaten-Tools ab, keinen
  Zugriff auf Buchungsdaten/Salden, und kein Async-Job-Muster.
- **Verworfen:** Fertiglösung AnythingMCP (AGPL, ungeeigneter Scope); komplett
  bei null beginnen (unnötig).
- **Konsequenz:** Wir behalten Kontrolle über Datenfluss, Sicherheit und
  Erweiterbarkeit; MIT-Herkunftshinweis bleibt erhalten.

### 1.2 Aufgabenorientierte Werkzeuge statt generisches Gateway
- **Entscheidung:** Fachliche Tools (`get_account_balance`, `get_open_items`,
  `list_bookings`, `search_documents`, `datev_*`), die im Code deterministisch
  rechnen.
- **Begründung:** DATEV-Daten kommen als ganzes Wirtschaftsjahr, asynchron und
  in großer Menge — ein generisches Resource-URI-Gateway (Muster Klardaten) kann
  weder das Async-Job-Warten noch die Mengenbegrenzung noch die verbindliche
  Salden-Logik leisten.
- **Verworfen:** Generisches OData-/Resource-Gateway.
- **Konsequenz:** Mehr Fachlogik bei uns, aber verlässliche, geprüfte Zahlen.

### 1.3 Zwei Datenquellen, ein Datenmodell
- **Entscheidung:** Datei-Export (EXTF/DTVF) **und** DATEV-Cloud speisen dasselbe
  interne Modell `DatevBooking`; die Analyse-Tools sind quellenunabhängig.
- **Begründung:** Der Dateimodus ist sofort ohne DATEV-Freischaltung nutzbar und
  dient als Testpfad; die Cloud liefert später Live-Daten — beide sollen dieselben
  Fragen beantworten.
- **Konsequenz:** Ein Satz Analyse-Tools für beide Welten.

---

## 2. Fachliche Korrektheit (das Herzstück für einen Steuerberater)

### 2.1 Autoritative Salden aus DATEVs Summen-/Saldenliste + Verprobung
- **Entscheidung:** Für Cloud-Daten ist der verbindliche Saldo **DATEVs eigene
  SuSa-Zahl** (identisch zum DATEV-Kontoblatt). Zusätzlich rechnet der Server aus
  den Rohbuchungen nach und meldet Abweichungen (`stimmtMitDatevUeberein`).
- **Begründung:** Ein Live-Fehltest zeigte, dass freies Aufsummieren über ~2.000
  Buchungen zu groben Abweichungen führt. DATEVs SuSa ist die autoritative Quelle.
- **Verworfen:** Saldo allein aus Buchungen summieren; Summieren im Sprachmodell.
- **Konsequenz:** Eine falsche Zahl kann nicht mehr unbemerkt als richtig
  erscheinen — sie fällt in der Verprobung auf.

### 2.2 Technisches Kontonummern-Format aus der Sachkontenlänge
- **Entscheidung:** Rohe Kontonummern werden über das Padding `8 − Sachkontenlänge`
  auf die Anzeigenummer zurückgeführt; die Sachkontenlänge wird zuerst aus den
  DATEV-Metadaten bestimmt, ersatzweise aus den Daten erkannt.
- **Begründung:** Empirisch bestätigt an Mandanten mit Länge 4, 5 und 6 — DATEV
  füllt Sachkonten rechts auf 8, Personenkonten auf 9 Stellen auf.
- **Verworfen:** Feste Annahme „immer ÷10000" (galt nur für Länge 4).
- **Konsequenz:** Korrekte Kontozuordnung für Sachkontenlängen 4–8.

### 2.3 Exakte Kontozuordnung für den autoritativen Wert
- **Entscheidung:** Der maßgebliche SuSa-Eintrag wird per **exaktem** Nummern-
  vergleich gewählt; tolerantes Auffüllen nur für die Kontrollrechnung.
- **Begründung:** Sonst könnte „1200" versehentlich Debitor „12000" treffen.
- **Konsequenz:** Keine Konto-Verwechslung beim verbindlichen Saldo.

### 2.4 Ehrliche Vollständigkeit
- **Entscheidung:** Jeder Datensatz trägt eine Herkunft/Vollständigkeit
  (`provenance`); unvollständige Bestände erzeugen einen `datenstandWarnung`.
- **Begründung:** Ein Teilbestand darf nie als vollständig erscheinen.
- **Konsequenz:** Teilergebnisse sind immer gekennzeichnet.

---

## 3. Robustheit & Betrieb

### 3.1 Async-Job-Muster mit Zeitbudget, Fortsetzung und Mengen-Cap
- **Entscheidung:** POST → Poll → paginiert laden, mit Zeitbudget (~50 s),
  Wiederaufnahme (Job-ID) und Zeilenobergrenze.
- **Begründung:** DATEV bereitet Buchungsdaten asynchron auf; ein ganzes WJ kann
  sehr groß sein.
- **Konsequenz:** Kein Hängen, kein Kontext-Überlauf; „in_arbeit" wird sauber
  behandelt.

### 3.2 Strenges Dateiformat (nur echte DATEV-Exporte)
- **Entscheidung:** `load_datev_file` akzeptiert nur EXTF/DTVF mit Kennung;
  Pflichtspalten und Soll/Haben werden strikt validiert. Legacy-Testformat nur
  über `DATEV_ALLOW_LEGACY_FORMAT=true` (Default aus).
- **Begründung:** Verhindert stille Fehlinterpretation fremder CSVs.
- **Konsequenz:** Import ist eindeutig; Testformat bleibt für Entwickler möglich.

---

## 4. Sicherheit & Verschwiegenheit (§ 203 StGB)

### 4.1 OAuth Authorization Code + PKCE, kein `client_credentials`
- **Entscheidung:** Interaktiver DATEV-Login (Confidential Client, PKCE S256,
  State-Prüfung, HTTP-Basic am Token-Endpunkt).
- **Begründung:** Nur Confidential Clients erhalten Rolling-Refresh-Token; Zugriff
  läuft im Namen eines echten DATEV-Nutzers mit dessen Rechten.
- **Konsequenz:** Der Server sieht genau das, was der angemeldete Nutzer darf.

### 4.2 Tokens lokal, restriktiv, atomar
- **Entscheidung:** Token-Datei 0600 im 0700-Verzeichnis, atomar geschrieben,
  ohne `idToken`; Client-Secret wird nie geloggt/ausgegeben.
- **Konsequenz:** Zugangsdaten bleiben lokal und geschützt.

### 4.3 Dateizugriff eingeschränkt (Pfad-Confinement)
- **Entscheidung:** `load_datev_file` liest nur aus einem festgelegten Import-Ordner
  (`DATEV_IMPORT_DIR`), Traversal/Absolutpfade außerhalb werden abgewiesen.
- **Begründung:** Per Prompt-Injection dürfte Claude sonst beliebige Dateien öffnen.
- **Konsequenz:** Kein Zugriff auf Token-Datei oder fremde Exporte.

### 4.4 Buchungsinhalte sind Drittdaten (Prompt-Injection-Leitplanke)
- **Entscheidung:** Buchungstexte/Belegfelder gelten ausdrücklich als Daten, nicht
  als Anweisungen (Hinweis in Hilfe und Tool-Beschreibungen).
- **Konsequenz:** Kein Mandantenwechsel/verändertes Verhalten aufgrund von Inhalten.

### 4.5 Nur Lese-Tools
- **Entscheidung:** Der Server schreibt nichts nach DATEV zurück.
- **Konsequenz:** Minimierte Angriffs-/Fehlerfläche; passt zum Verschwiegenheits-
  kontext.

---

## 5. Betriebsart & Identität (aktueller Beschluss)

### 5.1 Fernzugriff (remote, HTTPS) — „von überall"
- **Entscheidung:** Der Zielbetrieb ist ein öffentlich über HTTPS erreichbarer
  Dienst, nicht der lokale stdio-Betrieb.
- **Begründung:** Eine KI in claude.ai läuft in der Cloud und kann `localhost`
  nie erreichen; ein Connector braucht zwingend einen Internet-Endpunkt.
- **Verworfen:** Rein lokaler Betrieb (nur ein Rechner, kein Web/Handy).
- **Konsequenz:** Umbau stdio → HTTPS-Transport; Server braucht Domain/TLS/Betrieb
  (siehe `BETRIEB-REMOTE-BRIEFING.md`).

### 5.2 DATEV-Login als Identität (Türsteher-Schicht)
- **Entscheidung:** Anmeldung an der künftigen Zugangsschranke über den
  **DATEV-Login**; „wer bist du" und „Zugriff auf DATEV-Daten" fallen zusammen.
- **Begründung:** Ein einziger, starker Login; höchster Vertrauensvorschuss
  („DATEV-gesichert"). Weil der Login auf DATEVs eigener Seite stattfindet, sind
  **alle** DATEV-Anmeldemedien nutzbar — SmartLogin, **SmartCard**, **mIDentity-Stick**,
  SmartID; der Server berührt Karte/Stick nie.
- **Verworfen (für jetzt):** Kanzlei-SSO (z. B. Microsoft 365) — nicht jede Kanzlei
  hat es; bleibt als Option offen.
- **Offen (bei DATEV zu bestätigen):** Hardware-Login (Stick) in Produktion
  erlaubt? Zusätzliche Kosten? (Sandbox kennt nur Testnutzer „Test6".)

### 5.3 Sitzungs-Trennung
- **Entscheidung:** Jetzt pragmatisch (aktiver Datensatz + optionaler
  `dataset`-Schlüssel je Abfrage); die **volle** Isolation je Nutzer/Sitzung wird
  mit dem Fernzugriff gebaut.
- **Begründung:** Für den Einzel-Kanzlei-Betrieb genügt der pragmatische Stand;
  echte Mehrbenutzer-Trennung gehört zum Remote-Umbau.
- **Konsequenz:** Kein Datensatz trifft versehentlich den falschen Mandanten;
  der Ausbau ist vorgezeichnet.

---

## 6. Vertriebsperspektive (bewusst offengehalten)

> **Grundsatzentscheidung:** Wir bauen **jetzt zuerst für die eigene Kanzlei**
> fertig. Ein späterer Vertrieb an andere Kanzleien bleibt möglich, wird aber
> nicht vorgezogen. Die Architektur wird so gewählt, dass der Vertriebsweg
> **nicht verbaut** wird.

### 6.1 Jetzt: Einzel-Kanzlei, kein Bezahl-Türsteher
- **Entscheidung:** Kein Kundenkonto-/Abrechnungs-Layer in dieser Etappe.
- **Begründung:** Für den Eigenbetrieb nicht nötig; vermischt „funktioniert es
  fachlich" mit „kann ich es verkaufen".
- **Konsequenz:** Schnellerer Weg zum nutzbaren Eigenbetrieb.

### 6.2 Später möglich: zentraler Dienst (Modell B, SaaS)
- **Entscheidung (vorgemerkt, nicht gebaut):** Für den Vertrieb ist das saubere
  Modell **ein zentraler, von der Kanzlei betriebener Dienst**, mit dem sich alle
  Kunden-Kanzleien verbinden — inkl. eigenem **Kundenkonto-/Bezahl-Türsteher** und
  **Aus-Schalter** (Nichtzahler werden abgeschaltet).
- **Begründung:** Nur bei zentralem Betrieb hat der Anbieter die Kontrolle über
  den Zugang; bei reinem Selbst-Hosting je Kanzlei fehlt der Aus-Schalter.
- **Verworfen (für Vertrieb):** Selbst-Hosting je Kanzlei mit „Ruf-zu-Hause"-
  Lizenzcheck (umgehbar, unsauber).
- **Wichtige Konsequenz (§ 203/DSGVO):** Im zentralen Modell fließen die
  Mandantendaten **aller** Kunden-Kanzleien durch die Infrastruktur des Anbieters
  → der Anbieter wird **Auftragsverarbeiter**. Das erfordert AV-Verträge je Kunde,
  entsprechende Technik, rechtliche/versicherungstechnische Begleitung. Der Rollout
  soll über einen beauftragten Techniker (Fee-Split) erfolgen.

### 6.3 Wie „nicht verbaut" konkret sichergestellt wird
- **Strikte Sitzungs-Trennung** wird ohnehin für den Fernzugriff gebaut → sie ist
  zugleich das Fundament für Mehr-Mandanten-Betrieb.
- **Konfigurierbare statt fest verdrahtete Werte** (Umgebung, Ports, Import-Ordner,
  Legacy-Flag) → mehrere Instanzen/Umgebungen möglich.
- **Türsteher als eigener Baustein** → ein Bezahl-/Kundenkonto-Türsteher lässt sich
  **davorsetzen**, ohne die DATEV-Anmeldung dahinter zu ändern.
- **Nur Lese-Tools + Datensatz-Schlüssel** → sauberer Schnitt für mandantengetrennte
  Abfragen.

### 6.4 Was für den Vertrieb NOCH fehlt (nicht Teil der aktuellen Etappe)
- Kundenkonto-/Entitlement-/Abrechnungs-Schicht (der Bezahl-Aus-Schalter).
- Mandantentrennung auf **Betreiberebene** (mehrere Kunden-Kanzleien pro Instanz),
  über die pro-Abfrage-Trennung hinaus.
- AV-Verträge, Betriebs-/Support-/SLA-Struktur, Monitoring & Mandantendaten-Schutz
  auf Anbieterseite.

---

## 7. Offene Entscheidungen / nächste Klärungen

- **DATEV-Produktionsfreigabe** beantragen (Wochen Vorlauf) — Kanzleiaufgabe.
- **Hardware-Login (SmartCard/mIDentity)** in Produktion: erlaubt? Kosten? — bei
  DATEV bestätigen.
- **Betriebsumgebung**: eigener Server **oder** ASP — Domain, TLS, Firewall
  (siehe `BETRIEB-REMOTE-BRIEFING.md`).
- **Transparenz-Export-Werkzeug** (vollständiger Dump geladener Buchungen + SuSa
  zur händischen Gegenprobe) — vorgeschlagen, noch nicht gebaut.
- **§ 203/DSGVO-Freigabe** für den KI-Datenfluss (Anthropic) — vor Echtbetrieb.

---

*Verweise:* `ARCHITEKTUR.md` (Funktionsweise), `BETRIEB-REMOTE-BRIEFING.md`
(IT/Betrieb), `ONBOARDING-PRODUKTION.md` (Produktions-Checkliste),
`ABNAHME-PRUEFPROTOKOLL.md` (Wertprüfung), `DATEV-PORTAL-NOTIZEN.md` (API-Referenz).
