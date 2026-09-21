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
test/               Node tests for the book's pure logic (not deployed)
.claude/            Local tooling only; not part of the app
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

**Funding is now charged** (see below). No trading fees, no liquidation engine. Liq is a distance check vs weekly HL (“is leverage the constraint, or the trend?”).

**Add coin:** preset or CoinGecko id, leverage, USD + kind (margin vs notional) or qty override.

Presets (CoinGecko ids): HYPE `hyperliquid`, RENDER `render-token`, ENA `ethena`, PENDLE `pendle`, PUMP `pump-fun`, LIT `lighter`, XPL `plasma`, plus majors.

Watch-only: add with no qty/USD.

### Funding

Perps pay funding continuously and the book charged none of it, so every PnL
number was overstated. Measured on OKX over 95 days, longs paid in **79–91% of
funding periods**: BTC **5.4%/yr**, ETH **3.9%/yr**, DOGE **6.3%/yr** on
*notional*. At 2x that is roughly double against margin.

`fundingCost()` accrues across each gap between consecutive ledger events, on
the size held during that gap, using the last transacted price as the stand-in
for the price path and the live mark for the still-open gap. It needs no new
data source — only the event history already in the book.

`FUNDING_APR_DEFAULT` is **8%/yr**, editable in the toolbar and stored per book
as `fundingApr`. Set it to 0 to switch funding off.

**It is an estimate, and it is shown on its own line** — `Total PnL (gross)`,
`Funding (est)`, `Net PnL` — so it never silently rewrites realized or
unrealized PnL. `ROE (net)` and the simple-view tile use the net figure.

Known limits: one global rate for the whole book, not per coin; the real rate
varies by venue and by day, and AlphaX funding will not match OKX's; and the
price path between events is approximated by the last transacted price, so a
position held across a large move is estimated rather than exact. Logging exact
`funding` events is the obvious next step if the estimate proves too coarse.

### Suggested sizing (`allocTargets`)

Answers "which coin gets the next dollar, and how much" — the question the
action labels never carried a number for.

Capital is derived, not entered: **total = deployed margin + stables**, both
already in the book. BULL coins are ranked by **90-day momentum** and weighted
by rank; anything not BULL targets **zero**, which is what turns "cut this one"
into a dollar figure.

**Cash is not a percentage you choose.** The book deploys in proportion to how
much of it is actually in a bull regime — 5 of 5 BULL suggests ~100% deployed,
3 of 5 suggests 60%, 1 of 5 suggests 20%, none suggests all cash. Cash is the
remainder, so it rises on its own as coins break and falls as they recover.

Tested on the same 6-coin basket:

| policy | return | maxDD | return/DD | largest position |
|---|---|---|---|---|
| 0% cash floor (full deployment) | 2.60x | −77% | 0.034 | **100%** |
| 20% fixed cash floor | 2.56x | −67% | 0.038 | 80% |
| 40% fixed cash floor | 2.31x | −55% | 0.042 | 60% |
| **dynamic (bull share)** | **3.57x** | **−63%** | **0.057** | **29%** |

A **fixed** reserve is close to neutral — it scales return and risk down
together, so the number is a risk-tolerance choice, not an edge. **Dynamic cash
beat full deployment on both axes.** `DYNAMIC_CASH = false` reverts to always
fully deployed.

`MAX_WEIGHT` (0.33) bounds any single position. Dynamic sizing already held the
largest to 29% on the test basket, but a two-coin book would otherwise hand the
leader 67%. Before this, a lone surviving BULL coin was handed **100%** of the
book — at 2x that was the worst bug in the sizing model.

**Why momentum.** Cross-sectional test on 8.7 years of OKX daily closes, 6
coins, weekly samples, 30-day forward, top-half minus bottom-half:

| factor | spread | hit rate | t |
|---|---|---|---|
| **90d momentum** | **+15.5%** | **59%** | **2.90**† |
| furthest above 100 DMA | +14.0% | 55% | 2.60 |
| cheapest by stretch z | +3.3% | 47% | 0.61 |
| highest 30d volatility | +19.1% | **51%** | 3.47 |

Momentum is the only one where magnitude *and* frequency agree. The volatility
"edge" has the biggest t-stat and a 51% hit rate — it wins barely half the time
with huge magnitude, which is **beta, not prediction**; at 2x it is how you get
liquidated. Buying the cheapest coin does **not** work across coins:
DISCOUNTED/RELOAD is for timing *within* a coin, a different question.

