# Technisches Briefing: DATEV-MCP-Server als Fernzugriff-Dienst betreiben

**Zweck dieses Dokuments:** Grundlage für das Gespräch zwischen der Kanzlei und
ihrem IT-Verantwortlichen (eigener Server **oder** ASP-/Rechenzentrums-Umgebung).
Es beschreibt, was der Server ist, was er zum Betrieb braucht und welche
Entscheidungen die IT treffen muss. Die eigentliche Programmierung (Umstellung auf
Fernzugriff, Anmelde-/Türsteher-Schicht) übernimmt die Entwicklung — dieses Briefing
klärt die **Betriebs- und Netzwerkseite**.

---

## 1. Worum es geht (in einem Absatz)

Der DATEV-MCP-Server ist ein kleiner **Node.js-Dienst** (TypeScript, Node ≥ 20). Er
übersetzt zwischen einer KI (Claude / claude.ai) und den DATEV-Cloud-Schnittstellen.
Bisher lief er lokal auf einem einzelnen Rechner. Damit die KI **von überall** (Web,
Handy, mehrere Mitarbeiter) darauf zugreifen kann, muss er als **dauerhaft laufender,
über HTTPS öffentlich erreichbarer Dienst** betrieben werden — vergleichbar mit einem
gehosteten „Connector" wie dem von Klardaten.

---

## 2. Datenfluss (wer spricht mit wem)

```
   Mitarbeiter                                       DATEV-Cloud
   (Browser/App)                                     (*.datev.de)
        │                                                 ▲
        │ nutzt Claude                                    │ ausgehend HTTPS (443)
        ▼                                                 │
   claude.ai  ──── eingehend HTTPS (443) ────►  DATEV-MCP-Server
   (Anthropic-Cloud)      zur öffentlichen        (Kanzlei-Server / ASP)
                          Server-Adresse          - Node.js-Dienst, 24/7
                                                  - hält je Nutzer DATEV-Tokens
                                                  - verschlüsselter Speicher
```

- **Eingehend:** Anthropic (claude.ai) ruft den Server über eine **öffentliche
  HTTPS-Adresse** auf. Es gibt genau **einen** eingehenden Zugang: Port **443**.
- **Ausgehend:** Der Server ruft seinerseits die DATEV-Endpunkte auf
  (`login.datev.de`, `*.api.datev.de`) — Port 443.
- **Wichtig:** Der Server initiiert **nie** von sich aus Verbindungen zu Mitarbeitern.
  Alles läuft über die eine eingehende HTTPS-Adresse.

---

## 3. Anforderungen an die Laufzeitumgebung

| Punkt | Anforderung |
|-------|-------------|
| Betriebssystem | Linux (empfohlen) oder Windows Server — beides möglich |
| Laufzeit | Node.js ≥ 20 |
| Betrieb | Als **Dienst/Daemon**, der 24/7 läuft und nach Neustart automatisch startet (systemd / Windows-Dienst) |
| Ressourcen | Gering: ~1 CPU-Kern, 512 MB–1 GB RAM genügen für den Anfang |
| Speicher | Kleiner **persistenter, verschlüsselter** Datenbereich für die DATEV-Zugangstokens (siehe §5). Keine Datenbank nötig |
| Neustarts | Der Dienst muss Updates/Neustarts überstehen, ohne dass Tokens verloren gehen |

---

## 4. Netzwerk, Domain und Zertifikat

1. **Öffentliche Adresse (Domain):** Der Server braucht einen festen, öffentlich
   auflösbaren Namen, z. B. `datev-mcp.kanzlei-example.de`. Reine IP-Adresse geht
   nicht (Zertifikat).
