# Analyse: Klardaten DATEV-MCP (Referenz)

Auswertung eines fremden DATEV-MCP-Servers (Anbieter **Klardaten**), den die
Kanzlei übergangsweise nutzt. Grundlage sind zwei vom Kanzlei-Inhaber
bereitgestellte Dokumente:

1. **Klardaten „DATEV MCP Customer Documentation"** (PDF mit Textebene, hier ausgewertet).
2. Eine **E-Mail** von Klardaten — ein reines **Bild-PDF ohne Textebene**; ohne
   OCR-Werkzeug nicht maschinell lesbar. Die Aussagen dazu beruhen auf der Angabe
   des Kanzlei-Inhabers und der Doku.

> **Ablage:** Diese Notiz (unsere eigene Analyse) liegt im Repo. Die
> **Original-PDFs** bleiben **lokal beim Nutzer** und werden nicht eingecheckt
> (fremdes/privates Material). Siehe `.gitignore` (`docs/reference/*.pdf`).

## Kernbefund: alles aus den DATEV-API-Specs generiert
Der Doku-Footer lautet wörtlich *„Generated from tools.json, resources.json, and
document management-2.3.1.json"*. Klardatens Tools und Ressourcen sind also
**maschinell aus den DATEV-OpenAPI-Spezifikationen erzeugt** — denselben Specs,
die auch in unserem `docs/openapi/` liegen. Es steckt nichts Proprietäres darin;
das Wissen ist aus der DATEV-API-Dokumentation reproduzierbar.

## Klardatens Architektur (zur Einordnung)
- **Generisches „Resource-URI"-Gateway**, read-only: 11 Tools — je Modul ein
  `datev_<modul>_list` und `datev_<modul>_get` plus ein `datev_describe`
  (Erkundung: Module, Ressourcen, Filter-Dialekte, ID-Formate).
- **112 Ressourcen** über 5 Module: Accounting 30, Payroll 32, Master Data 21,
  Order Management 18, DMS 11.
- Steuerung über **OData-artige Parameter** (`filter`, `expand`, `select`,
  `skip`, `top`); Objekt-Auswahl über eine `resourceUri` (z. B.
  `datev://accounting/accounting_sums_and_balances`).
- Kontrast zu **unserem** Ansatz: Wir bauen **aufgabenorientierte** Tools mit
  fachlicher Aufbereitung (Saldo, offene Posten, Belegsuche) und der Cloud-
  spezifischen **Job-Abwicklung**. Beide Ansätze sind valide; der generische ist
  breiter, der aufgabenorientierte führungsstärker für konkrete Fragen.

## Wichtigste Erkenntnis für uns: Landkarte des DATEVconnect-Moduls
Klardatens Ressourcenkatalog deckt sich fast 1:1 mit den **DATEVconnect-Desktop-
Specs, die wir bereits besitzen** (`docs/openapi/datevconnect/`):

| Klardaten-Modul | Deckt sich mit unserer Spec |
|---|---|
| DMS (11) | `document management-2.3.1.json` (explizit im Footer genannt) |
| Accounting (30): accounts_payable/receivable, condensed_*, creditors/debitors, cost_* (Kostenrechnung), stocktaking, *_posting_proposal_rules, **OPOS** | `Accounting-1.7.4.4.json` |
| Payroll (32) | `Payroll-3.1.4.json` |
| Order Management (18) | `Order Management-1.4.9.json` |
| Master Data (21) | `Client Master Data-1.7.1.json` |

Damit ist dieser Katalog eine konkrete **Vorlage für unser geplantes
Phase-4-DATEVconnect-Modul** — u. a. für die **echten offenen Posten (OPOS)**
(`accounts_payable`/`accounts_receivable`), die aus einem einzelnen
Buchungsstapel prinzipiell nicht ableitbar sind (siehe `docs/ARCHITEKTUR.md`).

## ID-Formate (präzisiert — floss in DATEV-PORTAL-NOTIZEN.md ein)
- **Cloud (Accounting Data Exchange):** `clientId` = `Beraternummer-Mandantennummer`
  (z. B. `455148-1`).
- **DATEVconnect/Module:** `clientId` = **GUID** aus der `clients`-Ressource des
  jeweiligen Moduls — **je Modul verschieden**, nicht die Mandantennummer, nicht
  modulübergreifend wiederverwendbar.
- **`fiscalYearId`** = `JJJJMMTT` (Wirtschaftsjahresbeginn) — konsistent zu uns.
- **Payroll:** `employeeId` = nullgepolsterte Personalnummer (kein GUID); jeder
  Payroll-Aufruf braucht `referenceDate` (yyyy-mm-dd).
- **DMS:** Dokument-`id` = GUID, `number` = Integer; `structure_item`-ids und
  `document_file_id` = Integer.
- **Kontonummern** liegen im „DATEV technical format", abgeleitet aus der
  `account_length` des Wirtschaftsjahres (relevant für führende Nullen/Länge).

## Nützliche Detailhinweise aus der Doku
- **`accounting_sums_and_balances`** ist laut Klardaten die *beste Reporting-
  Ressource* für monatliche Umsatz-/Erlös- und Kontosaldo-Fragen — bestätigt
  unsere Wahl von Summen & Salden.
- **DMS-Dokumente**: Filterfelder u. a. `number`, `domain.id`, `folder.id`,
  `register.id`, `state.id`, `user.id` (GUID), `correspondence_partner_guid`,
  `create_/change_date_time`, `employee.id`, `checked_out`; Liste max. 1.000
  Einträge. `info`-Ressource: ab `version.number` 14.0 stehen API V1 **und** V2
  bereit (darunter nur V1).

## Fazit
Klardatens Material liefert keinen Grund, unsere Strategie zu ändern — im
Gegenteil, es **bestätigt** sie (Cloud-Buchungsdaten aufgabenorientiert; OPOS/
DMS/Payroll gehören in ein DATEVconnect-Modul) und gibt uns eine fertige,
aus DATEV-Specs abgeleitete **Ressourcen-Landkarte** für den DATEVconnect-Ausbau.
