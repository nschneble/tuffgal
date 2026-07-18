import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunResult } from '../schema/result.ts';
import { deriveExitCode } from './exitCode.ts';

function totals(over: Partial<RunResult['totals']>): RunResult['totals'] {
  return {
    stories: 0,
    passed: 0,
    changed: 0,
    failed: 0,
    new: 0,
    deleted: 0,
    ...over,
  };
}

describe('deriveExitCode: no mismatch', () => {
  it('returns 0 for a clean CI run', () => {
    assert.equal(deriveExitCode('ci', totals({ passed: 3 }), false), 0);
  });

  it('returns 2 for pending changes in CI mode', () => {
    assert.equal(deriveExitCode('ci', totals({ changed: 1 }), false), 2);
  });

  it('returns 2 for a new baseline in CI mode', () => {
    assert.equal(deriveExitCode('ci', totals({ new: 1 }), false), 2);
  });

  it('returns 2 when both new and changed are present in CI mode', () => {
    assert.equal(
      deriveExitCode('ci', totals({ new: 2, changed: 1 }), false),
      2,
    );
  });

  it('returns 2 for orphaned baselines only in CI mode', () => {
    assert.equal(deriveExitCode('ci', totals({ deleted: 1 }), false), 2);
  });

  it('returns 2 when only deleted alongside passing stories in CI mode', () => {
    assert.equal(
      deriveExitCode('ci', totals({ passed: 3, deleted: 2 }), false),
      2,
    );
  });

  it('never emits 2 for orphaned baselines in local mode', () => {
    assert.equal(deriveExitCode('local', totals({ deleted: 3 }), false), 0);
  });

  it('lets failed (1) beat pending changes (2) in CI mode', () => {
    assert.equal(
      deriveExitCode('ci', totals({ failed: 1, changed: 3 }), false),
      1,
    );
  });

  it('lets failed (1) beat orphaned baselines (2) in CI mode', () => {
    assert.equal(
      deriveExitCode('ci', totals({ failed: 1, deleted: 3 }), false),
      1,
    );
  });

  it('returns 1 for a failed CI run with no changes', () => {
    assert.equal(deriveExitCode('ci', totals({ failed: 1 }), false), 1);
  });

  it('never emits 2 in local mode: changes are advisory', () => {
    assert.equal(
      deriveExitCode('local', totals({ changed: 2, new: 1 }), false),
      0,
    );
  });

  it('still emits 1 for a failed local run', () => {
    assert.equal(
      deriveExitCode('local', totals({ failed: 1, changed: 2 }), false),
      1,
    );
  });

  it('returns 0 for a clean local run', () => {
    assert.equal(deriveExitCode('local', totals({ passed: 4 }), false), 0);
  });
});

describe('deriveExitCode: environment mismatch (3)', () => {
  it('returns 3 for a CI mismatch on an otherwise-clean run', () => {
    assert.equal(deriveExitCode('ci', totals({ passed: 3 }), true), 3);
  });

  it('lets failed (1) beat an environment mismatch (3)', () => {
    assert.equal(deriveExitCode('ci', totals({ failed: 1 }), true), 1);
  });

  it('lets a mismatch (3) beat pending changes (2)', () => {
    // A mismatch subsumes the new/changed churn it produces.
    assert.equal(
      deriveExitCode('ci', totals({ new: 5, changed: 2, deleted: 1 }), true),
      3,
    );
  });

  it('never emits 3 in local mode: local never reads the manifest', () => {
    assert.equal(deriveExitCode('local', totals({ passed: 2 }), true), 0);
    assert.equal(
      deriveExitCode('local', totals({ changed: 2, new: 1 }), true),
      0,
    );
  });

  it('still emits 1 for a failed local run even with mismatch flagged', () => {
    assert.equal(deriveExitCode('local', totals({ failed: 1 }), true), 1);
  });
});
