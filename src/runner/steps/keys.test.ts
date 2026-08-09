import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { unknownKeyFailure } from '../../../test/fixtures/playwrightFailures.ts';
import {
  explainKeyPressFailure,
  normaliseKey,
  UnknownKeyError,
} from './keys.ts';

describe('normaliseKey: alias resolution', () => {
  const aliases: Array<[string, string]> = [
    ['Ctrl', 'Control'],
    ['Cmd', 'Meta'],
    ['⌘', 'Meta'],
    ['Opt', 'Alt'],
    ['⌥', 'Alt'],
    ['Esc', 'Escape'],
  ];

  for (const [alias, key] of aliases) {
    it(`resolves "${alias}" standalone to "${key}"`, () => {
      assert.equal(normaliseKey(alias), key);
    });
  }

  const combos: Array<[string, string]> = [
    ['Cmd+K', 'Meta+K'],
    ['Ctrl+Shift+P', 'Control+Shift+P'],
    ['⌘+K', 'Meta+K'],
    ['⌥+Tab', 'Alt+Tab'],
    ['Opt+Shift+Esc', 'Alt+Shift+Escape'],
    // Alias in both the modifier and the key position.
    ['Cmd+Esc', 'Meta+Escape'],
  ];

  for (const [value, expected] of combos) {
    it(`resolves the combo "${value}" to "${expected}"`, () => {
      assert.equal(normaliseKey(value), expected);
    });
  }
});

describe('normaliseKey: passthrough', () => {
  // Playwright's own names must survive untouched, so an author who
  // already writes them sees no change. The first row is every name an
  // alias resolves to, so a reversed entry in the table cannot pass.
  const untouched = [
    'Control+Meta+Alt+Escape',
    // The deliberate escape hatch for a per-platform modifier.
    'ControlOrMeta+K',
    // `^` is a pressable key, deliberately not aliased to a modifier.
    '^',
    // Exact-case matching: neither of these is an alias.
    'esc',
    'ctrl+Shift+P',
    // Inherited object properties are not aliases either.
    'constructor',
    '__proto__',
  ];

  for (const value of untouched) {
    it(`passes "${value}" through unchanged`, () => {
      assert.equal(normaliseKey(value), value);
    });
  }
});

describe('normaliseKey: literal punctuation keys', () => {
  // `+` is a pressable key. Playwright splits a combo only on a `+` that
  // follows something, and this mirrors that exactly, so a `+` in the key
  // position survives and the text after it is not a token of its own.
  // "+Esc" and "Ctrl++Esc" are what a plain `value.split('+')` gets
  // wrong: neither `Esc` is an alias, because neither is a token.
  const literals: Array<[string, string]> = [
    ['+', '+'],
    ['++', '++'],
    ['Control++', 'Control++'],
    ['Ctrl++', 'Control++'],
    ['a++b', 'a++b'],
    ['+Esc', '+Esc'],
    ['Ctrl++Esc', 'Control++Esc'],
  ];

  for (const [value, expected] of literals) {
    it(`resolves "${value}" to "${expected}"`, () => {
      assert.equal(normaliseKey(value), expected);
    });
  }
});

describe('explainKeyPressFailure', () => {
  it("relabels Playwright's unknown-key failure", () => {
    const cause = unknownKeyFailure('esc');
    const error = explainKeyPressFailure('esc', cause);
    assert.ok(error instanceof UnknownKeyError);
    assert.equal(error.cause, cause);
    // Failures are classified by `name` after they cross the async
    // boundary — `isRetryable` in runAction reads it, not the class — so
    // the identity has to ride on the instance.
    assert.equal(error.name, 'UnknownKeyError');
    // A single-key step is its own value, so the message says it once.
    assert.match(error.message, /^Unknown key "esc"\. /);
  });

  // The case-sensitivity rule is the actionable half of the message: it
  // is what turns "esc" into "Esc" without a trip to Playwright's docs.
  it('spells out that key names are case-sensitive', () => {
    const error = explainKeyPressFailure('esc', unknownKeyFailure('esc'));
    assert.ok(error instanceof UnknownKeyError);
    assert.ok(
      error.message.includes(
        `Key names are Playwright's and case-sensitive, so "Esc" resolves and "esc" does not.`,
      ),
      'expected the message to spell out the case-sensitivity rule',
    );
  });

  it('names the rejected token, the step, the value, and every alias', () => {
    const error = explainKeyPressFailure('Cmd+esc', unknownKeyFailure('esc'));
    assert.ok(error instanceof UnknownKeyError);
    const message = error.message;
    assert.match(
      message,
      /^Unknown key "esc" in the `type` step value "Cmd\+esc"/,
    );
    for (const alias of [
      'Ctrl→Control',
      'Cmd→Meta',
      '⌘→Meta',
      'Opt→Alt',
      '⌥→Alt',
      'Esc→Escape',
    ]) {
      assert.ok(
        message.includes(alias),
        `expected the message to list ${alias}`,
      );
    }
  });

  // A trailing `+` splits to an empty token, and Playwright rejects it by
  // that name — there is nothing to quote, so the message says the value
  // and stops.
  it('drops the name when the rejected token has none to give', () => {
    const error = explainKeyPressFailure('Control+', unknownKeyFailure(''));
    assert.ok(error instanceof UnknownKeyError);
    const message = error.message;
    assert.match(message, /^Unknown key in the `type` step value "Control\+"/);
  });

  // A step value that interpolates to the empty string presses an empty
  // key, so there is no name to give and the value repeats it. The step
  // is still what the author has to go and look at.
  it('names the step when the value itself is empty', () => {
    const error = explainKeyPressFailure('', unknownKeyFailure(''));
    assert.ok(error instanceof UnknownKeyError);
    assert.match(error.message, /^Unknown key in the `type` step value ""\./);
  });

  // A rejected token can carry a quote of its own at either end, and
  // Playwright quotes it as-is. The name has to be the whole token: half
  // of "a"" is `a`, a key that works, so naming it sends the author
  // after the wrong thing.
  const quoted: Array<[string, string]> = [
    ['Ctrl+a"', 'a"'],
    ['Ctrl+"x', '"x'],
  ];

  for (const [value, token] of quoted) {
    it(`names the whole rejected token of "${value}"`, () => {
      const error = explainKeyPressFailure(value, unknownKeyFailure(token));
      assert.ok(error instanceof UnknownKeyError);
      assert.ok(
        error.message.startsWith(
          `Unknown key "${token}" in the \`type\` step value "${value}".`,
        ),
        `expected the message to open by naming ${token}, got: ${error.message}`,
      );
    });
  }

  // The match is on Playwright's exact wording, so one of its future
  // errors that merely mentions an unknown key keeps its own diagnostics.
  it('leaves a differently worded unknown-key failure untouched', () => {
    const cause = new Error('Unknown key handling for this platform');
    assert.equal(explainKeyPressFailure('Escape', cause), cause);
  });

  it('leaves a non-Error rejection untouched', () => {
    assert.equal(explainKeyPressFailure('Escape', 'nope'), 'nope');
  });
});
