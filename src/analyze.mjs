// Fine-grained store analysis: per-store stats + cross-store aggregates.
import { valueScore } from './lib/deals.mjs';

// Analyze one store's detail+menu into a compact but fine-grained record.
export function analyzeStore(listItem, detail, menu) {
  const items = (menu?.sections || []).flatMap((s) => s.items || []);
  const available = items.filter((i) => !i.soldOut);
  const prices = available.map((i) => i.effectivePrice ?? i.price).filter((p) => p != null);
  const bogoItems = available.filter((i) => i.bogo);
  const avg = prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null;
  const min = prices.length ? Math.min(...prices) : null;
  const rating = detail.rating ?? listItem.rating ?? null;
  const fee = listItem.fee ?? detail.fee ?? null;
  return {
    id: detail.id ?? listItem.id,
    name: detail.name ?? listItem.name,
    rating,
    reviews: detail.reviews ?? listItem.reviews ?? null,
    eta: detail.eta ?? listItem.eta ?? null,
    feeBadge: listItem.fee ?? null,      // €0 badge = free delivery with Uber One
    feeRaw: detail.fee ?? null,          // pre-membership service fee
    distance: detail.distance ?? null,
    priceBucket: detail.priceBucket ?? null,
    cuisines: detail.cuisines ?? [],
    address: detail.address ?? null,
    open: detail.open ?? null,
    promo: detail.promo ?? listItem.promo ?? null,
    hasPromo: !!detail.hasPromo,
    signposts: listItem.signposts ?? [],
    menuStats: {
      sections: (menu?.sections || []).length,
      items: items.length,
      available: available.length,
      soldOut: items.length - available.length,
      avgEffectivePrice: avg,
      minEffectivePrice: min,
      bogoCount: bogoItems.length,
    },
    bogoItems: bogoItems.slice(0, 10).map((i) => ({
      name: i.name, price: i.price, effectivePrice: i.effectivePrice, bogo: i.bogo, desc: i.desc, img: i.img,
    })),
    dealScore: bogoItems.length ? 50 : detail.hasPromo ? 25 : 0,
    valueScore: valueScore({ rating, fee, effectivePrice: avg ?? 99, discountPct: bogoItems.length ? 50 : 0 }),
  };
}

// Cross-store aggregates for the report.
export function aggregate(storesIn) {
  const seenStore = new Set();
  const stores = storesIn.filter((s) => (seenStore.has(s.id) ? false : (seenStore.add(s.id), true)));
  const withBogo = stores.filter((s) => s.menuStats.bogoCount > 0 || /buy\s*\d+\s*,?\s*get\s*\d+|2\s*for\s*1/i.test(s.promo || ''));
  const byValue = [...stores].sort((a, b) => b.valueScore - a.valueScore);
  const byRating = [...stores].filter((s) => s.rating != null).sort((a, b) => b.rating - a.rating);
  const freeDelivery = stores.filter((s) => s.feeBadge === 0);
  const cuisines = {};
  for (const s of stores) for (const c of s.cuisines) cuisines[c] = (cuisines[c] || 0) + 1;
  const allBogoItems = stores
    .flatMap((s) => s.bogoItems.map((i) => ({ ...i, store: s.name, storeId: s.id, rating: s.rating, feeBadge: s.feeBadge, eta: s.eta })))
    .sort((a, b) => (b.effectivePrice ?? 99) - (a.effectivePrice ?? 99) * -1 || a.effectivePrice - b.effectivePrice);
  const seenBogo = new Set();
  const bestBogoItems = stores
    .flatMap((s) => s.bogoItems.map((i) => ({
      ...i, store: s.name, storeId: s.id, rating: s.rating, feeBadge: s.feeBadge, eta: s.eta,
      valueScore: valueScore({ rating: s.rating, fee: s.feeBadge ?? s.feeRaw, effectivePrice: i.effectivePrice, discountPct: 50 }),
    })))
    .filter((i) => { const k = `${i.storeId}|${i.name}`; return seenBogo.has(k) ? false : (seenBogo.add(k), true); })
    .sort((a, b) => b.valueScore - a.valueScore)
    .slice(0, 20);
  return {
    storeCount: stores.length,
    withBogoCount: withBogo.length,
    freeDeliveryCount: freeDelivery.length,
    topByValue: byValue.slice(0, 10).map((s) => ({ name: s.name, id: s.id, rating: s.rating, valueScore: s.valueScore, bogoCount: s.menuStats.bogoCount, feeBadge: s.feeBadge, eta: s.eta })),
    topByRating: byRating.slice(0, 10).map((s) => ({ name: s.name, rating: s.rating, reviews: s.reviews, eta: s.eta, promo: s.promo })),
    bestBogoItems,
    cuisineBreakdown: Object.entries(cuisines).sort((a, b) => b[1] - a[1]).slice(0, 15),
  };
}
