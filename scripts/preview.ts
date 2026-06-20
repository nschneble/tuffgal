/**
 * Renders a sample report so you can eyeball the HTML reporter without running
 * a real suite (which needs Playwright + a dev server). Builds a fixture
 * `RunResult` covering passed / changed / failed stories, writes it through the
 * real `writeReport`, and opens the result in your browser.
 *
 *   npm run preview
 *
 * Output goes to a throwaway temp dir; nothing in the repo is touched.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from '../src/schema/result.ts';
import { writeReport } from '../src/reporter/writeReport.ts';

// A 1×1 PNG so the screenshot panels resolve to a real image.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

function openInBrowser(target: string): void {
  // win32 `start` is a shell builtin (needs an empty-title first arg); darwin
  // and linux take the path as a normal argument, so no shell — keeps the path
  // un-concatenated and dodges the shell-injection DeprecationWarning.
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
  try {
    spawn(command as string, args as string[], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch {
    // Headless / no opener — the printed path is the fallback.
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tuffgal-preview-'));
  const shot = (name: string): string => {
    const path = join(dir, `${name}.png`);
    writeFileSync(path, PIXEL_PNG);
    return path;
  };

  const result: RunResult = {
    startedAt: '2026-06-19T13:58:17.000Z',
    finishedAt: '2026-06-19T13:58:52.490Z',
    durationMs: 35490,
    totals: { stories: 3, passed: 1, changed: 1, failed: 1 },
    customCoverage: {
      screens: { total: 12, covered: 9, ratio: 0.75, missing: [] },
      flows: { total: 5, covered: 3, ratio: 0.6, missing: [] },
    },
    stories: [
      {
        story: 'A visitor lands on the home page and sees the hero.',
        file: 'user-lands-home.json',
        status: 'pass',
        startedAt: '2026-06-19T13:58:17.000Z',
        finishedAt: '2026-06-19T13:58:25.200Z',
        durationMs: 8200,
        actions: [
          {
            action: 'navigate',
            parameters: { url: '/' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:17.000Z',
            finishedAt: '2026-06-19T13:58:18.200Z',
            durationMs: 1200,
          },
          {
            action: 'screenshot',
            status: 'pass',
            startedAt: '2026-06-19T13:58:18.200Z',
            finishedAt: '2026-06-19T13:58:18.900Z',
            durationMs: 700,
            baselinePath: shot('home-base'),
            actualPath: shot('home-actual'),
          },
        ],
      },
      {
        story: 'A user opens settings and the layout drifted.',
        file: 'user-opens-settings.json',
        status: 'changed',
        startedAt: '2026-06-19T13:58:25.200Z',
        finishedAt: '2026-06-19T13:58:40.000Z',
        durationMs: 14800,
        actions: [
          {
            action: 'navigate',
            parameters: { url: '/settings' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:25.200Z',
            finishedAt: '2026-06-19T13:58:26.300Z',
            durationMs: 1100,
          },
          {
            action: 'screenshot',
            status: 'changed',
            startedAt: '2026-06-19T13:58:26.300Z',
            finishedAt: '2026-06-19T13:58:27.200Z',
            durationMs: 900,
            baselinePath: shot('settings-base'),
            actualPath: shot('settings-actual'),
            diffPath: shot('settings-diff'),
            diffPixels: 4210,
            diffRatio: 0.0182,
          },
        ],
      },
      {
        story: 'Checkout flow throws on the buy button.',
        file: 'user-checks-out.json',
        status: 'failed',
        startedAt: '2026-06-19T13:58:40.000Z',
        finishedAt: '2026-06-19T13:58:52.490Z',
        durationMs: 12490,
        tracePath: join(dir, 'checkout-trace.zip'),
        actions: [
          {
            action: 'navigate',
            parameters: { url: '/cart' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:40.000Z',
            finishedAt: '2026-06-19T13:58:41.000Z',
            durationMs: 1000,
          },
          {
            action: 'click',
            parameters: { selector: 'button#buy' },
            status: 'failed',
            startedAt: '2026-06-19T13:58:41.000Z',
            finishedAt: '2026-06-19T13:58:46.000Z',
            durationMs: 5000,
            failureMessage:
              'TimeoutError: locator.click: Timeout 5000ms exceeded.\n  waiting for locator("button#buy")',
          },
        ],
      },
    ],
  };

  const htmlPath = await writeReport(dir, result);
  console.log(`Sample report written to ${htmlPath}`);
  openInBrowser(htmlPath);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
