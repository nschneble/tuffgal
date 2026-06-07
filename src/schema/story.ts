import { z } from 'zod';

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
