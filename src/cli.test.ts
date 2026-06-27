import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArguments } from './cli.ts';

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
