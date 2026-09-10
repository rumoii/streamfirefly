import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeCaptureFinalization } from './capture-finalization.mjs';

test('duplicate stop failures remain visible without beginning finalization polling', async () => {
  const evidence = {};
  await assert.rejects(observeCaptureFinalization(async type => {
    if (type === 'capture.close') throw new Error('stop failed');
    return [{ id: 'session', state: 'capturing' }];
  }, 1, 'session', evidence), /stop failed/);
  assert.equal(evidence.stopResults.filter(item => item.status === 'rejected').length, 2);
});

for (const outcome of ['complete', 'missing', 'query-error', 'partial']) {
  test(`finalization records stop results and ${outcome}`, async () => {
    let clock = 0, queries = 0, stops = 0;
    const evidence = {};
    const request = async type => {
      if (type === 'capture.close') { stops++; return; }
      if (++queries === 1) return [{ id: 'session', state: 'capturing', bytes: 12 }];
      if (outcome === 'query-error') throw new Error('host disconnected');
      return outcome === 'missing' ? [] : [{ id: 'session', state: outcome, bytes: 12 }];
    };
    const pending = observeCaptureFinalization(request, 1, 'session', evidence, { timeout: 200, now: () => clock, pause: async duration => { clock += duration; } });
    if (['missing', 'query-error'].includes(outcome)) await assert.rejects(pending, /capture finalization: timeout/);
    else assert.equal((await pending).state, outcome);
    assert.equal(stops, 2);
    assert.equal(evidence.stopResults.length, 2);
    assert.equal(evidence.lastQuery.status, outcome === 'query-error' ? 'query-error' : outcome === 'missing' ? 'missing' : 'found');
    if (outcome === 'query-error') assert.equal(evidence.lastQuery.error, 'host disconnected');
  });
}
