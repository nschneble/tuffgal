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

export const stepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('navigate'),
    path: z.string().startsWith('/'),
    /**
     * Override Playwright's `page.goto` ready signal. Defaults to
     * `'networkidle'`, which suits production builds but can starve on
     * dev servers with long-tail external fetches (CDN font, gravatar,
     * placeholder images). Drop to `'domcontentloaded'` or `'load'` for
     * pages where the visual baseline is stable well before networkidle
     * settles. See Playwright docs for full semantics.
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
    amount: z.number().int().positive().optional(),
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
   * `waitFor`, does not poll — the element must already be present when
   * the step runs. Use as a mid-flow checkpoint after a click/input that
   * synchronously updates the DOM.
   */
  z.object({
    kind: z.literal('read'),
    hint: hintSchema,
  }),
  /**
   * Keyboard input directed at the page (not an input field). Passed
   * straight to Playwright's `keyboard.press`, so single keys ("A"),
   * named keys ("Escape", "Tab"), and combinations ("Shift+A",
   * "Control+Enter") all work. Use for hotkeys, modal dismissal, focus
   * cycling.
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
   * Bounded retry budget for individual steps. Wraps each step's dispatch so
   * a transient LocatorNotFoundError (UI not yet hydrated) does not fail the
   * action immediately. Steps that succeed on the first try cost no retry.
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
       * controls how the diff PNG is computed — it does not gate the
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
