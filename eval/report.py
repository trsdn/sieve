#!/usr/bin/env python3
"""Summarises bench_results.jsonl: per variant and per task, medians over repetitions."""
import json, statistics as st, sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "eval/bench_results.jsonl")]
ok = [r for r in rows if "error" not in r]
print(f"{len(rows)} runs, {len(rows) - len(ok)} failed to run\n")


def tokens(r):  # everything the model read or wrote, cache or not
    return r["in"] + r["cache_write"] + r["cache_read"] + r["out"]


def table(key, title):
    g = defaultdict(list)
    for r in ok:
        g[key(r)].append(r)
    print(title)
    print(f"{'':24}{'runs':>5}{'correct':>9}{'turns':>7}{'cost $':>9}{'tokens':>10}{'uncached':>10}{'ctx end':>9}{'secs':>7}")
    for k, v in sorted(g.items()):
        print(f"{str(k):24}{len(v):>5}{sum(r['correct'] for r in v) / len(v):>9.0%}{st.median(r['turns'] for r in v):>7.0f}"
              f"{st.median(r['cost'] for r in v):>9.4f}{st.median(tokens(r) for r in v):>10.0f}{st.median(r['in'] + r['cache_write'] for r in v):>10.0f}{st.median(r.get('ctx_final', 0) for r in v):>9.0f}{st.median(r['secs'] for r in v):>7.0f}")
    print()


table(lambda r: r["variant"], "By variant (medians)")
for t in sorted({r["task"] for r in ok}):
    sub = [r for r in ok if r["task"] == t]
    g = defaultdict(list)
    for r in sub:
        g[r["variant"]].append(r)
    print(f"task {t}: " + "  ".join(f"{v} ${st.median(x['cost'] for x in vs):.3f}/{st.median(tokens(x) for x in vs):.0f}tok/{sum(x['correct'] for x in vs)}of{len(vs)}" for v, vs in sorted(g.items())))
