import type { Page } from 'playwright';
import type { ResolvedConfig } from '../../config.ts';

export async function runNavigate(
  page: Page,
  path: string,
  config: ResolvedConfig,
): Promise<void> {
  const url = new URL(path, config.baseUrl).toString();
  await page.goto(url, {
    timeout: config.navigationTimeoutMs,
    waitUntil: 'networkidle',
  });
}
