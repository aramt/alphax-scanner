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
               "swings", "structure", "stretchZ", "trendRegime", "daysSince", "regimeFromOhlc", "actionFor"];
// The EXTENDED threshold is a top-level const, not a function.
const CONSTS = src.match(/const EXTENDED_Z = [\d.]+;[\s\S]*?const REGIME_WEEKS = \d+;/)[0];
const { fold, sizeFromInputs, structure, stretchZ, trendRegime, regimeFromOhlc, actionFor } =
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
  // Long enough that the 200 DMA exists (the regime gate needs 207 bars).
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
}

group("Regime gate (200 DMA, confirmed on weekly closes)");
{
  const DAYMS = 86400000;
  // Monday-anchored so weekly closes land on Sundays.
  const mk = (closes) => closes.map((c, i) => ({ t: Date.UTC(2024, 0, 1) + i * DAYMS, o: c, h: c, l: c, c }));

  ok("not enough history is THIN, not a bearish label",
     trendRegime(mk(Array.from({ length: 100 }, () => 10))).state === "THIN");

  const up = mk(Array.from({ length: 300 }, (_, i) => 10 + i * 0.1));
  ok("a sustained uptrend is BULL", trendRegime(up).state === "BULL", `got ${trendRegime(up).state}`);
  ok("the 200 DMA is reported for display", trendRegime(up).ma > 0);

  // Same history, then a hard sustained break well below the average.
  const broke = mk([...Array.from({ length: 300 }, (_, i) => 10 + i * 0.1),
                    ...Array.from({ length: 30 }, () => 5)]);
  ok("a sustained break below the 200 DMA is BROKEN",
     trendRegime(broke).state === "BROKEN", `got ${trendRegime(broke).state}`);

  // A single dip that recovers inside the same week must not break the regime.
  const dip = mk([...Array.from({ length: 300 }, (_, i) => 10 + i * 0.1),
                  5, ...Array.from({ length: 10 }, (_, i) => 40 + i)]);
  ok("a recovered dip does not break the regime",
     trendRegime(dip).state === "BULL", `got ${trendRegime(dip).state}`);

  ok("THIN emits no trade action",
     actionFor({ weeklyState: "THIN", dailyState: "UP", cycle: "EXTENDED", closes2: [1, 2], daily: {} },
               { qty: 100, peakQty: 100, lastSell: null }) === "HOLD");
}

console.log(`\n${fail ? "FAILED" : "ok"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
