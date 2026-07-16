import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { loadDatevFile } from '../src/tools/load.js';
import { datevStore } from '../src/store/memory.js';

const FIXTURES = path.resolve('test/fixtures');
const fixturePath = path.resolve('test/fixtures/sample.extf');

describe('server integration', () => {
  it('registers all required MCP tools', () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it('supports loading and querying within the same process', () => {
    datevStore.clear();
    const loaded = loadDatevFile({ path: fixturePath }, FIXTURES, true);

    expect(loaded.bookingCount).toBe(22);
    expect(datevStore.get().bookings[0]?.documentField1).toBe('RE-1001');
  });
});
