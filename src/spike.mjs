import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PoliteSession } from './lib/polite.mjs';
import { probeAuth, watchAuth, saveSession, SessionState } from './lib/session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(ROOT, 'browser-profile');
const FIXTURES = path.join(ROOT, 'fixtures');
const LOGS = path.join(ROOT, 'logs');
const BASE = 'https://www.ubereats.com';

const mode = process.argv[2] || 'run';

// Standard desktop Chrome UA matching the Chromium build we run (158) —
// a normal client string, not a stealth patch.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36';

function newPolite({ strict = true, explore = false } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new PoliteSession({
    captureDir: path.join(FIXTURES, 'api'),
    logFile: path.join(LOGS, `requests-${stamp}.log`),
    minDelayMs: 3000,
    maxDelayMs: 7000,
    maxNavigations: explore ? Number.MAX_SAFE_INTEGER : 5,
    apiBudget: explore ? Number.MAX_SAFE_INTEGER : 150,
    hardBudget: explore ? Number.MAX_SAFE_INTEGER : 5000,
    strict,
  });
}

async function launchContext(headless) {
  return await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    userAgent: UA,
    locale: 'en-US',
    args: ['--lang=en-US'],
  });
}

async function login() {
  const ctx = await launchContext(false); // headed: interactive sign-in
  const page = ctx.pages()[0] || (await ctx.newPage());
  // interactive: no budgets (a human clicking around must never hit ERR_BLOCKED_BY_CLIENT),
  // mutations log-only
  const polite = newPolite({ strict: false, explore: true });
  polite.attach(page);
  const state = { current: SessionState.ANONYMOUS };
  watchAuth(page, state);

  await polite.beforeNavigate(BASE + '/feed');
  await page.goto(BASE + '/feed', { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('Opened ubereats.com/feed in a headed window.');
  console.log('Sign in and click around as usual. The session is saved automatically');
  console.log('once the auth probe confirms you are logged in (or press ENTER to force-save).');

  let done = false;
  process.stdin.once('data', () => { done = true; console.log('ENTER pressed — saving session.'); });
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastProbe = 0;
  let lastLogged = '';
  while (Date.now() < deadline && !done) {
    if (Date.now() - lastProbe > 5000) {
      lastProbe = Date.now();
      try {
        state.current = await probeAuth(page);
        const line = `probe: ${state.current} @ ${page.url().slice(0, 60)}`;
        if (line !== lastLogged) { console.log(line); lastLogged = line; }
        if (state.current === SessionState.AUTHENTICATED) {
          console.log('AUTH CONFIRMED via probe — saving session.');
          done = true;
        }
      } catch { /* page mid-navigation, retry */ }
    }
    if (!done) await new Promise((r) => setTimeout(r, 1000));
  }
  await saveSession(ctx, FIXTURES);
  console.log('Saved storageState -> fixtures/storageState.json (profile in browser-profile/)');
  await ctx.close();
  if (!done) { console.error('Timed out without confirmed auth.'); process.exit(3); }
}

async function run() {
  const ctx = await launchContext(true); // headless, reuses saved profile
  const page = ctx.pages()[0] || (await ctx.newPage());
  const polite = newPolite({ strict: true });
  polite.attach(page);
  const state = { current: SessionState.ANONYMOUS };
  watchAuth(page, state);

  await polite.beforeNavigate(BASE + '/feed');
  await page.goto(BASE + '/feed', { waitUntil: 'domcontentloaded', timeout: 45000 });

  const auth = await probeAuth(page);
  console.log('session state:', auth);
  if (auth !== SessionState.AUTHENTICATED) {
    console.error('Not authenticated or session expired. Re-login required: npm run login');
    await ctx.close();
    process.exit(2);
  }
  state.current = auth;

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(LOGS, 'feed.png') });

  const links = await page.$$eval('a[href*="/store/"]', (as) =>
    [...new Set(as.map((a) => ({ href: a.href, text: a.innerText.trim().slice(0, 80) })))]
  );
  console.log(`store links found: ${links.length}`);
  console.log(JSON.stringify(links.slice(0, 30), null, 2));

  const first = links.find((l) => /\/store\//.test(l.href));
  if (first) {
    console.log('opening first restaurant:', first.href);
    await polite.beforeNavigate(first.href);
    await page.goto(first.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(LOGS, 'restaurant.png') });
  } else {
    console.log('no /store/ links found — check logs/feed.png');
  }

  const summary = {
    at: new Date().toISOString(),
    sessionState: state.current,
    navigations: polite.navigations,
    requests: polite.requestCount,
    apiCalls: polite.apiCount,
    flags: polite.flags,
    stores: links.slice(0, 50),
    captured: polite.captured,
  };
  fs.writeFileSync(path.join(FIXTURES, 'spike-summary.json'), JSON.stringify(summary, null, 2));
  console.log('SUMMARY:', JSON.stringify({
    sessionState: state.current,
    navigations: polite.navigations,
    requests: polite.requestCount,
    apiCalls: polite.apiCount,
    storesFound: links.length,
    capturedApis: polite.captured.length,
    flags: polite.flags,
  }, null, 2));
  await ctx.close();
}

// Open-ended interactive exploration: human-driven, nothing is ever blocked,
// everything is logged and API responses are captured. Session auto-saves once
// the auth probe confirms login. Ends on ENTER in this terminal.
async function explore() {
  const ctx = await launchContext(false);
  const page = ctx.pages()[0] || (await ctx.newPage());
  const polite = newPolite({ strict: false, explore: true });
  polite.attach(page);
  const state = { current: SessionState.ANONYMOUS };
  watchAuth(page, state);

  await polite.beforeNavigate(BASE + '/feed');
  await page.goto(BASE + '/feed', { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('EXPLORE MODE: open-ended, no limits. Click around freely.');
  console.log('Every request is logged, every API response captured to fixtures/api/.');
  console.log('Session auto-saves when login is confirmed. Press ENTER here to end.');

  let end = false;
  process.stdin.once('data', () => { end = true; });
  let saved = false;
  while (!end) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      state.current = await probeAuth(page);
      if (state.current === SessionState.AUTHENTICATED && !saved) {
        await saveSession(ctx, FIXTURES);
        saved = true;
        console.log('AUTH CONFIRMED — session saved to fixtures/storageState.json');
      }
    } catch { /* mid-navigation */ }
  }
  console.log('explore ended. requests:', polite.requestCount, 'api calls:', polite.apiCount, 'captured:', polite.captured.length);
  await ctx.close();
}

if (mode === 'login') await login();
else if (mode === 'explore') await explore();
else await run();
