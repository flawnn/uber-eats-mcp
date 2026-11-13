// One-shot: open headed browser, wait for login (SSO silent re-auth or manual),
// the moment the probe confirms, save the session AND run the live deal hunt
// in the same browser session (avoids the sessionStorage export problem).
// Usage: node src/login-and-run.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PoliteSession } from './lib/polite.mjs';
import { probeAuth, saveSession, SessionState } from './lib/session.mjs';
import { Backend } from './lib/api.mjs';
import * as tools from './tools.mjs';
import { analyzeStore, aggregate } from './analyze.mjs';
import { spree } from './spree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// optional preference filter, e.g.: node src/login-and-run.mjs "pizza"
// or "spree" to run the parallel burger + pizza spree
const arg = process.argv[2] || null;
const cuisine = arg === 'spree' ? null : arg;
const doSpree = arg === 'spree';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36';

const ctx = await chromium.launchPersistentContext(path.join(root, 'browser-profile'), {
  headless: false,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  colorScheme: 'light',
  userAgent: UA,
  locale: 'en-US',
  args: ['--lang=en-US'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
const polite = new PoliteSession({
  logFile: path.join(root, 'logs', `loginrun-${new Date().toISOString().replace(/[:.]/g, '-')}.log`),
  strict: false,
  maxNavigations: Number.MAX_SAFE_INTEGER,
  apiBudget: Number.MAX_SAFE_INTEGER,
  hardBudget: Number.MAX_SAFE_INTEGER,
});
polite.attach(page);

await page.goto('https://www.ubereats.com/feed', { waitUntil: 'domcontentloaded', timeout: 45000 });
console.log('Waiting for auth (SSO silent re-auth or manual sign-in in the window)...');

let authed = false;
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline && !authed) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const s = await probeAuth(page);
    if (s === SessionState.AUTHENTICATED) authed = true;
  } catch { /* mid-navigation */ }
}
if (!authed) {
  console.error('AUTH NOT CONFIRMED in time — sign in inside the window and rerun.');
  await ctx.close();
  process.exit(3);
}
console.log('AUTH CONFIRMED — saving session and running live hunt in this same session...');

await saveSession(ctx, path.join(root, 'fixtures'));
// capture ALL cookies (all domains, incl. httpOnly) as an extra session artifact
try {
  const allCookies = await ctx.cookies();
  fs.writeFileSync(path.join(root, 'fixtures', 'cookies-all.json'), JSON.stringify({ savedAt: new Date().toISOString(), cookies: allCookies }, null, 1));
  console.log('saved cookies-all.json:', allCookies.length, 'cookies across all domains');
} catch (e) { console.log('cookie dump failed:', e.message); }
// dump localStorage + sessionStorage for the ubereats origin (sessionStorage is
// not part of storageState, and the eater binding appears to live there)
const store = await page.evaluate(() => ({
  localStorage: Object.fromEntries(Object.entries(localStorage)),
  sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
})).catch(() => null);
if (store) {
  fs.writeFileSync(path.join(root, 'fixtures', 'session-storage.json'), JSON.stringify(store, null, 1));
  console.log('saved session-storage.json:', Object.keys(store.localStorage).length, 'ls keys,', Object.keys(store.sessionStorage).length, 'ss keys');
}

const be = new Backend({ root, mock: false, apiBudget: 600, hardBudget: 20000 });
await be.attachExternal(ctx, page);

