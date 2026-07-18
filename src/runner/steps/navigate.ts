import type { Page } from 'playwright';
import type { Step } from '../../schema/action.ts';
import type { ResolvedConfig } from '../../config.ts';

type NavigateStep = Extract<Step, { kind: 'navigate' }>;

export async function runNavigate(
  page: Page,
  path: string,
  config: ResolvedConfig,
  waitUntil?: NavigateStep['waitUntil'],
): Promise<void> {
  const url = new URL(path, config.baseUrl);
  // Belt-and-suspenders against origin escape: even if the schema guard on
  // `path` ever regresses, a resolved URL that lands on another origin (e.g. a
  // protocol-relative `//evil.com` or a backslash variant browsers normalise
  // to one) must never drive the browser off the configured baseUrl and into a
  // screenshot of an off-origin response.
  const baseOrigin = new URL(config.baseUrl).origin;
  if (url.origin !== baseOrigin) {
    throw new Error(
      `navigate path "${path}" resolved off-origin to ${url.origin} (expected ${baseOrigin}); refusing to navigate off the configured baseUrl`,
    );
  }
  await page.goto(url.toString(), {
    timeout: config.navigationTimeoutMs,
    waitUntil: waitUntil ?? 'load',
  });
}
