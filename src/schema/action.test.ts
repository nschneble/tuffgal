import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stepSchema } from './action.ts';

function parseNavigate(path: string): ReturnType<typeof stepSchema.safeParse> {
  return stepSchema.safeParse({ kind: 'navigate', path });
}

describe('navigate path guard — rejects origin-escaping forms', () => {
  // Each of these resolves off-origin against a baseUrl (browsers normalise the
  // backslash variants to `//host`), so the schema must reject them before the
  // runner ever calls `page.goto`.
  const rejected: Array<[string, string]> = [
    ['protocol-relative //host', '//evil.com/x'],
    ['protocol-relative to a metadata IP', '//169.254.169.254/latest'],
    ['backslash variant /\\host', '/\\evil.com'],
    ['double-backslash \\\\host', '\\\\evil.com'],
    ['absolute http URL', 'http://evil.com'],
    ['absolute https URL', 'https://evil.com/x'],
    ['unrooted relative path', 'dashboard'],
  ];

  for (const [label, path] of rejected) {
    it(`rejects ${label}`, () => {
      assert.equal(parseNavigate(path).success, false);
    });
  }
});

describe('navigate path guard — accepts single-slash-rooted paths', () => {
  const accepted: Array<[string, string]> = [
    ['bare root', '/'],
    ['simple path', '/path'],
    ['nested path with query', '/a/b?q=1'],
    ['interpolation token path', '/u/${breakpoint}'],
  ];

  for (const [label, path] of accepted) {
    it(`accepts ${label}`, () => {
      assert.equal(parseNavigate(path).success, true);
    });
  }
});

describe('navigate waitUntil — enum opt-in unchanged by the default flip', () => {
  it('still accepts an explicit networkidle opt-in', () => {
    const result = stepSchema.safeParse({
      kind: 'navigate',
      path: '/',
      waitUntil: 'networkidle',
    });
    assert.equal(result.success, true);
  });

  it('accepts navigate with waitUntil omitted (runner supplies the load default)', () => {
    assert.equal(parseNavigate('/').success, true);
  });
});
