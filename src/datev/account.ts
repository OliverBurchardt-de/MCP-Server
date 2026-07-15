/**
 * Umrechnung von DATEV-Kontonummern zwischen technischer Roh- und Anzeigeform.
 *
 * @remarks
 * DATEV liefert Kontonummern in den Rohdaten (Summen-/Saldenliste,
 * Buchungssätze) **technisch**: rechts mit Nullen aufgefüllt. Die Anzahl der
 * angehängten Nullen hängt von der **Sachkontenlänge** ab — es sind
 * `8 − Sachkontenlänge` Stellen. Verifiziert an zwei Mandanten:
 *
 * | Sachkontenlänge | Padding | Sachkonto 1200/12000 | Debitor | Kreditor |
 * |-----------------|---------|----------------------|---------|----------|
 * | 4 (455148)      | 4       | 1200 → `12000000`    | 10400 → `104000000` | 70000 → `700000000` |
 * | 5 (Comtec 13540)| 3       | 12000 → `12000000`   | 100005 → `100005000` | 700000 → `700000000` |
 *
 * Die Rückrechnung (÷ 10^Padding) ist eindeutig und verwechslungsfrei. Weil die
 * Sachkontenlänge je Mandant variiert, wird das Padding NICHT fest verdrahtet,
 * sondern **aus den Daten ermittelt** (siehe {@link detectAccountPadding}).
 */

/** Zählt die abschließenden Nullen einer Ganzzahl-Zeichenkette. */
const trailingZeros = (value: string): number => {
  let count = 0;
  for (
    let index = value.length - 1;
    index >= 0 && value[index] === '0';
    index -= 1
  ) {
    count += 1;
  }
  return count;
};

/**
 * Ermittelt die Zahl der rechts angehängten Auffüll-Nullen (Padding) aus einer
 * Menge **technischer** DATEV-Kontonummern.
 *
 * @remarks
 * Jede technische Nummer trägt mindestens `Padding` abschließende Nullen; da
 * mindestens ein Konto eine Anzeigenummer hat, die NICHT auf 0 endet (z. B.
 * Debitor 100005 → `100005000` mit genau 3 Null-Stellen), ist das **Minimum** der
 * abschließenden Nullen genau das Padding. Deckelung auf 4, weil die kleinste
 * DATEV-Sachkontenlänge 4 ist (Padding also höchstens 8 − 4 = 4). Ohne
 * numerische Werte wird 0 (keine Auffüllung) angenommen.
 *
 * @param technicalNumbers - Rohnummern aus der DATEV-API (Sachkonten und/oder
 *   Personenkonten desselben Mandanten).
 * @returns Das erkannte Padding (0–4).
 */
export const detectAccountPadding = (
  technicalNumbers: Array<string | number | undefined>
): number => {
  let minimum = Infinity;
  for (const raw of technicalNumbers) {
    if (raw === undefined) {
      continue;
    }
    const value = String(raw).trim();
    if (!/^\d+$/.test(value) || value === '0') {
      continue;
    }
    const zeros = trailingZeros(value);
    if (zeros < minimum) {
      minimum = zeros;
    }
    if (minimum === 0) {
      break;
    }
  }
  return Number.isFinite(minimum) ? Math.min(minimum, 4) : 0;
};

/**
 * Leitet die Sachkontenlänge aus dem erkannten Padding ab.
 *
 * @remarks Sachkonten sind technisch stets 8-stellig (mit führenden Nullen),
 *   daher gilt `Sachkontenlänge = 8 − Padding`.
 */
export const accountLengthFromPadding = (padding: number): number =>
  8 - padding;

/**
 * Bestimmt das Padding aus der (autoritativen) Sachkontenlänge.
 *
 * @remarks DATEV erlaubt Sachkontenlängen 4–8; das Padding ist entsprechend
 *   `8 − Sachkontenlänge` und liegt damit im Bereich 0 (Länge 8) bis 4 (Länge 4).
 *   Werte außerhalb werden konservativ auf diesen Bereich geklemmt.
 */
export const paddingForAccountLength = (accountLength: number): number =>
  Math.min(Math.max(8 - accountLength, 0), 4);

/**
 * Rechnet eine **technische** DATEV-Kontonummer auf die Anzeigenummer zurück.
 *
 * @param technical - Rohnummer aus der DATEV-API (z. B. `12000000`).
 * @param padding - Anzahl der angehängten Nullen (aus {@link detectAccountPadding}).
 * @returns Die Anzeigenummer als String (z. B. „1200" bzw. „12000"). Bei Padding
 *   0 oder nicht-numerischen Werten bleibt der Wert unverändert.
 * @remarks Nur auf DATEV-**Rohnummern** anwenden — nicht auf bereits kurze
 *   Nutzereingaben.
 */
export const datevAccountToDisplay = (
  technical: string | number,
  padding: number
): string => {
  const value = String(technical).trim();
  if (padding <= 0 || !/^\d+$/.test(value)) {
    return value;
  }
  return String(Math.round(Number(value) / 10 ** padding));
};
