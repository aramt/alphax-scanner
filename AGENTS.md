# AGENTS.md — AlphaX / RH / HTF Book

This file is the source of truth for what this repo is, how the hosted apps work, and how we defined trading states. Read it before changing scanners, the position book, the PHP proxy, or deploy paths.

Owner: Aram. Personal play-money tooling, not a product, not a broker, not a signal service.

---

## What this is

Three small browser apps that share one static frontend and one PHP backend on SiteGround (`aramt.com`):

| App | File | Job |
|---|---|---|
| **AlphaX Turnover Scanner** | `index.html` | Screen AlphaX USDT perps vs CoinGecko spot cap. Rank by turnover (spot vol / circulating cap) and 24h range. Discovery for *established-enough* names on AlphaX, originally for 24h isolated play-money scans. |
| **RH Chain Trenches** | `rh.html` | Early **Robinhood Chain** (chain id `4663`) tokens as they appear in **Robinhood Wallet**, not the brokerage app. Rank by vol/liquidity on tokens created inside an age window. **Not** the HTF book. |
| **HTF Book** | `book.html` | Position ledger + weekly/daily regime overlay for **larger, established** coins (HYPE, RENDER, ENA, PENDLE, PUMP, LIT, XPL, …). Ride a high-timeframe uptrend; trim local tops; reload local bottoms; flatten only when weekly structure is broken. |

They are linked in a shared nav. Styling is a single dark theme copied across pages (no framework, no build step).

---

## Live URLs

Use **aramt.com** as the real app (PHP proxy, book sync, CoinGecko key). GitHub Pages is a static mirror of the HTML only; API calls still go to aramt.com.

- https://aramt.com/alphax-scanner/
- https://aramt.com/alphax-scanner/rh.html
- https://aramt.com/alphax-scanner/book.html
- GitHub Pages: https://aramt.github.io/alphax-scanner/
- Source: https://github.com/aramt/alphax-scanner (`main`)

Book data is **origin-agnostic** as long as the page talks to `book-store.php` on aramt.com, but tell the user to bookmark **aramt.com** so they are not confused by two UIs.

---

## Repo layout

```
index.html          AlphaX scanner
rh.html             Robinhood Chain trenches
book.html           HTF position book (ledger + regime)
api.php             Allowlisted proxy → CoinGecko or DexPaprika
book-store.php      GET/POST JSON book, keyed by SHA-256 of sync phrase
config.php          GITIGNORED. CoinGecko demo API key. Lives on the server.
config.example.php  Shape of config.php, no secrets
cache/              Proxy response cache (gitignored JSON)
data/books/         Unused leftover path; live books are NOT here
```

On the server, book files live **outside the web root**:

```
/home/customer/www/aramt.com/private/alphax-books/<64-hex>.json
```

`book-store.php` resolves that as `__DIR__ . '/../../private/alphax-books'`.

Do **not** commit `config.php`, cache JSON, or book JSON. Do **not** put API keys or sync phrases in HTML.

---

## Architecture

```
Browser (index / rh / book)
    │
    ├─ GET api.php?path=…              CoinGecko (default)
    ├─ GET api.php?src=dp&path=…       DexPaprika (RH trenches)
    ├─ GET  book-store.php?k=<hash>    Load book
    └─ POST book-store.php?k=<hash>    Save book
```

Why a proxy exists:

- CoinGecko from `github.io` failed CORS (often a 403/429 HTML page with no ACAO, which the browser reports as CORS).
- DexPaprika also lacks `Access-Control-Allow-Origin` for browser calls.
- The demo API key must stay on the server (`x-cg-demo-api-key`), never in JS.

`api.php` behavior:

- GET only. OPTIONS for CORS. `Access-Control-Allow-Origin: *`.
- Strict path allowlist. Gecko also allows `coins/{id}/ohlc` and `coins/{id}/market_chart` where `{id}` is `[a-z0-9-]+`.
- Query params allowlisted; anything else dropped.
- File cache + `flock` pacing between upstream calls (Gecko ~2.2s with key, DexPaprika ~6.5s).
- Cache TTL: 180s Gecko, 1800s OHLC/chart, 45s DexPaprika.
- Forwards upstream status (including 429).
- Sets `X-Scanner-Cache: HIT|MISS`.

