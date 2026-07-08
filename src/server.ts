import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAccountBalance, getAccountBalanceSchema } from './tools/balance.js';
import { listBookings, listBookingsSchema } from './tools/bookings.js';
import { loadDatevFile, loadDatevFileSchema } from './tools/load.js';
import { getOpenItems, getOpenItemsSchema } from './tools/openItems.js';
import { searchDocuments, searchDocumentsSchema } from './tools/search.js';

const toContent = (payload: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(payload, null, 2)
    }
  ]
});

export const createServer = () => {
  const server = new McpServer({
    name: 'finrobotics-datev-mcp-server',
    version: '0.1.0'
  });

  server.registerTool(
    'load_datev_file',
    {
      title: 'Load DATEV EXTF file',
      description: 'Loads a DATEV EXTF CSV file into in-memory storage.',
      inputSchema: {
        path: z.string().min(1)
      }
    },
    async ({ path }) => toContent(loadDatevFile({ path }))
  );

  server.registerTool(
    'get_account_balance',
    {
      title: 'Get account balance',
      description: 'Calculates the balance for a DATEV account.',
      inputSchema: {
        account: z.string().min(1)
      }
    },
    async ({ account }) => toContent(getAccountBalance({ account }))
  );

  server.registerTool(
    'get_open_items',
    {
      title: 'Get open items',
      description: 'Lists open debtor or creditor items from the loaded DATEV file.',
      inputSchema: {
        overdueOnly: z.boolean().optional(),
        type: z.enum(['debtor', 'creditor']).optional(),
        referenceDate: z.string().optional()
      }
    },
    async (input) => toContent(getOpenItems(input))
  );

  server.registerTool(
    'list_bookings',
    {
      title: 'List bookings',
      description: 'Lists filtered bookings from the loaded DATEV file.',
      inputSchema: {
        account: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        minAmount: z.number().optional(),
        text: z.string().optional()
      }
    },
    async (input) => toContent(listBookings(input))
  );

  server.registerTool(
    'search_documents',
    {
      title: 'Search documents',
      description: 'Searches bookings by text, Belegfeld1 and Belegfeld2.',
      inputSchema: {
        query: z.string().min(1)
      }
    },
    async ({ query }) => toContent(searchDocuments({ query }))
  );

  return server;
};

export const schemas = {
  loadDatevFileSchema,
  getAccountBalanceSchema,
  getOpenItemsSchema,
  listBookingsSchema,
  searchDocumentsSchema
};
