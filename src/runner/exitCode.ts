import type { RunMode } from './mode.ts';
import type { RunResult } from '../schema/result.ts';

/**
 * The process exit code the CLI reports for a completed run. A small, pure
 * derivation kept apart from the run driver so its precedence table is
 * unit-testable in isolation and so later waves can extend it (wave 6 adds
 * `3` for an environment-manifest mismatch) without touching the driver.
 *
 * Precedence, highest wins:
 *   - `1` — one or more stories failed (a step threw / the harness broke).
 *     Always outranks a pending-changes signal: a broken run's failure is the
 *     headline, not the visual diff it never got to compute cleanly.
 *   - `2` — CI mode only: pending baseline changes a human must approve —
 *     `new` or `changed` stories, or `deleted` (orphaned committed baselines an
 *     approve/prune should retire). This is the PR-gate signal — the run itself
 *     succeeded, but committed baselines don't yet reflect the current UI. A
 *     deleted-only run still gates: the baseline set has drifted from the story
 *     set even though nothing rendered differently.
 *   - `0` — clean: every story passed and no baselines were orphaned.
 *
 * Local mode never emits `2` this wave: local runs are advisory (they auto-write
 * their own comparison target), so `new`/`changed` there are informational, not
 * a gate. Wave 4 finalises the advisory-local semantics; until then local keeps
 * the pre-existing "fail only on failed" behaviour (`1` or `0`).
 */
export function deriveExitCode(
  mode: RunMode,
  totals: RunResult['totals'],
): 0 | 1 | 2 {
  if (totals.failed > 0) return 1;
  if (mode === 'ci' && totals.changed + totals.new + totals.deleted > 0) {
    return 2;
  }
  return 0;
}
