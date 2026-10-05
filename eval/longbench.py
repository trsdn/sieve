#!/usr/bin/env python3
"""One long session per setup: nine tasks with large output, one after another (`--resume`), then a recall question.

What accumulates is the point: the window size after each step, and what the session cost in all.
usage: longbench.py FIXTURE OUT.jsonl REPS
"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
MODEL = os.environ.get("BENCH_MODEL", "claude-opus-5-5")  # pinned: the runs in the README used this model

fixture, out, reps = os.path.abspath(sys.argv[1]), sys.argv[2], int(sys.argv[3])
home = os.path.expanduser("~")
SIEVE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CM = os.environ.get("CM_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".scratch", "context-mode"))
T = " Answer in one short sentence."
recs = json.load(open(os.path.join(fixture, "data/records.json")))
first_err = next(i for i, l in enumerate(open(os.path.join(fixture, "logs/app.log")), 1) if "ERROR" in l)

STEPS = [
    ("Run exactly `cat logs/app.log` as written, no pipes, and tell me how many lines contain ERROR." + T, ["54"]),
    ("Run exactly `find deps` as written, no pipes, and tell me how many directories are named sub_5." + T, ["120"]),
    ("Run exactly `sh run_tests.sh` as written, no pipes, and tell me which test fails and why." + T, ["test_refund_rounding", "10.04"]),
    ("Run exactly `git log` as written, no pipes, and tell me who authored the most commits." + T, ["Mira Okafor"]),
    ("Run exactly `cat data/records.json` as written, no pipes, and tell me the price of the record with id 1100." + T, [str(recs[100]["price"])]),
    ("Run exactly `cat src/mod_*.py` as written, no pipes, and tell me which function has the most lines." + T, ["rebuild_index"]),
    ("Run exactly `cat logs/app.log` again as written, no pipes, and tell me the line number of the first ERROR line." + T, [str(first_err)]),
    ("Run exactly `ls -laR deps` as written, no pipes, and tell me how many entries are named file_0.py." + T, ["file_0"]),  # any count: checks only that it answered
    ("Without running anything: which test failed earlier, and what were the expected and actual values?" + T, ["test_refund_rounding", "10.05", "10.04"]),
]
# LONG_FREE=1: the same nine questions, but the model picks its own commands.
if os.environ.get("LONG_FREE"):
    STEPS = [
        ("In logs/app.log, how many lines contain ERROR?" + T, ["54"]),
        ("How many directories under deps/ are named sub_5?" + T, ["120"]),
        ("Run the tests with `sh run_tests.sh` and tell me which test fails and why." + T, ["test_refund_rounding", "10.04"]),
        ("Look at the git history: who authored the most commits?" + T, ["Mira Okafor"]),
        ("In data/records.json, what is the price of the record with id 1100?" + T, [str(recs[100]["price"])]),
        ("Which function in src/ has the most lines?" + T, ["rebuild_index"]),
        ("What is the line number of the first ERROR line in logs/app.log?" + T, [str(first_err)]),
        ("How many files named file_0.py are there under deps/?" + T, ["file_0"]),
        ("Without running anything: which test failed earlier, and what were the expected and actual values?" + T, ["test_refund_rounding", "10.05", "10.04"]),
    ]
TOOLS = "Bash,Read,Grep,Glob"
VARIANTS = {
    "base": ([], TOOLS, {}),
    "context-mode": (["--plugin-dir", CM], TOOLS + ",mcp__plugin_context-mode_context-mode", {}),
    "sieve": (["--plugin-dir", SIEVE], TOOLS + ",mcp__sieve__search", {}),
    "sieve-rules": (["--plugin-dir", SIEVE], TOOLS + ",mcp__sieve__search", {"SIEVE_DECIDER": "0"}),
}


def call(variant, prompt, sid):
    flags, tools, env = VARIANTS[variant]
    cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--setting-sources", "project", "--model", MODEL, *flags, "--allowedTools", tools]
    if sid:
        cmd += ["--resume", sid]
    p = subprocess.run(cmd, cwd=fixture, capture_output=True, text=True, timeout=420, stdin=subprocess.DEVNULL, env={**os.environ, **env})
    ev = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    res = next(e for e in ev if e.get("type") == "result")
    res["_tools"] = [c["name"] for e in ev if e.get("type") == "assistant" for c in e["message"]["content"] if c["type"] == "tool_use"]
    last = [e for e in ev if e.get("type") == "assistant"][-1]["message"]["usage"]
    return res, last


def session(job):
    variant, rep = job
    sid, rows = None, []
    for n, (prompt, expected) in enumerate(STEPS, 1):
        t0 = time.time()
        try:
            res, last = call(variant, prompt, sid)
        except Exception as e:
            rows.append({"variant": variant, "rep": rep, "step": n, "error": str(e)[:200]})
            break
        sid = res.get("session_id", sid)
        ans = str(res.get("result", "")).lower()
        rows.append({
            "variant": variant, "rep": rep, "step": n,
            "correct": all(x.lower() in ans for x in expected), "turns": res.get("num_turns"), "cost": res.get("total_cost_usd"),
            "ctx": last.get("input_tokens", 0) + last.get("cache_read_input_tokens", 0) + last.get("cache_creation_input_tokens", 0),
            "secs": round(time.time() - t0, 1), "answer": ans[:120], "tools": res["_tools"],
        })
    return rows


keep = set(os.environ.get('BENCH_VARIANTS', '').split(',')) - {''}
jobs = [(v, r) for r in range(reps) for v in VARIANTS if not keep or v in keep]
with ThreadPoolExecutor(3) as pool, open(out, "a") as f:
    for rows in pool.map(session, jobs):
        for r in rows:
            f.write(json.dumps(r) + "\n")
        f.flush()
        print(rows[0]["variant"], "rep", rows[0]["rep"], "steps", len(rows), "ok", sum(r.get("correct", 0) for r in rows), flush=True)
