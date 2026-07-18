import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page, Route } from 'playwright';

import { runIntercept } from './intercept.ts';

type RouteHandler = (route: Route) => Promise<void> | void;

/**
 * Captures the handler `runIntercept` registers with `page.route` so a test can
 * drive it directly with a fake `Route`, without a browser. Records the pattern
 * too, so the glob-forwarding can be asserted.
 */
function routeCapturingPage(): {
  page: Page;
  pattern: () => string | undefined;
  handler: () => RouteHandler;
} {
  let capturedPattern: string | undefined;
  let capturedHandler: RouteHandler | undefined;
  const page = {
    async route(pattern: string, handler: RouteHandler): Promise<void> {
      capturedPattern = pattern;
      capturedHandler = handler;
    },
  } as unknown as Page;
  return {
    page,
    pattern: () => capturedPattern,
    handler: () => {
      if (!capturedHandler) throw new Error('no route handler was registered');
      return capturedHandler;
    },
  };
}

/**
 * A fake `Route` reporting a fixed request method and recording which of the
 * two terminal calls the handler made — `fallback` (let the real network
 * proceed) or `fulfill` (synthesise a response) — with the exact fulfill
 * options so the content-type / body branches can be pinned.
 */
function fakeRoute(method: string): {
  route: Route;
  fallbackCount: () => number;
  fulfillOptions: () => Array<Record<string, unknown>>;
} {
  let fallbacks = 0;
  const fulfills: Array<Record<string, unknown>> = [];
  const route = {
    request() {
      return {
        method(): string {
          return method;
        },
      };
    },
    async fallback(): Promise<void> {
      fallbacks += 1;
    },
    async fulfill(options: Record<string, unknown>): Promise<void> {
      fulfills.push(options);
    },
  } as unknown as Route;
  return {
    route,
    fallbackCount: () => fallbacks,
    fulfillOptions: () => fulfills,
  };
}

describe('runIntercept — method filter', () => {
  it('falls back to the real network when the request method does not match the filter', async () => {
    const { page, handler } = routeCapturingPage();
    await runIntercept(page, '**/api/links', { status: 500 }, 'POST');

    // A GET arrives at a POST-scoped intercept → let it through untouched so a
    // sibling request on the same path is not clobbered.
    const { route, fallbackCount, fulfillOptions } = fakeRoute('GET');
    await handler()(route);

    assert.equal(fallbackCount(), 1);
    assert.equal(fulfillOptions().length, 0);
  });

  it('fulfills when the request method matches the filter', async () => {
    const { page, handler } = routeCapturingPage();
    await runIntercept(page, '**/api/links', { status: 500 }, 'POST');

    const { route, fallbackCount, fulfillOptions } = fakeRoute('POST');
    await handler()(route);

    // Method matched → the intercept owns the response; no fallback.
    assert.equal(fallbackCount(), 0);
    assert.equal(fulfillOptions().length, 1);
    assert.equal(fulfillOptions()[0]?.status, 500);
  });

  it('fulfills any method when no filter is supplied (the filter short-circuits)', async () => {
    const { page, handler } = routeCapturingPage();
    // No method arg — `method && ...` short-circuits, so every method fulfills.
    await runIntercept(page, '**/api/links', { status: 204 });

    const { route, fallbackCount, fulfillOptions } = fakeRoute('DELETE');
    await handler()(route);

    assert.equal(fallbackCount(), 0);
    assert.equal(fulfillOptions().length, 1);
  });
});

describe('runIntercept — body branches', () => {
  it('fulfills with status only and NO content-type when the body is undefined', async () => {
    const { page, handler } = routeCapturingPage();
    // Documented past bug: forcing application/json on an empty body made
    // consumers calling res.json() throw. An absent body must stay bare.
    await runIntercept(page, '**/api/ping', { status: 204 });

    const { route, fulfillOptions } = fakeRoute('GET');
    await handler()(route);

    const options = fulfillOptions()[0];
    assert.ok(options);
    assert.equal(options.status, 204);
    // Neither a content-type nor a body is declared for an empty response.
    assert.equal('contentType' in options, false);
    assert.equal('body' in options, false);
  });

  it('fulfills with a JSON content-type and a stringified body when a body is present', async () => {
    const { page, handler } = routeCapturingPage();
    await runIntercept(page, '**/api/links', {
      status: 200,
      body: { items: [1, 2], ok: true },
    });

    const { route, fulfillOptions } = fakeRoute('GET');
    await handler()(route);

    const options = fulfillOptions()[0];
    assert.ok(options);
    assert.equal(options.status, 200);
    assert.equal(options.contentType, 'application/json');
    assert.equal(options.body, JSON.stringify({ items: [1, 2], ok: true }));
  });

  it('forwards the glob pattern to page.route verbatim', async () => {
    const { page, pattern } = routeCapturingPage();
    await runIntercept(page, '**/api/links', { status: 200 });
    assert.equal(pattern(), '**/api/links');
  });
});
