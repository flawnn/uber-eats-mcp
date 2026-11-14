// Per-dish ratings from getStoreV1 catalog items.
// Uber shows "65% (444)" on a dish: share of positive ratings and how many ratings back it.
// Structured source: catalogItemAnalyticsData.endorsementMetadata ({endorsementType: 'ratings', rating: '65%', numRatings}).
// "#N most liked" dishes carry no structured rating, only the visible label text.

const VISIBLE_RATING_RE = /(\d{1,3})\s?%\s*\((\d+)\)/;
const RANK_RE = /#(\d+)\s+most liked/i;

export const PRIOR_PCT = 80;
export const PRIOR_WEIGHT = 10;
const MAX_PENALTY = -15;
const MAX_BONUS = 5;

export function parseDishRating(ci) {
  const e = ci?.catalogItemAnalyticsData?.endorsementMetadata;
  if (!e) return null;

  if (e.endorsementType === 'ratings') {
    const likePct = parseInt(e.rating, 10);
    return Number.isFinite(likePct) ? { likePct, ratings: e.numRatings ?? null, rank: null } : null;
  }

  if (e.endorsementType === 'most_liked') {
    const blob = JSON.stringify(ci);
    const rank = parseInt(blob.match(RANK_RE)?.[1], 10);
    const visible = blob.match(VISIBLE_RATING_RE);
    return {
      likePct: visible ? parseInt(visible[1], 10) : null,
      ratings: visible ? parseInt(visible[2], 10) : null,
      rank: Number.isFinite(rank) ? rank : null,
    };
  }
  return null;
}

// Shrinks a dish's percentage toward the prior so 4 ratings can't swing the score like 400 do.
export function smoothedLikePct({ likePct, ratings } = {}) {
  if (likePct == null || !ratings) return null;
  return (likePct * ratings + PRIOR_PCT * PRIOR_WEIGHT) / (ratings + PRIOR_WEIGHT);
}

// Score points to add to a dish's value score: negative below the prior, small bonus above it.
export function dishQualityAdjustment(rating) {
  const smoothed = smoothedLikePct(rating);
  if (smoothed == null) return 0;
  const raw = (smoothed - PRIOR_PCT) * 0.5;
  return Math.round(Math.min(MAX_BONUS, Math.max(MAX_PENALTY, raw)));
}
