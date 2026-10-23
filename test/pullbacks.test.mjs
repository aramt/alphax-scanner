// Pins the pullback page's pure logic. Run: node test/pullbacks.test.mjs
// Extracts the functions out of pullbacks.html rather than copying them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "pullbacks.html"), "utf8");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
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

const NAMES = ["pct", "pct1", "utcDay", "bandFor", "legHigh", "withMark", "seriesFor", "zoneFor", "statusText", "statusDetail"];
const api = new Function(NAMES.map(grab).join("\n") + `\nreturn {${NAMES.join(",")}};`)();
const { bandFor, legHigh, withMark, seriesFor, zoneFor, statusText, statusDetail } = api;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;
const T0 = Date.parse("2020-01-01T00:00:00Z");
const DAY = 86400000;
const bars = (closes) => closes.map((c, i) => ({ t: T0 + i * DAY, c }));

const BAND = { shallow: 0.19, typical: 0.24, deep: 0.30, worst: 0.63 };

console.log("\nRun high");
{
  // 100, a 30% dip to 70, a rally to 90. Shallow band is 25%, so the rally
  // (about 29% off the low) starts a new run and the old high is unreclaimed.
  const climb = [];
  for (let c = 50; c <= 100; c += 10) climb.push(c);
  const leg = legHigh(bars([...climb, 90, 80, 70, 80, 90]), 0.25);
  ok("bounce after a deep dip uses the new run high", near(leg.high, 90), JSON.stringify(leg));
  ok("the old high is kept as unreclaimed", near(leg.priorHigh, 100));
  ok("the dip is over once the rally confirms", leg.inDip === false);

  const taken = legHigh(bars([...climb, 70, 90, 110]), 0.25);
  ok("a new high clears the unreclaimed prior", taken.priorHigh == null && near(taken.high, 110), JSON.stringify(taken));

  const crashing = legHigh(bars([...climb, 80, 60, 40]), 0.25);
  ok("a dip with no rally still measures from the peak", near(crashing.high, 100) && crashing.inDip === true && crashing.priorHigh == null);

  const wiggle = legHigh(bars([...climb, 95, 92]), 0.25);
  ok("a dip inside the shallow band does not end the run", near(wiggle.high, 100) && wiggle.inDip === false && wiggle.priorHigh == null);

  const weakBounce = legHigh(bars([...climb, 70, 80]), 0.25);
  ok("a bounce smaller than the shallow band stays on the old high", near(weakBounce.high, 100) && weakBounce.inDip === true);

  // 100, dip, bounce to 88 (new run), dip, bounce to 83. 83 never took out 100,
  // so the unreclaimed high stays 100 rather than the lower bounce.
  const nested = legHigh(bars([100, 70, 88, 66, 83]), 0.25);
  ok("a lower bounce does not erase the unreclaimed high", near(nested.high, 83) && near(nested.priorHigh, 100), JSON.stringify(nested));
}

console.log("\nZone");
{
  const z = (price) => zoneFor(price, 100, BAND);
  ok("10% off is not yet", z(90).state === "notyet");
  ok("25% off is the typical scale", z(75).state === "scale");
  ok("40% off is the deep scale", z(60).state === "deep");
  ok("exactly the worst resumed dip is still a deep scale", z(37).state === "deep");
  ok("past the worst resumed dip stops the buy", z(36).state === "past");
  ok("typical price is 24% under the high", near(z(90).typicalPx, 76));
  ok("above the high is not a dip", z(110).state === "notyet" && z(110).dd < 0);

  ok("bitcoin uses its own band", bandFor("bitcoin", { btc: BAND, eth: { typical: 1 }, alt: { typical: 2 } }) === BAND);
  ok("ethereum uses its own band", bandFor("ethereum", { eth: BAND }).typical === 0.24);
  ok("any other id uses the alt band", bandFor("solana", { alt: BAND }).typical === 0.24);

  ok("scale copy", statusText("scale") === "Scale in");
  ok("deep copy", statusText("deep") === "Deep scale");
  ok("past copy points at the book", statusDetail(z(36), BAND).includes("book"));
  ok("not-yet copy names the typical depth", statusDetail(z(90), BAND).includes("24%"));
}

console.log("\nLive mark");
{
  const hist = bars([10, 11, 12]);
  const next = withMark(hist, 13, hist[hist.length - 1].t + DAY + 3600000);
  ok("a later mark extends the series", next.length === 4 && near(next[3].c, 13));
  const same = withMark(hist, 15, hist[hist.length - 1].t + 3600000);
  ok("a higher mark on the last day raises the high", same.length === 3 && near(same[2].c, 15));
  const lower = withMark(hist, 9, hist[hist.length - 1].t + 3600000);
  ok("a lower mark on the last day does not erase the high", lower.length === 3 && near(lower[2].c, 12));
  ok("the input series is not mutated", near(hist[2].c, 12));
}

console.log("\nWick series");
{
  const closes = bars([5, 6, 7]);
  const ohlc = [
    [closes[1].t, 6, 9, 5, 6],
    [closes[2].t, 7, 8, 4, 5],
  ];
  const series = seriesFor(closes, ohlc);
  ok("older closes stay in front of the wick window", series.length === 3 && near(series[0].c, 5));
  ok("the overlapping window uses the wick, not the close", near(series[1].c, 9) && near(series[2].c, 8));
  ok("no wick data leaves the closes alone", seriesFor(closes, []).length === 3 && near(seriesFor(closes, [])[2].c, 7));
  const leg = legHigh(series, 0.2);
  ok("the run high is the wick", leg && near(leg.high, 9));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
