import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAuth } from './lib/session.mjs';

function fakePage({ authedAfter = 0, gotoFails = false } = {}) {
  const page = {
    gotos: [],
    probes: 0,
    goto(url) {
      page.gotos.push(url);
      return gotoFails ? Promise.reject(new Error('ERR_ABORTED')) : Promise.resolve();
    },
    evaluate() {
      page.probes++;
      return Promise.resolve({ status: page.probes > authedAfter ? 'success' : 'failure' });
    },
  };
  return page;
}

test('waitForAuth resolves true once the probe succeeds, loading /feed once', async () => {
  const page = fakePage({ authedAfter: 2 });
  assert.equal(await waitForAuth(page, { budgetMs: 1000, pollMs: 1 }), true);
  assert.deepEqual(page.gotos, ['https://www.ubereats.com/feed']);
  assert.equal(page.probes, 3);
});

test('waitForAuth resolves false when the budget runs out', async () => {
  const page = fakePage({ authedAfter: Infinity });
  assert.equal(await waitForAuth(page, { budgetMs: 30, pollMs: 5 }), false);
});

test('waitForAuth keeps polling when the initial navigation is aborted', async () => {
  const page = fakePage({ authedAfter: 0, gotoFails: true });
  assert.equal(await waitForAuth(page, { budgetMs: 1000, pollMs: 1 }), true);
});
