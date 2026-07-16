/**
 * Tool `load_datev_file`: lädt eine EXTF-Exportdatei in den Store.
 *
 * @remarks
 * Nach dem Laden ist der Datensatz aktiv; die Analyse-Tools beziehen sich
 * darauf. Die Rückgabe fasst Mandant, Zeitraum und Buchungsanzahl zusammen,
 * damit Claude dem Nutzer sofort bestätigen kann, was geladen wurde.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { parseDatevExtfFile } from '../parser/extf.js';
import { datevStore } from '../store/memory.js';

/** Eingabeschema: Dateiname bzw. Pfad zur EXTF/DTVF-Datei (im Import-Ordner). */
export const loadDatevFileSchema = {
  path: z.string().min(1),
};

/**
 * Löst einen vom Modell gelieferten Dateipfad sicher gegen den freigegebenen
 * Import-Ordner auf.
 *
 * @remarks
 * Sicherheitsgrenze gegen willkürlichen Dateizugriff: Der Aufrufer (letztlich
 * das Sprachmodell, ggf. durch eingeschleuste Inhalte gesteuert) darf **nur**
 * Dateien innerhalb von `baseDir` laden. Relative Pfade werden gegen `baseDir`
 * aufgelöst, absolute Pfade müssen darin liegen. Zusätzlich werden echte Pfade
 * (`realpath`) geprüft, damit Symlinks nicht aus dem Ordner herausführen.
 * Fehler bleiben generisch (kein roher Dateisystem-Fehler mit fremdem Pfad).
 *
 * @param userPath - Vom Modell angegebener Datei­name oder Pfad.
 * @param baseDir - Freigegebener Import-Ordner (Standard {@link config.importBaseDir}).
 * @returns Der kanonische, geprüfte absolute Pfad innerhalb von `baseDir`.
 * @throws Error - wenn der Pfad aus dem Ordner herausführt oder nicht existiert.
 */
export const resolveImportPath = (
  userPath: string,
  baseDir: string
): string => {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, userPath);

  const within = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent + path.sep);

  if (!within(resolved, base)) {
    throw new Error(
      `Zugriff verweigert: Es dürfen nur Dateien aus dem freigegebenen Import-Ordner geladen werden (${base}). Bitte die Exportdatei dorthin kopieren und nur ihren Namen angeben.`
    );
  }

  let realBase: string;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    throw new Error(
      `Der Import-Ordner existiert nicht (${base}). Bitte anlegen und die Exportdatei hineinlegen.`
    );
  }

  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    throw new Error(
      'Datei nicht gefunden. Bitte prüfen, ob die Exportdatei im Import-Ordner liegt und der Name stimmt.'
    );
  }

  // Nach Auflösung etwaiger Symlinks erneut prüfen: Der echte Pfad muss weiter
  // innerhalb des (ebenfalls aufgelösten) Import-Ordners liegen.
  if (!within(realResolved, realBase)) {
    throw new Error(
      'Zugriff verweigert: Der Pfad verweist über eine Verknüpfung aus dem Import-Ordner heraus.'
    );
  }

  return realResolved;
};

/**
 * Lädt die Datei aus dem freigegebenen Import-Ordner und legt sie als aktiven
 * Datensatz ab.
 *
 * @param path - Dateiname (oder Pfad) relativ zum Import-Ordner; absolute Pfade
 *   müssen innerhalb des Import-Ordners liegen.
 * @param baseDir - Freigegebener Import-Ordner (Standard {@link config.importBaseDir});
 *   der Parameter dient vor allem Tests.
 * @returns Zusammenfassung des geladenen Datensatzes.
 */
export const loadDatevFile = (
  { path: userPath }: { path: string },
  baseDir: string = config.importBaseDir,
  allowLegacy: boolean = config.allowLegacyFormat
) => {
  const resolved = resolveImportPath(userPath, baseDir);
  const dataset = parseDatevExtfFile(resolved, allowLegacy);
  datevStore.set(dataset);

  return {
    clientNumber: dataset.header.clientNumber,
    clientName: dataset.header.clientName ?? null,
    advisorNumber: dataset.header.advisorNumber,
    fiscalYearStart: dataset.header.fiscalYearStart,
    accountFramework: dataset.header.accountFramework,
    accountLength: dataset.header.accountLength,
    dateRange: {
      from: dataset.header.dateFrom,
      to: dataset.header.dateTo,
    },
    bookingCount: dataset.bookings.length,
    summary: `Mandant ${dataset.header.clientNumber}${dataset.header.clientName ? ` (${dataset.header.clientName})` : ''}, Zeitraum ${dataset.header.dateFrom} bis ${dataset.header.dateTo}, ${dataset.bookings.length} Buchungen, Kontenrahmen ${dataset.header.accountFramework}`,
  };
};
