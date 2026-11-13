import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { FileCache } from './cache.mjs';
import { PoliteSession } from './polite.mjs';
import { probeAuth, SessionState, waitForAuth } from './session.mjs';
import { ensureDaemon } from './daemon.mjs';

export class SessionExpiredError extends Error {
  constructor(msg) { super(msg); this.name = 'SessionExpiredError'; }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36';
const BASE = 'https://www.ubereats.com';

// Backend talks to Uber Eats' own `/_p/api/*V1` endpoints via in-page fetch
// (cookies ride along), with a TTL cache and politeness guardrails.
// UE_MOCK=1 replays captured fixtures instead of hitting the network.
export class Backend {
  constructor({ root, mock = false, apiBudget = 150, hardBudget = 5000, headed = false, ssoWaitSecs = 0, cdp = null, maxNavigations = 5, autoStart = true, reauthWaitSecs = 90 } = {}) {
    this.root = root;
    this.mock = mock;
    this.headed = headed;
    this.ssoWaitSecs = ssoWaitSecs;
    this.cdp = cdp; // e.g. http://localhost:9333 — attach to the sessiond daemon
    this.autoStart = autoStart; // spawn sessiond when nothing answers on the CDP port
    this.reauthWaitSecs = reauthWaitSecs; // how long a call waits for the daemon's session to recover
    this.browser = null;
    this.profileDir = path.join(root, 'browser-profile');
    // captured API fixtures + cache live outside the repo (session-derived data)
    this.fixturesDir = process.env.UE_FIXTURES_DIR || path.join(root, 'fixtures', 'api');
    this.cache = new FileCache(process.env.UE_CACHE_DIR || path.join(root, 'fixtures', 'cache'));
    this.polite = new PoliteSession({
      logFile: path.join(root, 'logs', `server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`),
      strict: true,
      apiBudget,
      hardBudget,
      maxNavigations,
    });
    this.ctx = null;
    this.page = null;
    this.lastApiCall = 0;
    this.authed = false;
    this.csrfToken = 'x'; // the web app itself sends x-csrf-token: x; we capture the live one when seen
  }

