#!/usr/bin/env python3
"""Per variant, medians over sessions: steps right, window-turns, uncached input, end context, cost (last step: cumulative)."""
import json, statistics as st, sys
from collections import defaultdict
rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "eval/repo_results.jsonl")]
ok = [r for r in rows if "error" not in r]
print(f"{len(rows)} steps, {len(rows) - len(ok)} failed to run\n")
sess = defaultdict(list)
for r in ok:
    sess[(r["variant"], r["rep"])].append(r)
print(f"{'':14}{'sessions':>9}{'right':>8}{'window-turns':>14}{'uncached':>10}{'ctx end':>9}{'cost $':>8}{'calls':>7}")
for v in sorted({k[0] for k in sess}):
    S = [x for k, x in sess.items() if k[0] == v]
    med = lambda f: st.median(f(x) for x in S)
    print(f"{v:14}{len(S):>9}{med(lambda x: sum(1 for r in x if r['correct'])):>6.0f}/5{med(lambda x: sum(r['window_turns'] for r in x)):>14.0f}"
          f"{med(lambda x: sum(r['uncached'] for r in x)):>10.0f}{med(lambda x: x[-1]['ctx']):>9.0f}{med(lambda x: max(r['cost'] or 0 for r in x)):>8.3f}{med(lambda x: sum(r['calls'] for r in x)):>7.0f}")
print()
for r in ok:
    if r.get("correct") is False:
        print("MISS", r["variant"], r["rep"], "step", r["step"], r["answer"][:100])
