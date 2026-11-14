import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueScore, rankDeals } from './lib/deals.mjs';

test('valueScore ranks a poorly rated dish below an identical well rated one', () => {
  const base = { rating: 4.5, fee: 0, effectivePrice: 5, discountPct: 50, meal: 1 };
  const poor = valueScore({ ...base, likePct: 65, ratings: 444 });
  const good = valueScore({ ...base, likePct: 92, ratings: 444 });
  assert.ok(good > poor);
  assert.equal(valueScore(base), valueScore({ ...base, likePct: null, ratings: null }));
});

test('rankDeals uses the dish rating carried on a deal', () => {
  const deal = { kind: 'bogo', rating: 4.5, fee: 0, price: 10, effectivePrice: 5, discountPct: 50, discountText: '' };
  const [first] = rankDeals([{ ...deal, item: 'Poor', likePct: 60, ratings: 300 }, { ...deal, item: 'Fine', likePct: 90, ratings: 300 }]);
  assert.equal(first.item, 'Fine');
});