† **That t-stat was overstated and is corrected here.** It came from weekly
samples with 30-day forward windows, which overlap heavily. Re-run with
**non-overlapping** windows on the same 8.7 years, 90d momentum gives
**t=1.90**, spread +18.4%, hit 57% — suggestive, not significant. On the
separate Coinalyze basket (10 coins, 2022-2026, non-overlapping) it gives
**t=0.21**.

Allocating by momentum rank returned **2.60x vs 2.00x** equal-weight at the same
drawdown (−77% vs −79%). Split by period, that edge is front-loaded:

| period | equal weight | momentum tilt | tilt edge |
|---|---|---|---|
| full | 2.63x | 3.57x | **+36%** |
| to 2024-07 | 2.09x | 2.78x | +33% |
| 2024-07 onward | 1.26x | 1.28x | **+2%** |

The tilt **never lost** in any split, which is why `ALLOC_TILT` stays at 1, and
cross-sectional momentum has strong support outside this sample. But its edge
has been roughly nil for two years while it raises the top position from 20% to
33% (with five coins). If that concentration bothers you at 2x, `ALLOC_TILT = 0`
is equal weight and on recent evidence costs you almost nothing.

**Limits, and they are real:**

- Six coins. Overlapping 30-day windows from weekly samples means the effective
  sample is far smaller than n=148, so the t-stats are inflated — probably by
  about half. Momentum's real support is the external literature, not this test.
- The test used established coins. **A recently listed token that has run hard
  will rank #1 and attract the largest suggested add** — exactly where reversal
  risk is highest. This extrapolates beyond what was tested. Watch it on LIT,
  XPL and PUMP.
- Momentum crashes at turns. That is its documented failure mode.
- Open interest **was** tested and rejected — see below. It is absent on
  evidence, not for lack of data.
- `ALLOC_TILT` dials the tilt: 1 is what was tested, 0 is equal weight across
  BULL coins.

Shown as **suggestions** — never as orders, and never auto-applied.

### Coach: what to do next (the actual product)

The book is supposed to tell a trader trying to ride a bull toward **$500k**
what to consider next, in English, with a number.

`HOUSE_LEV` defaults to **2×** (editable as "House lev" on the book). Effective
leverage above `HOUSE_LEV * 1.25` (so 2.5×+) is **DE-LEVER**: add margin from
stables to sit at house leverage. That outranks TRIM and any add. A 15% isolated
dip at 10× is how you fail a six-month bull, not by missing a pico top.

Precedence (also in `actionFor`):

| Priority | Action | Means |
|---|---|---|
| 1 | **EXIT** | Consider selling everything in this name. Two Sunday closes under 100 DMA. |
| 2 | **DE-LEVER** | Consider adding margin. Do this before buying more coins. |
| 3 | **TRIM** | Consider selling ~30% of coins into stretch. Keep a runner. |
| 4 | **RE-ENTER** | Consider buying back the sleeve after a real reclaim. |
| 5 | **RELOAD / STAGED BID** | Consider buying more — only on a discount or a ≥5% dip. |
| 6 | **HOLD RUNNER** | Sit. Do not sell weakness. |
| 7 | **HOLD** | No edge. Wait. |

The top **coach** bar states: current equity, multiple still needed to $500k,
then the first move (sell / de-lever / trim / buy). Each card has a
"Consider …" paragraph. $500k is a scoreboard, not a forecast.

### Open interest: tested on 4 years, adds nothing

**Settled, with good data.** A live Coinalyze key already exists in the sibling
project `~/Local Sites/crypto-oi/.env` (the Flush Board). It gives **4.1 years**
of daily OI back to 2022-08, funding and liquidations back to 2021-01, and
covers every coin in the book including ENA. Price and OI come from the same
endpoint, so there is no date-alignment problem. Do not pay for anything.

Tested cross-sectionally on 10 coins, 2022-2026, **non-overlapping** 30-day
windows (n=46):

| factor | spread | hit | t |
|---|---|---|---|
| price momentum 30d (control) | +0.40% | 54% | 0.21 |
| OI growth 30d | +0.91% | 59% | 0.44 |
| OI z vs own 60d | −0.05% | 54% | −0.02 |
| price up + OI up | −0.79% | 52% | −0.37 |
| pure OI (OI growth − price growth) | +0.59% | 50% | 0.34 |

