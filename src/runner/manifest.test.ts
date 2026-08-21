import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ResolvedConfig } from '../config.ts';
import {
  CAPTURE_SCHEMA,
  MALFORMED_MANIFEST_KEY,
  SCHEMA_VERSION,
  captureEnvironment,
  compareEnvironment,
  readManifest,
  validateManifestShape,
  type EnvironmentManifest,
  type ManifestReadResult,
} from './manifest.ts';

/** A well-formed manifest fixture; override any field per test. */
function manifest(
  over: Partial<EnvironmentManifest> = {},
): EnvironmentManifest {
  return {
    schemaVersion: 1,
    captureSchema: 1,
    tuffgalVersion: '0.1.0',
    playwrightVersion: '1.61.0',
    browser: 'chromium',
    browserVersion: '131.0.0.0',
    platform: 'linux',
    captureMode: 'viewport',
    breakpoints: [{ name: 'desktop', width: 1280, height: 800 }],
    deviceScaleFactor: 1,
    frozenTime: '2026-01-15T12:00:00.000Z',
    ...over,
  };
}

/** An `ok` read result wrapping a manifest fixture. */
function ok(over: Partial<EnvironmentManifest> = {}): ManifestReadResult {
  return { status: 'ok', manifest: manifest(over) };
}

describe('readManifest: parse outcomes', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tuffgal-manifest-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns missing when no manifest file exists', async () => {
    const result = await readManifest(join(dir, 'no-such-dir'));
    assert.equal(result.status, 'missing');
  });

  it('reads a well-formed manifest as ok', async () => {
    const baselines = mkdtempSync(join(dir, 'ok-'));
    writeFileSync(join(baselines, 'manifest.json'), JSON.stringify(manifest()));
    const result = await readManifest(baselines);
    assert.equal(result.status, 'ok');
    assert.equal(result.status === 'ok' && result.manifest.platform, 'linux');
  });

  it('returns malformed for non-JSON content', async () => {
    const baselines = mkdtempSync(join(dir, 'bad-'));
    writeFileSync(join(baselines, 'manifest.json'), '{ not json');
    const result = await readManifest(baselines);
    assert.equal(result.status, 'malformed');
  });

  it('returns malformed when a required field has the wrong type', async () => {
    const baselines = mkdtempSync(join(dir, 'shape-'));
    writeFileSync(
      join(baselines, 'manifest.json'),
      JSON.stringify({ ...manifest(), captureSchema: 'one' }),
    );
    const result = await readManifest(baselines);
    assert.equal(result.status, 'malformed');
  });

  it('returns malformed when breakpoints is not an array', async () => {
    const baselines = mkdtempSync(join(dir, 'bp-'));
    writeFileSync(
      join(baselines, 'manifest.json'),
      JSON.stringify({ ...manifest(), breakpoints: 'desktop' }),
    );
    const result = await readManifest(baselines);
    assert.equal(result.status, 'malformed');
  });

  it('returns malformed when a breakpoint entry misses a dimension', async () => {
    const baselines = mkdtempSync(join(dir, 'bpdim-'));
    writeFileSync(
      join(baselines, 'manifest.json'),
      JSON.stringify({
        ...manifest(),
        breakpoints: [{ name: 'desktop', width: 1280 }],
      }),
    );
    const result = await readManifest(baselines);
    assert.equal(result.status, 'malformed');
  });
});

describe('colorScheme: a manifest predating the field never gates', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tuffgal-scheme-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads as ok and compares clean against any actual value', async () => {
    const baselines = mkdtempSync(join(dir, 'legacy-'));
    const committed = manifest();
    assert.equal(
      'colorScheme' in committed,
      false,
      'fixture must carry no colorScheme key',
    );
    writeFileSync(join(baselines, 'manifest.json'), JSON.stringify(committed));

    const read = await readManifest(baselines);
    assert.equal(read.status, 'ok');
    for (const actual of ['light', 'dark', 'no-preference'] as const) {
      const result = compareEnvironment(
        read,
        manifest({ colorScheme: actual }),
      );
      assert.equal(result.mismatch, false, `${actual} must not gate`);
      assert.deepEqual(result.mismatchKeys, []);
    }
  });

  it('flags a committed value that diverges from the run', () => {
    const result = compareEnvironment(
      ok({ colorScheme: 'dark' }),
      manifest({ colorScheme: 'light' }),
    );
    assert.equal(result.mismatch, true);
    assert.deepEqual(result.mismatchKeys, ['colorScheme']);
  });

  it('passes a committed value that matches the run', () => {
    const result = compareEnvironment(
      ok({ colorScheme: 'dark' }),
      manifest({ colorScheme: 'dark' }),
    );
    assert.equal(result.mismatch, false);
    assert.deepEqual(result.mismatchKeys, []);
  });

  it('flags a committed value when the run records none', () => {
    const result = compareEnvironment(ok({ colorScheme: 'dark' }), manifest());
    assert.deepEqual(result.mismatchKeys, ['colorScheme']);
  });
});