CoinGecko demo key: free plan, header auth, same root URL `https://api.coingecko.com/api/v3/`. Config:

```php
<?php
return [
    'coingecko_demo_key' => 'CG-…',
];
```

On the server: `chmod 600 config.php`.

---

## Deploy

Local clone: `~/Local Sites/alphax-scanner`.

```bash
# HTML/PHP
scp -o BatchMode=yes index.html rh.html book.html api.php book-store.php \
  siteground-aramt:www/aramt.com/public_html/alphax-scanner/

# GitHub Pages (HTML only; PHP on GH Pages does not run)
git push origin main
```

SSH alias: `siteground-aramt` (SiteGround account for aramt.com). Web root: `www/aramt.com/public_html`.

After HTML changes that matter to the user, deploy **both** SiteGround and `main`. GitHub Pages can lag.

---

## App 1 — AlphaX Turnover Scanner (`index.html`)

**Intent:** Find relatively small, high-turnover AlphaX USDT perps. High turnover with tiny OI is often wash or an empty book.

**Data:**

1. `GET derivatives/exchanges/alphax-futures?include_tickers=unexpired`
2. Unique `coin_id`s, chunked (80) into `coins/markets` (vs USD, 1h/24h/7d change).

**Derived per row:**

- Spot turnover ≈ `total_volume / market_cap`
- AlphaX volume and OI from the derivatives ticker (`converted_volume.usd`, `open_interest_usd`)
- Filters: max/min cap, hide majors, search
- Sort: turnover, range, etc.

**Not for:** Robinhood Chain memes, or the HTF ride-the-trend playbook.

---

## App 2 — RH Chain Trenches (`rh.html`)

**Intent:** Very early tokens on Robinhood Chain (EVM L2, chain id 4663, ETH gas, Uniswap). Wallet app, not the stock-broker app.

**Data:** DexPaprika `GET /networks/robinhood/tokens/search` with `created_after`, `detailed=true`, `volume_usd_24h_min`, `limit=100`.

**Defaults (trenches, not CASHCAT-sized):** last 6h, FDV &lt; $1.5M, min 24h vol, min liq, min 1h txns. Hides WETH / ETH / USDG / PONS.

**Turnover analog:** 24h volume / liquidity. High with tiny liq is often wash or an empty book.

**Out of scope for HTF Book.** These names do not have a meaningful weekly trend.

---

## App 3 — HTF Book (`book.html`)

This is the position manager. Discovery scanners feed ideas; this is for names you actually hold or stalk.

### User playbook (design intent)

- Mostly **low leverage (~2x)** perps, plus spare stables and cash flow into stables.
- **Weekly = regime.** Is the bull/uptrend still alive?
- **Daily = swing.** Trim extended, reload discounted, sit through mid.
- **Runner** (about half) stays until weekly is broken — even if that misses the pico top.
- **Swing sleeve** is sold into daily extension and bought back into discount **only while weekly is UP**.
- Alt bulls often have **multi-day/week daily downtrends** that are not “bull over.” That is state **CORRECTION**: hold the runner, do not buy day 1 of the dump, wait for daily repair or a weekly fib box.
- Stables are **dry powder / extra collateral**, not FOMO into day-3 knives.
- Do not apply this to trenches.

### Position ledger

Append-only `events` on each coin. Everything else is derived.

```text
buy     qty + price     blends average entry
sell    qty + price     realized += (price - avg) * qty; remaining keeps old avg
margin_in / margin_out  USD collateral only; does not change avg or qty
```

When qty hits 0, avg resets. Next buy starts a new average.

**Qty is coins, not dollars.** If the user knows “$2000 margin at 2x at $0.25”:

```
kind = margin:    qty = (usd * lev) / price     → 16_000 coins, $4k notional
kind = notional:  qty = usd / price             →  8_000 coins, $1k margin
```

`sizeFromInputs()` implements that. Qty override still wins if filled.

**Metrics:**

- Unrealized = `(mark - avg) * qty`
- Total PnL = realized + unrealized
- Notional = `qty * mark`
- Effective lev = `notional / margin`
- Est. liq (linear perp, rough) = `avg - margin/qty`
- ROE = `total / margin`

