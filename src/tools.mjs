// Tool implementations. Each takes the Backend and returns compact JSON-able data.
// Payloads for the /_p/api endpoints live here in one place — easy to adjust
// once we capture real request bodies.

import { normFeed, normStoreListItem, normStoreDetail, normMenu } from './lib/models.mjs';
import { collectStoreDeals, rankDeals, valueScore } from './lib/deals.mjs';

const BASE = 'https://www.ubereats.com';

const payloads = {
  getFeedV1: () => ({}),
  allStoresV1: (offset) => ({ offset }),
  getStoreV1: (storeUuid) => ({ storeUuid }),
};

async function storeListPage(be, offset) {
  const d = await be.callApi('allStoresV1', payloads.allStoresV1(offset), {
    ttlMs: 2 * 60 * 1000,
    navUrl: BASE + '/feed',
  });
  const stores = (d?.feedItems || []).map(normStoreListItem).filter(Boolean);
  return { stores, hasMore: !!d?.meta?.hasMore, nextOffset: d?.meta?.offset ?? null };
}

export async function storeDetail(be, uuid, navUrl = null) {
  const d = await be.callApi('getStoreV1', payloads.getStoreV1(uuid), {
    ttlMs: 5 * 60 * 1000,
    navUrl: navUrl ? BASE + navUrl : null,
  });
  return { detail: normStoreDetail(d), menu: normMenu(d), raw: d };
}

export async function browseFeed(be, { maxStores = 40 } = {}) {
  const d = await be.callApi('getFeedV1', payloads.getFeedV1(), { ttlMs: 60 * 1000 });
  return normFeed(d, { maxStores });
}

export async function listStores(be, { offset = 0, limit = 25 } = {}) {
  const page = await storeListPage(be, offset);
  return { ...page, stores: page.stores.slice(0, limit) };
}

export async function searchStores(be, { query, limit = 20, pages = 3 } = {}) {
  const q = (query || '').toLowerCase();
  const out = [];
  let offset = 0;
  for (let i = 0; i < pages && out.length < limit * 3; i++) {
    const page = await storeListPage(be, offset);
    for (const s of page.stores) {
      const hay = `${s.name} ${(s.signposts || []).join(' ')} ${(s.promo || '')}`.toLowerCase();
      if (!q || hay.includes(q)) out.push(s);
    }
    if (!page.hasMore) break;
    offset = page.nextOffset ?? offset + 50;
  }
  return { query, count: Math.min(out.length, limit), stores: out.slice(0, limit) };
}

export async function getStore(be, { storeUuid }) {
  const { detail } = await storeDetail(be, storeUuid);
  return detail;
}

export async function getMenu(be, { storeUuid }) {
  const { menu } = await storeDetail(be, storeUuid);
  return menu;
}

// The headline tool: best 2-for-1 / promo deals across nearby stores.
// Filters: minRating (strictly greater), maxFee (list badge fee — €0 for Uber
// One), bogoOnly, maxItemPrice (cap on the item's list price for item-level
// BOGO deals), cuisine, pages of stores to scan.
export async function findDeals(be, { limit = 10, cuisine = null, maxFee = null, minRating = null, bogoOnly = false, maxItemPrice = null, pages = 2 } = {}) {
  const allDeals = [];
  let offset = 0;
  for (let i = 0; i < pages; i++) {
    const page = await storeListPage(be, offset);
    for (const s of page.stores) {
      // fee filter prefers the list badge ("€0 Delivery Fee" = Uber One)
      const badgeFee = s.fee ?? null;
      let detail, menu;
      try {
        ({ detail, menu } = await storeDetail(be, s.uuid, s.url));
      } catch (e) {
        continue; // one store failing shouldn't sink the search
      }
      const rating = detail.rating ?? s.rating ?? null;
      const fee = badgeFee ?? detail.fee ?? null;
      if (minRating != null && (rating == null || !(rating > minRating))) continue;
      if (maxFee != null && (fee == null || fee > maxFee)) continue;
      if (cuisine) {
        const hay = `${(detail.cuisines || []).join(' ')} ${(detail.tags || []).join(' ')} ${detail.name}`.toLowerCase();
        if (!hay.includes(cuisine.toLowerCase())) continue;
      }
      allDeals.push(...collectStoreDeals(detail, s, menu));
    }
    if (!page.hasMore) break;
    offset = page.nextOffset ?? offset + 50;
  }
  let filtered = allDeals;
  if (bogoOnly) filtered = filtered.filter((d) => d.kind === 'bogo');
  if (maxItemPrice != null) {
    filtered = filtered.filter((d) => d.item == null || (d.price != null && d.price <= maxItemPrice));
  }
  // dedupe (same store+item+text can appear from list signposts and detail promo)
  const seen = new Set();
  const unique = allDeals.filter((d) => {
    const k = `${d.storeId}|${d.item ?? ''}|${d.text}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const ranked = rankDeals(unique, { limit });
  return { count: ranked.length, deals: ranked };
}

// Best price-for-value individual items across stores (deal-adjusted).
export async function bestValue(be, { limit = 10, cuisine = null, maxPrice = null, pages = 2 } = {}) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < pages; i++) {
    const page = await storeListPage(be, offset);
    for (const s of page.stores) {
      let detail, menu;
      try {
        ({ detail, menu } = await storeDetail(be, s.uuid, s.url));
      } catch { continue; }
      if (cuisine) {
        const hay = `${(detail.cuisines || []).join(' ')} ${(detail.tags || []).join(' ')} ${detail.name}`.toLowerCase();
        if (!hay.includes(cuisine.toLowerCase())) continue;
      }
      for (const sec of menu.sections || []) {
        for (const it of sec.items || []) {
          if (it.soldOut) continue;
          if (maxPrice != null && (it.effectivePrice ?? it.price) > maxPrice) continue;
          out.push({
            item: it.name,
            section: sec.title,
            price: it.price,
            effectivePrice: it.effectivePrice,
            bogo: it.bogo || null,
            discountPct: it.bogo ? Math.round((it.bogo.get / (it.bogo.buy + it.bogo.get)) * 100) : 0,
            store: detail.name,
            storeId: detail.id,
            rating: detail.rating ?? s.rating ?? null,
            fee: detail.fee ?? s.fee ?? null,
            eta: detail.eta ?? s.eta ?? null,
            likePct: it.likePct ?? null,
            ratings: it.ratings ?? null,
            valueScore: valueScore({
              rating: detail.rating ?? s.rating,
              fee: detail.fee ?? s.fee,
              effectivePrice: it.effectivePrice ?? it.price,
              discountPct: it.bogo ? Math.round((it.bogo.get / (it.bogo.buy + it.bogo.get)) * 100) : 0,
              likePct: it.likePct,
              ratings: it.ratings,
            }),
          });
        }
      }
    }
    if (!page.hasMore) break;
    offset = page.nextOffset ?? offset + 50;
  }
  const seen = new Set();
  const unique = out.filter((d) => {
    const k = `${d.storeId}|${d.item}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  unique.sort((a, b) => b.valueScore - a.valueScore);
  return { count: Math.min(unique.length, limit), items: unique.slice(0, limit) };
}
