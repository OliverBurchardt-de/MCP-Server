# Checkliste: Von der Sandbox zum Echtbetrieb (Produktion)

Diese Schritte kann nur die Kanzlei selbst erledigen — sie betreffen
Verträge, Freischaltungen und Identitäten bei DATEV. Erfahrungsgemäß
dauert die DATEV-Freigabe **mehrere Wochen** → früh starten.

## 1. Produktionsfreigabe der App beantragen

- Im DATEV-Entwicklerportal (developer.datev.de) auf der Detailseite der
  registrierten App das **Upgrade auf Produktion** anfordern.
- DATEV startet dann einen Konsultations-/Review-Prozess und prüft die
  Anwendung. Erst nach Freigabe funktioniert die App gegen `*.api.datev.de`
  (Produktion) statt der Sandbox.

## 2. Redirect-URL prüfen

- Für den lokalen Betrieb in Claude Desktop bleibt
  `http://localhost:53682/callback` — klären, ob DATEV dies für die
  Produktions-App akzeptiert (laut Richtlinie „Neue Richtlinien für
  Redirect URLs" ist localhost primär für Test/Sandbox gedacht).
- Falls DATEV eine HTTPS-URL verlangt oder der Server später im Internet
  betrieben wird: HTTPS-Redirect-URL registrieren.

## 3. Datenservice-Freischaltung je Mandant

- Der lesende Zugriff auf Buchungsdaten (Accounting Data Exchange) setzt
  voraus, dass der jeweilige Datenservice für die Berater-/Mandantennummer
  bestellt bzw. freigeschaltet ist und die Daten im DATEV-Rechenzentrum
  liegen (Rechnungswesen-Archiv/DUO).
- Pro Pilot-Mandant prüfen: Ist der Bestand RZ-geführt? Ist der Service
  aktiv? (Ansprechpartner: DATEV-Servicekontakt der Kanzlei.)

## 4. Anmelde-Identität

- Produktionszugriffe laufen immer im Namen eines echten DATEV-Nutzers mit
  **SmartLogin** (Handy-App) oder **SmartCard/mIDentity**.
- Festlegen, welcher Kanzlei-Benutzer die Anmeldung für den MCP-Server
  durchführt, und dessen Mandanten-Berechtigungen in der
  DATEV-Rechteverwaltung prüfen (der Server sieht genau das, was dieser
  Benutzer sehen darf).

## 5. Datenschutz/Berufsrecht freigeben

- Prüfung § 203 StGB / DSGVO: Buchungsdaten fließen bei Fragen an den
  KI-Dienst (Anthropic). Auftragsverarbeitung/DPA klären, ggf.
  Einwilligungen; interne Freigabe dokumentieren.

## 6. Technischer Umstieg (danach trivial)

- In der Claude-Desktop-Konfiguration `DATEV_ENV` von `sandbox` auf
  `production` stellen — mehr ist codeseitig nicht nötig.
- Erste Sitzung mit EINEM echten Pilot-Mandanten fahren und die
  Beispielfragen aus ANLEITUNG.md durchgehen.
