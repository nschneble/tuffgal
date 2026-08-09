import { z } from 'zod';

/**
 * Locator hint. The runner uses these to resolve a Playwright `Locator`. The
 * MVP resolver tries role + name, then accessible text, then an explicit
 * selector. `position` is reserved for an AI fallback that picks the right
 * candidate when more than one element matches.
 */
export const hintSchema = z.object({
  text: z.string().min(1).optional(),
  role: z
    .enum([
      'alert',
      'banner',
      'button',
      'checkbox',
      'combobox',
      'dialog',
      'form',
      'heading',
      'link',
      'list',
      'listitem',
      'main',
      'menu',
      'menuitem',
      'navigation',
      'option',
      'progressbar',
      'radio',
      'region',
      'row',
      'searchbox',
      'status',
      'switch',
      'tab',
      'table',
      'textbox',
    ])
    .optional(),
  selector: z.string().min(1).optional(),
  position: z.enum(['header', 'main', 'footer', 'modal']).optional(),
});

export type Hint = z.infer<typeof hintSchema>;

/**
 * True when `path` contains an ASCII control character (C0 range U+0000–U+001F
 * or DEL U+007F). The WHATWG URL parser strips tab (U+0009), newline (U+000A),
 * and carriage return (U+000D) from a URL BEFORE resolving it, so any of those
 * placed after the leading slash (e.g. `/<TAB>//host`) would slip past the
 * two-char slash-rooted regex and still resolve to a protocol-relative `//host`.
 * Rejecting the whole control range (not just the stripped trio) is the
 * conservative guard: no legitimate root-relative path carries a raw control
 * character. Expressed as a code-point scan rather than a control-character
 * regex literal so the source stays free of embedded control bytes.
 */
function containsControlChar(path: string): boolean {
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const stepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('navigate'),
    /**
     * Root-relative path, navigated against `config.baseUrl`. Must be a single
     * slash-rooted `/path`: protocol-relative (`//host`), backslash (`/\host`,
     * which browsers normalise to `//host`), and absolute-URL forms are
     * rejected so a story can never drive the browser off the target origin.
     * Control characters are rejected too, because the WHATWG URL parser strips
     * ASCII tab (U+0009), newline (U+000A), and carriage return (U+000D) BEFORE
     * it resolves the path: a tab (or newline/CR) after the leading slash (e.g.
     * `/<TAB>//host`) would otherwise slip past the two-char slash-rooted check
     * and resolve to a protocol-relative `//host`. The runner re-asserts the
     * resolved origin as defense in depth.
     */
    path: z
      .string()
      .regex(
        /^\/(?![/\\])/,
        'navigate path must be a slash-rooted "/path"; protocol-relative ("//host"), backslash ("/\\host"), and absolute-URL forms are rejected',
      )
      .refine((value) => !containsControlChar(value), {
        message:
          'navigate path must not contain control characters; the URL parser strips tab, newline, and carriage return before resolving, so a control char could smuggle a protocol-relative "//host" past the slash-rooted check',
      }),
    /**
     * Override Playwright's `page.goto` ready signal. Defaults to `'load'`.
     * `'networkidle'` remains available as an explicit opt-in but is a poor
     * default: on apps with long-lived sockets or polling it never settles, so
     * every navigation stalls to the full navigation timeout. Opt into
     * `'networkidle'` only for pages you know go quiet; use `'commit'` or
     * `'domcontentloaded'` for earlier ready signals. See Playwright docs for
     * full semantics.
     */
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
      .optional(),
  }),
  z.object({
    kind: z.literal('click'),
    hint: hintSchema,
  }),
  z.object({
    kind: z.literal('input'),
    hint: hintSchema,
    value: z.string(),
  }),
  z.object({
    kind: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    /**
     * Wheel distance in pixels. Defaults to 600 (roughly a viewport's worth
     * of scroll) so a story can request "scroll down" without picking a number.
     * The default is applied here (declaratively, like the other step defaults)
     * so the handler receives a concrete value.
     */
    amount: z.number().int().positive().default(600),
  }),
  z.object({
    kind: z.literal('intercept'),
    pattern: z.string().min(1),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    respond: z.object({
      status: z.number().int().min(100).max(599),
      body: z.unknown().optional(),
    }),
  }),
  z.object({
    kind: z.literal('waitFor'),
    hint: hintSchema,
  }),
  /**
   * Instant assertion that a hint resolves to an attached element. Unlike
   * `waitFor`, does not poll. The element must already be present when
   * the step runs. Use as a mid-flow checkpoint after a click/input that
   * synchronously updates the DOM.
   */
  z.object({
    kind: z.literal('read'),
    hint: hintSchema,
  }),
  /**
   * Keyboard input directed at the page (not an input field). Resolves a
   * fixed set of glyphs and abbreviations ("Cmd", "⌘", "Esc") first, then
   * hands the key to Playwright's `keyboard.press`, so single keys ("A"),
   * named keys ("Escape", "Tab"), and combinations ("Shift+A",
   * "Control+Enter") all work. Names are validated at press time, not by
   * this schema, so Playwright stays the one list of keys. Use for
   * hotkeys, modal dismissal, focus cycling. See runner/steps/keys.ts for
   * the alias table.
   */
  z.object({
    kind: z.literal('type'),
    value: z.string().min(1),
  }),
  /**
   * Pauses the action for the given number of milliseconds. Use to absorb
   * staggered enter animations or React-lazy chunk loads that happen after
   * `expect.anyOf` resolves but before paint settles. Staggered enter
   * animations and lazy-loaded chunks are the recurring offenders.
   * Bounded at 5 seconds to discourage hiding genuine flakes.
   */
  z.object({
    kind: z.literal('wait'),
    ms: z.number().int().min(0).max(5000),
  }),
]);

