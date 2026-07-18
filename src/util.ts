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
 * `false` on error or timeout. This is a cheap up/down LIVENESS check, not a
 * readiness gate: `supervise.ts`'s `probeAllHealthchecks` polls it against dev
 * servers that were already proven to be serving routes at startup (via
 * {@link probeHttp}), so once a server is HTTP-readiness-verified a bare TCP
 * accept is sufficient to confirm the process is still up. The false-ready
 * caveat that makes a TCP accept too weak for a cold-booting dev server (see
 * {@link probeHttp}) does not apply here — the server is past boot. Staying on
 * TCP also keeps the liveness poll agnostic to self-signed HTTPS certs and
 * non-2xx routes, which `fetch` (and thus `probeHttp`) would reject.
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

/**
 * Resolves `true` if an HTTP `GET` to `url` returns any non-5xx status within
 * `timeoutMs`, `false` on a 5xx status, connection refusal, TLS/DNS failure, or
 * timeout. Unlike {@link probeTcp}, this proves the server is actually *serving*
 * routes — a dev server (Vite/Next/webpack) binds its socket well before the
 * bundle finishes compiling, so a bare TCP accept can succeed while requests
 * still 503 or hang. Any received response (2xx/3xx/4xx) means it is up.
 *
 * Redirects are not followed (`redirect: 'manual'`): a 3xx already proves the
 * server is serving, and chasing `Location` risks an external host or a slow
 * login page. Note this does *not* accept self-signed HTTPS certs (fetch
 * rejects them) — an http health-check URL is expected.
 */
export async function probeHttp(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    // Drain the body so the socket doesn't linger in undici's connection pool.
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
