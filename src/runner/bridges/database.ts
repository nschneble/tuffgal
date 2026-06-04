import type { ResolvedConfig } from '../../config.ts';

/**
 * Invokes the consumer-supplied database reset. Called once at the start of
 * a run, before any story dispatches. No-op when the consumer did not supply
 * a `database.reset` function (e.g., a static site with no backend).
 */
export async function resetDatabase(config: ResolvedConfig): Promise<void> {
  const reset = config.database?.reset;
  if (!reset) {
    return;
  }
  await reset();
}

/**
 * Looks up and invokes a named fixture. Called once per story per fixture
 * declaration, before the browser launches. Throws with a discoverable
 * error when the consumer's config does not register the named fixture so
 * a typo in a story file fails loudly.
 */
export async function applyFixture(
  config: ResolvedConfig,
  name: string,
): Promise<void> {
  const fixtures = config.database?.fixtures;
  if (!fixtures || !fixtures[name]) {
    const known = fixtures ? Object.keys(fixtures).join(', ') : '(none)';
    throw new Error(
      `Unknown fixture: "${name}". Known fixtures in tuffgal.config.ts: ${known}`,
    );
  }
  await fixtures[name]();
}
