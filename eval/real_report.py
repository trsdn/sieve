#!/usr/bin/env python3
"""Real use: sieve's log joined with Claude Code's own transcripts, active sessions against the holdout.

Turn the control group on with SIEVE_HOLDOUT=0.2 (one session in five changes nothing and only logs).
Bench runs (cwd under sieve-bench-runs or .scratch, or SIEVE_BENCH=1) are left out.
usage: real_report.py [--days N] [--sessions]
"""
import glob, json, os, statistics as st, sys, time
from collections import defaultdict

days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 30
since = (time.time() - days * 86400) * 1000
home = os.path.expanduser("~")

S = defaultdict(lambda: {"holdout": False, "cuts": 0, "would_cut": 0, "kept_chars": 0, "followups": 0, "searches": 0,
                         "restored": 0, "prompts": [], "effort_low": False, "reminders": 0, "new_task": 0})
for line in open(f"{home}/.claude/sieve/usage.jsonl"):
    r = json.loads(line)
    if "s" not in r or r.get("bench") or r.get("t", 0) < since:
        continue
    s = S[r["s"]]
    s["holdout"] |= bool(r.get("holdout"))
    if r.get("cut"):
        s["would_cut" if r.get("holdout") else "cuts"] += 1
        s["kept_chars"] += r.get("size", 0)
    ev = r.get("event")
    if ev == "followup": s["followups"] += 1
    elif ev == "search": s["searches"] += 1
    elif ev == "prompt": s["prompts"].append(r.get("simple"))
    elif ev == "effort-low": s["effort_low"] = True
    elif ev == "reminder": s["reminders"] += 1
    elif ev == "new-task": s["new_task"] += 1
    if r.get("restored"): s["restored"] += 1


def transcript(sid):
    """Window-turns (context summed over every main-chain model call), output tokens, calls, from the transcript."""
    files = glob.glob(f"{home}/.claude/projects/*/{sid}.jsonl")
    if not files:
        return None
    seen, win, out = set(), 0, 0
    for line in open(files[0]):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        m = d.get("message") or {}
        if d.get("type") != "assistant" or d.get("isSidechain") or m.get("id") in seen or not m.get("usage"):
            continue
        seen.add(m.get("id"))
        u = m["usage"]
        win += u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
        out += u.get("output_tokens", 0)
    return {"window_turns": win, "output": out, "calls": len(seen)}


rows = []
for sid, s in S.items():
    t = transcript(sid)
    if t and t["calls"]:
        rows.append({"sid": sid, **s, **t})

med = lambda xs: round(st.median(xs)) if xs else "-"
print(f"{len(rows)} sessions in the last {days} days (bench runs left out)\n")
print(f"{'':10} {'sessions':>8} {'window-turns':>13} {'per call':>9} {'output':>7} {'calls':>6} {'cuts':>5}")
for name, grp in (("active", [r for r in rows if not r["holdout"]]), ("holdout", [r for r in rows if r["holdout"]])):
    cuts = "would_cut" if name == "holdout" else "cuts"
    print(f"{name:10} {len(grp):>8} {med([r['window_turns'] for r in grp]):>13} {med([r['window_turns'] // r['calls'] for r in grp]):>9} "
          f"{med([r['output'] for r in grp]):>7} {med([r['calls'] for r in grp]):>6} {sum(r[cuts] for r in grp):>5}")

act = [r for r in rows if not r["holdout"]]
cuts = sum(r["cuts"] for r in act)
print(f"\nactive sessions: {cuts} cuts, {sum(r['followups'] for r in act)} follow-ups to a cut output, "
      f"{sum(r['searches'] for r in act)} searches, {sum(r['restored'] for r in act)} repeats restored")
print(f"sessions with any cut: {sum(1 for r in act if r['cuts'])} of {len(act)}")
# Effort's known risk: a session set to low effort at its first request whose later requests were not simple.
hard = [r for r in rows if r["effort_low"] and any(p is not None and p < 0.3 for p in r["prompts"][1:])]
print(f"low-effort sessions that later turned hard (a later request with p(simple) < 0.3): {len(hard)} of {sum(1 for r in rows if r['effort_low'])}")
if "--sessions" in sys.argv:
    for r in sorted(rows, key=lambda r: -r["window_turns"]):
        print(f"  {r['sid'][:8]} {'H' if r['holdout'] else ' '} win {r['window_turns']:>9} calls {r['calls']:>4} cuts {r['cuts'] + r['would_cut']:>3} "
              f"follow {r['followups']} low {'y' if r['effort_low'] else 'n'} prompts {len(r['prompts'])}")
