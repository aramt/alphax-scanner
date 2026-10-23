#!/usr/bin/env python3
"""Measure resumed bull-market pullbacks and write pullbacks.json.

Bitcoin cycles are low-to-high on Bitstamp daily closes. A pullback counts
when, inside one of those windows, daily closes fall at least 15% from a
peak and later trade back through that peak before the cycle high. The
dump off the cycle high is stored separately and is not a buy level.

  python3 test/measure-pullbacks.py            # use cache/pullback-prices.json
  python3 test/measure-pullbacks.py --download # refresh prices, then measure
"""

import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "cache" / "pullback-prices.json"
OUT = ROOT / "pullbacks.json"
MIN_DEPTH = 0.15
LISTING_GAP_DAYS = 180
UA = {"User-Agent": "alphax-pullbacks"}

# id, symbol, kind, source. kind is btc / eth / alt / own.
# own coins are measured but do not vote in the alt basket.
BITSTAMP = [
    ("bitcoin", "BTC", "btc", "btcusd", 1420070400),
    ("ethereum", "ETH", "eth", "ethusd", 1502928000),
    ("ripple", "XRP", "alt", "xrpusd", 1491004800),
    ("litecoin", "LTC", "alt", "ltcusd", 1514764800),
]
OKX = [
    ("cardano", "ADA", "alt", "ADA-USDT"),
    ("chainlink", "LINK", "alt", "LINK-USDT"),
    ("dogecoin", "DOGE", "alt", "DOGE-USDT"),
    ("cosmos", "ATOM", "alt", "ATOM-USDT"),
    ("solana", "SOL", "alt", "SOL-USDT"),
    ("avalanche-2", "AVAX", "alt", "AVAX-USDT"),
    ("polkadot", "DOT", "alt", "DOT-USDT"),
    ("uniswap", "UNI", "alt", "UNI-USDT"),
    ("aave", "AAVE", "alt", "AAVE-USDT"),
    ("pendle", "PENDLE", "own", "PENDLE-USDT"),
    ("render-token", "RENDER", "own", "RENDER-USDT"),
]


def day(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d")


def parse_day(s):
    return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=40) as res:
        return json.load(res)


def dedupe(rows):
    by = {}
    for ts, close in rows:
        by[int(ts)] = float(close)
    return [{"t": ts, "c": by[ts]} for ts in sorted(by)]


def fetch_bitstamp(pair, start):
    rows = []
    cursor = start
    now = int(time.time())
    while cursor < now:
        url = f"https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=86400&limit=1000&start={cursor}"
        ohlc = get(url).get("data", {}).get("ohlc") or []
        if not ohlc:
            break
        for row in ohlc:
            rows.append((int(row["timestamp"]), float(row["close"])))
        last = int(ohlc[-1]["timestamp"])
        if last + 86400 <= cursor:
            break
        cursor = last + 86400
        time.sleep(0.15)
    return dedupe(rows)


