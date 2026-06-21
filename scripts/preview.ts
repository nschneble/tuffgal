/**
 * Renders a sample report so you can eyeball the HTML reporter without running
 * a real suite (which needs Playwright + a dev server). Builds a fixture
 * `RunResult` covering passed / changed / failed stories — each run at both the
 * `mobile` and `desktop` breakpoints so the reporter's multi-mode chrome is
 * exercised, and the screenshot panels are mock pages (title, divider, lorem
 * lines) painted at each breakpoint's real dimensions so mobile renders as a
 * believable narrow page — with the changed story's "actual" nudged a few
 * pixels so it reads as drifted — writes it through the real `writeReport`, and
 * opens the result in your browser.
 *
 *   npm run preview
 *
 * Output goes to a throwaway temp dir; nothing in the repo is touched.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { RunResult } from '../src/schema/result.ts';
import { writeReport } from '../src/reporter/writeReport.ts';

type Rgba = readonly [number, number, number, number];

// Fills an axis-aligned rect into a pngjs buffer, clipped to the image bounds so
// a shifted element near an edge can't write out of range.
function rect(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  [r, g, b, a]: Rgba,
): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(png.width, Math.round(x + w));
  const y1 = Math.min(png.height, Math.round(y + h));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const offset = (py * png.width + px) * 4;
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = a;
    }
  }
}

// Paints a mock page — title bar, divider, and a few lorem paragraph lines — at
// the real breakpoint dimensions. Everything is laid out as fractions of the
// canvas, so the mobile shot reads as a believable narrow page rather than a
// featureless rectangle. `shift` nudges the whole layout down-and-right so the
// "actual" capture registers as changed against an un-shifted baseline; `diff`
// re-skins it as pixelmatch-style magenta-on-dark to stand in for a diff image.
function mockPage(
  width: number,
  height: number,
  { shift = 0, diff = false }: { shift?: number; diff?: boolean } = {},
): Buffer {
  const png = new PNG({ width, height });
  const bg: Rgba = diff ? [26, 28, 32, 255] : [250, 250, 251, 255];
  rect(png, 0, 0, width, height, bg);

  const margin = Math.round(width * 0.07);
  const contentW = width - margin * 2;
  const x = margin + shift;
  const title: Rgba = diff ? [233, 30, 99, 255] : [34, 38, 46, 255];
  const divider: Rgba = diff ? [233, 30, 99, 255] : [206, 210, 218, 255];
  const text: Rgba = diff ? [233, 30, 99, 255] : [148, 154, 165, 255];

  let y = Math.round(height * 0.08) + shift;
  rect(png, x, y, Math.round(contentW * 0.58), Math.round(height * 0.035), title);
  y += Math.round(height * 0.06);
  rect(png, x, y, contentW, Math.max(2, Math.round(height * 0.004)), divider);
  y += Math.round(height * 0.035);

  const rowH = Math.max(3, Math.round(height * 0.014));
  const gap = Math.round(height * 0.018);
  for (const w of [1, 0.96, 0.88, 0.93, 0.6, 0.9, 0.84, 0.7, 0.5]) {
    if (y + rowH > height) break;
    rect(png, x, y, Math.round(contentW * w), rowH, text);
    y += rowH + gap;
  }
  return PNG.sync.write(png);
}

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

// The two built-in breakpoints the sample runs at, so the preview exercises
// the reporter's multi-mode chrome (one labelled group per breakpoint) instead
// of the single-mode flat list. Dimensions mirror the REGISTRY defaults in
// src/config.ts. Spread one of these into each `ActionResult` to tag it.
const BP = {
  mobile: { breakpoint: 'mobile', breakpointWidth: 375, breakpointHeight: 667 },
  desktop: {
    breakpoint: 'desktop',
    breakpointWidth: 1280,
    breakpointHeight: 800,
  },
} as const;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tuffgal-preview-'));
  // Renders a mock page sized to the breakpoint it was captured at. `bp` is one
  // of the `BP` entries above, so the panel reflects the real 375×667 /
  // 1280×800 shape; `opts` carries the `shift`/`diff` knobs through to mockPage.
  const shot = (
    name: string,
    bp: { breakpointWidth: number; breakpointHeight: number },
    opts: { shift?: number; diff?: boolean } = {},
  ): string => {
    const path = join(dir, `${name}.png`);
    writeFileSync(
      path,
      mockPage(bp.breakpointWidth, bp.breakpointHeight, opts),
    );
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
            ...BP.mobile,
            action: 'navigate',
            parameters: { url: '/' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:17.000Z',
            finishedAt: '2026-06-19T13:58:18.200Z',
            durationMs: 1200,
          },
          {
            ...BP.mobile,
            action: 'screenshot',
            status: 'pass',
            startedAt: '2026-06-19T13:58:18.200Z',
            finishedAt: '2026-06-19T13:58:18.900Z',
            durationMs: 700,
            baselinePath: shot('home-mobile-base', BP.mobile),
            actualPath: shot('home-mobile-actual', BP.mobile),
          },
          {
            ...BP.desktop,
            action: 'navigate',
            parameters: { url: '/' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:18.900Z',
            finishedAt: '2026-06-19T13:58:20.000Z',
            durationMs: 1100,
          },
          {
            ...BP.desktop,
            action: 'screenshot',
            status: 'pass',
            startedAt: '2026-06-19T13:58:20.000Z',
            finishedAt: '2026-06-19T13:58:20.700Z',
            durationMs: 700,
            baselinePath: shot('home-desktop-base', BP.desktop),
            actualPath: shot('home-desktop-actual', BP.desktop),
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
            ...BP.mobile,
            action: 'navigate',
            parameters: { url: '/settings' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:25.200Z',
            finishedAt: '2026-06-19T13:58:26.300Z',
            durationMs: 1100,
          },
          {
            ...BP.mobile,
            action: 'screenshot',
            status: 'pass',
            startedAt: '2026-06-19T13:58:26.300Z',
            finishedAt: '2026-06-19T13:58:27.200Z',
            durationMs: 900,
            baselinePath: shot('settings-mobile-base', BP.mobile),
            actualPath: shot('settings-mobile-actual', BP.mobile),
          },
          {
            ...BP.desktop,
            action: 'navigate',
            parameters: { url: '/settings' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:27.200Z',
            finishedAt: '2026-06-19T13:58:28.300Z',
            durationMs: 1100,
          },
          {
            ...BP.desktop,
            action: 'screenshot',
            status: 'changed',
            startedAt: '2026-06-19T13:58:28.300Z',
            finishedAt: '2026-06-19T13:58:29.200Z',
            durationMs: 900,
            baselinePath: shot('settings-desktop-base', BP.desktop),
            actualPath: shot('settings-desktop-actual', BP.desktop, {
              shift: 10,
            }),
            diffPath: shot('settings-desktop-diff', BP.desktop, {
              shift: 10,
              diff: true,
            }),
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
            ...BP.mobile,
            action: 'navigate',
            parameters: { url: '/cart' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:40.000Z',
            finishedAt: '2026-06-19T13:58:41.000Z',
            durationMs: 1000,
          },
          {
            ...BP.mobile,
            action: 'click',
            parameters: { selector: 'button#buy' },
            status: 'failed',
            startedAt: '2026-06-19T13:58:41.000Z',
            finishedAt: '2026-06-19T13:58:46.000Z',
            durationMs: 5000,
            failureMessage:
              'TimeoutError: locator.click: Timeout 5000ms exceeded.\n  waiting for locator("button#buy")',
          },
          {
            ...BP.desktop,
            action: 'navigate',
            parameters: { url: '/cart' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:46.000Z',
            finishedAt: '2026-06-19T13:58:47.000Z',
            durationMs: 1000,
          },
          {
            ...BP.desktop,
            action: 'click',
            parameters: { selector: 'button#buy' },
            status: 'failed',
            startedAt: '2026-06-19T13:58:47.000Z',
            finishedAt: '2026-06-19T13:58:52.000Z',
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
