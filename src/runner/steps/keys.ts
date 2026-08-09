/**
 * Key-name handling for the `type` step. Playwright's key names stay the
 * source of truth; this layer only rewrites a fixed set of glyphs and
 * abbreviations story authors reach for by habit ("Cmd+K", "⌘+K", "Esc")
 * into the names Playwright understands, and re-labels its unknown-key
 * failure. Everything else passes through untouched, so keys Playwright
 * gains on upgrade need no change here.
 */

/**
 * Author-facing spellings mapped 1:1 onto Playwright key names. A Map, not
 * an object literal, so a step value like "constructor" cannot read an
 * inherited property and resolve to something that is not a key.
 */
const KEY_ALIASES = new Map<string, string>([
  ['Ctrl', 'Control'],
  ['Cmd', 'Meta'],
  ['⌘', 'Meta'],
  ['Opt', 'Alt'],
  ['⌥', 'Alt'],
  ['Esc', 'Escape'],
]);

const ALIAS_SUMMARY = [...KEY_ALIASES]
  .map(([alias, key]) => `${alias}→${key}`)
  .join(', ');

/**
 * Playwright's own wording, from `Keyboard.press` in playwright-core:
 * `Unknown key: "${keyString}"`. The quote and colon are part of the match
 * so an unrelated future error that merely mentions an unknown key is not
 * relabelled with an alias list, and the capture hands back the one token
 * Playwright rejected.
 */
const PLAYWRIGHT_UNKNOWN_KEY = /Unknown key: "([^"]*)"/;

/**
 * Playwright's own `+` split, mirrored from `Keyboard.press` in
 * playwright-core. A `+` separates tokens only when something precedes it,
 * which is what keeps a bare "+" a pressable key instead of two empty
 * tokens. Diverging here would invent a bug Playwright does not have.
 */
function splitCombo(value: string): string[] {
  const tokens: string[] = [];
  let building = '';
  for (const char of value) {
    if (char === '+' && building) {
      tokens.push(building);
      building = '';
    } else {
      building += char;
    }
  }
  tokens.push(building);
  return tokens;
}

/**
 * Resolves each token of a key or combo through the alias table. Matching
 * is exact-case, like Playwright's own key names: "Esc" resolves, "esc"
 * does not and fails at press time.
 */
export function normaliseKey(value: string): string {
  return splitCombo(value)
    .map((token) => KEY_ALIASES.get(token) ?? token)
    .join('+');
}

export class UnknownKeyError extends Error {
  override readonly cause?: unknown;
  constructor(key: string, value: string, cause?: unknown) {
    super(
      `Unknown key "${key}" in type step value "${value}". Key names are Playwright's and case-sensitive, so "Escape" resolves and "esc" does not.\nAliases: ${ALIAS_SUMMARY}`,
    );
    this.name = 'UnknownKeyError';
    this.cause = cause;
  }
}

/**
 * Playwright reports an unrecognized name as `Unknown key: "esc"`, which
 * says nothing about where it came from or what tuffgal accepts. Only that
 * failure is rewritten; timeouts, closed pages, and everything else pass
 * through so their own diagnostics survive. Every alias resolves to a name
 * Playwright knows, so the token it rejected is never one this layer
 * rewrote and always appears in the author's value verbatim.
 */
export function explainKeyPressFailure(value: string, cause: unknown): unknown {
  const rejected =
    cause instanceof Error
      ? PLAYWRIGHT_UNKNOWN_KEY.exec(cause.message)?.[1]
      : undefined;
  return rejected === undefined
    ? cause
    : new UnknownKeyError(rejected, value, cause);
}
