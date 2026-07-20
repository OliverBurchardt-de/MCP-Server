# DATEV: Technisches Kontonummern-Format — die Regel

**Zweck:** Eigenständige Referenz, wie DATEV-Systeme (Cloud-Schnittstellen,
Rohdaten-Exporte) Kontonummern **technisch** darstellen und wie man sie in die
gewohnte **Anzeigenummer** zurückrechnet. Gilt für Sachkonten **und**
Personenkonten (Debitoren/Kreditoren), für alle Sachkontenlängen 4–8.
Dieses Dokument ist bewusst so geschrieben, dass es ohne weiteren Kontext
(z. B. in einem anderen Chat) verwendbar ist.

**Empirische Basis:** verifiziert an drei echten Mandanten mit Sachkontenlänge
4 (Beraternr. 455148, Sandbox-Testmandant), 5 (Mandant „Comtec" 13540) und
6 (Mandant 13481); Längen 7–8 folgen derselben Formel (getestet im Code).

---

## 1. Die Grundregel

DATEV füllt Kontonummern im technischen Format **rechts mit Nullen** auf eine
feste Gesamtbreite auf:

- **Sachkonten:** immer **8 Stellen** gesamt.
- **Personenkonten (Debitoren/Kreditoren):** immer **9 Stellen** gesamt.

Wie viele Nullen angehängt werden, hängt allein von der im Mandanten
eingestellten **Sachkontenlänge** ab (zulässig: 4 bis 8):

```
Anzahl angehängter Nullen (Padding) = 8 − Sachkontenlänge
```

Als Formel:

```
technische Nummer = Anzeigenummer × 10^(8 − Sachkontenlänge)
Anzeigenummer     = technische Nummer ÷ 10^(8 − Sachkontenlänge)
```

Das gilt **gleichermaßen** für Sachkonten und Personenkonten — Personenkonten
sind in der Anzeige eine Stelle länger als Sachkonten (Sachkontenlänge + 1)
und landen dadurch technisch bei 9 statt 8 Stellen. **Dasselbe Padding, eine
Regel für alles.**

> **Wichtig:** Die Sachkontenlänge ist **je Mandant** festgelegt. Man muss sie
> also **zuerst** ermitteln (aus den Mandanten-/Wirtschaftsjahr-Metadaten,
> Feld `account_length` bzw. „Sachkontenlänge"), bevor man Nummern umrechnet.
> Verschiedene Mandanten können verschiedene Längen haben.

---

## 2. Übersichtstabelle (alle zulässigen Längen)

| Sachkontenlänge | Padding (Nullen) | Sachkonto Anzeige → technisch (8-stellig) | Personenkonto Anzeige → technisch (9-stellig) |
|:---:|:---:|---|---|
| 4 | 4 | 1200 → **12000000** | 10000 → **100000000** |
| 5 | 3 | 12000 → **12000000** | 100005 → **100005000** |
| 6 | 2 | 120000 → **12000000** | 7000000 → **700000000** |
| 7 | 1 | 1200000 → **12000000** | 70000000 → **700000000** |
| 8 | 0 | 12000000 → **12000000** (keine Auffüllung) | 700000000 → **700000000** |

Belege aus echten Daten:
- Länge 4 (455148-1): Sachkonto 1200 „Bank" erscheint roh als `12000000`;
  Debitor 10400 als `104000000`; Kreditor 70000 als `700000000`.
- Länge 5 (Comtec 13540): Bank 12000 roh `12000000`; Debitor 100005 roh
  `100005000` (Padding 3 — widerlegte die frühere „immer 4 Nullen"-Annahme).
- Länge 6 (13481): Bank 120000 roh `12000000`; Kreditor 7000000 roh
  `700000000` (Padding 2).

**Achtung Verwechslungsgefahr:** Dieselbe technische Nummer `12000000` kann je
nach Mandant Konto 1200, 12000 oder 120000 bedeuten. Ohne die Sachkontenlänge
des Mandanten ist die Rückrechnung **nicht eindeutig** — deshalb immer zuerst
die Länge feststellen.

---

## 3. Sachkonto oder Personenkonto? (Klassifizierung)

Nach der Rückrechnung in die Anzeigenummer:

- **Sachkonto:** Anzeigenummer hat genau **Sachkontenlänge** Stellen.
- **Personenkonto:** Anzeigenummer hat **Sachkontenlänge + 1** Stellen.
  Die **führende Ziffer** entscheidet:
  - führende Ziffer **1–6** → **Debitor** (Kunde, Forderungen)
  - führende Ziffer **7–9** → **Kreditor** (Lieferant, Verbindlichkeiten)

Beispiele bei Sachkontenlänge 4: `10000`–`69999` = Debitoren,
`70000`–`99999` = Kreditoren. Bei Sachkontenlänge 5 entsprechend
`100000`–`699999` und `700000`–`999999`, usw.

Im technischen Format erkennt man Personenkonten an der **9. Stelle**
(9-stellig statt 8-stellig).

---

## 4. Rezept für die Praxis (Schritt für Schritt)

1. **Sachkontenlänge des Mandanten ermitteln** — autoritativ aus den
   DATEV-Metadaten des Wirtschaftsjahres (`account_length`). Das ist die
   primäre, deterministische Quelle.
2. **Padding berechnen:** `Padding = 8 − Sachkontenlänge` (Ergebnis 0–4).
3. **Rückrechnen:** technische Nummer ÷ `10^Padding` = Anzeigenummer.
   (Gleichwertig: die letzten `Padding` Nullen abschneiden.)
4. **Klassifizieren:** Stellenzahl der Anzeigenummer = Sachkontenlänge →
   Sachkonto; eine Stelle mehr → Personenkonto (führende Ziffer 1–6 Debitor,
   7–9 Kreditor).

**Rückfallebene, falls die Metadaten fehlen:** Das Padding lässt sich aus den
Daten selbst erkennen: über alle Kontonummern eines Datensatzes das **Minimum
der abschließenden Nullen** bilden (gedeckelt auf 4). Begründung: In einem
realen Kontenbestand endet praktisch immer mindestens ein Konto **nicht** auf
0; dieses Konto verrät das echte Padding. Diese Erkennung ist Heuristik —
die Metadaten-Angabe hat immer Vorrang.

---

## 5. Stolperfallen

- **Nicht alle DATEV-Ausgaben sind technisch.** Manche Auswertungen (z. B.
  Summen-/Saldenlisten-Ansichten) zeigen bereits die Anzeigenummer, während
  Rohdaten-Schnittstellen (z. B. Buchungssätze/`account-postings`) das
  technische Format liefern. Vor dem Umrechnen prüfen, welche Form vorliegt
  (8-/9-stellig mit auffälligen Null-Enden = vermutlich technisch).
- **Führende Nullen:** Die Formel ist multiplikativ — es geht um angehängte
  Nullen **rechts**, nicht um führende Nullen links.
- **Innerhalb eines Datensatzes ist die Breite einheitlich.** Gemischte
  Breiten deuten auf gemischte Quellen hin — dann je Quelle getrennt behandeln.
- **Niemals raten:** Bei Unklarheit über die Sachkontenlänge nicht aus einer
  einzelnen Nummer schließen (12000000 ist mehrdeutig!), sondern die
  Metadaten oder den Gesamtbestand (Rückfallebene) heranziehen.
