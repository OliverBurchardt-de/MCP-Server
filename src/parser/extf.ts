/**
 * Parser für DATEV-Buchungsstapel im EXTF/DTVF-Format.
 *
 * Unterstützt zwei Varianten:
 * 1. **Offizielles DATEV-Format** (Zeile 1 beginnt mit `"EXTF"`/`"DTVF"`): Zeile 1
 *    ist ein positionaler Header, Zeile 2 enthält die Spaltenüberschriften, ab
 *    Zeile 3 folgen die Buchungen.
 * 2. **Vereinfachtes Schlüssel/Wert-Format** (Testdaten): Zeile 1 = Feldnamen,
 *    Zeile 2 = Werte, Zeile 3 = Spaltenüberschriften, ab Zeile 4 Buchungen.
 *
 * @remarks
 * DATEV-Exporte sind Latin-1-kodiert und `;`-getrennt. Beträge nutzen die
 * deutsche Schreibweise (Tausenderpunkt, Dezimalkomma); Datumsangaben sind je
 * nach Variante `JJJJMMTT` oder — im offiziellen Buchungsteil — `TTMM` ohne Jahr
 * (das Jahr wird über den Wirtschaftsjahresbeginn ergänzt).
 */
import fs from 'node:fs';
import iconv from 'iconv-lite';
import { parse } from 'csv-parse/sync';
import type { DatevBooking, DatevDataset, DatevHeader } from './types.js';

/** Normalisiert `JJJJMMTT` oder bereits-ISO-Daten zu `JJJJ-MM-TT`. */
const normalizeDate = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
};

/**
 * Wandelt einen deutschen Betrag (`1.234,56`) in eine Zahl (`1234.56`).
 *
 * @remarks
 * Ein leerer Wert ergibt `0`. Ein **klar abweichend** formatierter Wert wird
 * bewusst NICHT stillschweigend zu `0` — das würde einen (im Datei-Modus selbst
 * gerechneten) Saldo unbemerkt verfälschen. Stattdessen wirft die Funktion, damit
 * die fehlerhafte Zeile auffällt. Akzeptiert wird das deutsche Format mit
 * optionalem Vorzeichen, Tausenderpunkten und einem Dezimalkomma.
 *
 * @throws Error - wenn der Wert kein interpretierbarer deutscher Betrag ist.
 */
export const parseAmount = (value: string): number => {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  const germanAmount = /^[+-]?\d{1,3}(\.\d{3})*(,\d+)?$|^[+-]?\d+(,\d+)?$/;
  if (!germanAmount.test(trimmed)) {
    throw new Error(
      `Betrag im DATEV-Export nicht interpretierbar: "${value}". Bitte den Buchungsstapel prüfen.`
    );
  }

  const normalized = trimmed.replace(/\./g, '').replace(',', '.');
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
};

/**
 * Leitet aus der (Anzeige-)Kontonummer den Personenkonto-Typ ab.
 *
 * @remarks
 * Personenkonten sind eine Stelle länger als Sachkonten (Sachkontenlänge + 1)
 * und werden nach der führenden Ziffer unterschieden: 1–6 = Debitoren (Kunden),
 * 7–9 = Kreditoren (Lieferanten). Die Grenzen hängen also von der
 * **Sachkontenlänge** ab:
 * - Länge 4: Debitoren 10000–69999, Kreditoren 70000–99999.
 * - Länge 5: Debitoren 100000–699999, Kreditoren 700000–999999.
 *
 * Sachkonten (≤ Sachkontenlänge Stellen) ergeben `undefined`.
 *
 * @param account - Anzeige-Kontonummer.
 * @param accountLength - Sachkontenlänge des Mandanten (Standard 4).
 */
const accountTypeFrom = (
  account: string,
  accountLength = 4
): 'debtor' | 'creditor' | undefined => {
  const numeric = Number.parseInt(account, 10);
  if (Number.isNaN(numeric)) {
    return undefined;
  }

  const personLower = 10 ** accountLength; // erste Personenkontonummer
  const creditorLower = 7 * 10 ** accountLength; // ab hier Kreditoren
  const personUpper = 10 ** (accountLength + 1); // erste Nummer darüber

  if (numeric >= personLower && numeric < creditorLower) {
    return 'debtor';
  }

  if (numeric >= creditorLower && numeric < personUpper) {
    return 'creditor';
  }

  return undefined;
};

