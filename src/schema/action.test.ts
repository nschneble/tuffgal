import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { actionSchema, hintSchema, stepSchema } from './action.ts';

function parseNavigate(path: string): ReturnType<typeof stepSchema.safeParse> {
  return stepSchema.safeParse({ kind: 'navigate', path });
}

function parseScroll(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof stepSchema.safeParse> {
  return stepSchema.safeParse({
    kind: 'scroll',
    direction: 'down',
    ...overrides,
  });
}

/**
 * A minimal valid action wrapped around `overrides`, so a single-constraint
 * boundary assert (retry, diff, name) reads as one line without re-inlining the
 * required `action`/`steps` scaffolding each time.
 */
function parseAction(
  overrides: Record<string, unknown>,
): ReturnType<typeof actionSchema.safeParse> {
  return actionSchema.safeParse({
    action: 'open',
    steps: [{ kind: 'wait', ms: 0 }],
    ...overrides,
  });
}

describe('navigate path guard: rejects origin-escaping forms', () => {
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

describe('navigate path guard: rejects control chars the URL parser strips', () => {
  // The WHATWG URL parser removes ASCII tab (U+0009), newline (U+000A), and
  // carriage return (U+000D) BEFORE resolving a URL, so each of these; a
  // control char right after the leading slash; resolves to a protocol-relative
  // `//evil.com` despite passing the two-char slash-rooted regex. The schema
  // must reject them at parse time. (`\t`, `\n`, `\r` here are the escape
  // sequences, so the source itself carries no raw control bytes.)
  const rejected: Array<[string, string]> = [
    ['tab before protocol-relative host', '/\t//evil.com'],
    ['newline before protocol-relative host', '/\n//evil.com'],
    ['carriage return before protocol-relative host', '/\r//evil.com'],
    ['tab before backslash host', '/\t\\evil.com'],
    // DEL (U+007F) exercises the SECOND arm of the code-point scan
    // (`code === 0x7f`), distinct from the `<= 0x1f` C0 arm the tab/LF/CR
    // vectors above hit. It passes the slash-rooted regex (DEL is neither `/`
    // nor `\`), so the control-char refine is the sole rejecter here.
    ['DEL (U+007F) after the leading slash', '/\x7fpath'],
  ];

  for (const [label, path] of rejected) {
    it(`rejects ${label}`, () => {
      assert.equal(parseNavigate(path).success, false);
    });
  }
});

describe('wait.ms bound: 0 to 5000 inclusive', () => {
  const cases: Array<[string, number, boolean]> = [
    ['accepts the lower bound 0', 0, true],
    ['accepts the upper bound 5000', 5000, true],
    ['rejects 5001 (just over the ceiling)', 5001, false],
    ['rejects a negative delay', -1, false],
  ];
  for (const [label, ms, ok] of cases) {
    it(label, () => {
      assert.equal(stepSchema.safeParse({ kind: 'wait', ms }).success, ok);
    });
  }
  it('rejects a fractional millisecond (int only)', () => {
    assert.equal(
      stepSchema.safeParse({ kind: 'wait', ms: 12.5 }).success,
      false,
    );
  });
});

describe('intercept.respond.status bound: 100 to 599 inclusive', () => {
  function parseStatus(status: number): boolean {
    return stepSchema.safeParse({
      kind: 'intercept',
      pattern: '**/api',
      respond: { status },
    }).success;
  }
  const cases: Array<[string, number, boolean]> = [
    ['accepts the lower bound 100', 100, true],
    ['accepts the upper bound 599', 599, true],
    ['rejects 99 (below the informational floor)', 99, false],
    ['rejects 600 (above the 5xx ceiling)', 600, false],
  ];
  for (const [label, status, ok] of cases) {
    it(label, () => {
      assert.equal(parseStatus(status), ok);
    });
  }
});

describe('action name: lowercase-kebab regex', () => {
  const cases: Array<[string, string, boolean]> = [
    ['accepts a kebab name', 'visit-home', true],
    ['accepts digits', 'step-2', true],
    ['rejects an uppercase letter', 'Visit', false],
    ['rejects a space', 'visit home', false],
    ['rejects an underscore', 'visit_home', false],
  ];
  for (const [label, name, ok] of cases) {
    it(label, () => {
      assert.equal(parseAction({ action: name }).success, ok);
    });
  }
});

describe('retry.attempts bound: 1 to 5 inclusive', () => {
  const cases: Array<[string, number, boolean]> = [
    ['accepts the lower bound 1', 1, true],
    ['accepts the upper bound 5', 5, true],
    ['rejects 0 (no attempt makes no sense)', 0, false],
    ['rejects 6 (over the retry ceiling)', 6, false],
  ];
  for (const [label, attempts, ok] of cases) {
    it(label, () => {
      assert.equal(parseAction({ retry: { attempts } }).success, ok);
    });
  }
});

describe('diff thresholds: pixelThreshold / ssimThreshold in 0 to 1', () => {
  for (const key of ['pixelThreshold', 'ssimThreshold'] as const) {
    const cases: Array<[string, number, boolean]> = [
      ['accepts 0', 0, true],
      ['accepts 1', 1, true],
      ['rejects just below 0', -0.01, false],
      ['rejects just above 1', 1.01, false],
    ];
    for (const [label, value, ok] of cases) {
      it(`${key} ${label}`, () => {
        assert.equal(parseAction({ diff: { [key]: value } }).success, ok);
      });
    }
  }
});

describe('hint role: enum membership', () => {
  it('accepts a member of the role enum', () => {
    assert.equal(hintSchema.safeParse({ role: 'button' }).success, true);
  });
  it('rejects a role outside the enum', () => {
    // `nav` is not a member; the enum spells it `navigation`.
    assert.equal(hintSchema.safeParse({ role: 'nav' }).success, false);
  });
  it('rejects an empty text hint (min 1)', () => {
    assert.equal(hintSchema.safeParse({ text: '' }).success, false);
  });
});

describe('navigate path guard: accepts single-slash-rooted paths', () => {
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

describe('navigate waitUntil: enum opt-in unchanged by the default flip', () => {
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

describe('scroll amount: schema default is load-bearing', () => {
  // Wave 12 moved the 600px default from the handler into the schema and retyped
  // `runScroll`'s param to a required `number`, so this `.default(600)` is the
  // only thing standing between an omitted `amount` and a `page.mouse.wheel(0,
  // NaN)`. Pin both directions: omitted resolves to 600, explicit survives.
  it('applies the 600px default when amount is omitted', () => {
    const result = parseScroll();
    assert.ok(result.success);
    assert.equal(result.data.kind, 'scroll');
    assert.equal(
      result.data.kind === 'scroll' ? result.data.amount : undefined,
      600,
    );
  });

  it('preserves an explicit amount instead of overwriting it with the default', () => {
    const result = parseScroll({ amount: 250 });
    assert.ok(result.success);
    assert.equal(
      result.data.kind === 'scroll' ? result.data.amount : undefined,
      250,
    );
  });
});
