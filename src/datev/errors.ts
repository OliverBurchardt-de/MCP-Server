/**
 * Übersetzt DATEV-Fehlerantworten in verständliche, handlungsleitende
 * deutsche Meldungen.
 *
 * DATEV liefert Fehler als RFC-7807-`ProblemDetail`. Da diese Meldungen direkt
 * bei Claude (und damit beim Nutzer) landen, mappen wir die wichtigsten
 * HTTP-Status auf konkrete nächste Schritte statt roher Statuscodes.
 */

/** Ausschnitt des RFC-7807-Fehlerobjekts, den wir auswerten. */
interface ProblemDetail {
  title?: string;
  detail?: string;
  status?: number;
  requestId?: string;
}

const GERMAN_HINTS: Record<number, string> = {
  400: 'Die Anfrage war ungültig (z. B. falsches Mandanten- oder Wirtschaftsjahr-Format).',
  401: 'Die Anmeldung ist abgelaufen oder ungültig. Bitte das Tool datev_login ausführen.',
  403: 'Kein Zugriff. Bitte prüfen: Ist der Datenservice für diesen Mandanten freigeschaltet und das API-Abo im DATEV-Entwicklerportal aktiv?',
  404: 'Nicht gefunden. Mandant, Wirtschaftsjahr oder Job existiert nicht (oder keine Berechtigung).',
  429: 'DATEV-Ratenlimit erreicht. Bitte einen Moment warten und erneut versuchen.',
  500: 'DATEV meldet einen internen Fehler. Bitte später erneut versuchen.',
  503: 'Der DATEV-Dienst ist vorübergehend nicht erreichbar. Bitte später erneut versuchen.',
};

/** Fehler eines DATEV-API-Aufrufs mit HTTP-Status und optionaler Request-ID. */
export class DatevError extends Error {
  /**
   * @param status - HTTP-Statuscode der Fehlerantwort.
   * @param message - Bereits übersetzte, nutzerlesbare Meldung.
   * @param requestId - DATEV-Request-ID aus dem ProblemDetail (für Support).
   */
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'DatevError';
  }
}

/**
 * Baut aus Status und Antwort-Body einen {@link DatevError} mit deutscher Meldung.
 *
 * @param status - HTTP-Statuscode der Antwort.
 * @param body - Roher Antworttext (idealerweise ein RFC-7807-ProblemDetail).
 * @returns Ein {@link DatevError}, dessen Meldung den passenden Hinweis aus
 *   {@link GERMAN_HINTS} mit `title`/`detail` bzw. Rohtext kombiniert.
 */
export const datevErrorFromResponse = (
  status: number,
  body: string
): DatevError => {
  let problem: ProblemDetail = {};
  try {
    problem = JSON.parse(body) as ProblemDetail;
  } catch {
    // Kein JSON-Fehlerobjekt — Rohtext unten anhängen.
  }

  const hint = GERMAN_HINTS[status] ?? `DATEV antwortete mit HTTP ${status}.`;
  const details = [problem.title, problem.detail].filter(Boolean).join(' — ');
  const raw = !details && body ? body.slice(0, 200) : '';
  const message = [hint, details || raw].filter(Boolean).join(' Details: ');

  return new DatevError(status, message, problem.requestId);
};
