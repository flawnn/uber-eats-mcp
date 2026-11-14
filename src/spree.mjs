// Cuisine spree: scan all stores matching a cuisine, pull every menu with a
// small concurrency pool, score items with the meal-aware value score, and
// apply dietary exclusions (ham/pork). Designed to run several sprees in
// parallel against one Backend (cache is shared).
import * as tools from './tools.mjs';
import { valueScore, classifyMeal, PORK_HAM_RE } from './lib/deals.mjs';

async function mapPool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const it = items[i++];
      out.push(await fn(it).catch(() => null));
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

export async function spree(be, cuisine, { pages = 4, limit = 30, excludeRe = PORK_HAM_RE, location = null, minRatingPct = 70 } = {}) {
  const q = cuisine.toLowerCase();
  // collect ALL stores: from the feed pages (current location) or from a city
  // page (/fr-en/city/<slug>) when `location` is given
  const all = [];
  const seenUuid = new Set();
  if (location) {
    // visiting the city page sets the session location server-side; the store
    // APIs then reflect that city, so we enumerate via the usual paging loop
    await be.ensurePage();
    await be.polite.beforeNavigate(`https://www.ubereats.com/fr-en/city/${location}`);
    // dedicated tab: the daemon keepalive navigates the shared page, which would
    // cancel our goto; the location cookie is per-context so a temp page is enough
    const tmp = await be.ctx.newPage();
    await tmp.goto(`https://www.ubereats.com/fr-en/city/${location}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await tmp.waitForTimeout(4000);
    await tmp.close().catch(() => {});
  }
  {
    let offset = 0;
    for (let i = 0; i < pages; i++) {
      const page = await tools.listStores(be, { offset, limit: 50 });
      for (const s of page.stores) if (!seenUuid.has(s.uuid)) { seenUuid.add(s.uuid); all.push(s); }
      if (!page.hasMore) break;
      offset = page.nextOffset ?? offset + 50;
    }
  }

  // fetch details+menus pooled; then match on name/signposts AND detail cuisines/tags
  const fetched = await mapPool(all, 4, async (s) => {
    const { detail, menu } = await tools.storeDetail(be, s.uuid, s.url);
    return { list: s, detail, menu };
  });
  const stores = fetched.filter((st) => {
    const hay = `${st.list.name} ${(st.list.signposts || []).join(' ')} ${(st.detail.cuisines || []).join(' ')} ${(st.detail.tags || []).join(' ')} ${st.detail.name}`.toLowerCase();
    return hay.includes(q);
  });

  // rating threshold: ratingPct = rating/5*100; below minRatingPct gets penalized+flagged
  const ratingPctOf = (st) => {
    const r = st.detail.rating ?? st.list.rating;
    return r == null ? null : (r / 5) * 100;
  };

  const seenItem = new Set();
  const items = [];
  const storeItems = new Map(); // storeId -> items[]
  for (const st of stores) {
    const storeIsCuisine = `${st.detail.name} ${(st.detail.cuisines || []).join(' ')} ${(st.detail.tags || []).join(' ')}`.toLowerCase().includes(q);
    storeItems.set(st.detail.id, []);
    for (const sec of st.menu.sections || []) {
      for (const it of sec.items || []) {
        if (it.soldOut) continue;
        const text = `${it.name} ${it.desc || ''}`;
        if (excludeRe && excludeRe.test(text)) continue;
        const key = `${st.detail.id}|${it.name}`;
        if (seenItem.has(key)) continue;
        seenItem.add(key);
        // at a matching-cuisine store, mains count as full meals (pizza/burger level)
        const cls = classifyMeal(it);
        // at a matching-cuisine store, anything that isn't a side/drink is a full meal
        const meal = storeIsCuisine && cls.kind !== 'side' ? 1 : cls.meal;
        const discountPct = it.bogo ? Math.round((it.bogo.get / (it.bogo.buy + it.bogo.get)) * 100) : 0;
        const ratingPct = ratingPctOf(st);
        const lowRating = ratingPct != null && ratingPct < minRatingPct;
        const rec = {
          item: it.name,
          section: sec.title,
          price: it.price,
          effectivePrice: it.effectivePrice,
          bogo: it.bogo || null,
          discountPct,
          mealKind: cls.kind,
          meal: Math.round(meal * 100) / 100,
          desc: it.desc,
          img: it.img,
          store: st.detail.name,
          storeId: st.detail.id,
          rating: st.detail.rating ?? st.list.rating ?? null,
          ratingPct: ratingPct == null ? null : Math.round(ratingPct),
          lowRating,
          likePct: it.likePct ?? null,
          ratings: it.ratings ?? null,
          feeBadge: st.list.fee ?? null,
          eta: st.detail.eta ?? st.list.eta ?? null,
          valueScore: valueScore({
            rating: st.detail.rating ?? st.list.rating,
            fee: st.list.fee ?? st.detail.fee,
            effectivePrice: it.effectivePrice ?? it.price,
            discountPct,
            meal,
            likePct: it.likePct,
            ratings: it.ratings,
          }) - (lowRating ? 15 : 0),
        };
        items.push(rec);
        storeItems.get(st.detail.id).push(rec);
      }
    }
  }
  items.sort((a, b) => b.valueScore - a.valueScore);

  // store ranking: best item value + BOGO count + meal completeness (full meals
  // available) − fee. Distance is deliberately NOT scored (user: bang for buck).
  const seenStore = new Set();
  const topStores = stores
    .filter((st) => (seenStore.has(st.detail.id) ? false : (seenStore.add(st.detail.id), true)))
    .map((st) => {
      const all = (st.menu.sections || []).flatMap((s) => s.items || []).filter((i) => !i.soldOut);
      const bogoCount = all.filter((i) => i.bogo).length;
      const its = storeItems.get(st.detail.id) || [];
      const fullMeals = its.filter((i) => i.meal >= 1).length;
      const best = its.length ? Math.max(...its.map((i) => i.valueScore)) : 0;
      const fee = st.list.fee ?? st.detail.fee ?? 0;
      const ratingPct = ratingPctOf(st);
      const lowRating = ratingPct != null && ratingPct < minRatingPct;
      const storeScore = Math.round(best + bogoCount * 4 + (fullMeals > 0 ? 20 : 0) + (its.length ? (fullMeals / its.length) * 10 : 0) - fee * 2 - (lowRating ? 25 : 0));
      return {
        name: st.detail.name,
        id: st.detail.id,
        rating: st.detail.rating ?? st.list.rating ?? null,
        ratingPct: ratingPct == null ? null : Math.round(ratingPct),
        lowRating,
        eta: st.detail.eta ?? st.list.eta ?? null,
        feeBadge: st.list.fee ?? null,
        items: all.length,
        bogoCount,
        fullMealCount: fullMeals,
        storeScore,
      };
    })
    .sort((a, b) => b.storeScore - a.storeScore)
    .slice(0, 15);

  return {
    cuisine,
    location: location || 'current',
    minRatingPct,
    scannedCount: all.length,
    matchedCount: stores.length,
    storeCount: stores.length,
    itemCount: items.length,
    topItems: items.slice(0, limit),
    topStores,
  };
}
