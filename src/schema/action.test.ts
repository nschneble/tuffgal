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

describe('navigate path guard — rejects control chars the URL parser strips', () => {
  // The WHATWG URL parser removes ASCII tab (U+0009), newline (U+000A), and
  // carriage return (U+000D) BEFORE resolving a URL, so each of these — a
  // control char right after the leading slash — resolves to a protocol-relative
  // `//evil.com` despite passing the two-char slash-rooted regex. The schema
  // must reject them at parse time. (`\t`, `\n`, `\r` here are the escape
  // sequences, so the source itself carries no raw control bytes.)
  const rejected: Array<[string, string]> = [
    ['tab before protocol-relative host', '/\t//evil.com'],
    ['newline before protocol-relative host', '/\n//evil.com'],
    ['carriage return before protocol-relative host', '/\r//evil.com'],
    ['tab before backslash host', '/\t\\evil.com'],
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
