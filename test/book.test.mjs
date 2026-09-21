// Pins the book's pure logic. Run: node test/book.test.mjs
//
// Extracts the functions out of book.html rather than copying them, so these
// tests exercise the code that actually ships. No deps, no build step.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "book.html"), "utf8");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in book.html`);
  // Skip the parameter list first: destructured params like ({ qty, price })
  // contain braces that would end the scan early.
  let p = src.indexOf("(", start), pd = 0, bodyStart = -1;
  for (let j = p; j < src.length; j++) {
    if (src[j] === "(") pd++;
    else if (src[j] === ")" && --pd === 0) { bodyStart = src.indexOf("{", j); break; }
  }
  if (bodyStart < 0) throw new Error(`no body for ${name}`);
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const NAMES = ["fold", "sizeFromInputs", "bucketBars", "toDaily", "toWeekly",
               "swings", "structure", "stretchZ", "trendRegime", "fundingCost", "allocTargets", "daysSince", "regimeFromOhlc", "actionFor"];
// The EXTENDED threshold is a top-level const, not a function.
const CONSTS = src.match(/const EXTENDED_Z = [\d.]+;[\s\S]*?const MAX_WEIGHT = [\d.]+;/)[0];
const { fold, sizeFromInputs, structure, stretchZ, trendRegime, fundingCost, allocTargets, regimeFromOhlc, actionFor } =
  new Function(CONSTS + "\n" + NAMES.map(grab).join("\n") + `\nreturn {${NAMES.join(",")}};`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;
const group = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- ledger ----
group("Ledger (AGENTS.md claims 4, 5, 6)");
{
  const f = fold([
    { ts: 1, type: "buy",  qty: 100, price: 10 },
    { ts: 2, type: "buy",  qty: 100, price: 20 },
    { ts: 3, type: "sell", qty: 50,  price: 30 },
  ]);
  ok("partial sell locks realized PnL", near(f.realized, 750), JSON.stringify(f));
  ok("partial sell leaves average entry alone", near(f.avg, 15));
  ok("remaining qty is correct", near(f.qty, 150));

  const g = fold([{ ts: 1, type: "buy", qty: 100, price: 10 }, { ts: 2, type: "margin_in", usd: 500 }]);
  ok("margin_in does not move average entry", g.avg === 10 && g.margin === 500);

  const h = fold([
    { ts: 1, type: "buy",  qty: 10, price: 10 },
    { ts: 2, type: "sell", qty: 10, price: 5 },
    { ts: 3, type: "buy",  qty: 10, price: 100 },
  ]);
  ok("average resets after going flat", h.avg === 100 && near(h.realized, -50));

  ok("qty from margin: $2000 @ 2x @ $0.25 = 16000 coins",
     sizeFromInputs({ usd: 2000, lev: 2, price: 0.25, kind: "margin" }).qty === 16000);
  ok("qty from notional: $2000 @ $0.25 = 8000 coins",
     sizeFromInputs({ usd: 2000, lev: 2, price: 0.25, kind: "notional" }).qty === 8000);
}

group("Trim tracking (new)");
{
  const f = fold([
    { ts: 1, type: "buy",  qty: 100, price: 10 },
    { ts: 2, type: "sell", qty: 40,  price: 25 },
  ]);
  ok("peakQty remembers full size", f.peakQty === 100, `peakQty=${f.peakQty}`);
  ok("lastSell records the trim price", f.lastSell === 25);

  const flat = fold([
    { ts: 1, type: "buy",  qty: 100, price: 10 },
    { ts: 2, type: "sell", qty: 100, price: 25 },
    { ts: 3, type: "buy",  qty: 10,  price: 30 },
  ]);
  ok("going flat resets peakQty (re-entry is a new position)", flat.peakQty === 10, `peakQty=${flat.peakQty}`);
  ok("going flat clears lastSell", flat.lastSell === null);
}

// ------------------------------------------------------------- structure ----
group("Weekly structure (AGENTS.md claims 7, 8)");
{
  const bar = (t, h, l, c) => ({ t, o: c, h, l, c });
  const wk = (n) => Date.UTC(2025, 0, 6) + n * 7 * 86400000;

  // The HYPE-at-ATH regression: confirmed highs lag at ~68 while price is 93.
  const ath = [bar(wk(0),40,30,35), bar(wk(1),71,40,70), bar(wk(2),50,45,48),
               bar(wk(3),60,46,58), bar(wk(4),68,55,66), bar(wk(5),55,50,52), bar(wk(6),93,52,93)];
  const a = structure(ath, 1, 1);
  ok("live ATH above last confirmed high reads UP, not EXIT",
     a.state === "UP", `state=${a.state} lastH=${a.lastH?.px} close=${a.close}`);

  const brk = [bar(wk(0),60,50,55), bar(wk(1),70,45,68), bar(wk(2),80,60,78),
               bar(wk(3),90,70,88), bar(wk(4),95,75,92), bar(wk(5),85,72,74), bar(wk(6),75,40,42)];
  const b = structure(brk, 1, 1);
  ok("close under last confirmed swing low is BROKEN",
     b.state === "BROKEN", `state=${b.state} lastL=${b.lastL?.px}`);

  const dn = [bar(wk(0),100,80,90), bar(wk(1),120,90,110), bar(wk(2),95,70,80),
              bar(wk(3),110,75,100), bar(wk(4),90,60,70), bar(wk(5),85,65,75), bar(wk(6),80,68,72)];
  ok("lower highs + lower lows while holding the low is DOWN, not BROKEN",
     structure(dn, 1, 1).state === "DOWN");

  ok("too little history returns NA", structure([bar(wk(0),1,1,1), bar(wk(1),1,1,1)], 1, 1).state === "NA");
}

// --------------------------------------------------- trim -> breakout arc ----
const DAY = 86400000, T0 = Date.UTC(2025, 0, 6);
const series = () => {
  const px = [];
  // Long enough that the regime MA exists (100 DMA + a week of weekly closes).
  for (let i = 0; i < 180; i++) px.push(20 + i * 0.222);     // long base rally
  for (let i = 0; i < 20; i++) px.push(60 - i * 0.6);        // pullback
  for (let i = 0; i < 50; i++) px.push(48 + i * 1.04);       // impulse to ~99 (trim here)
  const trim = px[px.length - 1];
  for (let i = 0; i < 21; i++) px.push(trim - 2 + Math.sin(i / 2) * 1.5); // 3wk sideways
  const consol = px.length;
  for (let i = 0; i < 10; i++) px.push(trim + i * 2.2);      // breakout, never retraced
  return { px, trim, consol };
};
const { px, trim, consol } = series();
const at = (n) => regimeFromOhlc(px.slice(0, n).map((c, i) => [T0 + i * DAY, c]), []);

const FULL    = { qty: 100, peakQty: 100, lastSell: null };
const TRIMMED = { qty: 50,  peakQty: 100, lastSell: trim };

group("EXTENDED means stretched, not merely at a high");
{
  const bo = at(consol + 3);
  ok("a fresh breakout to a new high is not automatically EXTENDED",
     bo.cycle !== "EXTENDED", `cycle=${bo.cycle} z=${bo.stretch && bo.stretch.z.toFixed(2)}`);
  ok("stretch and its z-score are reported so a TRIM call can be checked by hand",
     bo.stretch != null && isFinite(bo.stretch.now) && isFinite(bo.stretch.z));
  ok("the unreachable e127 field is gone", at(px.length).daily.fib.e127 === undefined);
  ok("the x127 stopgap is gone too", at(px.length).daily.fib.x127 === undefined);

  // Stretch must be monotone in price: the same bars pushed higher cannot be
  // scored as less extended. This holds whatever threshold is chosen.
  const bars = px.map((c, i) => ({ t: T0 + i * DAY, o: c, h: c, l: c, c }));
  const hotter = bars.map((b, i) => i === bars.length - 1 ? { ...b, c: b.c * 1.25 } : b);
  ok("pushing the last close higher raises the stretch score",
     stretchZ(hotter, 50).z > stretchZ(bars, 50).z);
  ok("stretch is null when there is too little history", stretchZ(bars.slice(0, 40), 50) === null);
}

group("The reported bug: trimmed, never retraced, then broke out");
{
  // Note: whether day 130 reads EXTENDED depends on EXTENDED_Z, so this suite
  // does not assert it on synthetic bars -- a linear ramp has near-constant
  // stretch and would only ever confirm the fixture. The threshold-independent
  // claim is that a full position has nothing to re-enter.
  ok("a full position at the high is never told to RE-ENTER",
     actionFor(at(130), FULL) !== "RE-ENTER", `got ${actionFor(at(130), FULL)}`);

  const bo = at(consol + 3);
  ok("after the breakout, a trimmed position is told to RE-ENTER",
     actionFor(bo, TRIMMED) === "RE-ENTER",
     `got ${actionFor(bo, TRIMMED)} (weekly=${bo.weeklyState} daily=${bo.dailyState} cycle=${bo.cycle})`);

  let reenter = 0, trimAgain = 0;
  for (let n = 131; n <= px.length; n++) {
    const act = actionFor(at(n), TRIMMED);
    if (act === "RE-ENTER") reenter++;
    if (act === "TRIM") trimAgain++;
  }
  ok("the trimmed position gets at least one way back in", reenter > 0, `RE-ENTER=${reenter}`);
  ok("a trimmed position is never told to TRIM again", trimAgain === 0, `TRIM=${trimAgain}`);
}

group("Re-entry guards");
{
  const bo = at(consol + 3);
  ok("an untrimmed position is not told to RE-ENTER",
     actionFor(bo, FULL) !== "RE-ENTER", `got ${actionFor(bo, FULL)}`);
  ok("a watch-only row (no position) is not told to RE-ENTER",
     actionFor(bo, { qty: 0, peakQty: 0, lastSell: null }) !== "RE-ENTER");
  ok("no re-entry while price is still below where we sold",
     actionFor(bo, { qty: 50, peakQty: 100, lastSell: 500 }) !== "RE-ENTER");

  // One close above the trim, the day before still below: must not fire.
  const oneDay = { ...at(consol + 3) };
  oneDay.closes2 = [trim - 1, trim + 5];
  ok("a single reclaim close does not fire re-entry (needs two)",
     actionFor(oneDay, TRIMMED) !== "RE-ENTER", `got ${actionFor(oneDay, TRIMMED)}`);

  // Both a valid reclaim AND already stretched: must not chase.
  const chase = { ...bo, cycle: "EXTENDED", closes2: [trim + 5, trim + 9] };
  ok("re-entry does not fire into an already EXTENDED move",
     actionFor(chase, TRIMMED) === "HOLD", `got ${actionFor(chase, TRIMMED)}`);

  const extended = { ...bo, cycle: "EXTENDED", daily: { ...bo.daily, tookHigh: false } };
  ok("trimmed + extended says HOLD, not TRIM (missed it, do not chase)",
     actionFor(extended, TRIMMED) === "HOLD", `got ${actionFor(extended, TRIMMED)}`);
  ok("untrimmed + extended still says TRIM",
     actionFor(extended, FULL) === "TRIM");

  const broken = { ...bo, weeklyState: "BROKEN" };
  ok("weekly BROKEN overrides re-entry", actionFor(broken, TRIMMED) === "EXIT");

  const corr = { ...bo, dailyState: "CORRECTION", cycle: "MID" };
  ok("an active correction outranks re-entry", actionFor(corr, TRIMMED) === "HOLD RUNNER");

  const chop = { ...bo, dailyState: "CORRECTION", cycle: "DISCOUNTED", close: 98, daily: { lastH: { px: 100 }, tookHigh: false } };
  ok("a fib-discounted correction with no real dip is HOLD RUNNER, not a bid",
     actionFor(chop, TRIMMED) === "HOLD RUNNER", `got ${actionFor(chop, TRIMMED)}`);
  const realDip = { ...chop, close: 90 };
  ok("a 5%+ dip into the weekly box is STAGED BID",
     actionFor(realDip, TRIMMED) === "STAGED BID", `got ${actionFor(realDip, TRIMMED)}`);
}

group("Regime gate (100 DMA, two completed Sunday closes)");
{
  const DAYMS = 86400000;
  // Monday-anchored so weekly closes land on Sundays.
  const mk = (closes) => closes.map((c, i) => ({ t: Date.UTC(2024, 0, 1) + i * DAYMS, o: c, h: c, l: c, c }));

  ok("not enough history is THIN, not a bearish label",
     trendRegime(mk(Array.from({ length: 100 }, () => 10))).state === "THIN");

  const up = mk(Array.from({ length: 300 }, (_, i) => 10 + i * 0.1));
  ok("a sustained uptrend is BULL", trendRegime(up).state === "BULL", `got ${trendRegime(up).state}`);
  ok("the regime MA is reported for display", trendRegime(up).ma > 0);

  // Same history, then a hard sustained break well below the average.
  const broke = mk([...Array.from({ length: 300 }, (_, i) => 10 + i * 0.1),
                    ...Array.from({ length: 30 }, () => 5)]);
  ok("two Sunday closes below the 100 DMA is BROKEN",
     trendRegime(broke).state === "BROKEN", `got ${trendRegime(broke).state}`);

  // 300 bars from Monday 2024-01-01: index 299 is Saturday, so the next bar is
  // Sunday. Four crash days = one Sunday plus Mon-Wed. Must stay BULL.
  const midweek = mk([...Array.from({ length: 300 }, (_, i) => 10 + i * 0.1),
                      ...Array.from({ length: 4 }, () => 5)]);
  ok("one weak Sunday plus a mid-week dip is not BROKEN",
     trendRegime(midweek).state === "BULL", `got ${trendRegime(midweek).state}`);

  // A single dip that recovers inside the same week must not break the regime.
  const dip = mk([...Array.from({ length: 300 }, (_, i) => 10 + i * 0.1),
                  5, ...Array.from({ length: 10 }, (_, i) => 40 + i)]);
  ok("a recovered dip does not break the regime",
     trendRegime(dip).state === "BULL", `got ${trendRegime(dip).state}`);

  ok("THIN emits no trade action",
     actionFor({ weeklyState: "THIN", dailyState: "UP", cycle: "EXTENDED", closes2: [1, 2], daily: {} },
               { qty: 100, peakQty: 100, lastSell: null }) === "HOLD");
}

group("Funding accrual");
{
  const DAY = 86400000, T0 = Date.UTC(2025, 0, 1);
  const YEAR_LATER = T0 + 365 * DAY;

  // 100 coins at $10 = $1,000 notional held for exactly one year at 8%/yr.
  const held = [{ ts: T0, type: "buy", qty: 100, price: 10 }];
  ok("one year at 8% on $1,000 notional costs $80",
     Math.abs(fundingCost(held, 8, 10, YEAR_LATER) - 80) < 0.01,
     `got ${fundingCost(held, 8, 10, YEAR_LATER).toFixed(2)}`);

  ok("a zero rate costs nothing", fundingCost(held, 0, 10, YEAR_LATER) === 0);
  ok("half the year costs half", Math.abs(fundingCost(held, 8, 10, T0 + 182.5 * DAY) - 40) < 0.01);

  ok("funding scales with the mark, not the entry",
     fundingCost(held, 8, 20, YEAR_LATER) > fundingCost(held, 8, 10, YEAR_LATER));

  // Closed after half a year: no accrual on a flat position afterwards.
  const closed = [{ ts: T0, type: "buy", qty: 100, price: 10 },
                  { ts: T0 + 182.5 * DAY, type: "sell", qty: 100, price: 10 }];
  ok("a closed position stops accruing",
     Math.abs(fundingCost(closed, 8, 10, YEAR_LATER) - 40) < 0.01,
     `got ${fundingCost(closed, 8, 10, YEAR_LATER).toFixed(2)}`);

  ok("a watch-only row with no fills costs nothing", fundingCost([], 8, 10, YEAR_LATER) === 0);
  ok("margin events alone do not accrue funding",
     fundingCost([{ ts: T0, type: "margin_in", usd: 5000 }], 8, 10, YEAR_LATER) === 0);

  // Trimming half the position halves the accrual from that point on.
  const trimmed = [{ ts: T0, type: "buy", qty: 100, price: 10 },
                   { ts: T0 + 182.5 * DAY, type: "sell", qty: 50, price: 10 }];
  ok("a trim reduces funding from the trim onward",
     Math.abs(fundingCost(trimmed, 8, 10, YEAR_LATER) - 60) < 0.01,
     `got ${fundingCost(trimmed, 8, 10, YEAR_LATER).toFixed(2)}`);
}

group("Suggested sizing");
{
  const E = (id, bull, mom, margin) => ({ id, bull, mom, margin });
  const sum = (p) => Object.values(p).reduce((s, x) => s + x.pct, 0);

  // Three BULL coins, $30k book. Rank by momentum: best gets the biggest share.
  const p = allocTargets([E("a", true, 0.9, 2000), E("b", true, 0.5, 5000), E("c", true, 0.1, 9000)], 30000, 1, { dynamic: false, cap: 1 });
  ok("strongest momentum is ranked first", p.a.rank === 1 && p.c.rank === 3);
  ok("weights sum to 1", Math.abs(sum(p) - 1) < 1e-9, `got ${sum(p)}`);
  ok("the leader gets the largest target", p.a.target > p.b.target && p.b.target > p.c.target);
  ok("targets sum to the whole book",
     Math.abs(p.a.target + p.b.target + p.c.target - 30000) < 1e-6);
  ok("under-sized leader is told to add", p.a.delta > 0, `delta=${p.a.delta}`);
  ok("over-sized laggard is told to trim", p.c.delta < 0, `delta=${p.c.delta}`);

  // Not BULL -> target zero, i.e. "close this one", which is what makes EXIT a number.
  const q = allocTargets([E("a", true, 0.9, 5000), E("dead", false, 0.9, 4000)], 20000, 1, { dynamic: false, cap: 1 });
  ok("a non-BULL coin targets zero", q.dead.target === 0 && q.dead.rank === null);
  ok("a non-BULL coin is told to trim its whole margin", Math.abs(q.dead.delta + 4000) < 1e-9);
  ok("a BULL coin alone takes the whole book", Math.abs(q.a.pct - 1) < 1e-9);

  // tilt = 0 is equal weight; tilt = 1 is the tested rank weighting.
  const eq = allocTargets([E("a", true, 0.9, 0), E("b", true, 0.1, 0)], 10000, 0, { dynamic: false, cap: 1 });
  ok("tilt 0 gives equal weight", Math.abs(eq.a.pct - eq.b.pct) < 1e-9);
  const tl = allocTargets([E("a", true, 0.9, 0), E("b", true, 0.1, 0)], 10000, 1, { dynamic: false, cap: 1 });
  ok("tilt 1 favours the leader", tl.a.pct > tl.b.pct);

  ok("a coin with no momentum history is not ranked",
     allocTargets([E("a", true, null, 1000)], 5000, 1, { dynamic: false }).a.rank === null);
  ok("an empty book produces an empty plan",
     Object.keys(allocTargets([], 10000, 1)).length === 0);
}

group("Cash is what is left over");
{
  const E = (id, bull, mom, margin) => ({ id, bull, mom, margin });
  const dep = (p) => Object.values(p).reduce((s, x) => s + x.pct, 0);
  const five = (nBull) => Array.from({ length: 5 }, (_, i) => E("c" + i, i < nBull, 0.9 - i * 0.1, 0));

  // At five coins the leader's rank weight is 33.3%, so the 33% cap shaves a
  // few basis points into cash. That is the cap working, not a rounding bug.
  ok("all five BULL suggests near-full deployment", dep(allocTargets(five(5), 1e5, 1)) >= 0.99,
     `got ${(100 * dep(allocTargets(five(5), 1e5, 1))).toFixed(1)}%`);
  ok("three of five BULL suggests 60% deployed", Math.abs(dep(allocTargets(five(3), 1e5, 1)) - 0.6) < 1e-9);
  ok("one of five BULL suggests 20% deployed", Math.abs(dep(allocTargets(five(1), 1e5, 1)) - 0.2) < 1e-9);
  ok("none BULL suggests all cash", dep(allocTargets(five(0), 1e5, 1)) === 0);

  ok("cash rises as coins break",
     dep(allocTargets(five(5), 1e5, 1)) > dep(allocTargets(five(3), 1e5, 1)));

  // The flaw this fixes: a lone survivor used to be handed the entire book.
  const lone = allocTargets(five(1), 1e5, 1);
  ok("a lone BULL coin is not handed the whole book",
     lone.c0.pct <= 0.33 + 1e-9, `got ${(100 * lone.c0.pct).toFixed(0)}%`);

  // Small books: two coins, rank weights would be 67/33 without a cap.
  const two = allocTargets([E("a", true, 0.9, 0), E("b", true, 0.1, 0)], 1e5, 1);
  ok("no single position exceeds the cap", two.a.pct <= 0.33 + 1e-9, `got ${(100 * two.a.pct).toFixed(0)}%`);

  ok("dynamic can be switched off",
     Math.abs(dep(allocTargets(five(3), 1e5, 1, { dynamic: false, cap: 1 })) - 1) < 1e-9);
}

console.log(`\n${fail ? "FAILED" : "ok"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
