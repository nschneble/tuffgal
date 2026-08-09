import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  explainKeyPressFailure,
  normalizeKey,
  UnknownKeyError,
} from './keys.ts';

describe('normalizeKey: alias resolution', () => {
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
      assert.equal(normalizeKey(alias), key);
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
      assert.equal(normalizeKey(value), expected);
    });
  }
});

describe('normalizeKey: passthrough', () => {
  // Playwright's own names must survive untouched, including the ones the
  // aliases resolve to, so an author who already writes them sees no change.
  const untouched = [
    'Escape',
    'Control+K',
    'Shift+A',
    'A',
    'Tab',
    'Meta+K',
    'Alt+Tab',
    // The deliberate escape hatch for a per-platform modifier.
    'ControlOrMeta+K',
    // Exact-case matching: neither of these is an alias.
    'esc',
    'ESC',
    'cmd+k',
    'ctrl+Shift+P',
    // Inherited object properties are not aliases either.
    'constructor',
    'toString',
    '__proto__',
  ];

  for (const value of untouched) {
    it(`passes "${value}" through unchanged`, () => {
      assert.equal(normalizeKey(value), value);
    });
  }
});

describe('normalizeKey: literal punctuation keys', () => {
  // `+` and `^` are pressable keys. Playwright splits a combo only on a `+`
  // that follows something, and this mirrors that exactly, so these round-trip
  // instead of being mangled into empty tokens.
  const literals = ['+', '^', '++', 'Control++', 'Ctrl++', 'Shift+^', 'a++b'];

  for (const value of literals) {
    it(`round-trips "${value}"`, () => {
      const expected = value === 'Ctrl++' ? 'Control++' : value;
      assert.equal(normalizeKey(value), expected);
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

  it('names the step, the value, and every alias', () => {
    const error = explainKeyPressFailure(
      'Cmd+esc',
      new Error('Unknown key: "esc"'),
    );
    const message = (error as Error).message;
    assert.match(message, /`type` step/);
    assert.match(message, /"Cmd\+esc"/);
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
    assert.match(message, /ControlOrMeta/);
  });

  it('leaves any other failure untouched', () => {
    const cause = new Error('keyboard.press: Timeout 5000ms exceeded.');
    assert.equal(explainKeyPressFailure('Escape', cause), cause);
  });

  it('leaves a non-Error rejection untouched', () => {
    assert.equal(explainKeyPressFailure('Escape', 'nope'), 'nope');
  });
});