2. **TLS-Zertifikat:** Ein **öffentlich vertrauenswürdiges** Zertifikat (z. B.
   Let's Encrypt oder ein kommerzielles). ⚠️ **Kein selbstsigniertes / internes
   CA-Zertifikat** — claude.ai muss es prüfen können, sonst verweigert es die
   Verbindung.
3. **Reverse Proxy (empfohlen):** Üblich ist ein vorgelagerter Webserver
   (nginx / Caddy / IIS) für TLS-Terminierung und als zusätzliche Schutzschicht.
   Der Node-Dienst lauscht dann nur lokal (z. B. 127.0.0.1:3000), der Proxy nimmt
   443 von außen an.
4. **Firewall:** Von außen ausschließlich **443 eingehend** öffnen. Ausgehend 443
   zu `*.datev.de` erlauben.
5. **IP-Einschränkung (optional):** Anthropic veröffentlicht keine garantiert
   stabilen Quell-IP-Bereiche — die Absicherung erfolgt deshalb primär über die
   Anmelde-/Türsteher-Schicht (§6), nicht über IP-Allowlisting.

---

## 5. Sicherheit & Berufsrecht (§ 203 StGB / DSGVO)

Der Server hält künftig **DATEV-Zugangstokens** (langlebig) und ggf. **zwischen-
gespeicherte Buchungsdaten** auf einer aus dem Internet erreichbaren Maschine. Das
hebt die Sicherheitslatte gegenüber dem lokalen Betrieb deutlich an. Zu klären:

- **Standort der Maschine:** möglichst in Deutschland/EU (eigener Server oder
  ASP-Rechenzentrum). Hinweis: Der Server-Standort bestimmt, wo **Tokens und Cache**
  liegen. Beim eigentlichen Fragenstellen fließen Buchungsdaten weiterhin zum
  KI-Dienst (Anthropic) — das ist der separat zu klärende Auftragsverarbeitungs-/
  DPA-Punkt, unabhängig vom Hosting.
- **Verschlüsselung ruhender Daten:** Der Token-Speicher wird verschlüsselt abgelegt;
  Zugriff nur für den Dienst. (Umsetzung: Entwicklung; die IT stellt ggf. einen
  Schlüsseltresor / Key-Management bereit, falls vorhanden.)
- **Zugriffsschutz:** Nur berechtigte Kanzlei-Nutzer dürfen sich verbinden (§6).
- **Betrieb:** regelmäßige Updates/Patches, Monitoring (läuft der Dienst?),
  Backup des Token-Speichers, Log-Aufbewahrung ohne sensible Inhalte.
- **Betreiberverantwortung:** Mit dem Fernbetrieb übernimmt die Kanzlei (bzw. der
  ASP-Dienstleister) die Rolle des **Betreibers** — inkl. Verantwortung für
  Absicherung und Verfügbarkeit.

---

## 6. Die Anmelde-/Türsteher-Schicht

Weil der Server öffentlich erreichbar ist, darf **nicht jeder** hinein. Vorgesehen ist
das gleiche Muster wie bei vergleichbaren Connectors: Der Nutzer fügt den Server in
claude.ai als **Custom Connector** (per Adresse) hinzu und **meldet sich einmal an**;
claude.ai merkt sich danach einen Zugangsschlüssel und verbindet sich in seinem Namen.

**Was die Entwicklung baut:** die OAuth-Anmeldeschicht im Server selbst
(claude.ai spricht mit dem Server, der Server verlangt eine Anmeldung).

**Offene Entscheidung (siehe §7):** Womit meldet sich der Nutzer an?
- **Variante 1 — DATEV-Login als Identität:** Ein einziger Login per DATEV-SmartLogin;
  er authentifiziert den Nutzer *und* liefert den DATEV-Zugang. Kein zweites Passwort.
- **Variante 2 — Kanzlei-SSO** (z. B. Microsoft Entra / 365): Anmeldung über das
  bestehende Mitarbeiter-Verzeichnis; der DATEV-Login erfolgt zusätzlich.

**Was die IT bereitstellt:** je nach Variante ggf. Zugang zum SSO/Verzeichnisdienst.

---

## 7. Entscheidungen, die die IT / Kanzlei treffen muss (Checkliste)

- [ ] **Wo läuft der Server?** Eigener (virtueller) Server oder ASP-/RZ-Umgebung?
      (Bei ASP: Wer stellt eine öffentliche HTTPS-Adresse bereit — kann der ASP-
      Dienstleister einen Endpunkt „veröffentlichen"?)
- [ ] **Betriebssystem** (Linux empfohlen, Windows Server möglich).
- [ ] **Domain/Subdomain** für den Dienst festlegen (z. B. `datev-mcp.<kanzlei>.de`).
- [ ] **TLS-Zertifikat**: Wer stellt es aus/erneuert es (Let's Encrypt automatisiert
      oder kommerziell)?
- [ ] **Reverse Proxy** vorhanden/gewünscht (nginx/Caddy/IIS)?
- [ ] **Firewall-Freigaben**: 443 eingehend; 443 ausgehend zu `*.datev.de`.
- [ ] **Persistenter, verschlüsselter Speicher** für Tokens: Pfad/Volume, Backup,
      ggf. vorhandener Schlüsseltresor.
- [ ] **Anmelde-Variante** (§6): DATEV-Login oder Kanzlei-SSO?
- [ ] **Betrieb**: Wer überwacht den Dienst, spielt Updates ein, prüft Backups?
- [ ] **Standort/Datenschutz**: Maschine in DE/EU; DPA-Lage mit KI-Dienst geklärt?

---

## 8. Rollenverteilung (wer macht was)

| Thema | Entwicklung | IT / Kanzlei |
|-------|:-----------:|:------------:|
| Umstellung auf HTTPS-Fernzugriff (Transport) | ✔ | |
| Anmelde-/Türsteher-Schicht (OAuth im Server), Sitzungs-Isolation | ✔ | |
| Verschlüsselte Token-Ablage (Code) | ✔ | |
| Server bereitstellen (VM/Container), Betriebssystem | | ✔ |
| Domain, DNS, TLS-Zertifikat | | ✔ |
| Reverse Proxy, Firewall-Regeln | | ✔ |
| SSO-/Verzeichnis-Zugang (falls Variante 2) | | ✔ |
| Monitoring, Updates, Backups | | ✔ |
| DATEV-Produktionsfreigabe, Redirect-URL, Datenservice je Mandant | | ✔ |

---

## 9. Nächste Schritte

1. IT-Gespräch anhand der Checkliste (§7) — insbesondere „wo läuft er" und
   „Anmelde-Variante".
2. Parallel läuft die Entwicklung: Sandbox-Abnahmeprüfung + Umbau auf Fernzugriff
   (lokal testbar, bevor der Kanzlei-Server steht).
3. Sobald Domain/Zertifikat/Server bereitstehen: Dienst ausrollen, als Custom
   Connector in claude.ai eintragen, erste Anmeldung testen.

> Bei Rückfragen der IT lässt sich die Entwicklung direkt einbinden — die
> technischen Detailfragen (Transport, OAuth-Parameter, Redirect-URLs) klären wir
> dann gemeinsam.
