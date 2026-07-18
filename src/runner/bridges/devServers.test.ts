import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitForUrl } from './devServers.ts';

const URL = 'http://127.0.0.1:3000/';

/** A probe that returns each queued value in turn, then repeats the last. */
function sequenceProbe(values: boolean[]): {
  probe: () => Promise<boolean>;
  calls: () => number;
} {
  let index = 0;
  return {
    probe: () => {
      const value = values[Math.min(index, values.length - 1)] ?? false;
      index += 1;
      return Promise.resolve(value);
    },
    calls: () => index,
  };
}

describe('waitForUrl', () => {
  it('resolves once the probe reports a non-5xx response', async () => {
    const { probe } = sequenceProbe([true]);
    await waitForUrl(URL, 1_000, () => undefined, probe, 1);
  });

  it('keeps polling while the server 5xxs, then resolves when it is ready', async () => {
    const { probe, calls } = sequenceProbe([false, false, true]);
    await waitForUrl(URL, 1_000, () => undefined, probe, 1);
    assert.equal(calls(), 3);
  });

  it('throws a timeout error when the probe never reports ready', async () => {
    const { probe } = sequenceProbe([false]);
    await assert.rejects(
      () => waitForUrl(URL, 30, () => undefined, probe, 1),
      /did not return a non-5xx HTTP response within 30ms/,
    );
  });

  it('throws the early-exit error in preference to timing out', async () => {
    const earlyExit = new Error('Dev server command exited early with code 1');
    const { probe, calls } = sequenceProbe([false]);
    // A generous timeout proves early-exit short-circuits rather than the loop
    // running to the deadline and throwing the generic timeout error.
    await assert.rejects(
      () => waitForUrl(URL, 60_000, () => earlyExit, probe, 1),
      (error) => error === earlyExit,
    );
    // Early exit is checked before the first probe, so it never runs.
    assert.equal(calls(), 0);
  });
});
