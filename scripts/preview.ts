/**
 * Renders a sample report so you can eyeball the HTML report without
 * running a real suite, which needs Playwright + a dev server.
 *
 * Builds a fixture `RunResult` covering passed, new, changed, and failed
 * stories, each run at both the `mobile` and `desktop` breakpoints, and
 * opens the report in your web browser. By default the fixture also trips
 * every conditional report section — the environment-mismatch banner and the
 * deleted (orphaned-baseline) list — so a preview shows the whole surface.
 *
 * The changed story drifts both ways: pixels on desktop (the screenshot
 * viewer) and the accessibility tree alone on mobile (the snapshot diff that
 * stands in for it).
 *
 * `npm run preview`                  — everything, including banner + deleted
 * `npm run preview -- --clean`       — happy path: no mismatch, nothing orphaned
 * `npm run preview -- --interactive` — press-and-hold screenshot viewer instead
 *                                      of the radio-tab panels
 *
 * Outputs to a (throwaway) temp directory.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { EnvironmentManifest } from '../src/runner/manifest.ts';
import type { RunResult } from '../src/schema/result.ts';
import { writeReport } from '../src/reporter/writeReport.ts';
import { buildA11yDiff } from '../src/runner/a11yDiff.ts';
import { renderDiffOverlay, scoreDiff } from '../src/screenshots/diff.ts';

type Rgba = readonly [number, number, number, number];

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

function mockPage(
  width: number,
  height: number,
  { shift = 0 }: { shift?: number } = {},
): Buffer {
  const png = new PNG({ width, height });
  rect(png, 0, 0, width, height, [250, 250, 251, 255]);

  const margin = Math.round(width * 0.07);
  const contentW = width - margin * 2;
  const x = margin + shift;
  const title: Rgba = [34, 38, 46, 255];
  const divider: Rgba = [206, 210, 218, 255];
  const text: Rgba = [148, 154, 165, 255];

  let y = Math.round(height * 0.08) + shift;
  rect(
    png,
    x,
    y,
    Math.round(contentW * 0.58),
    Math.round(height * 0.035),
    title,
  );
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
    // the report path is already printed, so opening is best effort
  }
}

const BP = {
  mobile: { breakpoint: 'mobile', breakpointWidth: 375, breakpointHeight: 667 },
  desktop: {
    breakpoint: 'desktop',
    breakpointWidth: 1280,
    breakpointHeight: 800,
  },
} as const;

// The mobile settings capture: same pixels either side, one control swapped
// and one live region added, which is what an a11y-only changed row looks like.
const SETTINGS_A11Y_BASELINE = `- navigation "Settings":
  - link "Profile"
  - link "Notifications"
  - link "Billing"
- main:
  - heading "Notifications" [level=1]
  - checkbox "Email me about product news"
  - checkbox "Email me about security alerts"
  - button "Save"
`;

const SETTINGS_A11Y_ACTUAL = `- navigation "Settings":
  - link "Profile"
  - link "Notifications"
  - link "Billing"
- main:
  - heading "Notifications" [level=1]
  - switch "Email me about product news"
  - checkbox "Email me about security alerts"
  - button "Save"
  - status "Saved 2 minutes ago"
`;

function manifest(
  overrides: Partial<EnvironmentManifest> = {},
): EnvironmentManifest {
  return {
    schemaVersion: 1,
    captureSchema: 1,
    tuffgalVersion: '0.2.0-alpha.1',
    playwrightVersion: '1.49.0',
    browser: 'chromium',
    browserVersion: 'chromium 131.0.6778.33',
    platform: 'linux',
    captureMode: 'headless',
    breakpoints: [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ],
    deviceScaleFactor: 1,
    frozenTime: '2026-06-19T13:58:17.000Z',
    ...overrides,
  };
}

async function main(): Promise<void> {
  const clean = process.argv.includes('--clean');
  const interactive = process.argv.includes('--interactive');
  const dir = mkdtempSync(join(tmpdir(), 'tuffgal-preview-'));
  const writeShot = (name: string, png: Buffer): string => {
    const path = join(dir, `${name}.png`);
    writeFileSync(path, png);
    return path;
  };
  const shot = (
    name: string,
    bp: { breakpointWidth: number; breakpointHeight: number },
    opts: { shift?: number } = {},
  ): string =>
    writeShot(name, mockPage(bp.breakpointWidth, bp.breakpointHeight, opts));
  const writeSnapshot = (name: string, tree: string): string => {
    const path = join(dir, `${name}.a11y.yaml`);
    writeFileSync(path, tree);
    return path;
  };

  const settingsBase = mockPage(
    BP.desktop.breakpointWidth,
    BP.desktop.breakpointHeight,
  );
  const settingsActual = mockPage(
    BP.desktop.breakpointWidth,
    BP.desktop.breakpointHeight,
    { shift: 10 },
  );
  const settingsDiff = scoreDiff(settingsBase, settingsActual, {
    pixelThreshold: 0.1,
  });
  const settingsOverlay = renderDiffOverlay(settingsDiff.decoded, 0.1);

  const actual = manifest();
  const expected = clean
    ? actual
    : manifest({
        browserVersion: 'chromium 129.0.6668.100',
        platform: 'darwin',
      });
  const deleted = clean
    ? []
    : [
        {
          action: 'visit-blog',
          breakpoint: 'desktop',
          baselinePaths: ['baselines/visit-blog/desktop/0.png'],
        },
        {
          action: 'visit-blog',
          breakpoint: 'legacy',
          baselinePaths: ['baselines/visit-blog/0.png'],
        },
      ];

  const result: RunResult = {
    startedAt: '2026-06-19T13:58:17.000Z',
    finishedAt: '2026-06-19T13:58:52.490Z',
    durationMs: 35490,
    mode: 'ci',
    totals: {
      stories: 4,
      passed: 1,
      changed: 1,
      failed: 1,
      new: 1,
      deleted: deleted.length,
    },
    deleted,
    environment: {
      expected,
      actual,
      mismatch: !clean,
      mismatchKeys: clean ? [] : ['browserVersion', 'platform'],
    },
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
            action: 'visit-home',
            parameters: { url: '/' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:17.000Z',
            finishedAt: '2026-06-19T13:58:18.200Z',
            durationMs: 1200,
          },
          {
            ...BP.mobile,
            action: 'capture-home',
            status: 'pass',
            startedAt: '2026-06-19T13:58:18.200Z',
            finishedAt: '2026-06-19T13:58:18.900Z',
            durationMs: 700,
            baselinePath: shot('home-mobile-base', BP.mobile),
            actualPath: shot('home-mobile-actual', BP.mobile),
          },
          {
            ...BP.desktop,
            action: 'visit-home',
            parameters: { url: '/' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:18.900Z',
            finishedAt: '2026-06-19T13:58:20.000Z',
            durationMs: 1100,
          },
          {
            ...BP.desktop,
            action: 'capture-home',
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
        story: 'A new pricing page is captured for the first time.',
        file: 'user-views-pricing.json',
        status: 'new',
        startedAt: '2026-06-19T13:58:25.200Z',
        finishedAt: '2026-06-19T13:58:29.000Z',
        durationMs: 3800,
        actions: [
          {
            ...BP.mobile,
            action: 'visit-pricing',
            parameters: { url: '/pricing' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:25.200Z',
            finishedAt: '2026-06-19T13:58:26.200Z',
            durationMs: 1000,
          },
          {
            ...BP.mobile,
            action: 'capture-pricing',
            status: 'new',
            startedAt: '2026-06-19T13:58:26.200Z',
            finishedAt: '2026-06-19T13:58:27.000Z',
            durationMs: 800,
            baselinePath: shot('pricing-mobile-base', BP.mobile),
            actualPath: shot('pricing-mobile-actual', BP.mobile),
          },
          {
            ...BP.desktop,
            action: 'capture-pricing',
            status: 'new',
            startedAt: '2026-06-19T13:58:27.000Z',
            finishedAt: '2026-06-19T13:58:29.000Z',
            durationMs: 2000,
            baselinePath: shot('pricing-desktop-base', BP.desktop),
            actualPath: shot('pricing-desktop-actual', BP.desktop),
          },
        ],
      },
      {
        story: 'A user opens settings and the page drifted.',
        file: 'user-opens-settings.json',
        status: 'changed',
        startedAt: '2026-06-19T13:58:25.200Z',
        finishedAt: '2026-06-19T13:58:40.000Z',
        durationMs: 14800,
        actions: [
          {
            ...BP.mobile,
            action: 'visit-settings',
            parameters: { url: '/settings' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:25.200Z',
            finishedAt: '2026-06-19T13:58:26.300Z',
            durationMs: 1100,
          },
          {
            ...BP.mobile,
            action: 'capture-settings',
            status: 'changed',
            startedAt: '2026-06-19T13:58:26.300Z',
            finishedAt: '2026-06-19T13:58:27.200Z',
            durationMs: 900,
            baselinePath: shot('settings-mobile-base', BP.mobile),
            actualPath: shot('settings-mobile-actual', BP.mobile),
            diffPixels: 0,
            diffRatio: 0,
            ssimScore: 1,
            a11yChanged: true,
            a11yBaselinePath: writeSnapshot(
              'settings-mobile-base',
              SETTINGS_A11Y_BASELINE,
            ),
            a11yActualPath: writeSnapshot(
              'settings-mobile-actual',
              SETTINGS_A11Y_ACTUAL,
            ),
            a11yDiff: buildA11yDiff(
              SETTINGS_A11Y_BASELINE,
              SETTINGS_A11Y_ACTUAL,
            ),
          },
          {
            ...BP.desktop,
            action: 'visit-settings',
            parameters: { url: '/settings' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:27.200Z',
            finishedAt: '2026-06-19T13:58:28.300Z',
            durationMs: 1100,
          },
          {
            ...BP.desktop,
            action: 'capture-settings',
            status: 'changed',
            startedAt: '2026-06-19T13:58:28.300Z',
            finishedAt: '2026-06-19T13:58:29.200Z',
            durationMs: 900,
            baselinePath: writeShot('settings-desktop-base', settingsBase),
            actualPath: writeShot('settings-desktop-actual', settingsActual),
            diffPath: writeShot('settings-desktop-diff', settingsOverlay),
            diffPixels: settingsDiff.score.diffPixels,
            diffRatio: settingsDiff.score.diffRatio,
            ssimScore: settingsDiff.score.ssimScore,
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
            action: 'visit-cart',
            parameters: { url: '/cart' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:40.000Z',
            finishedAt: '2026-06-19T13:58:41.000Z',
            durationMs: 1000,
          },
          {
            ...BP.mobile,
            action: 'press-buy',
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
            action: 'visit-cart',
            parameters: { url: '/cart' },
            status: 'pass',
            startedAt: '2026-06-19T13:58:46.000Z',
            finishedAt: '2026-06-19T13:58:47.000Z',
            durationMs: 1000,
          },
          {
            ...BP.desktop,
            action: 'press-buy',
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

  const htmlPath = await writeReport(dir, result, interactive);
  console.log(`Sample report written to ${htmlPath}`);
  openInBrowser(htmlPath);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
