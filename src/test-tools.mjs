// Mock-mode smoke test: runs the tool functions against captured fixtures.
// Usage: UE_MOCK=1 node src/test-tools.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend } from './lib/api.mjs';
import * as tools from './tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const be = new Backend({ root, mock: true });

const show = (label, v) => {
  const s = JSON.stringify(v, null, 1);
  console.log(`\n===== ${label} (${s.length} bytes) =====`);
  console.log(s.length > 2500 ? s.slice(0, 2500) + '\n...truncated' : s);
};

try {
  show('browse_feed', await tools.browseFeed(be, { maxStores: 5 }));
  show('list_stores', await tools.listStores(be, { limit: 5 }));
  const feed = await tools.browseFeed(be, { maxStores: 3 });
  const first = feed.stores?.[0];
  if (first?.uuid) {
    show('get_store', await tools.getStore(be, { storeUuid: first.uuid }));
    show('get_menu', await tools.getMenu(be, { storeUuid: first.uuid }));
  }
  show('find_deals', await tools.findDeals(be, { limit: 8, pages: 1 }));
  show('best_value', await tools.bestValue(be, { limit: 8, pages: 1 }));
  show('search_stores(pizza)', await tools.searchStores(be, { query: 'pizza', limit: 5 }));
} catch (e) {
  console.error('TEST FAILED:', e);
  process.exit(1);
} finally {
  await be.close();
}
console.log('\nALL TOOL TESTS DONE');
