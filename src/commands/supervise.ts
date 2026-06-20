import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ResolvedConfig, DevServerBridge } from '../config.ts';
import { parseHostPort, probeTcp, sleep } from '../util.ts';

const HEARTBEAT_FILE = '.heartbeat';
const SIGTERM_GRACE_MS = 5_000;
const HEALTHCHECK_PROBE_TIMEOUT_MS = 2_000;

const DEFAULT_HEALTHCHECK_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_LIMIT_MS = 10 * 60_000;
const DEFAULT_MAX_RUNTIME_MS = 60 * 60_000;
const DEFAULT_MAX_RESPAWNS = 3;

export interface SuperviseOptions {
  /** Milliseconds between port + heartbeat probes. Default 30_000. */
  healthcheckIntervalMs?: number;
  /**
   * Window with no `tuffgal run` heartbeat before the supervisor self-
   * terminates. Default 10 minutes. The heartbeat file lives at
   * `config.paths.report/.heartbeat` and is touched by every `tuffgal
   * run` invocation.
   */
  idleLimitMs?: number;
  /** Wall-clock cap, end-to-end. Default 60 minutes. */
  maxRuntimeMs?: number;
  /**
   * How many times the supervisor may respawn `devServers.command` after
   * an unhealthy probe or unexpected exit before giving up. Default 3.
   */
  maxRespawns?: number;
}

/**
 * Long-running supervisor around `config.devServers.command`. Solves
 * three problems observed during heavy harness iteration:
 *
 *   1. Hot-reload rot — after many file-watch restarts the framework
 *      drifts into a broken state. Supervisor probes every declared
 *      healthcheck URL and restarts the whole tree on failure.
 *   2. Forgotten dev servers — supervisor self-terminates after a
 *      wall-clock cap and after an idle window with no heartbeat from
 *      `tuffgal run`.
 *   3. Manual signal management — SIGINT/SIGTERM teardown kills the
 *      whole detached process group, not just the shell wrapper.
 *
 * Each invocation of `tuffgal run` writes
 * `config.paths.report/.heartbeat` (ISO timestamp). Supervisor reads
 * its mtime every healthcheck. If `Date.now() - mtime > idleLimitMs`,
 * supervisor shuts down. Missing heartbeat file is treated as "no runs
 * yet", not stale, so a fresh shell does not self-terminate immediately.
 */
