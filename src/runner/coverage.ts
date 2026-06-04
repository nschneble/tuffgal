import { join } from 'node:path';
import type { Page } from 'playwright';
import type MCR from 'monocart-coverage-reports';

type CoverageReportInstance = MCR.CoverageReport;

const PLAYWRIGHT_COVERAGE_OPTIONS = { resetOnNavigation: false } as const;

/**
 * Collects V8 JS + CSS coverage from every Playwright page the harness
 * opens during a run, then hands the aggregate to monocart-coverage-reports
 * for V8, Istanbul, and console summary output. Disabled by default — turn
 * on with `tuffgal run --coverage`.
 *
 * Two stages:
 *   1. `startForPage(page)` — call after every `newPage` so coverage spans
 *      every navigation the story performs.
 *   2. `stopForPage(page)` — call before `context.close()` to drain the
 *      entries into the aggregate.
 *
 * `generate()` runs once at end-of-run.
 */
export class CoverageCollector {
  private mcr: CoverageReportInstance | undefined;
  private readonly outputDir: string;
  private initialised = false;

  constructor(reportDir: string) {
    this.outputDir = join(reportDir, 'coverage');
  }

  private async ensureInitialised(): Promise<void> {
    if (this.initialised) return;
    const monocartModule = await import('monocart-coverage-reports');
    // `export = MCR` (CommonJS) becomes `.default` under ESM interop.
    const createReport = monocartModule.default;
    this.mcr = createReport({
      name: 'tuffgal coverage',
      outputDir: this.outputDir,
      reports: ['v8', 'console-summary'],
    });
    await this.mcr.cleanCache();
    this.initialised = true;
  }

  async startForPage(page: Page): Promise<void> {
    await this.ensureInitialised();
    await Promise.all([
      page.coverage.startJSCoverage(PLAYWRIGHT_COVERAGE_OPTIONS),
      page.coverage.startCSSCoverage(PLAYWRIGHT_COVERAGE_OPTIONS),
    ]);
  }

  async stopForPage(page: Page): Promise<void> {
    if (!this.mcr) return;
    try {
      const [js, css] = await Promise.all([
        page.coverage.stopJSCoverage(),
        page.coverage.stopCSSCoverage(),
      ]);
      await this.mcr.add([...js, ...css]);
    } catch (error) {
      // A page may already be closing when we stop — best effort, do not
      // fail the run because we missed coverage on one tab.
      process.stderr.write(
        `coverage: stopForPage failed — ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  async generate(): Promise<string> {
    if (!this.mcr) return this.outputDir;
    await this.mcr.generate();
    return this.outputDir;
  }
}
