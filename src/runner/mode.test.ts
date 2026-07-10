import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveRunMode } from './mode.ts';

describe('resolveRunMode — flag precedence', () => {
  it('--ci forces ci even when the env would default to local', () => {
    assert.equal(resolveRunMode({ ci: true, local: false, env: {} }), 'ci');
  });

  it('--local forces local even when CI is set truthy in the env', () => {
    assert.equal(
      resolveRunMode({ ci: false, local: true, env: { CI: 'true' } }),
      'local',
    );
  });

  it('throws when both --ci and --local are passed', () => {
    assert.throws(
      () => resolveRunMode({ ci: true, local: true, env: {} }),
      /both --ci and --local/,
    );
  });
});

describe('resolveRunMode — env default (no flag)', () => {
  const noFlags = { ci: false, local: false };

  it('defaults to ci when CI is a truthy string', () => {
    assert.equal(resolveRunMode({ ...noFlags, env: { CI: 'true' } }), 'ci');
    assert.equal(resolveRunMode({ ...noFlags, env: { CI: '1' } }), 'ci');
    // Non-empty, non-falsy tokens (e.g. a bare provider marker) count as CI.
    assert.equal(
      resolveRunMode({ ...noFlags, env: { CI: 'woodpecker' } }),
      'ci',
    );
  });

  it('defaults to local when CI is unset', () => {
    assert.equal(resolveRunMode({ ...noFlags, env: {} }), 'local');
  });

  it('defaults to local when CI is set to an explicitly-falsy string', () => {
    // Some setups export CI="false" / "0" / "" to opt OUT; honour that.
    assert.equal(resolveRunMode({ ...noFlags, env: { CI: 'false' } }), 'local');
    assert.equal(resolveRunMode({ ...noFlags, env: { CI: '0' } }), 'local');
    assert.equal(resolveRunMode({ ...noFlags, env: { CI: '' } }), 'local');
  });

  it('reads the negation set case-insensitively', () => {
    // A provider (or a developer) may export CI in any case; TRUE means CI,
    // FALSE means opt-out, regardless of casing.
    assert.equal(resolveRunMode({ ...noFlags, env: { CI: 'TRUE' } }), 'ci');
    assert.equal(resolveRunMode({ ...noFlags, env: { CI: 'False' } }), 'local');
  });
});
