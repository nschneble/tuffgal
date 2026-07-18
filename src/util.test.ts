import assert from 'node:assert/strict';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import { createServer, type Server } from 'node:net';
import { describe, it } from 'node:test';

import { parseHostPort, probeHttp, probeTcp } from './util.ts';

/** Spins up an HTTP server that answers every request with `status`. */
async function listenWithStatus(
  status: number,
): Promise<{ server: HttpServer; url: string }> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(
      status,
      status >= 300 && status < 400 ? { Location: '/' } : {},
    );
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

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

describe('probeHttp', () => {
  it('resolves true for a 2xx response', async () => {
    const { server, url } = await listenWithStatus(200);
    try {
      assert.equal(await probeHttp(url, 1_000), true);
    } finally {
      await close(server);
    }
  });

  it('resolves true for a 4xx response (server is serving)', async () => {
    const { server, url } = await listenWithStatus(404);
    try {
      assert.equal(await probeHttp(url, 1_000), true);
    } finally {
      await close(server);
    }
  });

  it('resolves true for a 3xx redirect without following it', async () => {
    const { server, url } = await listenWithStatus(302);
    try {
      assert.equal(await probeHttp(url, 1_000), true);
    } finally {
      await close(server);
    }
  });

  it('resolves false for a 5xx response (still compiling)', async () => {
    const { server, url } = await listenWithStatus(503);
    try {
      assert.equal(await probeHttp(url, 1_000), false);
    } finally {
      await close(server);
    }
  });

  it('resolves false when the connection is refused', async () => {
    // Port 1 is privileged and effectively never open for this process.
    assert.equal(await probeHttp('http://127.0.0.1:1/', 500), false);
  });
});
