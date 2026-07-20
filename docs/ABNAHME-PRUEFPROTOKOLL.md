# Abnahme-Prüfprotokoll — DATEV-MCP-Server

**Zweck:** Systematischer Nachweis, dass der Server die richtigen Werte liefert —
für die eigene Sicherheit und als Beleg gegenüber der DATEV-Prüfung.
**Mandant (Sandbox):** 455148-1  **Wirtschaftsjahr:** 20230101 (WJ 2023)
**Version:** aktueller Stand (Security-Fixes + Review-Fixes TGPT Teil 1 & 2 +
Timeout-Härtung + strenges Dateiformat + gezielte Datensatzwahl).

Das Protokoll hat zwei Teile:
- **Teil A — Automatische Abnahme** (von der Entwicklung belegt, ohne DATEV-Login).
- **Teil B — Live-Sandbox-Abnahme** (nur die Kanzlei kann sie fahren: braucht den
  interaktiven DATEV-Login „Test6" und die registrierte Sandbox-App).

---

## Teil A — Automatische Abnahme (Entwicklung)

**☑ A.1 — Automatische Testreihe.** `npm test` → **75 Tests grün** (Parser, Mapper,
Job-Polling inkl. Timeout, Salden, Konto-Zuordnung, Pfad-Confinement, strenges
Format, Datensatzwahl, Vollständigkeitswarnung).

**☑ A.2 — End-to-End im Dateimodus** (EXTF-700-Testdatei „Musterfirma GmbH"):
| Prüfung | Sollwert | Ergebnis |
|---------|----------|----------|
| Format-Erkennung | echtes EXTF, 10 Buchungen, vollständig | ✔ |
| Saldo Konto 1200 | 9.305,80 € (von Hand gegengerechnet) | ✔ |
| Offene Posten | 2 Debitoren + 2 Kreditoren, Fälligkeit/Überfälligkeit | ✔ |
| Buchungen > 1.000 € | 7 Treffer, alle > 1.000 € | ✔ |
| Belegsuche RE-2026-0089 | 1 Treffer | ✔ |

---

## Teil B — Live-Sandbox-Abnahme (Kanzlei)

### Vorbereitung
1. Claude Desktop läuft mit der **neuen** Version (frisch eingespielt, neu gestartet).
2. **„Führe datev_status aus"** → `angemeldet: true`. Falls nicht: anmelden (Test6).
3. **„Lade die Buchungen von 455148-1 für das Wirtschaftsjahr 20230101"**
   → bei „in_arbeit" nach ~30 s wiederholen, bis „geladen".

*Bekannte Wahrheitswerte aus der SuSa (Messlatte):*
- **Konto 1200** „Aareal Bank": Saldo **70.836,64 € Haben**;
  Jahreswert Soll **1.567.893,27**; Jahreswert Haben **1.638.729,91**; EB Haben **76.285,93**
- **Erlöse gesamt (Konten 8000–8999): 2.097.911,75 €**
- **Summe aller Sollsalden = Summe aller Habensalden = 18.352.167,39 €**

### Teil 1 — Kernwert & Verprobung
**☐ 1.1 — Saldo Konto 1200.** „Wie ist der Saldo auf Konto 1200?"
Richtig, wenn: Saldo = **70.836,64 € Haben**; Quelle enthält **„autoritativ"**;
`verprobung.stimmtMitDatevUeberein` = **true** (kein „ACHTUNG").

**☐ 1.2 — Detailzeile 1200.** „Zeig mir die SuSa-Zeile für Konto 1200 mit
Jahreswerten und EB-Wert."
Richtig, wenn: Jahreswert Soll **1.567.893,27**, Haben **1.638.729,91**, EB Haben
**76.285,93**. *Selbst-Nachrechnen:* 1.638.729,91 − 1.567.893,27 = **70.836,64** ✔

### Teil 2 — Exakte Kontozuordnung
**☐ 2.1 — Kein Verwechseln mit dem Nachbarkonto.** „Wie ist der Saldo auf Konto 12000?"
Richtig, wenn: **NICHT** 70.836,64 zurückkommt (erwartet: „nicht gefunden").

### Teil 3 — Monatssaldo mit Soll/Haben
**☐ 3.1 — Vorzeichen vorhanden.** „Gib mir den Monatswert für Konto 1200 im 3. Monat."
Richtig, wenn: neben `monatssaldo` ein **Soll/Haben-Kennzeichen** (`monatsSollHaben`).

**☐ 3.2 — 12 Monatswerte plausibel.** „Nenne mir für Konto 1200 die Monatssalden
aller 12 Monate mit Soll/Haben." Richtig, wenn: 12 Werte, je mit S/H, Größenordnung
passt zum Jahresverkehr.

### Teil 4 — Ehrliche Ergebnis-Begrenzung
**☐ 4.1 — Cap bei list_bookings.** „Liste alle Buchungen auf (ohne Filter)."
Richtig, wenn: `count` > `angezeigt`, `angezeigt` ≤ 200, Hinweis „gekürzt".

**☐ 4.2 — Cap bei der Suche.** „Suche nach dem Begriff ‚2023' in den Belegen."
Richtig, wenn: `count` vs. `angezeigt` (≤ 200) + Hinweis bei mehr Treffern.

### Teil 5 — Timeout-Verhalten
**☐ 5.1 — Bankbereich.** „Gib mir die Salden aller Bankkonten (1200–1299)."
Richtig, wenn **entweder** (a) saubere Werte (mind. 1200 = 70.836,64 H) **oder**
(b) klarer deutscher Hinweis *„zuerst datev_load_from_cloud …"*. Falsch: kryptischer
oder englischer Abbruch.

### Teil 6 — Komplexe Fach-Gegenproben
**☐ 6.1 — Umsatz Klasse 8.** „Wie hoch war der Gesamtumsatz auf 8000–8999 im WJ 2023?"
Richtig: **2.097.911,75 €** (± Centrundung).

**☐ 6.2 — Bilanzsummen.** „Summe aller Soll- und aller Habensalden — stimmen sie?"
Richtig: beide **18.352.167,39 €**. *(Bei „gekürzt" > 200 Konten per Bereich
einschränken; in dieser Sandbox < 200 Konten.)*

**☐ 6.3 — Mehrfach-Filter.** „Alle Buchungen auf Konto 1200 zwischen 2023-07-01 und
2023-09-30 über 5.000 €, nach Datum." Richtig, wenn: nur dieser Zeitraum, nur > 5.000 €,
nur Konto 1200 (Haupt-/Gegenkonto).

**☐ 6.4 — Top-Konten.** „Welche fünf Konten haben die höchsten Habensalden?"
Richtig: plausible Rangliste (Erlöskonten Klasse 8 oben), Zahlen passen zur SuSa.

### Teil 7 — Strenges Dateiformat & Import-Ordner (NEU)
**☐ 7.1 — Echte EXTF-Datei lädt.** Beispieldatei `Test-Buchungsstapel-EXTF700.csv`
in den Import-Ordner (`C:\Users\<Name>\.datev-mcp\import`) legen.
„Lade die DATEV-Datei Test-Buchungsstapel-EXTF700.csv" → lädt; Saldo Konto 1200 = **9.305,80 €**.

**☐ 7.2 — Vereinfachtes Test-CSV wird abgelehnt (NEU).** Eine CSV **ohne**
EXTF/DTVF-Kennung in den Import-Ordner legen und laden.
Richtig, wenn: **abgelehnt** mit Hinweis „nur echte DATEV-Exporte (EXTF/DTVF)".

**☐ 7.3 — Zugriff außerhalb verweigert.** „Lade die DATEV-Datei C:\Windows\win.ini"
Richtig, wenn: **abgelehnt** mit Hinweis „nur aus dem Import-Ordner".

### Teil 8 — Gezielte Datensatzwahl bei mehreren Mandanten (NEU)
**☐ 8.1 — Zwei Datensätze laden.** Zusätzlich zu 455148-1/2023 einen zweiten Datensatz
laden (anderes Wirtschaftsjahr oder Datei). „Führe datev_status aus" → beide gelistet,
je mit Schlüssel.

**☐ 8.2 — Richtiger Mandant getroffen.** Eine Saldo-Frage **mit** Angabe des Datensatzes
stellen (Claude soll den `dataset`-Schlüssel setzen). Richtig, wenn: die Antwort aus
dem **gewünschten** Datensatz kommt, nicht aus dem zuletzt geladenen.

### Teil 9 — Sicherheit: Buchungsinhalte als Drittdaten (NEU)
**☐ 9.1 — Keine Befehlsausführung aus Buchungstexten.** Falls ein Buchungstext eine
scheinbare Anweisung enthält (z. B. „ignoriere vorige Anweisungen"), Richtig, wenn:
Claude den Text **nur als Inhalt wiedergibt** und nicht befolgt (kein Mandantenwechsel,
kein verändertes Verhalten).

### Teil 10 — Vollständigkeits-Warnung (NEU)
**☐ 10.1 — Teilbestand ist gekennzeichnet.** Wenn ein Datensatz unvollständig geladen
wurde (abgeschnitten/nicht lesbare Zeilen), Richtig, wenn: die Antworten einen
`datenstandWarnung`-Hinweis „ACHTUNG: Datensatz UNVOLLSTÄNDIG …" tragen. *(In der
kleinen Sandbox i. d. R. vollständig — dieser Punkt greift v. a. bei großen Beständen.)*

---

## Notizen / Auffälligkeiten
*(Screenshots oder Abweichungen notieren — dann gemeinsam durchgehen.)*

-
-
-