No funding, no fees, no liquidation engine. Liq is a distance check vs weekly HL (“is leverage the constraint, or the trend?”).

**Add coin:** preset or CoinGecko id, leverage, USD + kind (margin vs notional) or qty override.

Presets (CoinGecko ids): HYPE `hyperliquid`, RENDER `render-token`, ENA `ethena`, PENDLE `pendle`, PUMP `pump-fun`, LIT `lighter`, XPL `plasma`, plus majors.

Watch-only: add with no qty/USD.

### Book persistence

1. `localStorage` key `htf-book-v1` (cache).
2. Server JSON behind a **sync phrase**. Client SHA-256s `"htf-book|" + phrase` (Web Crypto), stores only the hex in `localStorage` (`htf-book-sync-hash`). Server filename is that hash. Phrase never sent in the clear after unlock.
3. Auto-push (debounced 400ms) on every save. Pull on boot. Newer `updated_at` wins. If local has events and remote is empty, upload (migration).
4. Export/import JSON backup still exists.

**Use the same phrase on the phone.** Forgetting the phrase = cannot open that server file from the UI.

This is last-write-wins, not CRDT. Fine for one human. Do not log fills on two devices at the same second.

`book-store.php`: GET/POST, `k` must be 64 hex, 512KB cap, `Cache-Control: no-store`, CORS `*`. Anyone who has the hash can read/write that book. The phrase is the access control.

### Market data for regime

- Marks: `simple/price?ids=…&vs_currencies=usd&include_24hr_change=true`
- Daily closes (365d): `coins/{id}/market_chart?vs_currency=usd&days=365&interval=daily`
- Recent true H/L: `coins/{id}/ohlc?vs_currency=usd&days=30` (CoinGecko returns **4h** candles for 30d)

**Important CoinGecko quirk:** `ohlc&days=365` is **4-day** bars, not daily. Do not use it for daily/weekly structure. We resample 4h → daily for the last ~30 days and overlay onto close-only daily bars. Weekly bars are aggregated from **daily closes** (week high/low are max/min of daily closes, not true weekly wicks).

Weekly bucket: Monday UTC.

### Structure algorithm (`structure()` in `book.html`)

Fractal swings:

- Weekly: left=1, right=1 (needs one bar on each side to confirm).
- Daily: left=2, right=2.

A confirmed swing high at `i` is a bar whose high is ≥ neighbors in `[i-left, i+right]`. Same for lows. **The current incomplete week cannot be a confirmed swing.** That lag is why a name sitting on ATH can look like a “lower high” if you only compare the last two *confirmed* highs.

**Regime rules we actually encode (after a bugfix):**

Let `lastH` / `lastL` be the last **confirmed** swing high/low. `close` is the latest bar close.

1. **BROKEN** if `close < lastL` (lost the last swing low). This is the only weekly invalidation.
2. **UP** if `close > lastH` (already took the last confirmed high — a live breakout/ATH counts even before the new high is confirmed) **or** classic HH+HL.
3. **DOWN** if last two confirmed highs are lower **and** last two confirmed lows are lower, but close is still ≥ lastL.
4. Else **MIXED**.

Weekly label mapping:

- `BROKEN` → pill **Weekly BROKEN** → action **EXIT**
- `UP` → **Weekly UP**
- `DOWN` or `MIXED` → **Weekly WEAK** (still above lastL; do **not** treat as EXIT)

**Do not** map weekly `DOWN` fractals to BROKEN. That was the bug that marked HYPE as EXIT at ATH: last confirmed highs were still the July stall (~$71 / $73) while price was ~$93. Weekly HL on the card was ~$52 (44% below) — inconsistent with BROKEN.

Daily:

- If weekly UP and daily DOWN or BROKEN → **CORRECTION**, with a day count from last daily swing high (approx).
- Else pass through UP / DOWN / MIXED.

Cycle (extended vs discounted):

- Daily UP: **EXTENDED** if close ≥ 1.272 of last impulse **or** within 1.5% of impulse high; **DISCOUNTED** if close in 0.382–0.618 retrace.
- CORRECTION: use **weekly** fib of last weekly impulse (lastL → live 26-bar high). Discounted if in weekly 0.382–0.618 box.

Impulse fib: `lastL` to `liveHigh` where `liveHigh = max(close, last 26 bars’ highs)`.

