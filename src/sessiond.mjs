// sessiond — long-lived authenticated browser daemon.
// Launches the persistent profile ONCE, waits for the auth probe, saves all
// session artifacts, then stays alive serving CDP on :9333. Everything else
// (live-run, MCP server) attaches via UE_CDP=http://localhost:9333 — no fresh
// browser, no sign-in.
//
// Headless by default (UE_HEADLESS=1, or "auto"): the daemon runs invisible.
// Silent SSO re-auths from the persisted auth.uber.com session; only if that
// fails does it fall back to a headed window for one manual sign-in
// (UE_HEADLESS=0 forces headed). Usage: node src/sessiond.mjs
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { probeAuth, SessionState, waitForAuth } from './lib/session.mjs';

fs.mkdirSync(path.join(process.cwd(), 'fixtures'), { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
const CDP_PORT = process.env.SESSIOND_PORT || '9333';
const BASE = 'https://www.ubereats.com';
const HEADLESS_MODE = (process.env.UE_HEADLESS || 'auto') !== '0'; // '1'/'auto' = headless, '0' = headed

let ctx = null;
let page = null;
let headed = false;

// headed fallback: minimize the window so the daemon runs out of sight
function minimizeWindow() {
  if (!headed) return;
  exec(`osascript -e 'tell application "Google Chrome for Testing" to set miniaturized of (every window whose visible is true) to true'`, (e) => {
    if (e) console.log('[sessiond] minimize failed (cosmetic only):', e.message);
  });
}

async function launch(headless) {
  headed = !headless;
  ctx = await chromium.launchPersistentContext(path.join(root, 'browser-profile'), {
    headless,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    userAgent: UA,
    locale: 'en-US',
    args: [`--remote-debugging-port=${CDP_PORT}`, '--lang=en-US'],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
}

async function saveAll() {
  await ctx.storageState({ path: path.join(root, 'fixtures', 'storageState.json') }).catch(() => {});
  const allCookies = await ctx.cookies();
  fs.writeFileSync(path.join(root, 'fixtures', 'cookies-all.json'), JSON.stringify({ savedAt: new Date().toISOString(), cookies: allCookies }, null, 1));
  try {
    const store = await page.evaluate(() => ({
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
    }));
    fs.writeFileSync(path.join(root, 'fixtures', 'session-storage.json'), JSON.stringify(store, null, 1));
  } catch { /* page mid-nav */ }
  console.log(`[sessiond] saved session artifacts (${allCookies.length} cookies)`);
}

const ensureAuth = (budgetMs) => waitForAuth(page, { budgetMs, baseUrl: BASE });

if (HEADLESS_MODE) {
  console.log('[sessiond] starting HEADLESS — trying silent SSO re-auth (no window, no password)...');
  await launch(true);
  if (await ensureAuth(90 * 1000)) {
    console.log('[sessiond] silent SSO worked — fully headless, no window ever shown');
  } else {
    console.log('[sessiond] silent SSO did not fire — falling back to a headed window for one manual sign-in');
    await ctx.close().catch(() => {});
    await launch(false);
    await ensureAuth(10 * 60 * 1000);
  }
} else {
  console.log('[sessiond] starting HEADED — sign in inside the window once, I will detect it.');
  await launch(false);
  await ensureAuth(10 * 60 * 1000);
}

await saveAll();
console.log(`[sessiond] READY (${headed ? 'headed, minimized' : 'headless'}) — CDP on http://localhost:${CDP_PORT} — attach with UE_CDP=http://localhost:${CDP_PORT}`);
minimizeWindow();

// keepalive: reload the feed periodically so the app refreshes its tokens;
// re-check auth and re-run SSO if it ever lapses
setInterval(async () => {
  try {
    // if a client attached and navigated the page elsewhere, leave it alone —
    // navigating now would cancel their in-flight goto (ERR_ABORTED)
    if (!page.url().includes('/feed')) { console.log('[sessiond] keepalive skipped — page in use by a client:', page.url()); return; }
    await page.goto(BASE + '/feed', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const s = await probeAuth(page, 'x', 2);
    if (s !== SessionState.AUTHENTICATED) {
      console.log('[sessiond] session lapsed — attempting silent SSO re-auth...');
      if (await ensureAuth(headed ? 10 * 60 * 1000 : 90 * 1000)) {
        await saveAll();
        console.log('[sessiond] re-authed and re-saved');
        minimizeWindow();
      } else if (!headed) {
        console.log('[sessiond] headless SSO failed — restart with UE_HEADLESS=0 for a manual sign-in window');
      }
    }
  } catch (e) { console.log('[sessiond] keepalive error:', e.message); }
}, 60 * 1000);

await new Promise(() => {}); // run forever