Nothing. No OI specification clears t=0.5. The earlier 180-day result that
looked strong (86-93% hit rates) was price momentum in disguise plus an
overlapping-window artifact.

The crowding hypothesis — extreme OI marking a local top — has now had its fair
hearing on data spanning a real top, and it is not there. **Do not revisit this
without a genuinely new idea, not just more data.**

OI's real use is the job the Flush Board already does with it: liquidation
cascades and forced-selling exhaustion, which is a different question from
"which coin do I add to". Live OI also stays in the AlphaX scanner for
discovery. Neither belongs in the HTF book.

### Simple view

`viewBtn` toggles a compact grid (`.wrap.simple`) of one tile per coin: symbol,
mark, the action, regime, 24h change, PnL, and a bar showing how far the coin has
travelled toward `EXTENDED_Z`. The add-coin, entry and sync rows are hidden
(`body.simple-mode .toolbar.adv`) so the whole book fits above the fold. Clicking
a tile drops back to that coin's detailed card — the simple view is a snapshot,
never somewhere you log a fill from. The preference is per-browser in
`localStorage` (`htf-book-view`) and is deliberately **not** synced.

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

### Regime: is the bull still alive? (`trendRegime` in `book.html`)

**BULL** until **two consecutive weekly closes** land under the **100 DMA**; back
to BULL on the first weekly close above it. **THIN** when there are fewer than
107 daily bars — reported as its own state instead of being folded into a
bearish-looking label, and it emits no trade action.

This replaced the old rule (close under the last confirmed weekly swing low).
Replayed on real daily closes for HYPE, ENA, RENDER, PENDLE and BTC over the
same window, the candidates scored:

| rule | episodes | whipsaws |
|---|---|---|
| old: close < last confirmed weekly swing low | 18 | **18** |
| close < 50 DMA | 28 | 22 |
| close < 200 DMA | 12 | 8 |
| close < *falling* 200 DMA | 16 | 7 |
| **2 weekly closes < 200 DMA** | 6 | **0** |
| 2 weekly closes < 140 DMA | 4 | 0 |

(whipsaw = a BROKEN call that resolved back to BULL within 14 days.) The old
rule whipsawed on every one of its 18 exits. A daily MA cross still whipsawed 8
times; testing the cross only on weekly closes removed them entirely.

**Backtested on 8.7 years of real OKX daily OHLC** (BTC, ETH, SOL, LINK, AVAX,
DOGE — through the 2021 top and the 2022 bear), walk-forward, decision taken at
the prior close. Pooled result vs buy-and-hold, at 2 weekly closes:

| MA | 60 | 70 | 80 | 90 | **100** | 110 | 120 | 140 | 160 | 180 | 200 | 250 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| vs hold | +231% | +133% | +40% | +107% | **+102%** | +45% | +32% | +12% | −6% | −3% | **−20%** | −61% |

`REGIME_MA` was originally 200, chosen on whipsaw count over a 5-month bull
sample. **That was wrong** — 200 returned 20% less than buy-and-hold over the
full period and was beaten by every faster setting. Minimising whipsaws is a bad
proxy for making money.

**What this does NOT establish.** Split in half, the filter *lost* over
2018–2021 (100/2: −28%) and *won* over 2022–2026 (+102%) — and the best length
flips between the halves (100 in the first, 140 in the second). The sweep is
jagged: adjacent lengths swing by 60+ points, so any single pick is
substantially luck. 100 is chosen because it wins the full sample and the weaker
half and is never catastrophic, not because it is optimal. 100 vs 140 is inside
the noise.

Drawdown protection is real but modest: at 100/2, max drawdown was −52% (BTC)
and −70% (ETH) against −77% and −94% buy-and-hold, but still −88% on LINK and
−92% on DOGE. **At 2x that is a liquidation either way.** The filter is not a
risk control.

The cost/benefit is time-shifted: the filter pays for itself in bears and costs
you in violent melt-ups (its 2018–2021 loss is mostly missed 2020–21 upside).
Under an "early bull" thesis the cost comes first and the benefit comes later.

A 5% and a 10% buffer under the MA were both tested and made things worse (21
and 29 episodes). No buffer is used. The cost is that a marginal break — price
0.3% under the line on two weekly closes — reads the same as a decisive one.

