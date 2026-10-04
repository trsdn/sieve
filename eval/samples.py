#!/usr/bin/env python3
"""Samples for the evals; run directly to dump eval/samples.json. (Original docstring: does the decider tell 'a short excerpt will do' (1) from 'the reader needs it all' (0)?

Samples are real local outputs cut to the mid band (4-10k chars) where the mod asks the decider.
Prints accuracy per question variant over a threshold sweep.
"""
import json, os, random, subprocess, sys, urllib.request

URL = "http://127.0.0.1:8765/v1/systemone"
HOME = os.path.expanduser("~")
random.seed(7)


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60).stdout


def cut(text, lo=4500, hi=9500):
    n = random.randint(lo, hi)
    return text[:n]


def files(root, exts, limit):
    out = []
    for d, _, fs in os.walk(root):
        if "node_modules" in d or ".git" in d:
            continue
        for f in sorted(fs):
            if f.endswith(exts):
                p = os.path.join(d, f)
                try:
                    if 6000 < os.path.getsize(p) < 200000:
                        out.append(p)
                except OSError:
                    pass
    random.shuffle(out)
    return out[:limit]


samples = []  # (tool, descriptor, text, label)
# needed (0): code, config, docs, tracebacks
cache = f"{HOME}/.claude/plugins/cache"
for p in files(cache, (".ts", ".mjs", ".py", ".js"), 10):
    samples.append(("Read", p, cut(open(p, errors="ignore").read()), 0))
for p in files(cache, (".json", ".toml", ".yaml", ".yml"), 5):
    samples.append(("Bash", f"cat {p}", cut(open(p, errors="ignore").read()), 0))
for p in files(cache, (".md",), 6):
    samples.append(("Read", p, cut(open(p, errors="ignore").read()), 0))
trace = "Traceback (most recent call last):\n" + "".join(
    f'  File "/app/svc/handler_{i}.py", line {40+i}, in step_{i}\n    result = step_{i+1}(payload)\n' for i in range(40)
) + "KeyError: 'customer_id'\n\nThe above was raised while handling payload for order 1182\n"
samples.append(("Bash", "python app.py", trace * 3, 0))
samples.append(("Bash", "git diff HEAD~1", cut(sh(f"git -C {HOME}/dev/sieve show HEAD~1 --stat -p"), 4500, 9500), 0))

# verbose (1): listings, logs, progress, trees
listings = [
    f"find {HOME}/.claude/plugins/cache -maxdepth 6",
    "ls -laR /usr/share/zoneinfo",
    "find /usr/lib -maxdepth 4",
    "find /opt/homebrew -maxdepth 3 -type f",
    "ls -laR /Library/Frameworks",
    f"find {HOME}/.local/share/uv -maxdepth 7",
    "find /usr/share -maxdepth 5",
    "ls -la /usr/bin /usr/sbin /bin",
]
for cmd in listings:
    t = sh(cmd)
    if len(t) > 4500:
        samples.append(("Bash", cmd, cut(t), 1))
samples.append(("Bash", "uv pip list", cut(sh(f"{HOME}/.local/bin/uv pip list --python {HOME}/.local/share/uv/tools/strands-decider/bin/python 2>/dev/null"), 4500, 9500), 1))
samples.append(("Bash", "ls node tree", cut("\n".join(f"{'  '*(i%5)}├── pkg-{i}@{i%9}.{i%7}.{i%4}" for i in range(900)), 4500, 9500), 1))
samples.append(("Bash", "make build", cut("\n".join(f"[{i%100:3d}%] Building CXX object src/mod_{i}.cc.o" for i in range(600)), 4500, 9500), 1))
samples.append(("Bash", "npm test", cut("\n".join(f"  PASS src/unit/spec_{i}.test.ts ({i%9+1}.{i%10} s)" for i in range(500)), 4500, 9500), 1))
samples.append(("Bash", "docker logs web", cut("\n".join(f"2026-10-04T10:{i//60:02d}:{i%60:02d}Z INFO request handled path=/api/v1/items/{i} status=200 ms={i%40}" for i in range(500)), 4500, 9500), 1))
samples.append(("Grep", "TODO", cut("\n".join(f"src/module_{i%40}/file_{i}.ts:{i*3}:  // TODO: revisit" for i in range(500)), 4500, 9500), 1))
samples.append(("Glob", "**/*.ts", cut("\n".join(f"/work/app/src/feature_{i%30}/component_{i}.ts" for i in range(600)), 4500, 9500), 1))



if __name__ == "__main__":
    json.dump([{"tool": t, "desc": d, "text": x, "label": l} for t, d, x, l in samples], open(os.path.join(os.path.dirname(__file__), "samples.json"), "w"))
    print(len(samples), "samples written")
