import fs from 'node:fs';
import path from 'node:path';

// Session state machine for the personal Uber Eats login:
//   anonymous -> authenticated -> expired (-> relogin via `npm run login`)
export const SessionState = Object.freeze({
  ANONYMOUS: 'anonymous',
  AUTHENTICATED: 'authenticated',
  EXPIRED: 'expired',
});

// Active probe from inside the page: POSTs bare getOrderEntitiesV1 with the
// page's own cookies + the session's own x-csrf-token header (the web app itself
// sends x-csrf-token: x). Returns AUTHENTICATED when the response carries
// non-null data — the bare endpoint returns data:null when anonymous.
// Must be called while the page is on a ubereats.com origin.
export async function probeAuth(page, csrfToken = 'x', attempts = 3) {
  let last = SessionState.EXPIRED;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await page.evaluate(async (csrf) => {
        const r = await fetch('/_p/api/getActiveOrdersV1', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || 'x' },
          credentials: 'include',
          body: '{}',
        });
        return await r.json();
      }, csrfToken);
      // success => eater session attached; failure/NO_USER_UUID => anonymous
      return res && res.status === 'success' ? SessionState.AUTHENTICATED : SessionState.ANONYMOUS;
    } catch {
      last = SessionState.EXPIRED; // mid-navigation etc — retry after a pause
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return last;
}

const onSignInPage = (url) => {
  try { return new URL(url).hostname === 'auth.uber.com'; } catch { return false; }
};

// Loads /feed once, then polls until the page is authenticated or the budget runs out.
// Gives the browser's own silent SSO a chance to re-attach the eater session.
// A page already on the sign-in form is only polled: reloading it would wipe a sign-in in progress.
export async function waitForAuth(page, { budgetMs, csrfToken = 'x', pollMs = 5000, baseUrl = 'https://www.ubereats.com' }) {
  if (!onSignInPage(page.url())) {
    await page.goto(baseUrl + '/feed', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if ((await probeAuth(page, csrfToken, 2)) === SessionState.AUTHENTICATED) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// Passive watcher: flips state on API 401s and on getOrderEntitiesV1 responses.
export function watchAuth(page, state) {
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/_p/api/') && res.status() === 401) {
      state.current = SessionState.EXPIRED;
      return;
    }
    if (u.includes('getOrderEntitiesV1')) {
      try {
        const b = await res.json();
        if (b && b.data) state.current = SessionState.AUTHENTICATED;
        else if (state.current === SessionState.AUTHENTICATED) state.current = SessionState.EXPIRED;
      } catch { /* not json */ }
    }
  });
}

export async function saveSession(ctx, fixturesDir) {
  fs.mkdirSync(fixturesDir, { recursive: true });
  await ctx.storageState({ path: path.join(fixturesDir, 'storageState.json') });
}
