import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';

import type { Hint } from '../schema/action.ts';
import { LocatorHintError, resolveLocator } from './resolveLocator.ts';

interface RoleCall {
  role: string;
  options: unknown;
}

/**
 * A stand-in for the three `Page` methods `resolveLocator` can reach. Each spy
 * records its arguments and returns a distinct sentinel string, so a test can
 * assert BOTH which method fired (by the returned sentinel) and that the other
 * two never ran (by their empty call logs). The precedence chain is the whole
 * contract here; a regression that silently resolves the wrong element would
 * still "work" against a single-method mock, so every test pins the losers to
 * zero calls too.
 */
function spyPage(): {
  page: Page;
  calls: {
    getByRole: RoleCall[];
    getByText: Array<{ text: string; options: unknown }>;
    locator: string[];
  };
} {
  const calls = {
    getByRole: [] as RoleCall[],
    getByText: [] as Array<{ text: string; options: unknown }>,
    locator: [] as string[],
  };
  const page = {
    getByRole(role: string, options?: unknown): string {
      calls.getByRole.push({ role, options });
      return 'role-locator';
    },
    getByText(text: string, options?: unknown): string {
      calls.getByText.push({ text, options });
      return 'text-locator';
    },
    locator(selector: string): string {
      calls.locator.push(selector);
      return 'selector-locator';
    },
  } as unknown as Page;
  return { page, calls };
}

describe('resolveLocator: precedence chain picks exactly one method', () => {
  it('role + text → getByRole(role, { name, exact: false }), nothing else', () => {
    const { page, calls } = spyPage();
    const hint: Hint = { role: 'button', text: 'Save' };

    const result = resolveLocator(page, hint) as unknown as string;

    assert.equal(result, 'role-locator');
    assert.equal(calls.getByRole.length, 1);
    assert.deepEqual(calls.getByRole[0], {
      role: 'button',
      options: { name: 'Save', exact: false },
    });
    // The strongest match won; the weaker two never ran.
    assert.equal(calls.getByText.length, 0);
    assert.equal(calls.locator.length, 0);
  });

  it('role alone → getByRole(role) with no name option', () => {
    const { page, calls } = spyPage();
    const hint: Hint = { role: 'navigation' };

    const result = resolveLocator(page, hint) as unknown as string;

    assert.equal(result, 'role-locator');
    assert.equal(calls.getByRole.length, 1);
    // Role-only must NOT pass a name filter; a spurious `{ name }` here would
    // over-constrain the match to elements carrying that accessible name.
    assert.deepEqual(calls.getByRole[0], {
      role: 'navigation',
      options: undefined,
    });
    assert.equal(calls.getByText.length, 0);
    assert.equal(calls.locator.length, 0);
  });

  it('selector alone → page.locator(selector)', () => {
    const { page, calls } = spyPage();
    const hint: Hint = { selector: '.toast' };

    const result = resolveLocator(page, hint) as unknown as string;

    assert.equal(result, 'selector-locator');
    assert.deepEqual(calls.locator, ['.toast']);
    assert.equal(calls.getByRole.length, 0);
    assert.equal(calls.getByText.length, 0);
  });

  it('text alone → getByText(text, { exact: false })', () => {
    const { page, calls } = spyPage();
    const hint: Hint = { text: 'Welcome back' };

    const result = resolveLocator(page, hint) as unknown as string;

    assert.equal(result, 'text-locator');
    assert.equal(calls.getByText.length, 1);
    assert.deepEqual(calls.getByText[0], {
      text: 'Welcome back',
      options: { exact: false },
    });
    assert.equal(calls.getByRole.length, 0);
    assert.equal(calls.locator.length, 0);
  });

  it('no role, selector, or text → throws LocatorHintError', () => {
    const { page, calls } = spyPage();

    assert.throws(
      () => resolveLocator(page, {}),
      (error: unknown) => {
        assert.ok(error instanceof LocatorHintError);
        assert.match(error.message, /no role, selector, or text/);
        return true;
      },
    );
    // Nothing was resolved; no method fired before the throw.
    assert.equal(calls.getByRole.length, 0);
    assert.equal(calls.getByText.length, 0);
    assert.equal(calls.locator.length, 0);
  });
});

describe('resolveLocator: earlier rungs win when several hint fields coexist', () => {
  it('role + text beats a co-present selector (role+text is the top rung)', () => {
    const { page, calls } = spyPage();
    const hint: Hint = { role: 'button', text: 'Save', selector: '.save-btn' };

    const result = resolveLocator(page, hint) as unknown as string;

    assert.equal(result, 'role-locator');
    assert.equal(calls.getByRole.length, 1);
    // The selector escape hatch is never consulted while a stronger ARIA
    // contract is available.
    assert.equal(calls.locator.length, 0);
  });

  it('role alone beats a co-present selector', () => {
    const { page, calls } = spyPage();
    const hint: Hint = { role: 'list', selector: '#items' };

    const result = resolveLocator(page, hint) as unknown as string;

    assert.equal(result, 'role-locator');
    assert.equal(calls.locator.length, 0);
  });

  it('selector beats a co-present text (selector outranks text-only)', () => {
    const { page, calls } = spyPage();
    const hint: Hint = { selector: '.cta', text: 'Buy now' };

    const result = resolveLocator(page, hint) as unknown as string;

    assert.equal(result, 'selector-locator');
    assert.deepEqual(calls.locator, ['.cta']);
    // Text is the noisiest last resort; never reached while a selector exists.
    assert.equal(calls.getByText.length, 0);
  });
});