export type Step = z.infer<typeof stepSchema>;

export const actionSchema = z.object({
  action: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'action names must be lowercase-kebab'),
  parameters: z.array(z.string().min(1)).optional(),
  steps: z.array(stepSchema).min(1),
  screenshot: z.boolean().default(true),
  /**
   * Hints whose matching elements are blacked out before the screenshot is
   * captured. Use sparingly to neutralise non-deterministic content (relative
   * timestamps, randomised suggestions, animated counters) so the diff layer
   * only flags meaningful changes.
   */
  mask: z.array(hintSchema).optional(),
  /**
   * Success criteria the harness polls before capturing the screenshot. The
   * action is only "done" once at least one of the listed hints is visible.
   * Eliminates the entire class of "screenshot snapped mid-render" flakes.
   */
  expect: z
    .object({
      anyOf: z.array(hintSchema).min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Bounded retry budget for individual steps. Wraps each step's dispatch so a
   * transient fault does not fail the action immediately: a LocatorNotFoundError
   * (target not yet hydrated) or any bounded Playwright TimeoutError: a
   * navigation that missed its ready signal, or a step-level click/input/waitFor
   * whose own timeout elapsed. Steps that succeed on the first try cost no retry.
   */
  retry: z
    .object({
      attempts: z.number().int().min(1).max(5).default(2),
      backoffMs: z.number().int().min(0).default(200),
    })
    .optional(),
  diff: z
    .object({
      /**
       * Pixelmatch per-pixel similarity. Tighter values flag more pixels
       * as changed; loosens anti-aliasing tolerance as it grows. Only
       * controls how the diff PNG is computed. It does not gate the
       * action's pass/changed status.
       */
      pixelThreshold: z.number().min(0).max(1).default(0.1),
      /**
       * Mean SSIM score threshold. Action passes when the score is at
       * least this high. 1.0 = identical; 0.99 = the default and roughly
       * corresponds to "no perceptible change."
       */
      ssimThreshold: z.number().min(0).max(1).default(0.99),
    })
    .optional(),
});

export type Action = z.infer<typeof actionSchema>;
