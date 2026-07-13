# DATEV-Portal- und API-Notizen (verifiziert)

Gesammelte, gegen die OpenAPI-Specs in `docs/openapi/` und die
Postman-Collections in `docs/collections/` verifizierte Fakten. Ergänzt um
Erkenntnisse aus der Analyse des AnythingMCP-DATEV-Adapters (AGPL-Projekt,
nur ausgewertet, kein Code übernommen).

## OAuth / Anmeldung

- Flow: **OpenID Connect Authorization Code + PKCE (S256)**. Kein
  `client_credentials` — jeder Zugriff läuft im Namen eines echten
  DATEV-Nutzers (SmartLogin/SmartCard; Sandbox: Testuser „Test6").
- App-Registrierung: **Confidential Client** wählen — nur diese erhalten
  das ~2-Jahres-Rolling-**Refresh-Token** (Scope `offline_access`).
- Endpunkte:
  |              | Sandbox                                          | Produktion                                |
  | ------------ | ------------------------------------------------ | ----------------------------------------- |
  | Authorize    | `https://login.datev.de/openidsandbox/authorize` | `https://login.datev.de/openid/authorize` |
  | Token        | `https://sandbox-api.datev.de/token`             | `https://api.datev.de/token`              |
  | API-Basepath | `platform-sandbox`                               | `platform`                                |
- Token-Endpunkt: Client-Authentifizierung per **HTTP Basic** (client_id:client_secret).
- **`X-DATEV-Client-Id`** (= OAuth-Client-ID der App) muss bei **jedem**
  API-Aufruf zusätzlich zum `Authorization: Bearer` mitgesendet werden.
- Redirect-URL muss exakt registriert sein; `http://localhost:<port>/callback`
  wird nur für Sandbox/Test akzeptiert.

## IDs und Formate

- **clientId hängt von der API-Familie ab** (häufigste Fehlerquelle):
  - **Cloud (Accounting Data Exchange + accounting-clients v2):** Format
    `Beraternummer-Mandantennummer`, Pattern `^[1-9]\d{3,6}-[1-9]\d{0,4}$`,
    z. B. `455148-1` (Sandbox-Testmandant).
  - **DATEVconnect/Desktop-Module:** `clientId` = **GUID** aus der
    `clients`-Ressource des jeweiligen Moduls — **je Modul verschieden**, nicht
    die Mandantennummer und nicht modulübergreifend wiederverwendbar
    (bestätigt durch die Klardaten-MCP-Doku; siehe `reference/KLARDATEN-ANALYSE.md`).
  - In beiden Fällen: NICHT mit der OAuth-Client-ID der App verwechseln.
    (Die UUID-Mandanten-IDs aus dem AnythingMCP-Guide betreffen accounting-documents.)
- **fiscalYearId**: Integer `JJJJMMTT` (= Wirtschaftsjahresbeginn),
  z. B. `20260101`. `GET /clients/{id}/fiscal-years` liefert die Liste als
  NDJSON-Zahlen.
- **Payroll:** `employeeId` = nullgepolsterte Personalnummer (kein GUID); jeder
  Payroll-Aufruf braucht zusätzlich `referenceDate` (yyyy-mm-dd).
- **DMS:** Dokument-`id` = GUID, `number` = Integer; `structure_item`-ids und
  `document_file_id` = Integer.
- **Kontonummern** liegen im „DATEV technical format", abgeleitet aus der
  `account_length` des Wirtschaftsjahres (relevant für führende Nullen/Länge).
- Listen-Antworten der ADE sind **`application/x-ndjson`** (ein
  JSON-Objekt pro Zeile) — auch sums-and-balances und Job-Ergebnisse.

## Buchungsdaten (Accounting Data Exchange v1.5.8) — asynchrones Job-Muster

1. `POST /clients/{clientId}/fiscal-years/{fiscalYearId}/account-postings`
   → HTTP 202, Body `{"jobId": "<uuid>"}`. Kein Filter möglich — der Job
   liefert immer das komplette Wirtschaftsjahr.
2. `GET /clients/{clientId}/jobs/{jobId}/state` →
   `{"jobState": "PENDING|RUNNING|COMPLETED|FAILED|DELETED"}`.
3. `GET /clients/{clientId}/account-postings-jobs/{jobId}?page=N` →
   NDJSON-Seiten; Header `x-total-count`, `x-total-pages`,
   `x-current-page`, `x-page-size` (bis zu ~1,25 Mrd. Zeilen laut Spec —
   deshalb clientseitig Cap + Filter!).

- Posting-Felder u. a.: `accountNumber`, `contraAccountNumber`,
  `amountDebit`/`amountCredit` (genau eines gesetzt → Soll/Haben), `date`,
  `postingDescription`, `documentField1/2`, `currencyCode`,
  `isOpeningBalancePosting`, `taxRate`.

## Summen & Salden

- `GET .../sums-and-balances` (NDJSON): je Konto `accountNumber`,
  `caption`, `balance` + `balanceDebitCreditIdentifier`,
  `annualValueDebit/Credit`, `openingBalanceDebit/Credit`,
  `sumsAndBalancesMonthValues[]` (`fiscalYearMonth`, `monthlyBalance`).

## Sachkonten

- `GET .../general-ledger-accounts?onlyBooked=&includesPersonalAccounts=`:
  `accountNumber`, `caption`, Funktionsinfos.

## Fehlerformat

- RFC-7807 `ProblemDetail`: `type`, `title`, `status`, `detail`,
  `instance`, `requestId`. Mapping auf deutsche Meldungen in
  `src/datev/errors.ts`.

## Abos / Portal

- Pro API-Produkt ist ein Abo im Entwicklerportal nötig
  (accounting-clients und accounting-documents teilen sich eines;
  Accounting Data Exchange separat abonnieren).
- Apps starten in der Sandbox; Produktion erst nach DATEV-Review
  (siehe ONBOARDING-PRODUKTION.md).
- Sandbox-Testdaten: Mandant `455148-1`, Login „Test6" (Zugangsdaten in
  den Postman-Environments unter `docs/collections/`).

## Sonstiges

- Die 4 PDFs unter `docs/pdf/` sind Bild-PDFs ohne Textebene
  (Portal-Ausdrucke); Inhalte wurden aus Specs/Collections rekonstruiert.
- developer.datev.de ist eine JavaScript-SPA — für automatisiertes Lesen
  Browser-Rendering nötig.
