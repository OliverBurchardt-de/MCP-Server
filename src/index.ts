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
  console.error('Failed to start DATEV MCP server', error);
  process.exit(1);
});
