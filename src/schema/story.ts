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

/**
 * One per-story breakpoint selection, identical to the config-level
 * {@link BreakpointSelector}: a bare registry name (render at that mode's
 * built-in dimensions) or `{ name, width?, height? }` to override them. An
 * omitted `width`/`height` inherits the REGISTRY default — a story's list
 * stands alone and never references the project's per-mode overrides.
 */
const breakpointSelectorSchema = z.union([
  z.enum(breakpointNames),
  z.object({
    name: z.enum(breakpointNames),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
]);

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
   * The breakpoints this story runs at, REPLACING the project's
   * `config.breakpoints` for this story only (not intersected with them). Each
   * entry is a bare registry name (`mobile` | `tablet` | `laptop` | `desktop`)
   * or `{ name, width?, height? }`. Use it for stories whose modes differ from
   * the project default — e.g. a project that defaults to `desktop`+`laptop`
   * while a mobile-only nav drawer runs just `mobile`, or a dense dashboard
   * that needs a wider desktop. A story may name a mode the project does not;
   * the list stands alone, resolved against the registry. Must be non-empty
   * when present; omit the field to run the project's `config.breakpoints`.
   */
  breakpoints: z.array(breakpointSelectorSchema).min(1).optional(),
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
