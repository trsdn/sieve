#!/usr/bin/env python3
import json, statistics as st, sys
from collections import defaultdict
rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "eval/web_results.jsonl")]
ok = [r for r in rows if "error" not in r]
print(f"{len(rows)} runs, {len(rows) - len(ok)} failed\n")
print(f"{'':20}{'runs':>5}{'correct':>9}{'turns':>7}{'cost $':>9}{'tokens':>9}{'ctx end':>9}{'ctx_* calls':>12}")
for v in sorted({r["variant"] for r in ok}):
    x = [r for r in ok if r["variant"] == v]
    print(f"{v:20}{len(x):>5}{sum(r['correct'] for r in x) / len(x):>9.0%}{st.median(r['turns'] for r in x):>7.0f}{st.median(r['cost'] for r in x):>9.3f}"
          f"{st.median(r['tokens'] for r in x):>9.0f}{st.median(r['ctx_final'] for r in x):>9.0f}{sum(r['ctx_tools'] for r in x):>12}")
print()
for t in sorted({r["task"] for r in ok}):
    g = defaultdict(list)
    for r in ok:
        if r["task"] == t:
            g[r["variant"]].append(r)
    print(t + ": " + "  ".join(f"{v} {sum(r['correct'] for r in x)}/{len(x)} right, {st.median(r['tokens'] for r in x):.0f}tok" for v, x in sorted(g.items())))
