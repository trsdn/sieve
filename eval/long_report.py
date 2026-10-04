#!/usr/bin/env python3
"""Per variant: window size after each step (median over repetitions), steps right, session cost."""
import json, statistics as st, sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "eval/long_results.jsonl")]
ok = [r for r in rows if "error" not in r]
print(f"{len(rows) - len(ok)} failed steps\n")
steps = sorted({r["step"] for r in ok})
print("window size after step (tokens, median)")
print(f"{'':14}" + "".join(f"{s:>8}" for s in steps) + f"{'right':>8}{'cost $':>9}")
for v in sorted({r["variant"] for r in ok}):
    vr = [r for r in ok if r["variant"] == v]
    cells = [st.median(r["ctx"] for r in vr if r["step"] == s) for s in steps]
    sessions = defaultdict(list)
    for r in vr:
        sessions[r["rep"]].append(r)
    cost = st.median(max(r["cost"] or 0 for r in x) for x in sessions.values())  # total_cost_usd is cumulative within a resumed session
    right = sum(r["correct"] for r in vr) / len(sessions)
    print(f"{v:14}" + "".join(f"{c:>8.0f}" for c in cells) + f"{right:>7.1f}/{len(steps)}{cost:>9.3f}")
for r in ok:
    if not r["correct"]:
        print("MISS", r["variant"], "rep", r["rep"], "step", r["step"], r["answer"][:90])
