import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normaliseStoryArg, storyMatchesFilter } from './storyFilter.ts';

describe('storyMatchesFilter', () => {
  const candidate = { file: 'user-logs-in.json', storyName: 'A user logs in' };

  it('matches the exact file name', () => {
    assert.equal(storyMatchesFilter(candidate, 'user-logs-in.json'), true);
  });

  it('matches the file name without the .json suffix', () => {
    assert.equal(storyMatchesFilter(candidate, 'user-logs-in'), true);
  });

  it('matches the prose title', () => {
    assert.equal(storyMatchesFilter(candidate, 'A user logs in'), true);
  });

  it('rejects an unrelated filter', () => {
    assert.equal(storyMatchesFilter(candidate, 'user-registers'), false);
  });
});

describe('normaliseStoryArg', () => {
  it('passes a bare name through (with or without .json)', () => {
    assert.equal(normaliseStoryArg('user-logs-in'), 'user-logs-in');
    assert.equal(normaliseStoryArg('user-logs-in.json'), 'user-logs-in.json');
  });

  it('reduces a path to its basename so it matches story.file', () => {
    assert.equal(
      normaliseStoryArg('tuffgal/stories/user-logs-in.json'),
      'user-logs-in.json',
    );
  });

  it('handles backslash paths', () => {
    assert.equal(
      normaliseStoryArg('tuffgal\\stories\\user-logs-in.json'),
      'user-logs-in.json',
    );
  });
});
