import { access } from 'node:fs/promises';
import { createConnection } from 'node:net';

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True when `path` exists and is accessible, false otherwise. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Splits a URL into host and port, defaulting the port by scheme. */
export function parseHostPort(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  return { host: parsed.hostname, port };
}

/**
 * Resolves `true` if a TCP connection to `host:port` opens within `timeoutMs`,
 * `false` on error or timeout. Used to gate dev-server readiness without an
 * HTTP round-trip, so self-signed certs and 404s don't block.
 */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ port, host });
    const cleanup = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(result);
    };
    socket.once('connect', () => cleanup(true));
    socket.once('error', () => cleanup(false));
    socket.once('timeout', () => cleanup(false));
    socket.setTimeout(timeoutMs);
  });
}
