import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';

import type { ResolvedConfig } from '../../config.ts';
import { runNavigate } from './navigate.ts';

interface GotoCall {
  url: string;
  options: { timeout?: number; waitUntil?: string };
}

/** Records every `page.goto` call so the test can assert URL + options. */
function recordingPage(calls: GotoCall[]): Page {
  return {
    async goto(
      url: string,
      options: { timeout?: number; waitUntil?: string },
    ): Promise<null> {
      calls.push({ url, options });
      return null;
    },
  } as unknown as Page;
}

function config(): ResolvedConfig {
  return {
    baseUrl: 'http://localhost:3000',
    navigationTimeoutMs: 1000,
  } as unknown as ResolvedConfig;
}

describe('runNavigate: origin escape guard (runtime defense in depth)', () => {
  it('throws when the resolved URL lands on another origin', async () => {
    const calls: GotoCall[] = [];
    // Bypasses the schema (which also rejects this) to prove the runtime guard
    // stands on its own: `new URL('//evil.com', baseUrl)` resolves to
    // http://evil.com, a different origin than the configured baseUrl.
    await assert.rejects(
      runNavigate(recordingPage(calls), '//evil.com/x', config()),
      /resolved off-origin to http:\/\/evil\.com/,
    );
    // Crucially, the browser is never driven off-origin.
    assert.equal(calls.length, 0);
  });

  it('allows a same-origin root-relative path through to page.goto', async () => {
    const calls: GotoCall[] = [];
    await runNavigate(recordingPage(calls), '/a/b?q=1', config());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://localhost:3000/a/b?q=1');
  });

  // The schema also rejects these, but the runtime guard must stand on its own
  // as defense in depth: the WHATWG URL parser strips tab/newline/carriage
  // return BEFORE resolving, so each control char after the leading slash
  // resolves to a protocol-relative `//evil.com` off the configured baseUrl.
  // (`\t`, `\n`, `\r` are escape sequences; no raw control bytes in source.)
  const controlCharVectors: Array<[string, string]> = [
    ['tab', '/\t//evil.com'],
    ['newline', '/\n//evil.com'],
    ['carriage return', '/\r//evil.com'],
    ['tab before a backslash host', '/\t\\evil.com'],
  ];

  for (const [label, path] of controlCharVectors) {
    it(`throws on a ${label}-smuggled protocol-relative host and never navigates`, async () => {
      const calls: GotoCall[] = [];
      await assert.rejects(
        runNavigate(recordingPage(calls), path, config()),
        /resolved off-origin to http:\/\/evil\.com/,
      );
      assert.equal(calls.length, 0);
    });
  }
});

describe('runNavigate: waitUntil default flip', () => {
  it("defaults waitUntil to 'load' when the step omits it", async () => {
    const calls: GotoCall[] = [];
    await runNavigate(recordingPage(calls), '/', config());
    assert.equal(calls[0]?.options.waitUntil, 'load');
  });

  it('passes an explicit waitUntil straight through (opt-in preserved)', async () => {
    const calls: GotoCall[] = [];
    await runNavigate(recordingPage(calls), '/', config(), 'networkidle');
    assert.equal(calls[0]?.options.waitUntil, 'networkidle');
  });

  it('forwards the configured navigation timeout', async () => {
    const calls: GotoCall[] = [];
    await runNavigate(recordingPage(calls), '/', config());
    assert.equal(calls[0]?.options.timeout, 1000);
  });
});
