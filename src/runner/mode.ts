import type { ResolvedConfig } from '../config.ts';

/**
 * Which comparison contract a `tuffgal run` executes under. Foundation for the
 * CI-owned-baselines model: `ci` compares actuals against the committed
 * `paths.baselines` set (the source of truth, written only via approval flows),
 * while `local` compares against a per-machine gitignored cache for advisory
 * self-diffing. This wave only resolves + threads the mode; downstream branching
 * on it arrives in later waves.
 */
export type RunMode = 'ci' | 'local';

export interface RunModeInputs {
  /** `--ci` flag was passed. */
  ci: boolean;
  /** `--local` flag was passed. */
  local: boolean;
  /**
   * Environment to read the `CI` default from. Injected (rather than reading
   * `process.env` directly) so the resolution matrix is unit-testable without
   * mutating global process state.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * Strings a CI system might export to explicitly opt OUT of CI behaviour. Most
 * CI providers (GitHub Actions, Travis, CircleCI, GitLab, …) set `CI=true`, but
 * the de-facto convention — as codified by the widely-used `ci-info`/`is-ci`
 * packages — is that any non-empty `CI` value counts as "in CI" unless it is one
 * of these explicit negations. We mirror that so a developer who exports
 * `CI=false` locally still gets local mode.
 */
const FALSY_CI = new Set(['', '0', 'false']);

/**
 * Resolves the run mode from the two mutually-exclusive flags and the `CI`
 * environment variable:
 *   - `--ci` and `--local` are mutually exclusive; passing both throws.
 *   - An explicit flag always wins over the environment.
 *   - With no flag, default to `ci` when `CI` is truthy (non-empty and not an
 *     explicit negation — see {@link FALSY_CI}), else `local`.
 */
export function resolveRunMode(inputs: RunModeInputs): RunMode {
  if (inputs.ci && inputs.local) {
    throw new Error('Cannot pass both --ci and --local; choose one.');
  }
  if (inputs.ci) return 'ci';
  if (inputs.local) return 'local';
  const raw = inputs.env.CI;
  if (raw !== undefined && !FALSY_CI.has(raw.toLowerCase())) {
    return 'ci';
  }
  return 'local';
}

/**
 * The baseline root a run compares against for the given mode: the committed
 * `paths.baselines` set in CI mode, the per-machine gitignored `paths.localCache`
 * in local mode. This is the single source of the mode→root mapping — both the
 * per-action comparison in `runAction` and the screen-coverage metric in `run`
 * select their root through here, so the two can never drift. Encodes the PRD
 * invariant that a local run never reads `paths.baselines`.
 */
export function comparisonRootFor(
  config: ResolvedConfig,
  mode: RunMode,
): string {
  return mode === 'ci' ? config.paths.baselines : config.paths.localCache;
}