/** Baut den Header aus dem vereinfachten Schlüssel/Wert-Format (Testdaten). */
const mapLegacyHeader = (line1: string[], line2: string[]): DatevHeader => {
  const keys = line1.map((value) => value.trim());
  const values = line2.map((value) => value.trim());
  const get = (key: string): string => values[keys.indexOf(key)] ?? '';

  return {
    advisorNumber: get('Beraternummer'),
    clientNumber: get('Mandantennummer'),
    fiscalYearStart: normalizeDate(get('WJ-Beginn')) ?? get('WJ-Beginn'),
    accountLength: Number.parseInt(get('Sachkontenlänge'), 10) || 4,
    accountFramework: get('Kontenrahmen'),
    dateFrom: normalizeDate(get('Datum von')) ?? '',
    dateTo: normalizeDate(get('Datum bis')) ?? '',
    consultantName: get('Beratername') || undefined,
    clientName: get('Mandantenname') || undefined,
    rawLine1: line1,
    rawLine2: line2,
  };
};

// Offizieller DATEV-Format-Header (EXTF/DTVF, z. B. Formatversion 700):
// Zeile 1 ist positional. Relevante Felder (1-basiert):
// 11 Beraternummer, 12 Mandantennummer, 13 WJ-Beginn, 14 Sachkontenlänge,
// 15 Datum von, 16 Datum bis, 17 Bezeichnung, 27 SKR.
const mapOfficialHeader = (line1: string[], line2: string[]): DatevHeader => {
  const get = (index: number): string => (line1[index] ?? '').trim();
  const skr = get(26);

  return {
    advisorNumber: get(10),
    clientNumber: get(11),
    fiscalYearStart: normalizeDate(get(12)) ?? get(12),
    accountLength: Number.parseInt(get(13), 10) || 4,
    accountFramework: skr ? (skr.startsWith('SKR') ? skr : `SKR${skr}`) : '',
    dateFrom: normalizeDate(get(14)) ?? '',
    dateTo: normalizeDate(get(15)) ?? '',
    consultantName: undefined,
    clientName: get(16) || undefined,
    rawLine1: line1,
    rawLine2: line2,
  };
};

// Belegdatum im offiziellen Buchungsstapel ist TTMM (ohne Jahr). Das Jahr
// stammt aus dem WJ-Beginn; bei abweichendem Wirtschaftsjahr liegen Monate
// vor dem WJ-Beginn-Monat im Folgejahr.
const normalizeDocumentDate = (
  value: string,
  fiscalYearStart: string
): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const iso = normalizeDate(trimmed);
  if (iso) {
    return iso;
  }

  if (/^\d{3,4}$/.test(trimmed)) {
    const padded = trimmed.padStart(4, '0');
    const day = padded.slice(0, 2);
    const month = padded.slice(2, 4);
    const wjYear = Number.parseInt(fiscalYearStart.slice(0, 4), 10);
    const wjMonth = Number.parseInt(fiscalYearStart.slice(5, 7), 10) || 1;
    if (!Number.isFinite(wjYear)) {
      return '';
    }
    const year = Number.parseInt(month, 10) < wjMonth ? wjYear + 1 : wjYear;
    return `${year}-${month}-${day}`;
  }

  return '';
};

/**
 * Liefert den ersten nicht-leeren Wert unter mehreren möglichen Spaltennamen.
 *
 * @remarks
 * Fängt Namensunterschiede zwischen den Formaten ab, z. B. `Belegfeld 1`
 * (offiziell) vs. `Belegfeld1` (Testformat).
 */
// Das Feld „Fälligkeit" ist im DATEV-Format als TTMMJJJJ (Tag-Monat-Jahr)
// kodiert — anders als die Header-Datumsfelder (JJJJMMTT). Manche Bestände
// liefern es auch als JJJJMMTT oder (selten) als TTMM ohne Jahr. Wir
// unterscheiden anhand plausibler Jahreswerte, damit alle Varianten korrekt
// nach ISO (JJJJ-MM-TT) landen. In der Praxis ist das Feld oft leer.
const normalizeDueDate = (
  value: string,
  fiscalYearStart: string
): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d{8}$/.test(trimmed)) {
    const leadingFour = Number.parseInt(trimmed.slice(0, 4), 10);
    // Beginnt der Wert mit einer plausiblen Jahreszahl, ist es JJJJMMTT …
    if (leadingFour >= 1992 && leadingFour <= 2099) {
      return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    }
    // … andernfalls TTMMJJJJ.
    return `${trimmed.slice(4, 8)}-${trimmed.slice(2, 4)}-${trimmed.slice(0, 2)}`;
  }

  // Vierstellig ohne Jahr (TTMM): wie beim Belegdatum über den WJ-Beginn ergänzen.
  if (/^\d{3,4}$/.test(trimmed)) {
    return normalizeDocumentDate(trimmed, fiscalYearStart) || undefined;
  }

  return undefined;
};

