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

import { isMainEntry, parseArguments } from './cli.ts';

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
