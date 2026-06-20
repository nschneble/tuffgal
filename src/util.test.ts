import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { describe, it } from 'node:test';

import { parseHostPort, probeTcp } from './util.ts';

describe('parseHostPort', () => {
  it('reads an explicit port', () => {
    assert.deepEqual(parseHostPort('http://localhost:3000'), {
      host: 'localhost',
      port: 3000,
    });
  });

  it('defaults http to 80 and https to 443', () => {
    assert.equal(parseHostPort('http://example.com').port, 80);
    assert.equal(parseHostPort('https://example.com').port, 443);
  });
});

describe('probeTcp', () => {
  it('resolves true when a server is listening', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const open = await probeTcp('127.0.0.1', address.port, 1_000);
      assert.equal(open, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resolves false when nothing is listening', async () => {
    // Port 1 is privileged and effectively never open for this process.
    const open = await probeTcp('127.0.0.1', 1, 500);
    assert.equal(open, false);
  });
});
