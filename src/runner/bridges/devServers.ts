import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import type { ResolvedConfig } from '../../config.ts';
import { sleep } from '../../util.ts';

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export interface ManagedDevServers {
  stop(): Promise<void>;
}

/**
 * Spawns the consumer-declared `devServers.command` in a new process group,
 * tees its combined output to `<report>/dev-servers.log`, and waits until
 * every declared health-check URL accepts a TCP connection on its port.
 * Returns a handle whose `stop()` method tears the whole tree down with
 * the configured signal (default SIGTERM) followed by SIGKILL after the
 * grace window.
 *
 * Used by the CLI's `--manage-servers` flag.
 */
export async function startManagedDevServers(
  config: ResolvedConfig,
): Promise<ManagedDevServers> {
  if (!config.devServers) {
    throw new Error(
      '--manage-servers passed but tuffgal.config.ts has no `devServers` block. ' +
        'Either remove the flag or declare `devServers: { command, healthCheck: [...] }`.',
    );
  }

  const logsDirectory = config.paths.report;
  mkdirSync(logsDirectory, { recursive: true });
  const logPath = join(logsDirectory, 'dev-servers.log');
  const logStream = createWriteStream(logPath, { flags: 'w' });

  process.stdout.write(`Spawning dev servers (output → ${logPath})…\n`);
  const cwd = config.devServers.cwd
    ? resolve(config.rootDir, config.devServers.cwd)
    : config.rootDir;
  const child = spawn('sh', ['-c', config.devServers.command], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (child.stdout) child.stdout.pipe(logStream);
  if (child.stderr) child.stderr.pipe(logStream);

  let earlyExit: Error | undefined;
  child.once('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      earlyExit = new Error(
        `Dev server command exited early with code ${code}${
          signal ? ` (${signal})` : ''
        }`,
      );
    }
  });

  try {
    await Promise.all(
      config.devServers.healthCheck.map((check) =>
        waitForUrl(
          check.url,
          check.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
          () => earlyExit,
        ),
      ),
    );
  } catch (error) {
    await stopChild(child, config);
    logStream.end();
    if (earlyExit) throw earlyExit;
    throw error;
  }

  return {
    async stop(): Promise<void> {
      await stopChild(child, config);
      logStream.end();
    },
  };
}

async function stopChild(
  child: ChildProcess,
  config: ResolvedConfig,
): Promise<void> {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  const pid = child.pid;
  const signal = config.devServers?.shutdownSignal ?? 'SIGTERM';
  const graceMs =
    config.devServers?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  process.stdout.write('Stopping dev servers…\n');
  await new Promise<void>((resolveOuter) => {
    let killed = false;
    const finish = (): void => {
      if (killed) return;
      killed = true;
      resolveOuter();
    };
    child.once('exit', finish);
    try {
      // Negative pid targets the entire process group created by detached: true.
      process.kill(-pid, signal);
    } catch {
      // The group might already be gone; treat as resolved.
      finish();
      return;
    }
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already exited or unreachable; finishing is fine either way.
        }
      }
    }, graceMs);
  });
}

async function waitForUrl(
  url: string,
  timeoutMs: number,
  getEarlyExit: () => Error | undefined,
): Promise<void> {
  const parsed = new URL(url);
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  const host = parsed.hostname;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const earlyExit = getEarlyExit();
    if (earlyExit) {
      throw earlyExit;
    }
    const open = await probePort(host, port);
    if (open) {
      return;
    }
    await sleep(500);
  }
  throw new Error(
    `Health-check URL ${url} (TCP ${host}:${port}) did not respond within ${timeoutMs}ms`,
  );
}

function probePort(host: string, port: number): Promise<boolean> {
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
    socket.setTimeout(1_500);
  });
}