const pick = (record: Record<string, string>, ...names: string[]): string => {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return '';
};

/**
 * Wandelt die Buchungszeilen in {@link DatevBooking}-Objekte.
 *
 * @param rows - Datenzeilen (ohne Header/Spaltenzeile).
 * @param columns - Spaltenüberschriften zum Zuordnen der Werte.
 * @param header - Bereits geparster Header (liefert u. a. den WJ-Beginn für die
 *   Auflösung des TTMM-Belegdatums).
 * @param firstDataLine - Zeilennummer der ersten Datenzeile in der Originaldatei
 *   (für die `rowNumber` zur Nachvollziehbarkeit).
 */
const mapBookings = (
  rows: string[][],
  columns: string[],
  header: DatevHeader,
  firstDataLine: number
): DatevBooking[] =>
  rows.map((row, index) => {
    const record = Object.fromEntries(
      columns.map((column, columnIndex) => [
        column,
        (row[columnIndex] ?? '').trim(),
      ])
    );
    const account = pick(record, 'Konto', 'Sachkonto');
    const contraAccount = pick(
      record,
      'Gegenkonto (ohne BU-Schlüssel)',
      'Gegenkonto'
    );
    const dueDate = normalizeDueDate(
      pick(record, 'Fälligkeit', 'Faelligkeit'),
      header.fiscalYearStart
    );
    const rawDate = pick(record, 'Belegdatum', 'Buchungsdatum', 'Datum');
    const bookingDate =
      normalizeDate(rawDate) ??
      normalizeDocumentDate(rawDate, header.fiscalYearStart);
    const amount = parseAmount(
      pick(record, 'Umsatz (ohne Soll/Haben-Kz)', 'Umsatz', 'Betrag') || '0'
    );
    // Soll/Haben strikt validieren: NICHT unbekannte/fehlende Kennzeichen auf
    // Soll raten (das würde eine Buchung lautlos falsch verbuchen).
    const rawDirection = pick(
      record,
      'Soll/Haben-Kennzeichen',
      'Soll/Haben',
      'Saldo'
    )
      .trim()
      .toUpperCase();
    if (rawDirection !== 'S' && rawDirection !== 'H') {
      throw new Error(
        `Ungültiges oder fehlendes Soll/Haben-Kennzeichen in Zeile ${index + firstDataLine}.`
      );
    }
    const direction: 'S' | 'H' = rawDirection;
    const openItemFlag = (record['Offener Posten'] || '').toLowerCase();

    return {
      bookingDate,
      dueDate,
      account,
      contraAccount,
      amount,
      direction,
      bookingText: record.Buchungstext || '',
      documentField1: pick(record, 'Belegfeld 1', 'Belegfeld1'),
      documentField2: pick(record, 'Belegfeld 2', 'Belegfeld2'),
      currency: pick(record, 'WKZ Umsatz', 'Währung') || 'EUR',
      invoiceReference: record.Referenz || undefined,
      isOpenItem:
        openItemFlag === 'ja' ||
        openItemFlag === 'true' ||
        openItemFlag === '1' ||
        accountTypeFrom(account, header.accountLength) !== undefined,
      rowNumber: index + firstDataLine,
      raw: record,
    };
  });

/**
 * Liest eine DATEV-Buchungsstapel-Datei und wandelt sie in einen {@link DatevDataset}.
 *
 * Erkennt anhand des Kennzeichens in Zeile 1 automatisch, ob das offizielle
 * DATEV-Format oder das vereinfachte Testformat vorliegt.
 *
 * @param filePath - Pfad zur EXTF/DTVF-CSV-Datei.
 * @returns Der geparste Datensatz mit Header und Buchungen.
 * @throws Error - wenn die Datei zu wenige Zeilen für einen gültigen Stapel hat.
 */
/** Obergrenze der Import-Dateigröße (Schutz vor Speicher-/Prozess-Erschöpfung). */
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024; // 64 MB
/** Obergrenze der eingelesenen Datenzeilen. */
const MAX_IMPORT_DATA_ROWS = 200_000;

