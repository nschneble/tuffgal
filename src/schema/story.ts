import { z } from 'zod';
import { BREAKPOINTS } from '../config.ts';

/**
 * The set of valid per-story breakpoint names, derived from the single
 * {@link BREAKPOINTS} registry so the schema cannot drift from the modes the
 * runner actually knows how to render. `Object.keys` loses the literal-union
 * type, so we assert it back to a non-empty tuple of {@link BreakpointName}s —
 * `z.enum` needs a literal tuple to produce a typed enum, and the registry is
 * a non-empty `const` object so the cast is sound.
 */
const breakpointNames = Object.keys(BREAKPOINTS) as [
  keyof typeof BREAKPOINTS,
  ...(keyof typeof BREAKPOINTS)[],
];

export const storyStepSchema = z.object({
  action: z.string().min(1),
  parameters: z.record(z.string(), z.string()).optional(),
});

export type StoryStep = z.infer<typeof storyStepSchema>;

/**
 * Stories declare prerequisite **labels** through `needs` and emit
 * **labels** through `produces`. The harness uses these to build a
 * dependency DAG, validate uniqueness, detect cycles, and inherit storage
 * state from a producer onto its consumers. A produced label's storage
 * state lives at `.auth/<label>.json` and is loaded as the initial state
 * for every consumer.
 *
 * `storageState: "logged-in"` is retained as syntactic sugar — equivalent
 * to `needs: ["logged-in"]`. New stories should prefer the explicit form.
 */
export const storySchema = z.object({
  story: z.string().min(1),
  storageState: z.enum(['fresh', 'logged-in']).optional(),
  needs: z.array(z.string().min(1)).optional(),
  produces: z.array(z.string().min(1)).optional(),
  /**
   * Named fixtures (declared on the consumer's `tuffgal.config.ts` under
   * `database.fixtures`) applied to the test database BEFORE the story's
   * browser context launches. Useful for stories that need preloaded
   * state — e.g. a "mark all as read" flow needs links to exist first.
   * Fixtures apply sequentially in declaration order. Note that the test
   * DB is shared across parallel stories, so two stories applying
   * conflicting fixtures should be serialised via `needs`/`produces`
   * labels.
   */
  fixtures: z.array(z.string().min(1)).optional(),
  /**
   * Tag declaring which user-journey row in the configured
   * `flowInventory` markdown table this story covers. Used to compute
   * flow-coverage in the report. Match is case- and
   * whitespace-insensitive.
   */
  flow: z.string().min(1).optional(),
  /**
   * Override the config-level `viewport` for this story's browser
   * context. Width and height must be positive integers. Stories without
   * an override inherit the resolved config default. The override does
   * not cascade onto consumer stories that inherit storage state via
   * `needs`/`produces` — each story resolves its own viewport.
   */
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  /**
   * Restrict this story to a SUBSET of the project's configured breakpoints,
   * drawn from the built-in registry (`mobile` | `tablet` | `laptop` |
   * `desktop`). Use it for stories that only make sense at certain widths —
   * e.g. a mobile-only nav drawer that has no desktop counterpart, or a
   * dense dashboard that should only be screenshotted on wide modes.
   *
   * The story runs at the INTERSECTION of these names with the project's
   * `config.breakpoints`, in config order: a story cannot force a mode the
   * project opted out of (an unconfigured name is simply skipped). If the
   * intersection is empty — the story named only breakpoints the project
   * does not run — the story falls back to the full configured set rather
   * than being silently dropped (see `resolveRunSet`). Omit the field to run
   * every configured breakpoint.
   *
   * Mutually exclusive in spirit with the per-story `viewport` override:
   * `viewport` pins one exact pixel size and opts the story OUT of the
   * breakpoint matrix entirely, so when both are set `viewport` wins and
   * `breakpoints` is ignored.
   */
  breakpoints: z.array(z.enum(breakpointNames)).optional(),
  actions: z.array(storyStepSchema).min(1),
});

export type Story = z.infer<typeof storySchema>;

/**
 * Normalises `storageState` into the canonical `needs` array so the
 * scheduler only has one input format to reason about.
 */
export function normalisedNeeds(story: Story): string[] {
  const explicit = story.needs ?? [];
  if (story.storageState === 'logged-in' && !explicit.includes('logged-in')) {
    return [...explicit, 'logged-in'];
  }
  return explicit;
}
