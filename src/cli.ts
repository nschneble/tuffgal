#!/usr/bin/env node
import { approveAll } from './runner/approve.ts';
import { init } from './commands/init.ts';
import { loadConfig } from './config.ts';
import { runAll } from './runner/run.ts';
import { supervise } from './commands/supervise.ts';

const COMMANDS = ['approve', 'help', 'init', 'run', 'supervise'] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArguments {
  command: Command;
  coverage: boolean;
  headed: boolean;
  manageServers: boolean;
  healthcheckIntervalMs?: number;
  idleLimitMs?: number;
  maxRespawns?: number;
  maxRuntimeMs?: number;
  newOnly: boolean;
  storyFilter?: string;
  workers?: number;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const parsed: ParsedArguments = {
    command: COMMANDS.includes(command as Command)
      ? (command as Command)
      : 'help',
    headed: false,
    manageServers: false,
    coverage: false,
    newOnly: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (arg === '--headed') {
      parsed.headed = true;
    } else if (arg === '--story') {
      parsed.storyFilter = rest[index + 1];
      index += 1;
    } else if (arg.startsWith('--story=')) {
      parsed.storyFilter = arg.slice('--story='.length);
    } else if (arg === '--workers') {
      parsed.workers = Number(rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--workers=')) {
      parsed.workers = Number(arg.slice('--workers='.length));
    } else if (arg === '--manage-servers') {
      parsed.manageServers = true;
    } else if (arg === '--coverage') {
      parsed.coverage = true;
    } else if (arg === '--new-only') {
      parsed.newOnly = true;
    } else if (arg === '--healthcheck-interval') {
      parsed.healthcheckIntervalMs = Number(rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--healthcheck-interval=')) {
      parsed.healthcheckIntervalMs = Number(
        arg.slice('--healthcheck-interval='.length),
      );
    } else if (arg === '--idle-limit') {
      parsed.idleLimitMs = Number(rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--idle-limit=')) {
      parsed.idleLimitMs = Number(arg.slice('--idle-limit='.length));
    } else if (arg === '--max-runtime') {
      parsed.maxRuntimeMs = Number(rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--max-runtime=')) {
      parsed.maxRuntimeMs = Number(arg.slice('--max-runtime='.length));
    } else if (arg === '--max-respawns') {
      parsed.maxRespawns = Number(rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--max-respawns=')) {
      parsed.maxRespawns = Number(arg.slice('--max-respawns='.length));
    }
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: tuffgal <command> [options]',
      '',
      'Commands:',
      '  run                 Run every story under the configured stories directory.',
      '  approve             Promote every "changed" actual to its baseline.',
      '  init                Scaffold a tuffgal.config.ts in the current directory.',
      '  supervise           Long-running wrapper around devServers.command with',
      '                      healthcheck restart, idle auto-term, and wall-clock cap.',
      '  help                Show this message.',
      '',
      'Options:',
      '  --story <name>             Filter to a single story (filename or story text).',
      '  --headed                   Show the browser while running.',
      '  --workers N                Override the worker pool size (default min(cpus/2, 4)).',
      '  --manage-servers           Spawn devServers.command, wait, run, then kill it.',
      '  --coverage                 Capture V8 JS + CSS coverage and emit a monocart report.',
      '  --new-only                 (approve) Only promote new baselines; skip changed.',
      '',
      'Supervise options:',
      '  --healthcheck-interval N   Probe interval in ms (default 30_000).',
      '  --idle-limit N             Ms with no `tuffgal run` heartbeat before exit (default 600_000).',
      '  --max-runtime N            Wall-clock cap in ms (default 3_600_000).',
      '  --max-respawns N           Respawn budget after unhealthy/exit (default 3).',
    ].join('\n') + '\n',
  );
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === 'help') {
    printHelp();
    return;
  }
  if (args.command === 'init') {
    await init({ cwd: process.cwd() });
    return;
  }
  const config = await loadConfig(process.cwd());
  if (args.command === 'run') {
    const result = await runAll(config, {
      storyFilter: args.storyFilter,
      headed: args.headed,
      workers: args.workers,
      manageServers: args.manageServers,
      coverage: args.coverage,
    });
    process.stdout.write(
      `\nTotals: ${result.totals.passed} pass · ${result.totals.changed} changed · ${result.totals.failed} failed\n`,
    );
    process.exit(result.totals.failed > 0 ? 1 : 0);
  }
  if (args.command === 'approve') {
    const summary = await approveAll(config, {
      storyFilter: args.storyFilter,
      newOnly: args.newOnly,
    });
    process.stdout.write(
      `\nApproved ${summary.approved} baselines; skipped ${summary.skipped} actions.\n`,
    );
  }
  if (args.command === 'supervise') {
    await supervise(config, {
      healthcheckIntervalMs: args.healthcheckIntervalMs,
      idleLimitMs: args.idleLimitMs,
      maxRuntimeMs: args.maxRuntimeMs,
      maxRespawns: args.maxRespawns,
    });
  }
}

main().catch((error) => {
  process.stderr.write(
    `tuffgal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
