// Normalizers: turn raw /_p/api payloads into compact, LLM-friendly shapes.
// Prices arrive in cents; we emit euros as numbers. Long uuids are shortened
// for display (full uuid is kept alongside when needed for follow-up calls).

export const shortId = (u) => (u || '').replace(/-/g, '').slice(0, 8);
export const eur = (cents) => (cents == null ? null : Math.round(cents) / 100);

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

function badgeTexts(store) {
  return (store?.meta || []).map((m) => m?.text).filter(Boolean);
}

function feeFromBadges(badges) {
  const m = badges.find((t) => /delivery fee/i.test(t));
  if (!m) return null;
  const v = m.match(/€\s?([\d.,]+)/);
  return v ? parseFloat(v[1].replace(',', '.')) : null;
}

function etaFromBadges(badges) {
  return badges.find((t) => /\d+\s?min/i.test(t)) || null;
}

// Store as it appears inside feed/list items (allStoresV1, getFeedV1 REGULAR_STORE)
export function normStoreListItem(item) {
  const s = item?.store ? item.store : item;
  if (!s || !s.storeUuid) return null;
  const badges = badgeTexts(s);
  return clean({
    id: shortId(s.storeUuid),
    uuid: s.storeUuid,
    name: s.title?.text ?? (typeof s.title === 'string' ? s.title : null),
    rating: parseFloat(s.rating?.text ?? s.rating?.ratingValue) || null,
    reviews: s.rating?.reviewCount ?? null,
    eta: etaFromBadges(badges),
    fee: feeFromBadges(badges),
    sponsored: badges.some((t) => /sponsored/i.test(t)),
    signposts: (s.signposts || []).map((p) => p?.text).filter(Boolean),
    promo: s.storeAd?.text ?? s.storeAd?.title ?? null,
    fav: !!s.favorite,
    url: s.actionUrl ?? null,
  });
}

// Full store record from getStoreV1
export function normStoreDetail(d) {
  return clean({
    id: shortId(d.uuid),
    uuid: d.uuid,
    name: d.title,
    rating: d.rating?.ratingValue ?? null,
    reviews: d.rating?.reviewCount ?? null,
    eta: d.etaRange?.text ?? null,
    fee: d.fareInfo?.serviceFee ?? null,
    priceBucket: d.priceBucket ?? null,
    cuisines: (d.cuisineList || []).map((c) => c?.text ?? c).filter(Boolean),
    tags: d.categories ?? [],
    address: d.location
      ? [d.location.streetAddress, d.location.city, d.location.postalCode].filter(Boolean).join(', ')
      : null,
    open: d.isOpen,
    orderable: d.isOrderable,
    distance: d.distanceBadge?.text ?? null,
    hasPromo: !!d.hasStorePromotion,
    promo: d.suggestedPromotion?.text ?? d.promotion?.text ?? null,
    promoUuid: d.suggestedPromotion?.promotionUuid ?? null,
  });
}

// One catalog item (dish) from getStoreV1 catalogSectionsMap
export function normItem(ci) {
  const bogo = ci.itemPromotion?.buyXGetYItemPromotion || null;
  const price = eur(ci.price);
  const effectivePrice =
    bogo && bogo.getQuantity > 0
      ? Math.round((price * bogo.buyQuantity) / (bogo.buyQuantity + bogo.getQuantity) * 100) / 100
      : price;
  return clean({
    id: shortId(ci.uuid),
    name: ci.title ?? null,
    price,
    effectivePrice,
    soldOut: ci.isSoldOut ? true : null,
    customizable: ci.hasCustomizations ? true : null,
    bogo: bogo ? { buy: bogo.buyQuantity, get: bogo.getQuantity, max: bogo.maxRedemptionCount ?? null } : null,
    desc: (ci.itemDescription || '').split('\n')[0]?.slice(0, 140) || null,
    img: ci.imageUrl || null,
  });
}

// Menu: sections -> items, from getStoreV1
export function normMenu(d) {
  const sections = [];
  for (const sec of d.sections || []) {
    const items = [];
    // items can hang off the section uuid itself or off its subsection uuids
    const keys = [sec.uuid, ...(sec.subsectionUuids || [])];
    for (const key of keys) {
      for (const entry of d.catalogSectionsMap?.[key] || []) {
        if (entry.type === 'EATER_MESSAGE') continue;
        const payload = entry.payload?.standardItemsPayload;
        for (const ci of payload?.catalogItems || []) items.push(normItem(ci));
      }
    }
    if (items.length) sections.push(clean({ title: sec.title, onSale: sec.isOnSale ? true : null, items }));
  }
  return { store: clean({ id: shortId(d.uuid), name: d.title }), sections };
}

// Personalized feed from getFeedV1
export function normFeed(d, { maxStores = 40 } = {}) {
  const sectionTitles = [];
  const stores = [];
  for (const it of d.feedItems || []) {
    if (it.type === 'SECTION_HEADER') sectionTitles.push(it.title?.text ?? it.title ?? null);
    else if (it.type === 'REGULAR_STORE' && it.store) stores.push(normStoreListItem(it));
    else if (it.payload?.stores || it.carousel?.stores) {
      for (const s of it.payload?.stores || it.carousel?.stores || []) {
        stores.push(normStoreListItem(s?.store ? s : { store: s }));
      }
    } else if (it.payload?.catalogItems) {
      // item carousels: keep as compact item cards with their store context if any
      for (const ci of it.payload.catalogItems || []) {
        const n = normItem(ci);
        if (n) stores.push(null); // placeholder, filtered below
      }
    }
  }
  const seen = new Set();
  const compact = stores
    .filter(Boolean)
    .filter((s) => (seen.has(s.uuid) ? false : (seen.add(s.uuid), true)))
    .slice(0, maxStores);
  return clean({ sections: sectionTitles.filter(Boolean), hasMore: d.meta?.hasMore ?? null, stores: compact });
}
