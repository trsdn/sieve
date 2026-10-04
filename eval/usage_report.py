#!/usr/bin/env python3
"""Where do the bytes in real sessions come from? Reads ~/.claude/sieve/usage.jsonl (sizes only, no content)."""
import json, os, statistics as st, sys
from collections import defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.claude/sieve/usage.jsonl")
rows = [json.loads(l) for l in open(path) if l.strip()]
by = defaultdict(list)
for r in rows:
    if "size" in r:
        by[r["tool"]].append(r)
total = sum(r["size"] for v in by.values() for r in v) or 1
print(f"{len(rows)} records\n{'tool':12}{'calls':>7}{'median':>9}{'p90':>9}{'share':>8}{'cut':>6}{'asked':>7}")
for tool, v in sorted(by.items(), key=lambda kv: -sum(r["size"] for r in kv[1])):
    sizes = sorted(r["size"] for r in v)
    cut = sum(1 for r in v if r.get("cut"))
    asked = sum(1 for r in v if r.get("verdict") == "ask")
    print(f"{tool:12}{len(v):>7}{st.median(sizes):>9.0f}{sizes[int(len(sizes) * .9) - 1]:>9}{sum(sizes) / total:>8.0%}{cut:>6}{asked:>7}")
print(f"\nsieve.execute calls: {sum(1 for r in rows if r.get('tool') == 'sieve.execute')}")
