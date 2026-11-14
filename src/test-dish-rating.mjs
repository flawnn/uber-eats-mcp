import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDishRating, smoothedLikePct, dishQualityAdjustment } from './lib/dish-rating.mjs';
import { normItem } from './lib/models.mjs';

const ratedItem = (rating, numRatings) => ({
  uuid: 'a1b2c3d4-0000-0000-0000-000000000000',
  title: 'Margherita',
  price: 990,
  catalogItemAnalyticsData: { endorsementMetadata: { endorsementType: 'ratings', rating, numRatings } },
});

const mostLikedItem = (rank, label) => ({
  uuid: 'e5f6a7b8-0000-0000-0000-000000000000',
  title: 'Pide SUCUK',
  price: 1300,
  catalogItemAnalyticsData: { endorsementMetadata: { endorsementType: 'most_liked' } },
  imageOverlayElements: [{ element: { payload: { tagsPayload: { tags: [{ text: `#${rank} most liked` }] } } } }],
  itemThumbnailElements: [
    {},
    { payload: { labelPayload: { label: { richTextElements: [{ text: { text: { text: label } } }] } } } },
  ],
});

test('parses the structured rating of a rated dish', () => {
  assert.deepEqual(parseDishRating(ratedItem('65%', 444)), { likePct: 65, ratings: 444, rank: null });
});

test('parses rank and visible rating of a most-liked dish', () => {
  assert.deepEqual(parseDishRating(mostLikedItem(1, ' 83% (37)')), { likePct: 83, ratings: 37, rank: 1 });
});

test('dishes without endorsement data have no rating', () => {
  assert.equal(parseDishRating({ title: 'Campione', price: 1890 }), null);
  assert.equal(parseDishRating(ratedItem('n/a', 3)), null);
});

test('normItem exposes the dish rating and omits it when unknown', () => {
  const rated = normItem(ratedItem('65%', 444));
  assert.equal(rated.likePct, 65);
  assert.equal(rated.ratings, 444);
  const plain = normItem({ uuid: 'c9d8e7f6-0000-0000-0000-000000000000', title: 'Campione', price: 1890 });
  assert.equal('likePct' in plain, false);
  assert.equal('ratings' in plain, false);
});

test('smoothing pulls tiny samples toward the prior and keeps large samples', () => {
  assert.ok(Math.abs(smoothedLikePct({ likePct: 100, ratings: 4 }) - 85.7) < 0.1);
  assert.ok(Math.abs(smoothedLikePct({ likePct: 65, ratings: 444 }) - 65.3) < 0.1);
  assert.equal(smoothedLikePct({ likePct: 70, ratings: 0 }), null);
});

test('quality adjustment penalises poor well-evidenced dishes and barely moves on thin evidence', () => {
  assert.equal(dishQualityAdjustment({ likePct: 65, ratings: 444 }), -7);
  assert.ok(dishQualityAdjustment({ likePct: 40, ratings: 3 }) > dishQualityAdjustment({ likePct: 40, ratings: 444 }));
  assert.equal(dishQualityAdjustment({ likePct: 98, ratings: 900 }), 5);
  assert.equal(dishQualityAdjustment({ likePct: 5, ratings: 5000 }), -15);
  assert.equal(dishQualityAdjustment({}), 0);
});
