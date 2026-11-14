# Uber Eats MCP

A small personal MCP server that reads your own logged-in Uber Eats session and answers the only question that matters at 9pm: what's the best deal right now? 

It browses your feed, opens menus and deals, and ranks 2-for-1 (BOGO) offers and price-for-value in one compact report — meal-aware (fries alone don't count), no ham/pork, multi-city if you want.

This is especially for you if you keep scrolling past the same €12 burger and would rather have an agent just find the €3.30 Big King for you.

> [!WARNING]
> This is a vibe-coded fun project (that works) - happy to take PRs and have other methods implemented to have a legitimate, non-detectable way of querying & accessing Uber Eats without getting banned.
> 
> Session cookies and captures are secrets. They live outside this repo in `.private/` and are gitignored — never commit them. The server is read-only in agent mode by design, and it's only for your own account.

## Usage

```bash
npm install
npm run sessiond                                  # opens one window once, SSO signs you in, then it minimizes itself and serves CDP on :9333
UE_CDP=http://localhost:9333 npm run serve        # the MCP server — attach your client here, no sign-in
UE_CDP=http://localhost:9333 npm run live-run     # one-shot deal hunt: feed + deals + value + spree report
```

One note on the session: Uber's eater binding only stays valid in the live signed-in browser (short-lived session cookies, rotated server-side — fresh headless launches with exported cookies come back anonymous, we tested). So the daemon is the trick that means you never log in again; everything else just attaches to it.

The MCP server starts the daemon itself when nothing answers on `:9333` (`UE_AUTOSTART=0` turns that off). If the session lapses, a call waits up to `UE_REAUTH_WAIT` seconds (default 90) while silent SSO re-attaches it; if that fails, `sessiond` opens one sign-in window — complete it and retry. Offline checks for this logic: `npm run test:reauth`.

Tests run offline against captured fixtures: `npm run test:tools && npm run test:mcp`.

## Dish ratings and availability

Menu items from `get_menu`/`best_value`/`cuisine_spree`/`find_deals` carry the dish's own rating when Uber shows one: `likePct` (share of customers who liked it), `ratings` (count; absent for "most liked" badges that only expose a percentage) and `mostLikedRank`. Value scores shrink `likePct` toward 80% by count (prior weight 10) and apply −15…+5.

`get_store` reports `open` as false while a `closedNote` ("Opens at 11:00 AM") is set, plus `opensAt` (UTC ISO) and `schedulable`. Offline checks: `npm run test:dish`.

## TODO

- [ ] richer per-item verdicts (image-based portion-size guesses)
- [ ] watch mode: re-scan deals every N minutes and ping on new BOGO
