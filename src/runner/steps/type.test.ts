import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';

import { UnknownKeyError } from './keys.ts';
import { runType } from './type.ts';

/** Records every `keyboard.press` call so the test can assert the key sent. */
function recordingPage(keys: string[]): Page {
  return {
    keyboard: {
      async press(key: string): Promise<void> {
        keys.push(key);
      },
    },
  } as unknown as Page;
}

/** A page whose keyboard always fails, standing in for Playwright's throw. */
function failingPage(error: unknown): Page {
  return {
    keyboard: {
      async press(): Promise<void> {
        throw error;
      },
    },
  } as unknown as Page;
}

describe('runType: aliases reach the keyboard', () => {
  const cases: Array<[string, string]> = [
    ['Esc', 'Escape'],
    ['Cmd+K', 'Meta+K'],
    ['⌥+Tab', 'Alt+Tab'],
    // Untouched keys and literal punctuation arrive exactly as authored.
    ['Control+K', 'Control+K'],
    ['ControlOrMeta+K', 'ControlOrMeta+K'],
    ['+', '+'],
    ['^', '^'],
  ];

  for (const [value, pressed] of cases) {
    it(`presses "${pressed}" for the step value "${value}"`, async () => {
      const keys: string[] = [];
      await runType(recordingPage(keys), value);
      assert.deepEqual(keys, [pressed]);
    });
  }
});

describe('runType: unknown keys', () => {
  it('re-labels an unknown key with the step name and aliases', async () => {
    await assert.rejects(
      runType(failingPage(new Error('Unknown key: "esc"')), 'esc'),
      (error: unknown) => {
        assert.ok(error instanceof UnknownKeyError);
        assert.match(error.message, /`type` step value "esc"/);
        assert.match(error.message, /Esc→Escape/);
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
