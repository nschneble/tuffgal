#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { approveAll } from './runner/approve.ts';
import { init } from './commands/init.ts';
import { BREAKPOINTS, loadConfig } from './config.ts';
import { runAll } from './runner/run.ts';
import { normaliseStoryArg } from './runner/storyFilter.ts';
import { supervise } from './commands/supervise.ts';

const COMMANDS = ['approve', 'help', 'init', 'run', 'supervise'] as const;
type Command = (typeof COMMANDS)[number];

/** Registry breakpoint names that double as `--<name>` approve shorthands. */
const BREAKPOINT_FLAGS = Object.keys(BREAKPOINTS);

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
  /** Bare positional argument (e.g. `approve user-logs-in`). */
  positional?: string;
  /** `--breakpoint <name>` (repeatable) plus `--<name>` shorthands. */
  breakpoints: string[];
  workers?: number;
}

export function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const parsed: ParsedArguments = {
    command: COMMANDS.includes(command as Command)
      ? (command as Command)
      : 'help',
    headed: false,
    manageServers: false,
    coverage: false,
    newOnly: false,
    breakpoints: [],
  };

  const addBreakpoint = (name: string | undefined): void => {
    if (name === undefined || name === '') {
      throw new Error('--breakpoint requires a mode name (e.g. desktop)');
    }
    if (!parsed.breakpoints.includes(name)) parsed.breakpoints.push(name);
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
    } else if (arg === '--breakpoint') {
      addBreakpoint(rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--breakpoint=')) {
      addBreakpoint(arg.slice('--breakpoint='.length));
    } else if (
      arg.startsWith('--') &&
      BREAKPOINT_FLAGS.includes(arg.slice(2))
    ) {
      addBreakpoint(arg.slice(2));
    } else if (!arg.startsWith('-')) {
      if (parsed.positional !== undefined) {
        throw new Error(
          `unexpected extra argument "${arg}" (already got "${parsed.positional}")`,
        );
      }
      parsed.positional = arg;
    } else if (arg === '--workers') {
      parsed.workers = numericFlag('--workers', rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--workers=')) {
      parsed.workers = numericFlag('--workers', arg.slice('--workers='.length));
    } else if (arg === '--manage-servers') {
      parsed.manageServers = true;
    } else if (arg === '--coverage') {
      parsed.coverage = true;
    } else if (arg === '--new-only') {
      parsed.newOnly = true;
    } else if (arg === '--healthcheck-interval') {
      parsed.healthcheckIntervalMs = numericFlag(
        '--healthcheck-interval',
        rest[index + 1],
      );
      index += 1;
    } else if (arg.startsWith('--healthcheck-interval=')) {
      parsed.healthcheckIntervalMs = numericFlag(
        '--healthcheck-interval',
        arg.slice('--healthcheck-interval='.length),
      );
    } else if (arg === '--idle-limit') {
      parsed.idleLimitMs = numericFlag('--idle-limit', rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--idle-limit=')) {
      parsed.idleLimitMs = numericFlag(
        '--idle-limit',
        arg.slice('--idle-limit='.length),
      );
    } else if (arg === '--max-runtime') {
      parsed.maxRuntimeMs = numericFlag('--max-runtime', rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--max-runtime=')) {
      parsed.maxRuntimeMs = numericFlag(
        '--max-runtime',
        arg.slice('--max-runtime='.length),
      );
    } else if (arg === '--max-respawns') {
      parsed.maxRespawns = numericFlag('--max-respawns', rest[index + 1]);
      index += 1;
    } else if (arg.startsWith('--max-respawns=')) {
      parsed.maxRespawns = numericFlag(
        '--max-respawns',
        arg.slice('--max-respawns='.length),
      );
    }
  }
  return parsed;
}

/**
 * Parses a numeric CLI flag, rejecting anything non-finite or <= 0. Without
 * this, `--idle-limit foo` became `NaN` and flowed into `setTimeout(…, NaN)`,
 * which behaves as `0` and busy-loops the supervisor's healthcheck. Fail loudly
 * at parse time instead.
 */
function numericFlag(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (
    raw === undefined ||
    raw === '' ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new Error(`${flag} requires a positive number (got "${raw ?? ''}")`);
  }
  return value;
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
      '',
      'Approve options:',
      '  <story>                    Positional story to approve (name or path); same as --story.',
      '  --new-only                 Only promote new baselines; skip changed.',
      '  --breakpoint <name>        Only approve this mode; repeatable. Also --desktop/--mobile/etc.',
      '',
      'Supervise options:',
      '  --healthcheck-interval N   Probe interval in ms (default 30_000).',
      '  --idle-limit N             Ms with no `tuffgal run` heartbeat before exit (default 600_000).',
      '  --max-runtime N            Wall-clock cap in ms (default 3_600_000).',
      '  --max-respawns N           Respawn budget after unhealthy/exit (default 3).',
    ].join('\n') + '\n',
  );
}

function failExit(message: string): never {
  process.stderr.write(`tuffgal error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));

  // `--new-only` and the breakpoint filters narrow an approval set; they have no
  // meaning on the other subcommands.
  if (args.command !== 'approve') {
    if (args.newOnly) {
      failExit('--new-only is only valid with the `approve` subcommand');
    }
    if (args.breakpoints.length > 0) {
      failExit(
        '--breakpoint (and --desktop/--mobile/…) is only valid with the `approve` subcommand',
      );
    }
    if (args.positional !== undefined) {
      failExit(`unexpected argument "${args.positional}"`);
    }
  }

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
    process.exit(result.totals.failed > 0 ? 1 : 0);
  }
  if (args.command === 'approve') {
    // A story may be named positionally (`approve user-logs-in`) or via
    // `--story`, but not both.
    if (args.positional !== undefined && args.storyFilter !== undefined) {
      failExit('name a story positionally or with --story, not both');
    }
    const storyFilter =
      args.positional !== undefined
        ? normaliseStoryArg(args.positional)
        : args.storyFilter;
    const summary = await approveAll(config, {
      storyFilter,
      newOnly: args.newOnly,
      breakpoints: args.breakpoints,
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

// Only drive the CLI when run as the entry point. Importing this module (e.g.
// from a unit test exercising `parseArguments`) must not kick off a real run.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `tuffgal error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
