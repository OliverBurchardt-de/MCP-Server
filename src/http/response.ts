/** Sichere, größenbegrenzte Verarbeitung externer HTTP-Antworten. */

/** Signalisiert, dass ein externer Dienst mehr Daten als erlaubt gesendet hat. */
export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(
      `Die Antwort des externen Dienstes überschreitet die zulässige Größe von ${Math.round(maxBytes / 1048576)} MB.`
    );
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Liest einen Fetch-Response-Body höchstens bis zur angegebenen Byte-Grenze.
 *
 * Sowohl `Content-Length` als auch die tatsächlich dekomprimiert gelesenen
 * Bytes werden geprüft. Damit können fehlende, falsche oder komprimierte
 * Größenangaben den Prozess nicht zu unbegrenztem Speicherverbrauch zwingen.
 */
export const readResponseText = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ResponseTooLargeError(maxBytes);
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
};
