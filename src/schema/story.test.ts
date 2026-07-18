import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { storySchema } from './story.ts';

/**
 * A minimal valid story wrapped around `overrides`. `load.test.ts` proves the
 * fs-loading path (duplicate names, nested dirs, unknown breakpoint modes);
 * these are the cheaper pure-`safeParse` boundary asserts on the schema itself.
 */
function parseStory(
  overrides: Record<string, unknown>,
): ReturnType<typeof storySchema.safeParse> {
  return storySchema.safeParse({
    story: 'home renders',
    actions: [{ action: 'visit-home' }],
    ...overrides,
  });
}

describe('storySchema — breakpoints.min(1)', () => {
  it('accepts a single-entry breakpoints list', () => {
    assert.equal(parseStory({ breakpoints: ['mobile'] }).success, true);
  });

  it('rejects an empty breakpoints list (present-but-empty is a mistake)', () => {
    // The field is optional — omit it to inherit the project default. But an
    // explicit `[]` would run the story at zero breakpoints, so it is rejected
    // rather than silently rendering nothing.
    assert.equal(parseStory({ breakpoints: [] }).success, false);
  });

  it('still accepts a story that omits breakpoints entirely', () => {
    assert.equal(parseStory({}).success, true);
  });
});

describe('storySchema — required non-empty fields', () => {
  it('rejects an empty story title', () => {
    assert.equal(parseStory({ story: '' }).success, false);
  });

  it('rejects an empty actions list', () => {
    assert.equal(parseStory({ actions: [] }).success, false);
  });
});
