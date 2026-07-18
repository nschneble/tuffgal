import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { isMainEntry, parseArguments, validateCommandFlags } from './cli.ts';
import { resolveRunMode } from './runner/mode.ts';

describe('parseArguments — approve filters', () => {
  it('captures a bare positional story argument', () => {
    const args = parseArguments(['approve', 'user-logs-in']);
    assert.equal(args.command, 'approve');
    assert.equal(args.positional, 'user-logs-in');
  });

  it('collects --breakpoint repeatably and dedupes', () => {
    const args = parseArguments([
      'approve',
      '--breakpoint',
      'desktop',
      '--breakpoint=mobile',
      '--breakpoint',
      'desktop',
    ]);
    assert.deepEqual(args.breakpoints, ['desktop', 'mobile']);
  });

  it('expands --<name> registry shorthands to breakpoints', () => {
    const args = parseArguments(['approve', '--desktop', '--mobile']);
    assert.deepEqual(args.breakpoints, ['desktop', 'mobile']);
  });

  it('keeps a positional alongside breakpoint + new-only flags', () => {
    const args = parseArguments([
      'approve',
      'user-logs-in',
      '--desktop',
      '--new-only',
    ]);
    assert.equal(args.positional, 'user-logs-in');
    assert.deepEqual(args.breakpoints, ['desktop']);
    assert.equal(args.newOnly, true);
  });

  it('does not mistake a flag value for a positional', () => {
    const args = parseArguments(['approve', '--story', 'user-logs-in']);
    assert.equal(args.storyFilter, 'user-logs-in');
    assert.equal(args.positional, undefined);
  });

  it('throws on a second positional argument', () => {
    assert.throws(
      () => parseArguments(['approve', 'one', 'two']),
      /unexpected extra argument "two"/,
    );
  });

  it('throws when --breakpoint has no value', () => {
    assert.throws(
      () => parseArguments(['approve', '--breakpoint']),
      /--breakpoint requires a mode name/,
    );
  });
});

describe('parseArguments — unknown flag rejection', () => {
  it('throws on an unrecognized dash-prefixed option', () => {
    assert.throws(
      () => parseArguments(['run', '--nope']),
      /unknown option "--nope"/,
    );
  });

  it('still parses a known flag on the happy path', () => {
    const args = parseArguments(['run', '--ci']);
    assert.equal(args.ci, true);
  });
});

describe('parseArguments — run mode flags', () => {
  it('captures --ci', () => {
    const args = parseArguments(['run', '--ci']);
    assert.equal(args.ci, true);
    assert.equal(args.local, false);
  });

  it('captures --local', () => {
    const args = parseArguments(['run', '--local']);
    assert.equal(args.local, true);
    assert.equal(args.ci, false);
  });

  it('defaults both mode flags to false', () => {
    const args = parseArguments(['run']);
    assert.equal(args.ci, false);
    assert.equal(args.local, false);
  });
});

describe('validateCommandFlags — cross-command flag placement', () => {
  it('accepts --ci on the run command', () => {
    assert.equal(
      validateCommandFlags(parseArguments(['run', '--ci'])),
      undefined,
    );
  });

  it('accepts --local on the run command', () => {
    assert.equal(
      validateCommandFlags(parseArguments(['run', '--local'])),
      undefined,
    );
  });

  it('rejects --ci on a non-run command (approve)', () => {
    const error = validateCommandFlags(parseArguments(['approve', '--ci']));
    assert.match(
      String(error),
      /--ci and --local are only valid with the `run`/,
    );
  });

  it('rejects --local on a non-run command (help falls through)', () => {
    // An unknown command parses to `help`; --local there is still illegal.
    const error = validateCommandFlags(parseArguments(['bogus', '--local']));
    assert.match(
      String(error),
      /--ci and --local are only valid with the `run`/,
    );
  });

  it('rejects --new-only outside approve', () => {
    const error = validateCommandFlags(parseArguments(['run', '--new-only']));
    assert.match(String(error), /--new-only is only valid with the `approve`/);
  });

  it('rejects a breakpoint filter outside approve', () => {
    const error = validateCommandFlags(parseArguments(['run', '--desktop']));
    assert.match(
      String(error),
      /--breakpoint .* is only valid with the `approve`/,
    );
  });

  it('rejects a stray positional outside approve', () => {
    const error = validateCommandFlags(parseArguments(['run', 'extra']));
    assert.match(String(error), /unexpected argument "extra"/);
  });

  it('accepts a clean run invocation', () => {
    assert.equal(validateCommandFlags(parseArguments(['run'])), undefined);
  });

  it('does NOT itself block both --ci and --local — resolveRunMode owns that', () => {
    // The both-flags error is routed through resolveRunMode (which `main`
    // catches and sends to failExit), not this pre-flight validator: the flags
    // are individually legal on `run`, and their mutual exclusivity is a
    // mode-resolution concern.
    const args = parseArguments(['run', '--ci', '--local']);
    assert.equal(validateCommandFlags(args), undefined);
    assert.throws(
      () => resolveRunMode({ ci: args.ci, local: args.local, env: {} }),
      /both --ci and --local/,
    );
  });
});

