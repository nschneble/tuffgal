import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadActions, loadStories, LoadError } from './load.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tuffgal-load-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(relative: string, contents: string): Promise<void> {
  const path = join(dir, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

const validStory = JSON.stringify({
  story: 'home renders',
  actions: [{ action: 'visit-home' }],
});

const validAction = JSON.stringify({
  action: 'visit-home',
  steps: [{ kind: 'wait', ms: 0 }],
});

describe('loadStories', () => {
  it('throws LoadError with the file path on malformed JSON', async () => {
    await write('broken.json', '{ not valid json');
    await assert.rejects(
      loadStories(dir),
      (error: unknown) => {
        assert.ok(error instanceof LoadError);
        assert.match(error.path, /broken\.json$/);
        return true;
      },
    );
  });

  it('throws LoadError when a story fails schema validation', async () => {
    await write('empty.json', JSON.stringify({ story: 'x', actions: [] }));
    await assert.rejects(loadStories(dir), LoadError);
  });

  it('throws LoadError on a duplicate story basename across subdirectories', async () => {
    await write('home.json', validStory);
    await write('nested/home.json', validStory);
    await assert.rejects(
      loadStories(dir),
      (error: unknown) => {
        assert.ok(error instanceof LoadError);
        assert.match(error.reason, /duplicate story filename/);
        return true;
      },
    );
  });

  it('loads stories from nested subdirectories', async () => {
    await write('a.json', validStory);
    await write('nested/b.json', validStory);
    const stories = await loadStories(dir);
    const files = stories.map((entry) => entry.file).sort();
    assert.deepEqual(files, ['a.json', 'b.json']);
  });

  it('accepts breakpoint entries as bare names or override objects', async () => {
    await write(
      'bp.json',
      JSON.stringify({
        story: 'mixed breakpoints',
        actions: [{ action: 'visit-home' }],
        breakpoints: ['mobile', { name: 'desktop', width: 1440, height: 900 }],
      }),
    );
    const stories = await loadStories(dir);
    assert.deepEqual(stories[0]?.story.breakpoints, [
      'mobile',
      { name: 'desktop', width: 1440, height: 900 },
    ]);
  });

  it('rejects a story breakpoint override naming an unknown mode', async () => {
    await write(
      'bad.json',
      JSON.stringify({
        story: 'bad breakpoint',
        actions: [{ action: 'visit-home' }],
        breakpoints: [{ name: 'phablet', width: 600 }],
      }),
    );
    await assert.rejects(loadStories(dir), LoadError);
  });
});

describe('loadActions', () => {
  it('throws LoadError on a duplicate action name', async () => {
    await write('one.json', validAction);
    await write('two.json', validAction);
    await assert.rejects(
      loadActions(dir),
      (error: unknown) => {
        assert.ok(error instanceof LoadError);
        assert.match(error.reason, /duplicate action name/);
        return true;
      },
    );
  });

  it('returns a name-keyed map for valid actions', async () => {
    await write('visit.json', validAction);
    const actions = await loadActions(dir);
    assert.ok(actions.has('visit-home'));
    assert.equal(actions.get('visit-home')?.steps.length, 1);
  });
});