export async function supervise(
  config: ResolvedConfig,
  options: SuperviseOptions = {},
): Promise<void> {
  if (!config.devServers) {
    throw new Error(
      'tuffgal supervise requires a `devServers` block in tuffgal.config.ts. ' +
        'Declare `devServers: { command, healthCheck: [...] }` and try again.',
    );
  }

  const healthcheckIntervalMs =
    options.healthcheckIntervalMs ??
    numberFromEnv(
      'TUFFGAL_HEALTHCHECK_INTERVAL_MS',
      DEFAULT_HEALTHCHECK_INTERVAL_MS,
    );
  const idleLimitMs =
    options.idleLimitMs ??
    numberFromEnv('TUFFGAL_IDLE_LIMIT_MS', DEFAULT_IDLE_LIMIT_MS);
  const maxRuntimeMs =
    options.maxRuntimeMs ??
    numberFromEnv('TUFFGAL_MAX_RUNTIME_MS', DEFAULT_MAX_RUNTIME_MS);
  const maxRespawns =
    options.maxRespawns ??
    numberFromEnv('TUFFGAL_MAX_RESPAWNS', DEFAULT_MAX_RESPAWNS);

  mkdirSync(config.paths.report, { recursive: true });
  const logPath = join(config.paths.report, 'dev-servers.log');
  const heartbeatPath = join(config.paths.report, HEARTBEAT_FILE);

  process.stdout.write(
    [
      'Starting tuffgal supervisor.',
      `  Command:      ${config.devServers.command}`,
      `  Healthcheck:  ${config.devServers.healthCheck.map((entry) => entry.url).join(', ')}`,
      `  Log:          ${logPath}`,
      `  Heartbeat:    ${heartbeatPath}`,
      `  Interval:     ${healthcheckIntervalMs}ms`,
      `  Idle limit:   ${idleLimitMs}ms`,
      `  Max runtime:  ${maxRuntimeMs}ms`,
      `  Max respawns: ${maxRespawns}`,
      '',
    ].join('\n'),
  );

  const startedAt = Date.now();
  let respawns = 0;
  let child = spawnDevServers(config.devServers, config.rootDir, logPath);
  let stopped = false;

  const teardown = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.stdout.write(`Supervisor stopping: ${reason}\n`);
    await stopChild(child, config.devServers);
    process.exit(0);
  };

  process.on('SIGINT', () => void teardown('SIGINT received'));
  process.on('SIGTERM', () => void teardown('SIGTERM received'));

  while (!stopped) {
    await sleep(healthcheckIntervalMs);
    if (stopped) break;

    if (Date.now() - startedAt > maxRuntimeMs) {
      await teardown('wall-clock cap reached');
      return;
    }
    if (heartbeatIsStale(heartbeatPath, idleLimitMs)) {
      await teardown(`no tuffgal run activity in ${idleLimitMs}ms`);
      return;
    }

    if (child.exitCode !== null) {
      respawns += 1;
      if (respawns > maxRespawns) {
        await teardown(
          `dev servers exited and respawn budget exhausted (${maxRespawns})`,
        );
        return;
      }
      process.stdout.write(
        `Dev servers exited; respawning (${respawns}/${maxRespawns}).\n`,
      );
      child = spawnDevServers(config.devServers, config.rootDir, logPath);
      continue;
    }

    const healthy = await probeAllHealthchecks(config.devServers);
    if (!healthy) {
      respawns += 1;
      if (respawns > maxRespawns) {
        await teardown(
          `unhealthy ports and respawn budget exhausted (${maxRespawns})`,
        );
        return;
      }
      process.stdout.write(
        `Healthcheck failed; killing + respawning (${respawns}/${maxRespawns}).\n`,
      );
      await stopChild(child, config.devServers);
      child = spawnDevServers(config.devServers, config.rootDir, logPath);
    }
  }
}

function spawnDevServers(
  devServers: DevServerBridge,
  rootDir: string,
  logPath: string,
): ChildProcess {
  const stream = createWriteStream(logPath, { flags: 'a' });
  stream.write(`\n--- dev servers spawned @ ${new Date().toISOString()} ---\n`);
  const cwd = devServers.cwd ? resolve(rootDir, devServers.cwd) : rootDir;
  const child = spawn('sh', ['-c', devServers.command], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (child.stdout) child.stdout.pipe(stream);
  if (child.stderr) child.stderr.pipe(stream);
  return child;
}

async function probeAllHealthchecks(
  devServers: DevServerBridge,
): Promise<boolean> {
  const results = await Promise.all(
    devServers.healthCheck.map((entry) => probeUrl(entry.url)),
  );
  return results.every((result) => result);
}

function probeUrl(url: string): Promise<boolean> {
  const { host, port } = parseHostPort(url);
  return probeTcp(host, port, HEALTHCHECK_PROBE_TIMEOUT_MS);
}

function heartbeatIsStale(heartbeatPath: string, idleLimitMs: number): boolean {
  try {
    const stat = statSync(heartbeatPath);
    return Date.now() - stat.mtimeMs > idleLimitMs;
  } catch {
    // No heartbeat yet — count grace period from supervisor start so a
    // fresh shell does not immediately kill itself.
    return false;
  }
}

async function stopChild(
  child: ChildProcess,
  devServers: DevServerBridge | undefined,
): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  const pid = child.pid;
  const signal = devServers?.shutdownSignal ?? 'SIGTERM';
  const graceMs = devServers?.shutdownGraceMs ?? SIGTERM_GRACE_MS;
  await new Promise<void>((resolveOuter) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolveOuter();
    };
    child.once('exit', finish);
    try {
      process.kill(-pid, signal);
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, graceMs);
  });
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