def fetch_okx(inst):
    rows = []
    after = None
    prev_oldest = None
    while True:
        url = f"https://www.okx.com/api/v5/market/history-candles?instId={inst}&bar=1Dutc&limit=100"
        if after:
            url += "&after=" + after
        payload = get(url)
        if payload.get("code") not in ("0", 0, None):
            raise SystemExit(f"OKX {inst}: {payload.get('msg')}")
        data = payload.get("data") or []
        if not data:
            break
        for row in data:
            rows.append((int(row[0]) // 1000, float(row[4])))
        oldest = int(data[-1][0])
        if prev_oldest is not None and oldest >= prev_oldest:
            break
        prev_oldest = oldest
        after = str(oldest)
        time.sleep(0.11)
    return dedupe(rows)


def download():
    series = {}
    for gid, sym, kind, pair, start in BITSTAMP:
        print(f"bitstamp {sym}…", flush=True)
        bars = fetch_bitstamp(pair, start)
        series[gid] = {"symbol": sym, "kind": kind, "source": "bitstamp:" + pair, "bars": bars}
        print(f"  {len(bars)} days {day(bars[0]['t'])} → {day(bars[-1]['t'])}")
    for gid, sym, kind, inst in OKX:
        print(f"okx {sym}…", flush=True)
        bars = fetch_okx(inst)
        series[gid] = {"symbol": sym, "kind": kind, "source": "okx:" + inst, "bars": bars}
        print(f"  {len(bars)} days {day(bars[0]['t'])} → {day(bars[-1]['t'])}")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(series))
    print(f"cached {CACHE}")
    return series


def slice_bars(bars, start_ts, end_ts):
    return [b for b in bars if start_ts <= b["t"] <= end_ts]


def scan(bars, min_depth=MIN_DEPTH):
    """Peak-to-trough pullbacks that close back through the peak.

    Returns (episodes, terminal). Terminal is the still-open drawdown at the
    end of the window, or None. Depth is (peak - trough) / peak.
    """
    episodes = []
    if len(bars) < 2:
        return episodes, None
    peak_i = 0
    trough_i = 0
    in_dd = False
    for i, bar in enumerate(bars):
        c = bar["c"]
        if not in_dd:
            if c >= bars[peak_i]["c"]:
                peak_i = i
                trough_i = i
            elif c <= bars[peak_i]["c"] * (1 - min_depth):
                in_dd = True
                trough_i = i
            continue
        if c < bars[trough_i]["c"]:
            trough_i = i
        if c >= bars[peak_i]["c"]:
            episodes.append(episode(bars, peak_i, trough_i, i))
            in_dd = False
            peak_i = i
            trough_i = i
    terminal = episode(bars, peak_i, trough_i, None) if in_dd else None
    return episodes, terminal


def episode(bars, peak_i, trough_i, reclaim_i):
    peak = bars[peak_i]
    trough = bars[trough_i]
    depth = (peak["c"] - trough["c"]) / peak["c"]
    out = {
        "peakDate": day(peak["t"]),
        "troughDate": day(trough["t"]),
        "peak": round(peak["c"], 8),
        "trough": round(trough["c"], 8),
        "depth": round(depth, 4),
        "daysDown": int((trough["t"] - peak["t"]) / 86400),
    }
    if reclaim_i is None:
        out["reclaimDate"] = None
        out["daysBack"] = None
    else:
        out["reclaimDate"] = day(bars[reclaim_i]["t"])
        out["daysBack"] = int((bars[reclaim_i]["t"] - peak["t"]) / 86400)
    return out


def wpercentile(pairs, p):
    """Smallest value at which the cumulative weight reaches p of the total."""
    items = sorted((v, w) for v, w in pairs if w > 0)
    total = sum(w for _, w in items)
    if total <= 0:
        return None
    acc = 0.0
    target = p * total
    for v, w in items:
        acc += w
        if acc >= target - 1e-12:
            return v
    return items[-1][0]


def summarize(episodes, coin_counts):
    """coin_counts maps symbol → number of episodes, for equal coin weight."""
    if not episodes:
        return None
    weighted = []
    for ep in episodes:
        n = coin_counts[ep["symbol"]]
        weighted.append((ep["depth"], 1 / n))
    days = [(ep["daysDown"], 1 / coin_counts[ep["symbol"]]) for ep in episodes]
    back = [(ep["daysBack"], 1 / coin_counts[ep["symbol"]]) for ep in episodes if ep["daysBack"] is not None]
    depths = [ep["depth"] for ep in episodes]
    return {
        "n": len(episodes),
        "coins": len(coin_counts),
        "shallow": round(wpercentile(weighted, 0.25), 4),
        "typical": round(wpercentile(weighted, 0.50), 4),
        "deep": round(wpercentile(weighted, 0.75), 4),
        "worst": round(max(depths), 4),
        "medianDaysDown": int(round(wpercentile(days, 0.50))),
        "medianDaysBack": int(round(wpercentile(back, 0.50))) if back else None,
    }


def choose_set(early, late, full):
    """Early-bull figures win only when that half is clearly shallower
    and the choice actually moves the typical depth."""
    if (
        early and late and full
        and early["n"] >= 3 and late["n"] >= 3
        and early["typical"] <= late["typical"] - 0.05
        and early["typical"] <= full["typical"] - 0.02
    ):
        return "early", early, (
            f"Early-bull dips were shallower "
            f"({pct(early['typical'])} vs {pct(late['typical'])} late), so the scale uses the early half."
        )
    if (
        early and late and full
        and early["n"] >= 3 and late["n"] >= 3
        and early["typical"] <= late["typical"] - 0.05
    ):
        return "all", full, (
            f"The early half was shallower than the late half "
            f"({pct(early['typical'])} vs {pct(late['typical'])}), and the full set lands on that same typical depth. "
            "The scale uses every resumed dip."
        )
    return "all", full, (
        "The early half of each bull was not clearly shallower than the late half, "
        "so the scale uses every resumed dip."
    )


def pct(x):
    return f"{round(x * 100):.0f}%"


def find_cycles(btc_bars):
    """Bulls are Bitcoin low → later cycle high.

    A high is the cycle high once a later close falls 70% from it and a new
    high eventually exceeds it. The low in between is the next bull's start.
    The still-unfinished bull runs from the last bear low to the highest
    close since then. 70% is above the May 2021 decline and catches the
    2018 and 2022 bears. The exact dates are whatever Bitstamp printed.
    """
    # Confirm candidate tops: a close that later drops 70% and is later exceeded.
    n = len(btc_bars)
    closes = [b["c"] for b in btc_bars]
    cycles = []
    i = 0
    guard = 0
    while i < n and guard < 12:
        guard += 1
        peak = i
        confirmed = None
        for j in range(i + 1, n):
            if closes[j] >= closes[peak]:
                peak = j
            elif closes[j] <= closes[peak] * 0.30:
                confirmed = peak
                break
        if confirmed is None:
            peak = max(range(i, n), key=lambda k: closes[k])
            low = min(range(i, peak + 1), key=lambda k: closes[k])
            cycles.append(cycle_record(btc_bars, low, peak, complete=False))
            break
        # Trough is the cheapest close after the top until that top is taken out.
        trough = confirmed
        reclaimed = False
        for k in range(confirmed + 1, n):
            if closes[k] < closes[trough]:
                trough = k
            if closes[k] >= closes[confirmed]:
                reclaimed = True
                break
        low = min(range(i, confirmed + 1), key=lambda k: closes[k])
        cycles.append(cycle_record(btc_bars, low, confirmed, complete=True))
        if not reclaimed:
            break
        i = trough
    return cycles


def cycle_record(bars, low_i, high_i, complete):
    low, high = bars[low_i], bars[high_i]
    mid = low["t"] + (high["t"] - low["t"]) / 2
    return {
        "low": day(low["t"]),
        "high": day(high["t"]),
        "lowPrice": round(low["c"], 2),
        "highPrice": round(high["c"], 2),
        "mid": day(mid),
        "complete": complete,
    }


def self_test():
    def bars_from(pairs):
        t0 = parse_day("2020-01-01")
        return [{"t": t0 + i * 86400, "c": c} for i, c in enumerate(pairs)]

    # 30% dip that comes back, then a 50% dip that comes back.
    climb = [100 + i * 10 for i in range(11)]  # to 200
    dip1 = [200, 180, 160, 140, 150, 180, 200]
    up = [210, 220, 240]
    dip2 = [240, 200, 160, 120, 140, 200, 240]
    eps, term = scan(bars_from(climb + dip1 + up + dip2))
    assert term is None, term
    assert len(eps) == 2, eps
    assert abs(eps[0]["depth"] - 0.30) < 0.011, eps[0]
    assert abs(eps[1]["depth"] - 0.50) < 0.011, eps[1]

    # A 10% wiggle is not a dip. A 40% dip that never comes back is terminal.
    noise = [100, 110, 130, 120, 125, 140]
    dead = [140, 120, 100, 84]
    eps, term = scan(bars_from(noise + dead))
    assert eps == [], eps
    assert term and abs(term["depth"] - 0.40) < 0.011, term

    # Bounce inside a dip does not split it.
    one = [100, 150, 120, 130, 90, 100, 150]
    eps, term = scan(bars_from(one))
    assert len(eps) == 1 and abs(eps[0]["depth"] - 0.40) < 0.011, eps
    assert term is None

    # Equal coin weight: one choppy coin cannot outvote a quieter one.
    episodes = [
        {"symbol": "A", "depth": 0.20, "daysDown": 5, "daysBack": 10},
        {"symbol": "A", "depth": 0.80, "daysDown": 50, "daysBack": 100},
        {"symbol": "B", "depth": 0.30, "daysDown": 12, "daysBack": 20},
    ]
    stats = summarize(episodes, {"A": 2, "B": 1})
    # A contributes 0.20 and 0.80 at weight 0.5 each. B contributes 0.30 at weight 1.
    # Sorted: 0.20 (0.5), 0.30 (1.0), 0.80 (0.5). Median target 1.0 lands on 0.30.
    assert abs(stats["typical"] - 0.30) < 1e-9, stats
    assert abs(stats["worst"] - 0.80) < 1e-9
    print("self-test ok")


def main():
    self_test()
    if "--download" in sys.argv or not CACHE.exists():
        series = download()
    else:
        series = json.loads(CACHE.read_text())

    btc = series["bitcoin"]["bars"]
    cycles = find_cycles(btc)
    if cycles and not cycles[-1]["complete"]:
        high_ts = parse_day(cycles[-1]["high"])
        after = [b for b in btc if b["t"] > high_ts]
        if after:
            trough = min(after, key=lambda b: b["c"])
            hp = cycles[-1]["highPrice"]
            cycles[-1]["sinceHigh"] = {
                "trough": day(trough["t"]),
                "troughPrice": round(trough["c"], 2),
                "maxDrawdown": round((hp - trough["c"]) / hp, 4),
                "stillOff": round((hp - btc[-1]["c"]) / hp, 4),
            }
    print("\nCycles (Bitcoin daily closes)")
    for c in cycles:
        flag = "complete" if c["complete"] else "still open"
        print(f"  {c['low']} ${c['lowPrice']:,.0f}  →  {c['high']} ${c['highPrice']:,.0f}  mid {c['mid']}  {flag}")

    # Big Bitcoin drawdowns, so a bad cycle split is obvious.
    print("\nBitcoin drawdowns of 30% or more")
    eps, term = scan(btc, 0.30)
    for ep in eps:
        print(f"  {ep['peakDate']} → {ep['troughDate']}  {pct(ep['depth'])}  back {ep['reclaimDate']}  ({ep['daysDown']}d down)")
    if term:
        print(f"  OPEN {term['peakDate']} → {term['troughDate']}  {pct(term['depth'])}")

    episodes = []
    terminal = []
    for gid, meta in series.items():
        bars = meta["bars"]
        if not bars:
            continue
        listed = bars[0]["t"]
        for cyc in cycles:
            window = slice_bars(bars, parse_day(cyc["low"]), parse_day(cyc["high"]))
            found, dead = scan(window)
            for ep in found:
                peak_ts = parse_day(ep["peakDate"])
                if peak_ts < listed + LISTING_GAP_DAYS * 86400:
                    continue
                ep = dict(ep)
                ep.update({
                    "id": gid,
                    "symbol": meta["symbol"],
                    "kind": meta["kind"],
                    "cycleLow": cyc["low"],
                    "cycleHigh": cyc["high"],
                    "early": ep["peakDate"] < cyc["mid"],
                    "cycleComplete": cyc["complete"],
                })
                episodes.append(ep)
            if dead and parse_day(dead["peakDate"]) >= listed + LISTING_GAP_DAYS * 86400:
                dead = dict(dead)
                dead.update({"id": gid, "symbol": meta["symbol"], "kind": meta["kind"], "cycleLow": cyc["low"]})
                terminal.append(dead)

    def bucket(kind, early=None, complete_only=False):
        rows = [e for e in episodes if e["kind"] == kind]
        if early is not None:
            rows = [e for e in rows if e["cycleComplete"] and e["early"] is early]
        if complete_only:
            rows = [e for e in rows if e["cycleComplete"]]
        counts = {}
        for e in rows:
            counts[e["symbol"]] = counts.get(e["symbol"], 0) + 1
        # A single dip is not a vote.
        rows = [e for e in rows if counts[e["symbol"]] >= 2]
        counts = {s: n for s, n in counts.items() if n >= 2}
        return rows, summarize(rows, counts) if rows else None

    def worst_of(rows):
        if not rows:
            return None
        ep = max(rows, key=lambda e: e["depth"])
        return {
            "symbol": ep["symbol"],
            "peakDate": ep["peakDate"],
            "troughDate": ep["troughDate"],
            "depth": ep["depth"],
        }

    groups = {}
    for kind in ("btc", "eth", "alt"):
        early_rows, early = bucket(kind, early=True)
        late_rows, late = bucket(kind, early=False)
        full_rows, full = bucket(kind, early=None)
        which, chosen, reason = choose_set(early, late, full)
        chosen_rows = early_rows if which == "early" else full_rows
        groups[kind] = {
            "set": which,
            "reason": reason,
            "shallow": chosen["shallow"],
            "typical": chosen["typical"],
            "deep": chosen["deep"],
            "worst": chosen["worst"],
            "worstEpisode": worst_of(chosen_rows),
            "medianDaysDown": chosen["medianDaysDown"],
            "medianDaysBack": chosen["medianDaysBack"],
            "n": chosen["n"],
            "coins": chosen["coins"],
            "early": early,
            "late": late,
            "all": full,
        }

    own = {}
    for gid, meta in series.items():
        if meta["kind"] != "own":
            continue
        rows = [e for e in episodes if e["id"] == gid]
        counts = {meta["symbol"]: len(rows)} if len(rows) >= 2 else {}
        stats = summarize(rows, counts) if counts else None
        own[gid] = stats

    print("\nPer coin")
    by_coin = {}
    for e in episodes:
        by_coin.setdefault(e["symbol"], []).append(e)
    for sym in sorted(by_coin):
        rows = by_coin[sym]
        med = wpercentile([(r["depth"], 1) for r in rows], 0.5)
        print(f"  {sym:6} n={len(rows):2}  median {pct(med)}")
        for r in rows:
            half = "early" if r["early"] else "late "
            print(f"         {r['cycleLow']}  {half}  {r['peakDate']} → {r['troughDate']}  {pct(r['depth']):>4}  {r['daysDown']:3}d  back {r['daysBack']}d")

    print("\nGroups")
    for kind, g in groups.items():
        print(f"  {kind:4} USE {g['set']:5}  shallow {pct(g['shallow'])}  typical {pct(g['typical'])}  deep {pct(g['deep'])}  worst {pct(g['worst'])}  n={g['n']} coins={g['coins']}")
        print(f"       {g['reason']}")
        for label in ("early", "late", "all"):
            s = g[label]
            if not s:
                print(f"       {label:5} none")
            else:
                print(f"       {label:5} n={s['n']:3} coins={s['coins']}  {pct(s['shallow'])} / {pct(s['typical'])} / {pct(s['deep'])}  worst {pct(s['worst'])}  down {s['medianDaysDown']}d  back {s['medianDaysBack']}d")

    basket = sorted({e["symbol"] for e in episodes if e["kind"] == "alt"})
    coin_stats = []
    for sym in sorted(by_coin):
        rows = by_coin[sym]
        med = wpercentile([(r["depth"], 1) for r in rows], 0.5)
        coin_stats.append({
            "id": rows[0]["id"],
            "symbol": sym,
            "kind": rows[0]["kind"],
            "n": len(rows),
            "median": round(med, 4),
        })
    cut = parse_day("2023-01-01")
    closes = {
        gid: [[day(b["t"]), round(b["c"], 8)] for b in meta["bars"] if b["t"] >= cut]
        for gid, meta in series.items() if meta["bars"]
    }
    payload = {
        "asOf": day(btc[-1]["t"]),
        "minDepth": MIN_DEPTH,
        "listingGapDays": LISTING_GAP_DAYS,
        "method": (
            "Daily closes. A bull is a Bitcoin cycle from its low to its high. "
            "A pullback is a drop of at least 15% that later closed back through its peak "
            "before that cycle high. The first 180 days after a coin's first bar are ignored. "
            "Each coin gets an equal vote. Shallow, typical, and deep are the 25th, 50th, and 75th "
            "percentiles of that vote. Worst is the deepest dip that still came back."
        ),
        "cycles": cycles,
        "basket": basket,
        "coinStats": coin_stats,
        "stats": {k: {kk: vv for kk, vv in g.items() if kk not in ("early", "late", "all")} | {
            "compare": {"early": g["early"], "late": g["late"], "all": g["all"]}
        } for k, g in groups.items()},
        "own": own,
        "episodes": episodes,
        "terminal": terminal,
        "closes": closes,
        "sources": {gid: {"symbol": m["symbol"], "kind": m["kind"], "source": m["source"],
                          "from": day(m["bars"][0]["t"]), "to": day(m["bars"][-1]["t"]), "days": len(m["bars"])}
                    for gid, m in series.items() if m["bars"]},
    }
    # The dict-union above assumes py3.9+. macOS python3 is fine on 3.9+.
    OUT.write_text(json.dumps(payload, indent=2))
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
