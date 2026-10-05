#!/usr/bin/env python3
"""Single quick questions on the real repository: where a lower effort should save output tokens without losing answers.
usage: simplebench.py TEMPLATE_DIR OUT.jsonl REPS"""
import json, os, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
MODEL = os.environ.get("BENCH_MODEL", "claude-opus-5-5")  # pinned: the runs in the README used this model
template, out, reps = os.path.abspath(sys.argv[1]), sys.argv[2], int(sys.argv[3])
SIEVE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
cwd = os.path.expanduser("~/dev/sieve-bench-runs/simple")
if not os.path.exists(cwd):
    shutil.copytree(template, cwd, symlinks=True)
g = lambda *a: subprocess.run(a, cwd=cwd, capture_output=True, text=True).stdout.strip()
TASKS = {
    "branch": ("What is the current git branch? Answer with the name only.", [g("git", "branch", "--show-current")]),
    "tests": ("How many entries are in the tests directory?", [str(len(os.listdir(os.path.join(cwd, "tests"))))]),
    "author": ("Who authored the most recent commit?", [g("git", "log", "-1", "--format=%an").split()[0]]),
    "python": ("Which Python versions does pyproject.toml require?", ["3."]),
}
VARIANTS = {"base": ([], {}), "sieve": (["--plugin-dir", SIEVE], {}), "sieve-no-effort": (["--plugin-dir", SIEVE], {"SIEVE_EFFORT": "0"})}
def one(job):
    v, t, r = job
    flags, env = VARIANTS[v]; prompt, exp = TASKS[t]
    p = subprocess.run(["claude", "-p", prompt, "--output-format", "json", "--setting-sources", "project", "--model", MODEL, *flags, "--allowedTools", "Bash,Read,Grep,Glob"],
                       cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL, env={**os.environ, **env}, timeout=300)
    try:
        d = json.loads(p.stdout)
    except Exception as e:
        return {"variant": v, "task": t, "rep": r, "error": str(e)[:100]}
    u = d.get("usage", {}); a = str(d.get("result", ""))
    return {"variant": v, "task": t, "rep": r, "correct": all(x.lower() in a.lower() for x in exp), "out": u.get("output_tokens", 0),
            "cost": d.get("total_cost_usd"), "turns": d.get("num_turns"), "answer": a[:100]}
jobs = [(v, t, r) for r in range(reps) for t in TASKS for v in VARIANTS]
with ThreadPoolExecutor(3) as pool, open(out, "a") as f:
    for res in pool.map(one, jobs):
        f.write(json.dumps(res) + "\n"); f.flush()