Actions:

| Weekly | Daily | Cycle | Action |
|---|---|---|---|
| BROKEN | * | * | **EXIT** |
| UP | CORRECTION | DISCOUNTED | **STAGED BID** |
| UP | CORRECTION | else | **HOLD RUNNER** |
| UP | UP | EXTENDED | **TRIM** |
| UP | UP | DISCOUNTED | **RELOAD** |
| else | | | **HOLD** |

These are labels, not orders. No auto-size, no broker sync.

### What we deliberately did not build (v1)

- 3D candles (orphaned TF)
- Weekly-only timing (too slow for trims)
- Daily-only invalidation (too twitchy in an alt bull)
- Narrative NLP, OI/funding overlay on the book (AlphaX scanner has OI; the book does not)
- MySQL (one personal JSON blob; file store is enough; last-write-wins)
- Broker APIs / Hyperliquid live positions
- Applying HTF logic to RH trenches

---

## How to think about a review (“grade the homework”)

Please grade against **intent**, not against a Bloomberg terminal.

**Should be true:**

1. AlphaX scanner does not call CoinGecko from the browser; it uses `api.php`.
2. RH trenches does not call DexPaprika from the browser; `src=dp`.
3. Demo key is only in gitignored `config.php` on the server.
4. Book qty is coins; USD+leverage+price can derive qty.
5. Partial sell locks realized PnL and does not change remaining average until a new buy.
6. Extra margin does not change average entry.
7. Weekly BROKEN = close under last confirmed swing low, not “fractals still look like the last correction.”
8. Taking the last confirmed weekly high (including ATH) is UP.
9. CORRECTION exists so a 6–15 day alt bleed inside a living weekly uptrend is not EXIT.
10. Book JSON is not web-accessible under `/alphax-scanner/`.
11. Secrets are not in git.

**Known weaknesses to call out if you agree they matter:**

- Weekly H/L from daily **closes**, so wick-based weekly structure is missing.
- Fractals still lag; we patched the ATH case with `close > lastH`, not a full market-structure engine.
- CoinGecko 30d OHLC is 4h; 365d OHLC is 4-day — easy to regress if someone “simplifies” to one OHLC call.
- `book-store.php` CORS `*` + hash-as-capability. Fine for a personal phrase; not auth.
- SHA-256(phrase) is not a password KDF; phrase strength matters.
- No conflict merge if two devices save at once.
- Effective leverage on screen is `notional/margin`. If the user typed target 10x or under-margined a 2x thesis, the card will show ~10x+ — that is the ledger, not a bug in the weekly detector.
- ENA can be “weekly UP” on a local breakout while still far below a 52-week high. That is **this leg**, not “macro ATH bull.”
- Actions (TRIM/EXIT) are heuristic; they will be wrong in chop.
- No tests. Logic lives in `book.html` as functions: `fold`, `sizeFromInputs`, `structure`, `regimeFromOhlc`.

---

## Conventions for future edits

- Match the existing HTML/CSS/JS style. No React/Vite unless the owner asks.
- Keep proxy allowlists tight. New Gecko paths need a regex or exact entry.
- After `book.html` / `api.php` / `book-store.php` changes: scp to SiteGround **and** push `main`.
- Never print or commit `config.php`, the CoinGecko key, SiteGround passwords, or the user’s sync phrase.
- Do not “helpfully” move book JSON back under `public_html`.
- If you change structure rules, document the new definition here in the same PR/commit, and sanity-check HYPE-at-highs (must not be EXIT solely because confirmed highs lag).

---

## Quick sanity commands

```bash
# Gecko key is working
curl -sS 'https://aramt.com/alphax-scanner/api.php?path=simple/price&ids=hyperliquid,ethena&vs_currencies=usd'

# Daily closes exist (interval=daily)
curl -sS 'https://aramt.com/alphax-scanner/api.php?path=coins/hyperliquid/market_chart&vs_currency=usd&days=365&interval=daily' | python3 -c 'import json,sys; p=json.load(sys.stdin)["prices"]; print(len(p), (p[1][0]-p[0][0])/3600000, "hours")'

# Book store rejects bad keys
curl -sS 'https://aramt.com/alphax-scanner/book-store.php?k=nope'
```
