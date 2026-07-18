import type { RunMode } from './mode.ts';
import type { RunResult } from '../schema/result.ts';

/**
 * The process exit code the CLI reports for a completed run. A small, pure
 * derivation kept apart from the run driver so its precedence table is
 * unit-testable in isolation.
 *
 * Precedence, highest wins:
 *   - `1`: one or more stories failed (a step threw / the harness broke).
 *     Always outranks every other signal: a broken run's failure is the
 *     headline, not the visual diff it never got to compute cleanly.
 *   - `3`: CI mode only: the committed environment manifest is present but its
 *     pixel-affecting keys diverge from this run's capture environment (a
 *     platform/browser/capture-mode/… drift). The comparison still ran (this
 *     is not an abort) but the diffs are computed against baselines rendered in
 *     a different environment, so the signal is "expect a full re-approve",
 *     distinct from ordinary pending changes. Outranks `2`: an environment
 *     mismatch subsumes and explains the `new`/`changed` churn it produces.
 *   - `2`: CI mode only: pending baseline changes a human must approve,
 *     `new` or `changed` stories, or `deleted` (orphaned committed baselines an
 *     approve/prune should retire). This is the PR-gate signal. The run itself
 *     succeeded, but committed baselines don't yet reflect the current UI. A
 *     deleted-only run still gates: the baseline set has drifted from the story
 *     set even though nothing rendered differently.
 *   - `0`: clean: every story passed, the environment matched (or no manifest
 *     to check), and no baselines were orphaned.
 *
 * Local mode never emits `2` or `3`: local runs are advisory and never read
 * `paths.baselines` at all (no committed manifest to check, no committed set to
 * gate against), so `new`/`changed`/`deleted`/mismatch there are informational.
 * It keeps the "fail only on failed" behaviour (`1` or `0`).
 */
export function deriveExitCode(
  mode: RunMode,
  totals: RunResult['totals'],
  mismatch: boolean,
): 0 | 1 | 2 | 3 {
  if (totals.failed > 0) return 1;
  if (mode === 'ci' && mismatch) return 3;
  if (mode === 'ci' && totals.changed + totals.new + totals.deleted > 0) {
    return 2;
  }
  return 0;
}