const report = { at: new Date().toISOString(), session: 'live-authenticated' };
try {
  report.feed = await tools.browseFeed(be, { maxStores: 10 });
  console.log('FEED OK:', report.feed.stores?.length, 'stores');
  report.deals = await tools.findDeals(be, { limit: 25, pages: 4, minRating: 4, maxFee: 0, bogoOnly: true, maxItemPrice: 15, cuisine });
  console.log('DEALS OK:', report.deals.count);
  report.value = await tools.bestValue(be, { limit: 15, pages: 4, maxPrice: 15, cuisine });
  console.log('VALUE OK:', report.value.count);

  // fine-grained store analysis across store pages (preference-filtered if given)
  const analyzed = [];
  let offset = 0;
  for (let i = 0; i < 4; i++) {
    const page = await tools.listStores(be, { offset, limit: 50 });
    for (const s of page.stores) {
      try {
        const { detail, menu } = await tools.storeDetail(be, s.uuid, s.url);
        const rec = analyzeStore(s, detail, menu);
        if (cuisine) {
          const hay = `${rec.name} ${(rec.cuisines || []).join(' ')} ${(rec.signposts || []).join(' ')} ${rec.promo || ''}`.toLowerCase();
          if (!hay.includes(cuisine.toLowerCase())) continue;
        }
        analyzed.push(rec);
      } catch { /* skip failing store */ }
    }
    if (!page.hasMore) break;
    offset = page.nextOffset ?? offset + 50;
  }
  const analysis = { at: new Date().toISOString(), storeCount: analyzed.length, stores: analyzed, aggregates: aggregate(analyzed) };
  fs.writeFileSync(path.join(root, 'fixtures', 'analysis.json'), JSON.stringify(analysis, null, 1));
  fs.writeFileSync(path.join(root, 'fixtures', 'ANALYSIS.md'), renderMarkdown(analysis));
  console.log('ANALYSIS OK:', analysis.storeCount, 'stores -> fixtures/analysis.json + ANALYSIS.md');

  if (doSpree) {
    // burger spree and pizza spree in parallel, sharing one session + cache
    const [burgers, pizza] = await Promise.all([spree(be, 'burger'), spree(be, 'pizza')]);
    const out = { at: new Date().toISOString(), burgers, pizza };
    fs.writeFileSync(path.join(root, 'fixtures', 'spree.json'), JSON.stringify(out, null, 1));
    fs.writeFileSync(path.join(root, 'fixtures', 'SPREE.md'), renderSpree(out));
    console.log('SPREE OK: burgers', burgers.storeCount + '/' + burgers.matchedCount, 'stores,', burgers.itemCount, 'items | pizza', pizza.storeCount + '/' + pizza.matchedCount, 'stores,', pizza.itemCount, 'items');
  }
} catch (e) {
  report.error = String(e && e.message || e);
  console.error('HUNT ERROR:', report.error);
}
fs.writeFileSync(path.join(root, 'fixtures', 'live-report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1).slice(0, 7000));
console.log('LOGIN-AND-RUN DONE');
await ctx.close();

function renderSpree(out) {
  const lines = [`# Cuisine spree — ${out.at}`, ''];
  for (const key of ['burgers', 'pizza']) {
    const s = out[key];
    lines.push(`## ${key.toUpperCase()} — ${s.storeCount} stores (${s.matchedCount} matched), ${s.itemCount} items (ham/pork excluded)`);
    lines.push('\n### Top items (meal-aware value score)');
    lines.push('| Score | Item | Store | Rating | ETA | Fee | Price | Effective | BOGO | Meal |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const i of s.topItems.slice(0, 20)) {
      lines.push(`| ${i.valueScore} | ${i.item} | ${i.store} | ${i.rating ?? '-'} | ${i.eta ?? '-'} | ${i.feeBadge ?? '-'} | €${i.price} | **€${i.effectivePrice}** | ${i.bogo ? i.bogo.buy + '+' + i.bogo.get : '-'} | ${i.meal} |`);
    }
    lines.push('\n### Top stores');
    lines.push('| Store | Rating | ETA | Fee badge | Items | BOGO items |');
    lines.push('|---|---|---|---|---|---|');
    for (const st of s.topStores) lines.push(`| ${st.name} | ${st.rating ?? '-'} | ${st.eta ?? '-'} | ${st.feeBadge ?? '-'} | ${st.items} | ${st.bogoCount} |`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function renderMarkdown(a) {
  const agg = a.aggregates;
  const lines = [];
  lines.push(`# Uber Eats store analysis — ${a.at}`);
  lines.push(`\n${a.storeCount} stores analyzed | ${agg.withBogoCount} with 2-for-1/BOGO | ${agg.freeDeliveryCount} with €0 delivery badge (Uber One)`);
  lines.push(`\n## Top stores by value score`);
  lines.push(`| Store | Rating | Score | BOGO items | Fee badge | ETA |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const s of agg.topByValue) lines.push(`| ${s.name} | ${s.rating ?? '-'} | ${s.valueScore} | ${s.bogoCount} | ${s.feeBadge ?? '-'} | ${s.eta ?? '-'} |`);
  lines.push(`\n## Top by rating`);
  lines.push(`| Store | Rating | Reviews | ETA | Promo |`);
  lines.push(`|---|---|---|---|---|`);
  for (const s of agg.topByRating) lines.push(`| ${s.name} | ${s.rating} | ${s.reviews ?? '-'} | ${s.eta ?? '-'} | ${s.promo ?? '-'} |`);
  lines.push(`\n## Best 2-for-1 items (deal-adjusted, ranked)`);
  lines.push(`| Item | Store | Price | Effective | Rating | ETA |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const i of agg.bestBogoItems) lines.push(`| ${i.name} | ${i.store} | €${i.price} | **€${i.effectivePrice}** | ${i.rating ?? '-'} | ${i.eta ?? '-'} |`);
  lines.push(`\n## Cuisine breakdown`);
  for (const [c, n] of agg.cuisineBreakdown) lines.push(`- ${c}: ${n}`);
  lines.push(`\n## All stores`);
  lines.push(`| Store | Rating | ETA | Fee badge | Bucket | Cuisines | Items | Avg eff € | BOGO | Promo |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of a.stores) lines.push(`| ${s.name} | ${s.rating ?? '-'} | ${s.eta ?? '-'} | ${s.feeBadge ?? '-'} | ${s.priceBucket ?? '-'} | ${(s.cuisines || []).join(', ') || '-'} | ${s.menuStats.items} | ${s.menuStats.avgEffectivePrice ?? '-'} | ${s.menuStats.bogoCount} | ${s.promo ?? '-'} |`);
  return lines.join('\n') + '\n';
}
