/**
 * Umrechnung von DATEV-Kontonummern zwischen technischer Roh- und Anzeigeform.
 *
 * @remarks
 * DATEV liefert Kontonummern in den Rohdaten (Summen-/Saldenliste,
 * Buchungssätze) **technisch**: an die Anzeigenummer werden **4 Nullen**
 * angehängt (× 10000). Beispiele (verifiziert an der Sandbox, Sachkontenlänge 4):
 *
 * - Sachkonto 1200 → `12000000` (4-stellig + 4 Nullen = 8-stellig)
 * - Debitor 10400 → `104000000` (5-stellig + 4 Nullen = 9-stellig)
 * - Kreditor 70000 → `700000000`
 *
 * Weil die Auffüllung **immer** genau 4 Nullen sind, ist die Rückrechnung
 * (÷ 10000) eindeutig und verwechslungsfrei: 1200 → `12000000`, 12000 →
 * `120000000` ergeben unterschiedliche technische Nummern. Das ist der
 * entscheidende Unterschied zu einem naiven „Nullen abschneiden".
 */

/**
 * Rechnet eine **technische** DATEV-Kontonummer auf die Anzeigenummer zurück.
 *
 * @param technical - Rohnummer aus der DATEV-API (z. B. `12000000`).
 * @returns Die Anzeigenummer als String (z. B. „1200"). Nicht-numerische Werte
 *   und bereits kurze Anzeigenummern (≤ 5 Stellen) bleiben unverändert.
 * @remarks Nur auf DATEV-**Rohnummern** anwenden — niemals auf bereits kurze
 *   Nutzereingaben, sonst würde z. B. „70000" fälschlich zu „7".
 */
export const datevAccountToDisplay = (technical: string | number): string => {
  const value = String(technical).trim();
  if (!/^\d+$/.test(value)) {
    return value;
  }
  // Technische Nummern sind ≥ 8-stellig und enden auf mindestens 4 Nullen;
  // Anzeigenummern sind höchstens 5-stellig und bleiben unverändert.
  if (value.length > 5 && value.endsWith('0000')) {
    return String(Number(value) / 10000);
  }
  return value;
};
