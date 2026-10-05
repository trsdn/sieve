#!/usr/bin/env python3
"""Same tasks, four setups: bare Claude Code, context-mode, sieve with the decider, sieve rules only.

usage: bench.py FIXTURE OUT.jsonl REPS [task-ids...]
Each run is `claude -p --output-format json` in the fixture; tokens and cost come from its usage block.
"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
MODEL = os.environ.get("BENCH_MODEL", "claude-opus-5-5")  # pinned: the runs in the README used this model

fixture, out, reps = os.path.abspath(sys.argv[1]), sys.argv[2], int(sys.argv[3])
only = set(sys.argv[4:])
home = os.path.expanduser("~")
CM = os.environ.get("CM_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".scratch", "context-mode"))  # a copy of the installed plugin with its dependencies installed
SIEVE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TAIL = " Answer in one short sentence."

TASKS = {
    "log": ("In logs/app.log, which error message occurs most often and how many times?", ["db timeout", "37"]),
    "json": ("In data/records.json find the id of the record whose name is 'zeta-4421'.", ["4734"]),
    "src": ("Which function in src/ has the most lines, and in which file is it?", ["rebuild_index", "mod_37"]),
    "deps": ("How many .py files are under deps/?", ["878"]),
    "tests": ("Run `sh run_tests.sh` and tell me which test fails and why.", ["test_refund_rounding", "10.04"]),
    "git": ("Who authored the most commits in this repo (use git log) and how many?", ["Mira Okafor", "61"]),
}
# Tasks that name the command, so the big output cannot be avoided by choosing a smaller one.
_recs = json.load(open(os.path.join(fixture, "data/records.json")))
TASKS.update({
    "run-log": ("Run `cat logs/app.log` and tell me how many lines contain the word ERROR.", ["54"]),
    "run-find": ("Run `find deps` and tell me how many directories are named sub_5.", ["120"]),
    "run-json": ("Run `cat data/records.json` and tell me the price of the record with id 1100.", [str(_recs[100]["price"])]),
})
# Mid band (4-10k chars): where only the decider can cut. A listing should be cut, code must not be.
def _txt(pkgs):
    return str(sum(f.endswith(".txt") for p in pkgs for d, _, fs in os.walk(os.path.join(fixture, "deps", p)) for f in fs))
def _longest(glob_prefix):
    best = (0, "")
    for f in sorted(os.listdir(os.path.join(fixture, "src"))):
        if f.startswith(glob_prefix) and f.endswith(".py"):
            fn, n = None, 0
            for line in open(os.path.join(fixture, "src", f)).read().split("\n") + ["def end():"]:
                if line.startswith("def "):
                    if fn and n > best[0]: best = (n, fn)
                    fn, n = line[4:line.index("(")], 0
                else:
                    n += 1
    return best[1]
TASKS.update({
    "mid-find": ("Run `find deps/pkg_7 deps/pkg_8 deps/pkg_9 deps/pkg_11 deps/pkg_12 deps/pkg_13 deps/pkg_14 -type f` and tell me how many files end in .txt.", [_txt(["pkg_7", "pkg_8", "pkg_9", "pkg_11", "pkg_12", "pkg_13", "pkg_14"])]),
    "mid-find-raw": ("Run exactly `find deps/pkg_7 deps/pkg_8 deps/pkg_9 deps/pkg_11 deps/pkg_12 deps/pkg_13 deps/pkg_14 -type f` with no pipes or filters, then count the files ending in .txt from its output.", [_txt(["pkg_7", "pkg_8", "pkg_9", "pkg_11", "pkg_12", "pkg_13", "pkg_14"])]),
    "mid-find-skim": ("Run exactly `find deps/pkg_7 deps/pkg_8 deps/pkg_9 deps/pkg_11 deps/pkg_12 deps/pkg_13 deps/pkg_14 -type f` with no pipes or filters, then give me a rough idea of what the output shows.", ["pkg|package"]),
    "mid-code": ("Run `cat src/mod_3?.py` and tell me which function defined in those files has the most lines.", [_longest("mod_3")]),
})
BASE_TOOLS = "Bash,Read,Grep,Glob"
VARIANTS = {
    "base": ([], BASE_TOOLS, {}),
    "context-mode": (["--plugin-dir", CM], BASE_TOOLS + ",mcp__plugin_context-mode_context-mode", {}),
    "sieve": (["--plugin-dir", SIEVE], BASE_TOOLS + ",mcp__sieve__execute,mcp__sieve__search", {}),
    "sieve-rules": (["--plugin-dir", SIEVE], BASE_TOOLS + ",mcp__sieve__execute,mcp__sieve__search", {"SIEVE_DECIDER": "0"}),
}


def one(job):
    variant, task, rep = job
    flags, tools, env = VARIANTS[variant]
    prompt, expected = TASKS[task]
    cmd = ["claude", "-p", prompt + TAIL, "--output-format", "stream-json", "--verbose", "--setting-sources", "project", "--model", MODEL, *flags, "--allowedTools", tools]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=fixture, capture_output=True, text=True, timeout=420, stdin=subprocess.DEVNULL, env={**os.environ, **env})
        events = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
        d = next(e for e in events if e.get("type") == "result")
        last = [e for e in events if e.get("type") == "assistant"][-1]["message"]["usage"]
    except Exception as e:  # a failed run is a data point, not a crash
        return {"variant": variant, "task": task, "rep": rep, "error": str(e)[:200]}
    u = d.get("usage", {})
    answer = str(d.get("result", ""))
    return {
        "variant": variant, "task": task, "rep": rep,
        "correct": all(any(alt.lower() in answer.lower() for alt in x.split("|")) for x in expected),
        "turns": d.get("num_turns"), "cost": d.get("total_cost_usd"),
        "in": u.get("input_tokens", 0), "cache_write": u.get("cache_creation_input_tokens", 0),
        "cache_read": u.get("cache_read_input_tokens", 0), "out": u.get("output_tokens", 0),
        # what the window held at the last model call: the number that says how much room is left
        "ctx_final": last.get("input_tokens", 0) + last.get("cache_read_input_tokens", 0) + last.get("cache_creation_input_tokens", 0),
        "secs": round(time.time() - t0, 1), "answer": answer[:160],
    }


keep = set(os.environ.get("BENCH_VARIANTS", "").split(",")) - {""}
done = set()
if os.path.exists(out):
    done = {(r["variant"], r["task"], r["rep"]) for r in map(json.loads, open(out)) if "error" not in r}
jobs = [(v, t, r) for r in range(reps) for t in TASKS if not only or t in only for v in VARIANTS if not keep or v in keep]
jobs = [j for j in jobs if j not in done]
print(len(jobs), "runs to do", flush=True)
with ThreadPoolExecutor(3) as pool, open(out, "a") as f:
    for res in pool.map(one, jobs):
        f.write(json.dumps(res) + "\n"); f.flush()
        print(res["variant"], res["task"], res.get("correct"), res.get("turns"), res.get("cost"), res.get("error", ""), flush=True)
