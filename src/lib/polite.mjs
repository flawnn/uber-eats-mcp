import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Endpoints that would mutate account state. v1 is read-only: in strict mode we
// abort these; in interactive mode we only log them so the page stays usable.
const MUTATION_RE = /(placeOrder|place-order|checkout|addToCart|add-to-cart|updateCart|update-cart|removeFromCart|redeemCoupon|applyPromotion|cancelOrder)/i;

// PoliteSession wraps a Playwright page with responsible-usage guardrails:
// - minimum delay (with jitter) before every navigation we initiate
// - a navigation cap per run
// - an API budget (only XHR/fetch to app endpoints count — static assets get a
//   separate high hard cap so one page load can never break the page)
// - an audit log of every request/response
// - capture of ubereats API JSON responses into fixtures
// - a mutation safety guard (hard block in strict mode, log-only otherwise)
export class PoliteSession {
  constructor(opts = {}) {
    this.minDelayMs = opts.minDelayMs ?? 3000;
    this.maxDelayMs = opts.maxDelayMs ?? 7000;
    this.maxNavigations = opts.maxNavigations ?? 5;
    this.apiBudget = opts.apiBudget ?? 150;   // app API calls per run
    this.hardBudget = opts.hardBudget ?? 5000; // all requests per run (runaway stop)
    this.captureDir = opts.captureDir || null;
    this.logFile = opts.logFile;
    this.strict = opts.strict ?? true;
    this.blockMutations = opts.blockMutations ?? true;
    this.navigations = 0;
    this.requestCount = 0;
    this.apiCount = 0;
    this.captured = [];
    this.flags = [];
    if (this.logFile) fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    if (this.captureDir) fs.mkdirSync(this.captureDir, { recursive: true });
  }

  log(line) {
    if (!this.logFile) return;
    fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`);
  }

  jitter() {
    return this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
  }

  async beforeNavigate(url) {
    if (this.navigations >= this.maxNavigations) {
      throw new Error(`navigation budget exhausted (${this.maxNavigations}) — stopping per politeness policy`);
    }
    this.navigations++;
    const d = Math.round(this.jitter());
    this.log(`NAV #${this.navigations} -> ${url} (polite delay ${d}ms)`);
    await new Promise((r) => setTimeout(r, d));
  }

  attach(page) {
    // Blocking goes through page.route — Request.abort() was removed in Playwright 1.65.
    page.route('**/*', (route) => {
      const req = route.request();
      this.requestCount++;
      const url = req.url();
      let pathname = url;
      try { pathname = new URL(url).pathname; } catch { /* keep raw */ }
      const rt = req.resourceType();
      const isApi = (rt === 'xhr' || rt === 'fetch') && !/_static\//.test(pathname);
      if (isApi) this.apiCount++;
      this.log(`REQ ${req.method()} ${url}`);

      if (this.requestCount > this.hardBudget) {
        this.log(`HARD BUDGET EXCEEDED (${this.hardBudget}) — ${rt === 'document' ? 'letting navigation through' : 'aborting'} ${req.method()} ${url}`);
        if (rt !== 'document') { route.abort('blockedbyclient').catch(() => {}); return; }
      }
      if (isApi && this.apiCount > this.apiBudget) {
        this.log(`API BUDGET EXCEEDED (${this.apiBudget}) — aborting ${req.method()} ${pathname}`);
        this.flags.push(`api budget exceeded at ${pathname}`);
        route.abort('blockedbyclient').catch(() => {});
        return;
      }

      let op = null;
      try { op = JSON.parse(req.postData() || '{}')?.operationName || null; } catch { /* not graphql */ }
      if (this.blockMutations && req.method() !== 'GET' && MUTATION_RE.test(pathname + ' ' + (op || ''))) {
        if (this.strict) {
          this.log(`SAFETY BLOCK: aborted mutation-looking request ${req.method()} ${pathname}`);
          this.flags.push(`blocked mutation ${pathname}`);
          route.abort('blockedbyclient').catch(() => {});
          return;
        }
        this.log(`WOULD BLOCK (interactive mode): mutation-looking ${req.method()} ${pathname}`);
        this.flags.push(`logged mutation ${pathname}`);
      }
      route.continue().catch(() => {});
    });

    page.on('response', async (res) => {
      const req = res.request();
      const url = res.url();
      if (!/ubereats\.com/.test(url)) return;
      if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
      this.log(`RES ${res.status()} ${url}`);
      if (res.status() === 429 || res.status() === 403) {
        this.flags.push(`status ${res.status()} on ${url}`);
        this.log(`FLAG: rate-limit/denied status ${res.status()} — will back off hard`);
      }
      if (!this.captureDir) return;
      try {
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const body = await res.json().catch(() => null);
        if (!body) return;
        const post = req.postData() || '';
        let op = null;
        try { op = JSON.parse(post)?.operationName || null; } catch { /* not graphql */ }
        const slug = op || crypto.createHash('sha1').update(req.method() + ' ' + url).digest('hex').slice(0, 12);
        const fname = `${slug}.json`;
        fs.writeFileSync(
          path.join(this.captureDir, fname),
          JSON.stringify({ url, method: req.method(), postData: post || null, operationName: op, status: res.status(), capturedAt: new Date().toISOString(), body }, null, 2)
        );
        this.captured.push({ operationName: op, url, file: fname });
        this.log(`CAPTURED ${op || url} -> ${path.relative(process.cwd(), path.join(this.captureDir, fname))}`);
      } catch (e) {
        this.log(`capture error: ${e.message}`);
      }
    });
  }
}