`trendRegime` only inspects **Sunday UTC** bars. The live mid-week close is
ignored, so one weak Sunday plus a Wednesday dip cannot flip BROKEN.

### Do not de-risk into weakness

Replaying "sell the swing sleeve when the book says CORRECTION, buy back on the
first redeploy signal" over the same real data: **30 of 35 round trips lost
money, −139% total, −3.97% average.** The cause is that CORRECTION was never a
correction detector — **86% of its episodes never fell more than 5% below where
they started, and the median depth was 0.0%.** PENDLE printed 12 in seven months.

So CORRECTION stays **informational**. It maps to HOLD RUNNER and never to an
exit. The way to hold stables during a drawdown is to have **trimmed into the
top** (TRIM builds the pile, RELOAD / STAGED BID / RE-ENTER spend it), not to
sell the dip. Stables are a consequence of selling strength, never of selling
weakness.

### Fractal structure (`structure()` in `book.html`)

Still used for the **daily** swing state and for the weekly **fib box** only —
no longer for the regime.

Weekly fractals no longer produce a regime label. `structure(weekly, 1, 1)` is
kept only for `w.fib`, the weekly retracement box used by STAGED BID.

Daily:

- If weekly UP and daily DOWN or BROKEN → **CORRECTION**, with a day count from last daily swing high (approx).
- Else pass through UP / DOWN / MIXED.

Cycle (extended vs discounted):

- Daily UP: **EXTENDED** if the stretch z-score (below) is ≥ `EXTENDED_Z`; **DISCOUNTED** if close in the 0.382–0.618 retrace box.
- CORRECTION: use **weekly** fib of last weekly impulse (lastL → live 26-bar high). Discounted if in weekly 0.382–0.618 box.

Retrace fib: `lastL` to `liveHigh` where `liveHigh = max(close, last 26 bars' highs)`. Retracement only — see below for why the extension moved off fibs.

**Stretch (`stretchZ`), and why EXTENDED was rebuilt.** The old test was
`close >= e127 || close >= high * 0.985`, and both halves were broken:

- `e127` was projected off `liveHigh`, and `liveHigh` includes `close`, so
  `e127 > close` always. It could never fire. Measured: 0 hits in 79 bars.
- The surviving clause was therefore the whole rule — and it is true at **any**
  new high, since `close == liveHigh >= 0.985 * liveHigh`. So every breakout
  read EXTENDED and the book said TRIM into strength.

Measuring the extension off the last *confirmed* pivots does not fix it either:
after a consolidation the last confirmed pivot pair **is** the consolidation, so
1.272 of a chop range is a meaningless threshold (tested: a 2.30-wide wiggle
produced an x127 only 0.6 above the range high). A percentile rank does not work
either — on real daily closes the same setting fired on 2% of RENDER days and
93% of ENA days.

What ships instead: `stretchZ` takes `close / SMA50 - 1`, then scores today
against the distribution of that value over the coin's own last year. EXTENDED
is `z >= EXTENDED_Z` with stretch positive.

**`EXTENDED_Z` is a judgment dial, not a discovered constant.** At the default
2.0, measured on real daily closes gated to weekly-UP + daily-UP, it fires on
roughly 14% of HYPE days, 28% of PENDLE, 17% of BTC, ~0% of RENDER and ~87% of
ENA. It does **not** behave uniformly across coins. Raise it to trim less, lower
it to trim more. The card shows the raw stretch % and the z-score next to the
threshold so any TRIM call can be checked by hand.

### Actions depend on the ledger, not only on price

`regimeFromOhlc` is price-only and cached per coin. The action is derived
separately by `actionFor(regime, positionState)` **at render time**, so logging
a fill changes the action immediately instead of waiting for a refresh.

`fold()` additionally returns `peakQty` (largest size held since the position was
last flat) and `lastSell` (price of the most recent sell). Both reset when qty
hits 0, because a re-entry after a full exit is a new position, not a trim.
A position is **trimmed** when `0 < qty < peakQty`.

**RE-ENTER — the missing invalidation.** A trim previously had no invalidation
level. The runner has one (weekly BROKEN); the swing sleeve had an entry trigger
and an exit trigger but no "I was wrong to sell" trigger. If price never
retraced to the 0.382–0.618 box and instead broke out, the book said TRIM again
and you ratcheted out of your best name. RE-ENTER fires when **all** hold:

