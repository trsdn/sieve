#!/usr/bin/env python3
"""A developer session on a real repository (more-itertools with one injected bug), five steps in one session.

Each run works on its own copy of the template. Step 2 (fix the bug) is judged by running the test suite after the session.
Measured per step: correct, window-turns (context size summed over every model call: what the window costs over time),
uncached input, cost. usage: repobench.py TEMPLATE_DIR OUT.jsonl REPS
"""
import json, os, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

template, out, reps = os.path.abspath(sys.argv[1]), sys.argv[2], int(sys.argv[3])
# not under a hidden folder: Claude Code treats files there as sensitive and asks before editing
runs_root = os.environ.get("BENCH_RUNS", os.path.expanduser("~/dev/sieve-bench-runs"))
SIEVE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CM = os.environ.get("CM_DIR", "/tmp/claude-501/cm-repaired")
STEPS = [
    ("Run the test suite verbosely with `python3 -m unittest discover -s tests -v` and tell me how many tests were skipped and how many failed.", ["5", "26"]),
    ("Find the cause of the failing tests and fix it so that all tests pass. Do not change the tests.", None),  # judged by running the suite
    ("Which file was changed in the most commits among the last 200 commits?", ["more.py"]),
    ("How many public top-level functions (a def at column 0 whose name does not start with an underscore) does more_itertools/more.py define?", ["107"]),
    ("Without running anything: which function had the bug, and what exactly was wrong with it?", ["ilen"]),
]
# BENCH_SCENARIO=hard: a session that starts with a trivial question and then needs real debugging
# (a padding off-by-one in windowed(), committed, so git diff does not point at it).
if os.environ.get("BENCH_SCENARIO") == "hard":
    STEPS = [
        ("What is the current git branch? Answer with the name only.", ["master"]),
        ("Some tests are failing. Find the cause and fix it without changing the tests.", None),
        ("In two sentences: what exactly was wrong?", ["padding|fill"]),
    ]
STEPS = STEPS[: int(os.environ.get('BENCH_STEPS', len(STEPS)))]
TOOLS = "Bash,Read,Edit,Grep,Glob"
VARIANTS = {
    "base": ([], TOOLS, {}),
    "context-mode": (["--plugin-dir", CM], TOOLS + ",mcp__plugin_context-mode_context-mode", {}),
    "sieve-rules": (["--plugin-dir", SIEVE], TOOLS + ",mcp__sieve__search", {"SIEVE_DECIDER": "0"}),
    "sieve": (["--plugin-dir", SIEVE], TOOLS + ",mcp__sieve__search", {}),
    "sieve-no-effort": (["--plugin-dir", SIEVE], TOOLS + ",mcp__sieve__search", {"SIEVE_EFFORT": "0"}),
}


def call(variant, prompt, sid, cwd):
    flags, tools, env = VARIANTS[variant]
    cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--setting-sources", "project", *flags, "--allowedTools", tools]
    if sid:
        cmd += ["--resume", sid]
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=900, stdin=subprocess.DEVNULL, env={**os.environ, **env})
    ev = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
    res = next(e for e in ev if e.get("type") == "result")
    usages = [e["message"]["usage"] for e in ev if e.get("type") == "assistant"]
    # one assistant message per content block can repeat the same usage: count each distinct message once
    seen, calls = set(), []
    for e in ev:
        if e.get("type") == "assistant" and e["message"].get("id") not in seen:
            seen.add(e["message"].get("id")); calls.append(e["message"]["usage"])
    win = lambda u: u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
    tools_used = [c["name"] for e in ev if e.get("type") == "assistant" for c in e["message"]["content"] if c["type"] == "tool_use"]
    return res, {"window_turns": sum(win(u) for u in calls), "ctx": win(usages[-1]) if usages else 0,
                 "uncached": sum(u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) for u in calls), "calls": len(calls), "tools": tools_used}


def session(job):
    variant, rep = job
    cwd = os.path.join(runs_root, f"{variant}-{rep}")
    shutil.rmtree(cwd, ignore_errors=True)
    shutil.copytree(template, cwd, symlinks=True)
    sid, rows = None, []
    for n, (prompt, expected) in enumerate(STEPS, 1):
        t0 = time.time()
        try:
            res, m = call(variant, prompt, sid, cwd)
        except Exception as e:
            rows.append({"variant": variant, "rep": rep, "step": n, "error": str(e)[:200]}); break
        sid = res.get("session_id", sid)
        ans = str(res.get("result", "")).lower()
        ok = None if expected is None else all(any(a.lower() in ans for a in x.split("|")) for x in expected)
        rows.append({"variant": variant, "rep": rep, "step": n, "correct": ok, "cost": res.get("total_cost_usd"), "turns": res.get("num_turns"),
                     "secs": round(time.time() - t0, 1), "answer": ans[:140], **m})
    suite = subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests"], cwd=cwd, capture_output=True, text=True, timeout=300)
    tests_changed = subprocess.run(["git", "diff", "--quiet", "--", "tests"], cwd=cwd).returncode != 0
    for r in rows:
        if r.get("step") == 2:  # the fix step in both scenarios
            r["correct"] = suite.returncode == 0 and not tests_changed
    return rows


keep = set(os.environ.get("BENCH_VARIANTS", "").split(",")) - {""}
jobs = [(v, r) for r in range(reps) for v in VARIANTS if not keep or v in keep]
with ThreadPoolExecutor(int(os.environ.get("BENCH_PARALLEL", "3"))) as pool, open(out, "a") as f:
    for rows in pool.map(session, jobs):
        for r in rows:
            f.write(json.dumps(r) + "\n")
        f.flush()
        print(rows[0]["variant"], "rep", rows[0]["rep"], "right", sum(1 for r in rows if r.get("correct")), "of", len(rows), flush=True)
