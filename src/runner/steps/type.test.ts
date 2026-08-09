import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';

import { unknownKeyFailure } from '../../../test/fixtures/playwrightFailures.ts';
import { UnknownKeyError } from './keys.ts';
import { runType } from './type.ts';

/** Records `keyboard.press` calls so a test can assert the key sent. */
function recordingPage(keys: string[]): Page {
  return {
    keyboard: {
      async press(key: string): Promise<void> {
        keys.push(key);
      },
    },
  } as unknown as Page;
}

/** A page whose keyboard throws, standing in for a Playwright failure. */
function failingPage(error: unknown): Page {
  return {
    keyboard: {
      async press(): Promise<void> {
        throw error;
      },
    },
  } as unknown as Page;
}

// keys.ts owns which spellings resolve to what; these cover only what
// `runType` itself decides.
describe('runType', () => {
  it('presses the resolved key, not the authored one', async () => {
    const keys: string[] = [];
    await runType(recordingPage(keys), 'Cmd+K');
    assert.deepEqual(keys, ['Meta+K']);
  });

  it('reports the value as authored, not as resolved', async () => {
    await assert.rejects(
      runType(failingPage(unknownKeyFailure('esc')), 'Cmd+esc'),
      (error: unknown) => {
        assert.ok(error instanceof UnknownKeyError);
        assert.match(error.message, /`type` step value "Cmd\+esc"/);
        assert.doesNotMatch(error.message, /Meta\+esc/);
        return true;
      },
    );
  });

  it('lets any other keyboard failure surface unchanged', async () => {
    const cause = new Error('keyboard.press: Target page closed');
    await assert.rejects(runType(failingPage(cause), 'Escape'), (error) => {
      assert.equal(error, cause);
      return true;
    });
  });
});
