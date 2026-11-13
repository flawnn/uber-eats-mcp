import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Backend, SessionExpiredError } from './lib/api.mjs';
import * as tools from './tools.mjs';
import { spree } from './spree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// UE_HEADED=1 launches a headed browser on startup (SSO re-auths silently, no
// password needed); UE_SSO_WAIT=<secs> waits that long for the auth probe.
const be = new Backend({
  root,
  mock: process.env.UE_MOCK === '1',
  apiBudget: 300,
  hardBudget: 20000,
  headed: process.env.UE_HEADED === '1',
  ssoWaitSecs: parseInt(process.env.UE_SSO_WAIT || '0', 10),
  cdp: process.env.UE_CDP || null, // attach to sessiond daemon, e.g. UE_CDP=http://localhost:9333
});

const server = new McpServer({ name: 'uber-eats-mcp', version: '0.1.0' });

function wrap(fn: (args: any) => Promise<any>) {
  return async (args: any) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 1) }] };
    } catch (e) {
      const err = e as Error;
      if (e instanceof SessionExpiredError || err.name === 'SessionExpiredError') {
        return { content: [{ type: 'text' as const, text: `SESSION_EXPIRED: ${err.message}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `ERROR: ${err.message}` }], isError: true };
    }
  };
}

server.registerTool('browse_feed', {
  description: 'Personalized Uber Eats home feed: section titles + nearby stores (compact: id, name, rating, eta, fee, promos). Use first to see what is around.',
  inputSchema: { maxStores: z.number().min(1).max(100).optional() },
}, wrap((a) => tools.browseFeed(be, a)));

server.registerTool('list_stores', {
  description: 'Paginated list of nearby stores (compact cards). Pass offset from previous response to get more.',
  inputSchema: { offset: z.number().min(0).optional(), limit: z.number().min(1).max(50).optional() },
}, wrap((a) => tools.listStores(be, a)));

server.registerTool('search_stores', {
  description: 'Search nearby stores by name/cuisine/promo keyword (e.g. "pizza", "sushi", "2 for 1").',
  inputSchema: { query: z.string().min(1), limit: z.number().min(1).max(50).optional() },
}, wrap((a) => tools.searchStores(be, a)));

server.registerTool('get_store', {
  description: 'Full store details incl. promotions: rating, reviews, eta, delivery fee, price bucket, cuisines, address, promo text.',
  inputSchema: { storeUuid: z.string().min(1) },
}, wrap((a) => tools.getStore(be, a)));

server.registerTool('get_menu', {
  description: 'Full menu of a store: sections with items (name, price in EUR, effective price after BOGO, sold-out flag, bogo {buy,get}).',
  inputSchema: { storeUuid: z.string().min(1) },
}, wrap((a) => tools.getMenu(be, a)));

server.registerTool('find_deals', {
  description: 'Best deals across nearby stores: 2-for-1 / BOGO (structured item promotions + promo text), % off, free delivery. Ranked by value score (rating + discount - price - fee). Filter by cuisine and max delivery fee.',
  inputSchema: {
    limit: z.number().min(1).max(25).optional(),
    cuisine: z.string().optional(),
    maxFee: z.number().min(0).optional(),
    minRating: z.number().min(0).max(5).optional(),
    bogoOnly: z.boolean().optional(),
    maxItemPrice: z.number().min(0).optional(),
    pages: z.number().min(1).max(4).optional(),
  },
}, wrap((a) => tools.findDeals(be, a)));

server.registerTool('best_value', {
  description: 'Best price-for-value menu items across nearby stores, deal-adjusted (effective price after BOGO). Ranked by transparent value score. Filter by cuisine / max effective price.',
  inputSchema: {
    limit: z.number().min(1).max(25).optional(),
    cuisine: z.string().optional(),
    maxPrice: z.number().min(0).optional(),
    pages: z.number().min(1).max(4).optional(),
  },
}, wrap((a) => tools.bestValue(be, a)));

server.registerTool('cuisine_spree', {
  description: 'Sweep ALL stores of a cuisine (e.g. "burger", "pizza"): every menu item scored with the meal-aware value score (meal-size bonus up to 60, BOGO discount, rating, minus price and fee). Ham/pork items are excluded (pastrami/beef fine). Returns top items with effective BOGO prices + top stores.',
  inputSchema: {
    cuisine: z.string().min(1),
    limit: z.number().min(1).max(50).optional(),
    pages: z.number().min(1).max(4).optional(),
  },
}, wrap((a) => spree(be, a.cuisine, { limit: a.limit, pages: a.pages })));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error('uber-eats-mcp ready (mock=' + (process.env.UE_MOCK === '1') + ')');
}

main().catch((e) => {
  console.error('server failed to start:', e);
  process.exit(1);
});