describe('validateManifestShape: colorScheme is optional, never loose', () => {
  it('accepts a manifest with the key absent', () => {
    assert.equal(validateManifestShape(manifest()), undefined);
  });

  it('accepts each valid value', () => {
    for (const colorScheme of ['light', 'dark', 'no-preference'] as const) {
      assert.equal(validateManifestShape(manifest({ colorScheme })), undefined);
    }
  });

  it('rejects an out-of-enum value', () => {
    const invalid = { ...manifest(), colorScheme: 'auto' };
    assert.match(String(validateManifestShape(invalid)), /colorScheme/);
  });

  it('rejects a wrong-typed value', () => {
    const invalid = { ...manifest(), colorScheme: 1 };
    assert.match(String(validateManifestShape(invalid)), /colorScheme/);
  });
});

describe('compareEnvironment: read-result gating', () => {
  it('never mismatches on a missing manifest (bootstrap case)', () => {
    const result = compareEnvironment({ status: 'missing' }, manifest());
    assert.equal(result.mismatch, false);
    assert.deepEqual(result.mismatchKeys, []);
  });

  it('flags a malformed manifest as a single manifest note', () => {
    const result = compareEnvironment(
      { status: 'malformed', reason: 'bad' },
      manifest(),
    );
    assert.equal(result.mismatch, true);
    assert.deepEqual(result.mismatchKeys, [MALFORMED_MANIFEST_KEY]);
  });

  it('reports no mismatch when expected equals actual', () => {
    const result = compareEnvironment(ok(), manifest());
    assert.equal(result.mismatch, false);
    assert.deepEqual(result.mismatchKeys, []);
  });
});

describe('compareEnvironment: pixel-affecting keys each trigger', () => {
  const cases: Array<{ key: string; over: Partial<EnvironmentManifest> }> = [
    { key: 'captureSchema', over: { captureSchema: 2 } },
    { key: 'browserVersion', over: { browserVersion: '999.0.0.0' } },
    { key: 'platform', over: { platform: 'darwin' } },
    { key: 'captureMode', over: { captureMode: 'fullPage' } },
    { key: 'deviceScaleFactor', over: { deviceScaleFactor: 2 } },
    { key: 'frozenTime', over: { frozenTime: '2020-01-01T00:00:00.000Z' } },
  ];

  for (const { key, over } of cases) {
    it(`flags ${key} when it diverges`, () => {
      const result = compareEnvironment(ok(), manifest(over));
      assert.equal(result.mismatch, true);
      assert.deepEqual(result.mismatchKeys, [key]);
    });
  }

  it('collects multiple diverging keys in registry order', () => {
    const result = compareEnvironment(
      ok(),
      manifest({ platform: 'darwin', frozenTime: '2020-01-01T00:00:00.000Z' }),
    );
    assert.deepEqual(result.mismatchKeys, ['platform', 'frozenTime']);
  });
});

describe('compareEnvironment: informational keys never trigger', () => {
  it('ignores a tuffgalVersion difference', () => {
    const result = compareEnvironment(
      ok(),
      manifest({ tuffgalVersion: '9.9.9' }),
    );
    assert.equal(result.mismatch, false);
    assert.deepEqual(result.mismatchKeys, []);
  });

  it('ignores a playwrightVersion difference', () => {
    const result = compareEnvironment(
      ok(),
      manifest({ playwrightVersion: '2.0.0' }),
    );
    assert.equal(result.mismatch, false);
  });

  it('ignores a browser NAME difference (implied by browserVersion)', () => {
    const result = compareEnvironment(ok(), manifest({ browser: 'firefox' }));
    assert.equal(result.mismatch, false);
    assert.deepEqual(result.mismatchKeys, []);
  });

  it('ignores a schemaVersion difference (file-format only)', () => {
    const result = compareEnvironment(ok(), manifest({ schemaVersion: 2 }));
    assert.equal(result.mismatch, false);
  });
});

