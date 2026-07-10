import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunResult } from '../schema/result.ts';
import { deriveExitCode } from './exitCode.ts';

function totals(over: Partial<RunResult['totals']>): RunResult['totals'] {
  return { stories: 0, passed: 0, changed: 0, failed: 0, new: 0, ...over };
}

describe('deriveExitCode', () => {
  it('returns 0 for a clean CI run', () => {
    assert.equal(deriveExitCode('ci', totals({ passed: 3 })), 0);
  });

  it('returns 2 for pending changes in CI mode', () => {
    assert.equal(deriveExitCode('ci', totals({ changed: 1 })), 2);
  });

  it('returns 2 for a new baseline in CI mode', () => {
    assert.equal(deriveExitCode('ci', totals({ new: 1 })), 2);
  });

  it('returns 2 when both new and changed are present in CI mode', () => {
    assert.equal(deriveExitCode('ci', totals({ new: 2, changed: 1 })), 2);
  });

  it('lets failed (1) beat pending changes (2) in CI mode', () => {
    assert.equal(deriveExitCode('ci', totals({ failed: 1, changed: 3 })), 1);
  });

  it('returns 1 for a failed CI run with no changes', () => {
    assert.equal(deriveExitCode('ci', totals({ failed: 1 })), 1);
  });

  it('never emits 2 in local mode — changes are advisory', () => {
    assert.equal(deriveExitCode('local', totals({ changed: 2, new: 1 })), 0);
  });

  it('still emits 1 for a failed local run', () => {
    assert.equal(deriveExitCode('local', totals({ failed: 1, changed: 2 })), 1);
  });

  it('returns 0 for a clean local run', () => {
    assert.equal(deriveExitCode('local', totals({ passed: 4 })), 0);
  });
});
