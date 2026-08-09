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
  // Playwright's own names must survive untouched, including the ones the
  // aliases resolve to, so an author who already writes them sees no
  // change.
  const untouched = [
    'Escape',
    'Control+K',
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
  // position survives and the text after it is not a token of its own: the
  // last two cases are what a plain `value.split('+')` gets wrong.
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
  it("re-labels Playwright's unknown-key failure", () => {
    const cause = new Error('Unknown key: "esc"');
    const error = explainKeyPressFailure('esc', cause);
    assert.ok(error instanceof UnknownKeyError);
    assert.equal(error.cause, cause);
  });

  it('names the rejected token, the step, the value, and every alias', () => {
    const error = explainKeyPressFailure(
      'Cmd+esc',
      new Error('Unknown key: "esc"'),
    );
    assert.ok(error instanceof UnknownKeyError);
    const message = error.message;
    assert.match(message, /^Unknown key "esc" in type step value "Cmd\+esc"/);
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

  it('leaves any other failure untouched', () => {
    const cause = new Error('keyboard.press: Timeout 5000ms exceeded.');
    assert.equal(explainKeyPressFailure('Escape', cause), cause);
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
