#!/usr/bin/env python3
"""Browser test: large pages read through the Playwright MCP, the model chooses how to process them.

Setups: no plugin, context-mode, context-mode with the prompt telling the model to use its tools (a diagnostic:
does the saving exist when the tools are used?), sieve.
usage: webbench.py WEBFIXTURE_EXPECTED_JSON OUT.jsonl REPS
"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
MODEL = os.environ.get("BENCH_MODEL", "claude-opus-5-5")  # pinned: the runs in the README used this model

exp = json.load(open(sys.argv[1])); out = sys.argv[2]; reps = int(sys.argv[3])
fixture = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".scratch", "fixture"))
SIEVE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CM = os.environ.get("CM_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".scratch", "context-mode"))
MCP = os.environ.get("PLAYWRIGHT_MCP_CONFIG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".scratch", "playwright-mcp.json"))
B = "http://127.0.0.1:8791"
T = " Answer in one short sentence."
TOLD = " Use the context-mode tools (ctx_execute / ctx_execute_file) to process large data instead of reading it into your context."
TASKS = {
    "top-customer": (f"Open {B}/orders.html in the browser and tell me which customer has the highest total order value and what that total is." + T,
                     [exp["top_customer"], f"{exp['top_total']:.2f}|{exp['top_total']:,.2f}"]),
    "orders-over-500": (f"Open {B}/orders.html in the browser and tell me how many orders have a line value (qty times unit price) above 500." + T, [str(exp["orders_over_500"])]),
    "security-entries": (f"Open {B}/changelog.html in the browser and tell me how many release entries mention a security fix." + T, [str(exp["security_entries"])]),
}
TOOLS = "mcp__playwright,Read,Bash,Grep,Glob"
VARIANTS = {
    "base": ([], TOOLS, ""),
    "context-mode": (["--plugin-dir", CM], TOOLS + ",mcp__plugin_context-mode_context-mode", ""),
    "context-mode-told": (["--plugin-dir", CM], TOOLS + ",mcp__plugin_context-mode_context-mode", TOLD),
    "sieve": (["--plugin-dir", SIEVE], TOOLS + ",mcp__sieve__execute,mcp__sieve__search", ""),
}


def one(job):
    variant, task, rep = job
    flags, tools, suffix = VARIANTS[variant]
    prompt, expected = TASKS[task]
    cmd = ["claude", "-p", prompt + suffix, "--output-format", "stream-json", "--verbose", "--setting-sources", "project", "--model", MODEL,
           "--mcp-config", MCP, *flags, "--allowedTools", tools]
    # WEB_NO_EVALUATE=1: the page cannot be scripted, so the snapshot has to be read (the case context-mode describes)
    if os.environ.get("WEB_NO_EVALUATE"):
        cmd += ["--disallowedTools", "mcp__playwright__browser_evaluate,mcp__playwright__browser_run_code_unsafe,mcp__playwright__browser_run_code"]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=fixture, capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
        ev = [json.loads(l) for l in p.stdout.splitlines() if l.startswith("{")]
        d = next(e for e in ev if e.get("type") == "result")
        last = [e for e in ev if e.get("type") == "assistant"][-1]["message"]["usage"]
        names = [c["name"] for e in ev if e.get("type") == "assistant" for c in e["message"]["content"] if c["type"] == "tool_use"]
    except Exception as e:
        return {"variant": variant, "task": task, "rep": rep, "error": str(e)[:200]}
    u = d.get("usage", {}); ans = str(d.get("result", ""))
    return {
        "variant": variant, "task": task, "rep": rep,
        "correct": all(any(a.lower() in ans.lower() for a in x.split("|")) for x in expected),
        "turns": d.get("num_turns"), "cost": d.get("total_cost_usd"),
        "tokens": u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("output_tokens", 0),
        "ctx_final": last.get("input_tokens", 0) + last.get("cache_read_input_tokens", 0) + last.get("cache_creation_input_tokens", 0),
        "ctx_tools": sum("ctx_" in n or "mcp__sieve" in n for n in names), "tools": names,
        "secs": round(time.time() - t0, 1), "answer": ans[:140],
    }


jobs = [(v, t, r) for r in range(reps) for t in TASKS for v in VARIANTS if not (set(os.environ.get('BENCH_VARIANTS', '').split(',')) - {''}) or v in os.environ.get('BENCH_VARIANTS', '').split(',')]
with ThreadPoolExecutor(2) as pool, open(out, "a") as f:
    for res in pool.map(one, jobs):
        f.write(json.dumps(res) + "\n"); f.flush()
        print(res["variant"], res["task"], res.get("correct"), res.get("turns"), res.get("ctx_tools"), res.get("error", ""), flush=True)
