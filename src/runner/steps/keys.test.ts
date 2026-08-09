import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
  // Playwright's real failure, prefixed with the call the way the client
  // sends it: `keyboard.press: Unknown key: "esc"`.
  function unknownKey(token: string): Error {
    return new Error(`keyboard.press: Unknown key: "${token}"`);
  }

  it("relabels Playwright's unknown-key failure", () => {
    const cause = unknownKey('esc');
    const error = explainKeyPressFailure('esc', cause);
    assert.ok(error instanceof UnknownKeyError);
    assert.equal(error.cause, cause);
    // A single-key step is its own value, so the message says it once.
    assert.match(error.message, /^Unknown key "esc"\. /);
  });

  it('names the rejected token, the step, the value, and every alias', () => {
    const error = explainKeyPressFailure('Cmd+esc', unknownKey('esc'));
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
  // that name. The capture is empty for a rejected token holding a quote
  // too, since the quote closes the capture early.
  it('drops the name when the rejected token has none to give', () => {
    const error = explainKeyPressFailure('Control+', unknownKey(''));
    assert.ok(error instanceof UnknownKeyError);
    const message = error.message;
    assert.match(message, /^Unknown key in the `type` step value "Control\+"/);
  });

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
