#!/usr/bin/env node
import { loadConfig } from './config.ts';
import { approveAll } from './runner/approve.ts';
import { runAll } from './runner/run.ts';

interface ParsedArguments {
  command: 'run' | 'approve' | 'init' | 'help';
  storyFilter?: string;
  headed: boolean;
  workers?: number;
  manageServers: boolean;
  coverage: boolean;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const parsed: ParsedArguments = {
    command:
      command === 'run' ||
      command === 'approve' ||
      command === 'init' ||
      command === 'help'
        ? command
        : 'help',
    headed: false,
    manageServers: false,
    coverage: false,
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
      '  help                Show this message.',
      '',
      'Options:',
      '  --story <name>      Filter to a single story (filename or story text).',
      '  --headed            Show the browser while running.',
      '  --workers N         Override the worker pool size (default min(cpus/2, 4)).',
      '  --manage-servers    Spawn the configured devServers.command, wait for it, run, then kill it.',
      '  --coverage          Capture V8 JS + CSS coverage and emit a monocart report.',
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
    process.stdout.write(
      '`tuffgal init` scaffolder lands in a follow-up commit. For now copy ' +
        'the example tuffgal.config.ts from the documentation.\n',
    );
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
    });
    process.stdout.write(
      `\nApproved ${summary.approved} baselines; skipped ${summary.skipped} actions.\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `tuffgal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