export const parseDatevExtfFile = (
  filePath: string,
  allowLegacy = false
): DatevDataset => {
  // Nur reguläre Dateien und eine sichere Maximalgröße zulassen: Ein sehr großer
  // Bestand oder ein Spezialpfad (Gerät/FIFO) könnte sonst den stdio-Prozess
  // blockieren oder den Speicher erschöpfen. Die Pfadgrenze schützt nur die
  // Vertraulichkeit, nicht die Verfügbarkeit.
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error('Es können nur reguläre Dateien geladen werden.');
  }
  if (stats.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error(
      `Die Datei ist zu groß (${Math.round(stats.size / 1048576)} MB; Grenze ${MAX_IMPORT_FILE_BYTES / 1048576} MB). Bitte den DATEV-Export einschränken.`
    );
  }

  const buffer = fs.readFileSync(filePath);
  // DATEV-Exporte sind Latin-1-kodiert; ohne diese Dekodierung würden Umlaute
  // (ä/ö/ü/ß) in Konto- und Buchungstexten zerstört.
  const content = iconv.decode(buffer, 'latin1');
  const rows = parse(content, {
    delimiter: ';',
    relax_column_count: true,
    skip_empty_lines: true,
    bom: false,
    trim: false,
  }) as string[][];

  const marker = (rows[0]?.[0] ?? '').trim().replace(/^"|"$/g, '');
  const isOfficialFormat = marker === 'EXTF' || marker === 'DTVF';

  // Nur echte DATEV-Formate (EXTF/DTVF) akzeptieren. Das vereinfachte Legacy-/
  // Testformat wird ohne ausdrückliche Freigabe abgelehnt, damit eine fremde
  // oder beschädigte CSV nicht als gültiger Buchungsstapel durchgeht.
  if (!isOfficialFormat && !allowLegacy) {
    throw new Error(
      'Unbekanntes Dateiformat: Es werden nur echte DATEV-Exporte (EXTF/DTVF) akzeptiert. Bitte den Buchungsstapel im DATEV-Format exportieren.'
    );
  }

  if (rows.length < (isOfficialFormat ? 2 : 3)) {
    throw new Error('Ungültige DATEV-Datei: zu wenige Zeilen.');
  }

  // Header sind die ersten 2 (offiziell) bzw. 3 (Legacy) Zeilen; danach Daten.
  const headerRowCount = isOfficialFormat ? 2 : 3;
  const allDataRows = rows.slice(headerRowCount);
  const truncated = allDataRows.length > MAX_IMPORT_DATA_ROWS;
  const dataRows = truncated
    ? allDataRows.slice(0, MAX_IMPORT_DATA_ROWS)
    : allDataRows;

  const line1 = rows[0] ?? [];
  const header = isOfficialFormat
    ? mapOfficialHeader(line1, rows[1] ?? [])
    : mapLegacyHeader(line1, rows[1] ?? []);
  const columns = (rows[isOfficialFormat ? 1 : 2] ?? []).map((value) =>
    value.trim()
  );

  // Pflichtspalten prüfen, bevor gemappt wird — sonst könnten stumme
  // Fehlinterpretationen entstehen (fehlender Betrag/Konto/Kennzeichen).
  const hasColumn = (...names: string[]): boolean =>
    names.some((name) => columns.includes(name));
  const missing: string[] = [];
  if (!hasColumn('Umsatz (ohne Soll/Haben-Kz)', 'Umsatz', 'Betrag')) {
    missing.push('Umsatz/Betrag');
  }
  if (!hasColumn('Soll/Haben-Kennzeichen', 'Soll/Haben', 'Saldo')) {
    missing.push('Soll/Haben-Kennzeichen');
  }
  if (!hasColumn('Konto', 'Sachkonto')) {
    missing.push('Konto');
  }
  if (missing.length > 0) {
    throw new Error(
      `Pflichtspalten fehlen im Buchungsstapel: ${missing.join(', ')}.`
    );
  }

  const bookings = mapBookings(dataRows, columns, header, headerRowCount + 1);

  return {
    filePath,
    header,
    columns,
    bookings,
    loadedAt: new Date().toISOString(),
    provenance: {
      complete: !truncated,
      loadedCount: bookings.length,
      totalCount: allDataRows.length,
      truncated,
      parseErrors: 0,
    },
  };
};

/**
 * Öffentlicher Alias für die Personenkonto-Einordnung.
 *
 * @remarks Wird u. a. von `get_open_items` genutzt, um Debitoren/Kreditoren zu
 *   unterscheiden. Siehe {@link accountTypeFrom} für die Kontenbereiche.
 */
export const getPersonAccountType = accountTypeFrom;
