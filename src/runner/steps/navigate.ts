import type { Page } from 'playwright';
import type { ResolvedConfig } from '../../config.ts';

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export async function runNavigate(
  page: Page,
  path: string,
  config: ResolvedConfig,
  waitUntil?: WaitUntil,
): Promise<void> {
  const url = new URL(path, config.baseUrl).toString();
  await page.goto(url, {
    timeout: config.navigationTimeoutMs,
    waitUntil: waitUntil ?? 'networkidle',
  });
}