  // Attach to the long-lived sessiond browser — no fresh launch, no sign-in.
  async attachDaemon() {
    if (this.autoStart) await ensureDaemon({ root: this.root, cdp: this.cdp, log: (m) => this.polite.log(m) });
    this.browser = await chromium.connectOverCDP(this.cdp);
    this.browser.once('disconnected', () => this.resetConnection());
    this.ctx = this.browser.contexts()[0] || (await this.browser.newContext());
    this.page = this.ctx.pages().find((pg) => pg.url().includes('ubereats.com')) || (await this.ctx.newPage());
    if (!this.page.url().includes('ubereats.com')) {
      await this.page.goto(BASE + '/feed', { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await this.attachPageHandlers();
  }

  resetConnection() {
    this.browser = null;
    this.ctx = null;
    this.page = null;
    this.authed = false;
  }

  async ensurePage() {
    if (this.mock) return;
    if (!this.ctx && this.cdp) await this.attachDaemon();
    if (!this.ctx) {
      const storageStatePath = path.join(this.root, 'fixtures', 'storageState.json');
      const opts = {
        headless: !this.headed,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: false,
        colorScheme: 'light',
        userAgent: UA,
        locale: 'en-US',
        args: ['--lang=en-US'],
      };
      // inject the last saved session (cookies + localStorage) if present
      if (fs.existsSync(storageStatePath)) opts.storageState = storageStatePath;
      // restore localStorage + sessionStorage (eater binding lives here; storageState misses sessionStorage)
      const ssPath = path.join(this.root, 'fixtures', 'session-storage.json');
      if (fs.existsSync(ssPath)) {
        const data = JSON.parse(fs.readFileSync(ssPath, 'utf8'));
        opts.addInitScript = `(() => { const d = ${JSON.stringify(data)};
          for (const [k, v] of Object.entries(d.localStorage || {})) { try { localStorage.setItem(k, v); } catch {} }
          for (const [k, v] of Object.entries(d.sessionStorage || {})) { try { sessionStorage.setItem(k, v); } catch {} } })();`;
      }
      this.ctx = await chromium.launchPersistentContext(this.profileDir, opts);
      this.page = this.ctx.pages()[0] || (await this.ctx.newPage());
      await this.attachPageHandlers();
      await this.page.goto(BASE + '/feed', { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    if (this.authed) return; // probe once per session; re-probe only after a 401
    let auth = await probeAuth(this.page, this.csrfToken, 3);
    if (auth !== SessionState.AUTHENTICATED && this.cdp) {
      const recovered = await waitForAuth(this.page, { budgetMs: this.reauthWaitSecs * 1000, csrfToken: this.csrfToken });
      if (!recovered) {
        throw new SessionExpiredError(
          `Uber Eats session lapsed and silent re-login failed within ${this.reauthWaitSecs}s. sessiond opens a sign-in window when it can — complete it and retry; if no window appears, restart it: npm run sessiond`,
        );
      }
      auth = SessionState.AUTHENTICATED;
    }
    // if anonymous, give SSO silent re-auth a chance (works headed without any input)
    if (auth !== SessionState.AUTHENTICATED && this.ssoWaitSecs > 0) {
      const deadline = Date.now() + this.ssoWaitSecs * 1000;
      while (Date.now() < deadline && auth !== SessionState.AUTHENTICATED) {
        await new Promise((r) => setTimeout(r, 5000));
        await this.page.goto(BASE + '/feed', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
        auth = await probeAuth(this.page, this.csrfToken).catch(() => auth);
      }
    }
    if (auth !== SessionState.AUTHENTICATED) {
      throw new SessionExpiredError('Uber Eats session is not authenticated — run: node src/login-and-run.mjs');
    }
    this.authed = true;
  }

  async attachPageHandlers() {
    // CDP attach: drop stale route handlers from previous runs first — their
    // budgets are exhausted and they would abort every request (ERR_ABORTED).
    if (this.cdp && this.page.unrouteAll) { try { await this.page.unrouteAll({ behavior: 'default' }); } catch {} }
    this.polite.attach(this.page);
    // capture the session's own csrf header value from the app's requests
    this.page.on('request', (req) => {
      if (req.url().includes('/_p/api/') && req.method() === 'POST') {
        const t = req.headers()['x-csrf-token'];
        if (t) this.csrfToken = t;
      }
    });
  }

  // Use an already-open, already-authenticated browser session (e.g. right after login).
  async attachExternal(ctx, page) {
    this.ctx = ctx;
    this.page = page;
    this.authed = true; // caller just confirmed auth via probe
    await this.attachPageHandlers();
  }

  async callApi(endpoint, body = {}, { ttlMs = 5 * 60 * 1000, cache = true, navUrl = null } = {}) {
    await this.ensurePage();
    const key = `${endpoint} ${JSON.stringify(body)}`;
    if (cache) {
      const hit = this.cache.get(key);
      if (hit) { this.polite.log(`CACHE HIT ${endpoint}`); return hit; }
    }
    // small jitter between our own API calls — polite pacing
    const since = Date.now() - this.lastApiCall;
    const wait = Math.max(0, 150 + Math.random() * 250 - since);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastApiCall = Date.now();

    let data;
    if (this.mock) {
      data = this.mockLoad(endpoint);
    } else {
      const res = await this.page.evaluate(async ([ep, bd, csrf]) => {
        const r = await fetch(`/_p/api/${ep}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || 'x' },
          credentials: 'include',
          body: JSON.stringify(bd),
        });
        let b = null;
        try { b = await r.json(); } catch { /* non-json */ }
        return { status: r.status, body: b };
      }, [endpoint, body, this.csrfToken]);
      this.polite.log(`API ${res.status} ${endpoint} ${JSON.stringify(body).slice(0, 120)}`);
      if (res.status === 401) {
        this.authed = false; // force re-probe / SSO re-auth, then retry once
        await this.ensurePage();
        const retry = await this.page.evaluate(async ([ep, bd, csrf]) => {
          const r = await fetch(`/_p/api/${ep}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || 'x' },
            credentials: 'include',
            body: JSON.stringify(bd),
          });
          let b = null;
          try { b = await r.json(); } catch { /* non-json */ }
          return { status: r.status, body: b };
        }, [endpoint, body, this.csrfToken]);
        this.polite.log(`API RETRY ${retry.status} ${endpoint}`);
        if (retry.status === 401) throw new SessionExpiredError(`401 on ${endpoint} — run: node src/login-and-run.mjs`);
        if (retry.body && retry.body.status === 'success') {
          if (cache) this.cache.set(key, retry.body.data, ttlMs);
          return retry.body.data;
        }
        throw new Error(`API ${endpoint} failed after retry: ${JSON.stringify(retry.body)?.slice(0, 200)}`);
      }
      if (res.body && res.body.status === 'success') {
        data = res.body.data;
      } else if (navUrl) {
        // page-driven fallback: navigate the real page and capture the endpoint response
        this.polite.log(`FALLBACK page-nav for ${endpoint} -> ${navUrl}`);
        const respP = this.page
          .waitForResponse((r) => r.url().includes(`/_p/api/${endpoint}`) && r.request().method() === 'POST', { timeout: 30000 })
          .catch(() => null);
        await this.polite.beforeNavigate(navUrl);
        await this.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await this.page.waitForTimeout(4000);
        const res2 = await respP;
        const b2 = res2 ? await res2.json().catch(() => null) : null;
        if (b2 && b2.status === 'success') data = b2.data;
        else throw new Error(`API ${endpoint} failed (direct + page-nav): ${JSON.stringify(res.body)?.slice(0, 150)}`);
      } else {
        throw new Error(`API ${endpoint} failed: ${JSON.stringify(res.body)?.slice(0, 200)}`);
      }
    }
    if (cache) this.cache.set(key, data, ttlMs);
    return data;
  }

  mockLoad(endpoint) {
    const files = fs.readdirSync(this.fixturesDir);
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.fixturesDir, f), 'utf8'));
        if (d.url && d.url.includes(`/_p/api/${endpoint}`)) {
          return d.body?.data !== undefined ? d.body.data : d.body;
        }
      } catch { /* skip bad file */ }
    }
    throw new Error(`no fixture for endpoint ${endpoint}`);
  }

  async close() {
    // CDP attach: just drop the connection (client exit closes it) — never close the daemon
    if (this.browser) { try { await this.browser.close(); } catch { /* already gone */ } this.browser = null; this.ctx = null; }
    else if (this.ctx) await this.ctx.close().catch(() => {});
  }
}
