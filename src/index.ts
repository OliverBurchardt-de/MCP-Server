/**
 * Einstiegspunkt des DATEV-MCP-Servers.
 *
 * Baut den Server ({@link createServer}) und verbindet ihn über stdio — das
 * Transportprotokoll, das Claude Desktop für lokale MCP-Server nutzt. Ein
 * späterer Remote-Betrieb (Streamable HTTP) würde hier ein anderes Transport
 * einhängen; die Tool-Logik bliebe identisch.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const main = async (): Promise<void> => {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error: unknown) => {
  // Nur die Meldung protokollieren (kein vollständiges Fehlerobjekt, das
  // versehentlich Konfigurations-/Zugangsdaten enthalten könnte).
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start DATEV MCP server: ${message}`);
  process.exit(1);
});