describe('compareEnvironment: breakpoints deep compare', () => {
  it('flags a changed dimension', () => {
    const result = compareEnvironment(
      ok(),
      manifest({
        breakpoints: [{ name: 'desktop', width: 1440, height: 800 }],
      }),
    );
    assert.deepEqual(result.mismatchKeys, ['breakpoints']);
  });

  it('flags an added breakpoint', () => {
    const result = compareEnvironment(
      ok(),
      manifest({
        breakpoints: [
          { name: 'desktop', width: 1280, height: 800 },
          { name: 'mobile', width: 375, height: 667 },
        ],
      }),
    );
    assert.deepEqual(result.mismatchKeys, ['breakpoints']);
  });

  it('flags a renamed breakpoint at identical dimensions', () => {
    const result = compareEnvironment(
      ok(),
      manifest({ breakpoints: [{ name: 'laptop', width: 1280, height: 800 }] }),
    );
    assert.deepEqual(result.mismatchKeys, ['breakpoints']);
  });

  it('flags a reorder (order-sensitive)', () => {
    const two = [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ];
    const reversed = [two[1]!, two[0]!];
    const result = compareEnvironment(
      ok({ breakpoints: two }),
      manifest({ breakpoints: reversed }),
    );
    assert.deepEqual(result.mismatchKeys, ['breakpoints']);
  });

  it('treats identical multi-breakpoint lists as equal', () => {
    const two = [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ];
    const result = compareEnvironment(
      ok({ breakpoints: two }),
      manifest({ breakpoints: two.map((bp) => ({ ...bp })) }),
    );
    assert.equal(result.mismatch, false);
  });
});

describe('captureEnvironment: builds the actual side', () => {
  const config = {
    captureMode: 'viewport',
    frozenTime: '2026-01-15T12:00:00.000Z',
    breakpoints: [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ],
  } as unknown as ResolvedConfig;

  it('stamps constants, host platform, and the supplied browser', () => {
    const env = captureEnvironment(config, {
      name: 'chromium',
      version: '131.0.0.0',
    });
    assert.equal(env.schemaVersion, SCHEMA_VERSION);
    assert.equal(env.captureSchema, CAPTURE_SCHEMA);
    assert.equal(env.browser, 'chromium');
    assert.equal(env.browserVersion, '131.0.0.0');
    assert.equal(env.platform, process.platform);
    assert.equal(env.deviceScaleFactor, 1);
  });

  it('mirrors resolved config breakpoints, capture mode, and frozen time', () => {
    const env = captureEnvironment(config, {
      name: 'chromium',
      version: '131.0.0.0',
    });
    assert.equal(env.captureMode, 'viewport');
    assert.equal(env.frozenTime, '2026-01-15T12:00:00.000Z');
    assert.deepEqual(env.breakpoints, [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'desktop', width: 1280, height: 800 },
    ]);
  });

  it('records the pinned colorScheme from the resolved config', () => {
    const env = captureEnvironment(
      { ...config, colorScheme: 'dark' } as ResolvedConfig,
      { name: 'chromium', version: '131.0.0.0' },
    );
    assert.equal(env.colorScheme, 'dark');
  });

  it("records 'light' for a 'no-preference' config, the scheme painted", () => {
    const env = captureEnvironment(
      { ...config, colorScheme: 'no-preference' } as ResolvedConfig,
      { name: 'chromium', version: '131.0.0.0' },
    );
    assert.equal(env.colorScheme, 'light');
  });

  it("records 'light' when the config pins nothing", () => {
    const unset = { ...config, colorScheme: undefined } as ResolvedConfig;
    const env = captureEnvironment(unset, {
      name: 'chromium',
      version: '131.0.0.0',
    });
    assert.equal(env.colorScheme, 'light');
  });

  it('reads real tuffgal and playwright versions (non-empty strings)', () => {
    const env = captureEnvironment(config, {
      name: 'chromium',
      version: '131.0.0.0',
    });
    assert.equal(typeof env.tuffgalVersion, 'string');
    assert.ok(env.tuffgalVersion.length > 0);
    assert.equal(typeof env.playwrightVersion, 'string');
    assert.ok(env.playwrightVersion.length > 0);
  });

  it('round-trips: captured env compares clean against itself', () => {
    const env = captureEnvironment(config, {
      name: 'chromium',
      version: '131.0.0.0',
    });
    const result = compareEnvironment({ status: 'ok', manifest: env }, env);
    assert.equal(result.mismatch, false);
  });
});