- weekly UP **and** daily UP
- daily `tookHigh` (structural break of the last confirmed daily high)
- the **last two** daily closes are above `lastSell` — one reclaim wick that
  reverses the same day does not count
- the position is trimmed (`0 < qty < peakQty`)
- the cycle is **not** EXTENDED

Actions, in precedence order:

| Condition | Action |
|---|---|
| Weekly BROKEN | **EXIT** |
| Effective lev > house × 1.25 | **DE-LEVER** |
| Daily CORRECTION + weekly-discounted + **≥5% below the starting swing high** | **STAGED BID** |
| Daily CORRECTION (otherwise) | **HOLD RUNNER** |
| EXTENDED, position already trimmed | **HOLD** (missed it — do not chase, do not trim again) |
| EXTENDED, position full | **TRIM** |
| Reclaim conditions above | **RE-ENTER** |
| DISCOUNTED + weekly UP + daily UP | **RELOAD** |
| else | **HOLD** |

EXTENDED deliberately outranks RE-ENTER: extension is where the swing sleeve is
sold, so buying it back there is chasing.

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
7. Weekly regime is BULL / BROKEN / THIN. BROKEN = **two completed Sunday UTC closes** under the 100 DMA. A live mid-week bar does not count. Fractal swing lows do **not** set the weekly regime.
8. Daily `tookHigh` (close above last confirmed daily high) is still how a *swing* breakout is detected, including ATH. That is not the weekly regime.
9. Daily CORRECTION is informational: HOLD RUNNER, never EXIT. STAGED BID only if the coin is actually ≥5% below the swing high that started the correction **and** in the weekly fib box.
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
- The regime rule beats buy-and-hold over 8.7 years but LOSES in one of the two sample halves, and the best MA length flips between halves. It is the single most important rule in the book and its exact setting is inside the noise.
- A marginal MA break reads identically to a decisive one, because buffers tested worse.
- `EXTENDED_Z` is unvalidated. It is a reasonable dial, not a backtested edge, and it fires very unevenly across coins (see above). Treat TRIM as a prompt to look, not a number to trust.
- RE-ENTER buys strength. The two-close guard blocks same-day reversals but not a two-day fakeout. In chop it will be wrong.
- Stretch uses `SMA50` of daily **closes**, so it inherits the close-only weakness above. It needs 80 daily bars; below that `stretchZ` returns null and the cycle stays MID.
- Suggested sizing ranks on a factor tested over six established coins; it will over-weight a hot new listing. See above.
- Funding is a flat estimated rate, not the venue's actual per-period rate. See above.
- Tests cover the pure logic only (`fold`, `sizeFromInputs`, `structure`, `stretchZ`, `regimeFromOhlc`, `actionFor`, `consider`). Nothing covers the DOM, the sync layer, or the PHP.
- Getting to $500k from a ~$40k book is roughly 11×. The tool will not print a path that is actually a 10× gamble on LIT. De-lever is the feature. The multiple is honest, not motivational.

---

## Conventions for future edits

- Match the existing HTML/CSS/JS style. No React/Vite unless the owner asks.
- Keep proxy allowlists tight. New Gecko paths need a regex or exact entry.
- After `book.html` / `api.php` / `book-store.php` changes: scp to SiteGround **and** push `main`.
- Never print or commit `config.php`, the CoinGecko key, SiteGround passwords, or the user’s sync phrase.
- Do not “helpfully” move book JSON back under `public_html`.
- If you change regime rules, document the new definition here in the same commit. Sanity-check: HYPE near highs must not be EXIT; one mid-week dip after a single weak Sunday must not be BROKEN.

---

## Quick sanity commands

```bash
# Book logic (pure functions, extracted live from book.html -- no deps)
node test/book.test.mjs

# Gecko key is working
curl -sS 'https://aramt.com/alphax-scanner/api.php?path=simple/price&ids=hyperliquid,ethena&vs_currencies=usd'

# Daily closes exist (interval=daily)
curl -sS 'https://aramt.com/alphax-scanner/api.php?path=coins/hyperliquid/market_chart&vs_currency=usd&days=365&interval=daily' | python3 -c 'import json,sys; p=json.load(sys.stdin)["prices"]; print(len(p), (p[1][0]-p[0][0])/3600000, "hours")'

# Book store rejects bad keys
curl -sS 'https://aramt.com/alphax-scanner/book-store.php?k=nope'
```
