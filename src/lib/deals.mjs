// Deal extraction + price-for-value scoring.
// 2-for-1 comes in two forms:
//  - structured: itemPromotion.buyXGetYItemPromotion on a menu item (best signal)
//  - textual: store-level promotion text ("2 for 1", "Buy 1, get 1", ...)

export const BUY_GET_RE = /buy\s*(\d+)\s*,?\s*get\s*(\d+)/i;
export const BOGO_TEXT_RE = /(2\s*for\s*1|bogo|2\s*x\s*1|2\s*pour\s*1|deux\s+pour\s+le\s+prix\s+d|buy\s*\d+\s*,?\s*get\s*\d+)/i;
export const PERCENT_RE = /(\d{1,3})\s?%\s*off|(-\d{1,3}\s?%)/i;
export const FIXED_OFF_RE = /€\s*(\d+(?:[.,]\d+)?)\s*off/i;

export function classifyPromoText(text) {
  if (!text) return null;
  if (BOGO_TEXT_RE.test(text)) return 'bogo';
  if (PERCENT_RE.test(text)) return 'percent';
  if (FIXED_OFF_RE.test(text)) return 'fixed_off';
  if (/free\s*delivery|livraison\s*offerte|€0/i.test(text)) return 'free_delivery';
  return 'other';
}

export function bogoQuantitiesFromText(text) {
  const m = text?.match(BUY_GET_RE);
  return m ? { buy: parseInt(m[1], 10), get: parseInt(m[2], 10) } : { buy: 1, get: 1 };
}

export function discountPctOf(deal) {
  if (deal.kind === 'bogo' && deal.buy != null && deal.get != null) {
    return Math.round((deal.get / (deal.buy + deal.get)) * 100);
  }
  if (deal.kind === 'percent' && deal.pct != null) return deal.pct;
  return 0;
}

// Collect deals for one store: store-level promo (detail promo, storeAd, list
// signposts like "Buy 1, get 1") + item-level BOGO from its menu.
export function collectStoreDeals(storeDetail, listItem, menu) {
  const out = [];
  const base = {
    store: storeDetail?.name ?? listItem?.name,
    storeId: storeDetail?.id ?? listItem?.id ?? null,
    uuid: storeDetail?.uuid ?? listItem?.uuid ?? null,
    rating: storeDetail?.rating ?? listItem?.rating ?? null,
    fee: storeDetail?.fee ?? listItem?.fee ?? null,
    eta: storeDetail?.eta ?? listItem?.eta ?? null,
  };
  const texts = [storeDetail?.promo, listItem?.promo, ...(listItem?.signposts || [])].filter(Boolean);
  for (const promoText of texts) {
    const kind = classifyPromoText(promoText);
    if (!kind) continue;
    const q = kind === 'bogo' ? bogoQuantitiesFromText(promoText) : null;
    out.push({
      ...base,
      kind,
      text: promoText.trim(),
      discountPct:
        kind === 'percent'
          ? parseInt(((promoText.match(PERCENT_RE) || [])[1] || (promoText.match(PERCENT_RE) || [])[2] || '0').replace('-', ''), 10)
          : kind === 'bogo'
            ? Math.round((q.get / (q.buy + q.get)) * 100)
            : 0,
      item: null,
    });
  }
  for (const sec of menu?.sections || []) {
    for (const it of sec.items || []) {
      if (it.bogo && !it.soldOut) {
        out.push({
          ...base,
          kind: 'bogo',
          text: `${it.bogo.buy}+${it.bogo.get} on "${it.name}"`,
          item: it.name,
          itemId: it.id,
          price: it.price,
          effectivePrice: it.effectivePrice,
          discountPct: discountPctOf({ kind: 'bogo', buy: it.bogo.buy, get: it.bogo.get }),
          section: sec.title,
          desc: it.desc ?? null,
          img: it.img ?? null,
        });
      }
    }
  }
  return out;
}

// Ham/pork exclusion (user preference). Note: \bham\b does NOT match "hamburger";
// pastrami (beef) is unaffected.
export const PORK_HAM_RE = /\bjambon\b|\bham\b|porc|pork|bacon|lardons?|chorizo|salami|pepperoni|saucisson|coppa|guanciale|prosciutto|parma/i;

// "Full meal" classification:
//  - combo (menu/formule/combo/duo, "+ frites", "with fries") -> meal 1.0
//  - main dish (pizza/burger/bowl/wrap/kebab/bagel/...)        -> meal 1.0
//    (user: "level of a pizza, or a burger" counts as a full meal)
//  - side/drink/dessert ALONE (fries, coca, cake...)            -> meal 0.15 (NOT a meal)
//  - unknown                                                     -> 0.4
const COMBO_RE = /\b(menu|formule|combo|duo|trio|plateau)\b|\+\s?frites|with fries|w\/\s?fries/i;
const MAIN_RE = /\b(pizza|burger|bowl|wrap|kebab|durum|bagel|sandwich|panini|maki|poke|poké|curry|pasta|pâtes|risotto|assiette|tacos?)\b/i;
const SIDE_RE = /frites?|fries|sides|garlic bread|\bbread\b|boisson|drink|coca|pepsi|dessert|cake|cookie|glace|sorbet|nuggets?|sticks/i;
export function classifyMeal(item) {
  const text = `${item?.name || ''} ${item?.desc || ''}`;
  if (COMBO_RE.test(text)) return { kind: 'combo', meal: 1 };
  if (MAIN_RE.test(text)) return { kind: 'main', meal: 1 };
  if (SIDE_RE.test(text)) return { kind: 'side', meal: 0.15 };
  return { kind: 'other', meal: 0.4 };
}
export function mealiness(item) {
  return classifyMeal(item).meal;
}

// Transparent value score: rating matters, deals add a lot, meal-worthiness adds
// up to 60, price and fee subtract.
export function valueScore({ rating, fee, effectivePrice, discountPct, meal = 0 }) {
  const base = (rating || 4.0) * 20; // 0..100
  const mealBonus = meal * 60;
  const pricePenalty = Math.min(effectivePrice ?? 0, 40) * 1.2;
  const feePenalty = (fee ?? 0) * 2;
  return Math.round(base + (discountPct || 0) + mealBonus - pricePenalty - feePenalty);
}

export function rankDeals(deals, { limit = 10 } = {}) {
  return deals
    .map((d) => ({ ...d, valueScore: valueScore({ rating: d.rating, fee: d.fee, effectivePrice: d.effectivePrice ?? d.price, discountPct: d.discountPct }) }))
    .sort((a, b) => b.valueScore - a.valueScore || (b.discountPct || 0) - (a.discountPct || 0))
    .slice(0, limit);
}
