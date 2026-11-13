// Live run against the real account: session probe + feed + the user's
// deal hunt (BOGO only, rating > 4, €0 delivery fee, item price <= €15).
// Usage: node src/live-run.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Backend } from './lib/api.mjs';
import * as tools from './tools.mjs';
import { spree } from './spree.mjs';

fs.mkdirSync(path.join(process.cwd(), 'fixtures'), { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// UE_CDP=http://localhost:9333 attaches to the sessiond daemon (no sign-in);
// otherwise launches its own headless context from the saved profile.
const be = new Backend({ root, mock: false, apiBudget: 1200, hardBudget: 40000, maxNavigations: 40, cdp: process.env.UE_CDP || null });
const doSpree = process.argv.includes('spree');

const report = { at: new Date().toISOString() };

try {
  report.feed = await tools.browseFeed(be, { maxStores: 10 });
  console.log('FEED OK:', report.feed.stores?.length, 'stores, sections:', report.feed.sections);

  const filters = { limit: 15, pages: 3, minRating: 4, maxFee: 0, bogoOnly: true, maxItemPrice: 15 };
  report.deals = await tools.findDeals(be, filters);
  console.log('DEALS OK:', report.deals.count);

  report.value = await tools.bestValue(be, { limit: 10, pages: 2, maxPrice: 15, minRating: 4 });
  console.log('VALUE OK:', report.value.count);

  if (doSpree) {
    // LOCATIONS="paris-idf,bordeaux-naq" (city slugs; empty = current feed location only)
    // CUISINES="burger,pizza"
    const locs = (process.env.LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cuisines = (process.env.CUISINES || 'burger,pizza').split(',').map((s) => s.trim());
    const out = { at: new Date().toISOString(), locations: {} };
    for (const loc of (locs.length ? locs : [null])) {
      const key = loc || 'current';
      out.locations[key] = {};
      await Promise.all(cuisines.map(async (c) => {
        out.locations[key][c + 's'] = await spree(be, c, { location: loc });
      }));
      console.log('SPREE', key, Object.entries(out.locations[key]).map(([k, v]) => `${k}: ${v.storeCount}/${v.matchedCount} stores, ${v.itemCount} items`).join(' | '));
    }
    report.spree = out;
    fs.writeFileSync(path.join(root, 'fixtures', 'spree.json'), JSON.stringify(out, null, 1));
    console.log('SPREE DONE -> fixtures/spree.json');
  }
} catch (e) {
  report.error = String(e && e.message || e);
  if (e.name === 'SessionExpiredError') report.error = 'SESSION_EXPIRED — run: npm run login';
  console.error('LIVE RUN ERROR:', report.error);
} finally {
  await be.close();
}

fs.writeFileSync(path.join(root, 'fixtures', 'live-report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1).slice(0, 6000));
console.log('LIVE RUN DONE');
