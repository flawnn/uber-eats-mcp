// Capture EVERYTHING from the live daemon session, then test whether a
// headless launch on a copy of the profile still binds the eater session.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const priv = path.join(root, '..', 'uber-eats-mcp-private', 'fixtures');
fs.mkdirSync(priv, { recursive: true });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

const b = await chromium.connectOverCDP('http://localhost:9333');
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('ubereats.com')) || await ctx.newPage();
if (!page.url().includes('ubereats.com')) await page.goto('https://www.ubereats.com/feed', { waitUntil: 'domcontentloaded' });

// 1) cookies (all, incl. HttpOnly) + storageState
const cookies = await ctx.cookies();
fs.writeFileSync(path.join(priv, 'cookies-all.json'), JSON.stringify(cookies, null, 1));
const ss = await ctx.storageState();
fs.writeFileSync(path.join(priv, 'storageState.json'), JSON.stringify(ss, null, 1));
console.log('cookies:', cookies.length, 'storageState origins:', ss.origins.length);

// 2) localStorage + sessionStorage for ubereats origins
const ls = await page.evaluate(() => {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
  return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
});
fs.writeFileSync(path.join(priv, 'session-storage.json'), JSON.stringify({ url: page.url(), ...ls }, null, 1));
console.log('localStorage keys:', Object.keys(ls.localStorage).length, 'sessionStorage keys:', Object.keys(ls.sessionStorage).length);

// 3) IndexedDB dump (capped) + service workers
const idb = await page.evaluate(async () => {
  const out = {};
  const dbs = await indexedDB.databases();
  for (const d of dbs) {
    if (!d.name) continue;
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const stores = {};
      for (const sn of db.objectStoreNames) {
        const tx = db.transaction(sn, 'readonly');
        const st = tx.objectStore(sn);
        const all = await new Promise((res) => { const r = st.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
        stores[sn] = all.slice(0, 500);
      }
      out[d.name] = stores;
      db.close();
    } catch (e) { out[d.name] = { error: String(e) }; }
  }
  const sws = await navigator.serviceWorker.getRegistrations();
  return { dbs: out, serviceWorkers: sws.map((s) => s.active?.scriptURL || s.installing?.scriptURL) };
});
fs.writeFileSync(path.join(priv, 'indexeddb.json'), JSON.stringify(idb, null, 1));
console.log('indexedDB databases:', Object.keys(idb.dbs).length, 'serviceWorkers:', (idb.serviceWorkers || []).length);
await b.close();

// 4) headless rebind experiment: copy profile, launch headless, probe auth
console.log('--- headless rebind test ---');
fs.rmSync('/tmp/ue-hl-profile', { recursive: true, force: true });
fs.cpSync(path.join(root, 'browser-profile'), '/tmp/ue-hl-profile', { recursive: true });
const hl = await chromium.launchPersistentContext('/tmp/ue-hl-profile', {
  headless: true, userAgent: UA, locale: 'en-US', viewport: { width: 1440, height: 900 },
});
const hp = hl.pages()[0] || await hl.newPage();
await hp.goto('https://www.ubereats.com/feed', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('goto err', String(e).split('\n')[0]));
await hp.waitForTimeout(4000);
const probe = await hp.evaluate(async () => {
  try {
    const r = await fetch('/_p/api/getActiveOrdersV1', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' }, body: '{}', credentials: 'include' });
    const j = await r.json();
    return { http: r.status, status: j.status || null, code: j.code || j.errorCode || null, msg: j.message || null };
  } catch (e) { return { error: String(e) }; }
});
console.log('HEADLESS PROBE:', JSON.stringify(probe));
await hl.close();