describe('parseArguments — approve --from / --prune', () => {
  it('parses --from <dir> and --prune', () => {
    const args = parseArguments(['approve', '--from', 'candidates', '--prune']);
    assert.equal(args.from, 'candidates');
    assert.equal(args.prune, true);
  });

  it('parses --from=dir form', () => {
    const args = parseArguments(['approve', '--from=candidates']);
    assert.equal(args.from, 'candidates');
  });

  it('throws when --from has no value', () => {
    assert.throws(
      () => parseArguments(['approve', '--from']),
      /--from requires a value/,
    );
  });

  it('throws when --from is followed by another flag', () => {
    assert.throws(
      () => parseArguments(['approve', '--from', '--prune']),
      /--from requires a value/,
    );
  });
});

describe('validateCommandFlags — --from / --prune placement', () => {
  it('rejects --from outside approve', () => {
    assert.match(
      validateCommandFlags(parseArguments(['run', '--from', 'x'])) ?? '',
      /--from is only valid with the `approve`/,
    );
  });

  it('rejects --prune without --from', () => {
    assert.match(
      validateCommandFlags(parseArguments(['approve', '--prune'])) ?? '',
      /--prune requires --from/,
    );
  });

  it('rejects --from combined with a story filter', () => {
    assert.match(
      validateCommandFlags(
        parseArguments(['approve', '--from', 'x', '--story', 's']),
      ) ?? '',
      /--from cannot be combined with a story filter/,
    );
  });

  it('rejects --from combined with a positional story', () => {
    assert.match(
      validateCommandFlags(parseArguments(['approve', '--from', 'x', 's'])) ??
        '',
      /--from cannot be combined with a story filter/,
    );
  });

  it('rejects --from combined with --new-only', () => {
    assert.match(
      validateCommandFlags(
        parseArguments(['approve', '--from', 'x', '--new-only']),
      ) ?? '',
      /--from cannot be combined with --new-only/,
    );
  });

  it('rejects --from combined with --breakpoint', () => {
    assert.match(
      validateCommandFlags(
        parseArguments(['approve', '--from', 'x', '--desktop']),
      ) ?? '',
      /--from cannot be combined with --breakpoint/,
    );
  });

  it('accepts a clean approve --from --prune', () => {
    assert.equal(
      validateCommandFlags(
        parseArguments(['approve', '--from', 'x', '--prune']),
      ),
      undefined,
    );
  });
});

describe('isMainEntry — entry-point detection', () => {
  it('matches when argv[1] is a symlink resolving to the module file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tuffgal-entry-'));
    try {
      const realScript = join(directory, 'cli.js');
      const symlink = join(directory, 'tuffgal');
      writeFileSync(realScript, '');
      symlinkSync(realScript, symlink);

      // Mirror reality: Node hands `import.meta.url` to the module already
      // symlink-resolved (tmpdir itself is a symlink on macOS: /var ->
      // /private/var), so build the expected URL from the resolved path.
      const moduleUrl = pathToFileURL(realpathSync(realScript)).href;
      // The installed `.bin/tuffgal` symlink is what lands in argv[1]; the
      // module URL is already symlink-resolved. Both must still match.
      assert.equal(isMainEntry(moduleUrl, symlink), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not match when imported as a module (different argv[1])', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tuffgal-entry-'));
    try {
      const moduleFile = join(directory, 'cli.js');
      const importer = join(directory, 'test-runner.js');
      writeFileSync(moduleFile, '');
      writeFileSync(importer, '');

      assert.equal(
        isMainEntry(pathToFileURL(moduleFile).href, importer),
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns false when argv[1] is undefined', () => {
    assert.equal(isMainEntry('file:///anything.js', undefined), false);
  });
});
