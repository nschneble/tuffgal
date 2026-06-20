import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertValidConfig } from './config.ts';

const SOURCE = '/fake/tuffgal.config.ts';

function validConfig(): Record<string, unknown> {
  return {
    paths: {
      actions: 'tuffgal/actions',
      stories: 'tuffgal/stories',
      baselines: 'tuffgal/baselines',
      report: 'tuffgal/report',
    },
    baseUrl: 'http://localhost:3000',
  };
}

describe('assertValidConfig', () => {
  it('accepts a minimal valid config', () => {
    assert.doesNotThrow(() => assertValidConfig(validConfig(), SOURCE));
  });

  it('accepts valid optional fields', () => {
    const config = {
      ...validConfig(),
      apiHost: 'http://localhost:4000',
      workers: 4,
      viewport: { width: 1280, height: 800 },
      flowInventory: 'docs/flows.md',
    };
    assert.doesNotThrow(() => assertValidConfig(config, SOURCE));
  });

  it('rejects a non-object export, naming the source', () => {
    assert.throws(
      () => assertValidConfig(null, SOURCE),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\/fake\/tuffgal\.config\.ts/);
        return true;
      },
    );
  });

  it('requires paths and its string members', () => {
    assert.throws(() => assertValidConfig({ baseUrl: 'x' }, SOURCE), /paths/);
    const config = validConfig();
    delete (config.paths as Record<string, unknown>).report;
    assert.throws(() => assertValidConfig(config, SOURCE), /paths\.report/);
  });

  it('requires a string baseUrl', () => {
    const config = validConfig();
    config.baseUrl = 123;
    assert.throws(() => assertValidConfig(config, SOURCE), /baseUrl/);
  });

  it('rejects a non-positive workers count', () => {
    const config = { ...validConfig(), workers: 0 };
    assert.throws(() => assertValidConfig(config, SOURCE), /workers/);
  });

  it('rejects a malformed viewport', () => {
    const config = { ...validConfig(), viewport: { width: 1280 } };
    assert.throws(() => assertValidConfig(config, SOURCE), /viewport/);
  });
});
