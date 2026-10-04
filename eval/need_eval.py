#!/usr/bin/env python3
"""Given the request and a repetitive output, can the decider tell 'needs every line' from 'an excerpt will do'?"""
import json, os, subprocess, urllib.request

URL = "http://127.0.0.1:8765/v1/systemone"
home = os.path.expanduser("~")
sh = lambda c: subprocess.run(c, shell=True, capture_output=True, text=True).stdout
outs = {
    "find": ("find /usr/lib -maxdepth 4", sh("find /usr/lib -maxdepth 4")[:7500]),
    "ls": ("ls -laR /usr/share/zoneinfo", sh("ls -laR /usr/share/zoneinfo")[:7500]),
    "log": ("docker logs web", "\n".join(f"2026-10-04T10:{i//60:02d}:{i%60:02d}Z INFO request handled path=/api/v1/items/{i} status={200 if i % 37 else 500} ms={i%40}" for i in range(110))),
    "tests": ("npm test", "\n".join(f"  PASS src/unit/spec_{i}.test.ts ({i%9+1}.{i%10} s)" for i in range(170))),
    "make": ("make build", "\n".join(f"[{i%100:3d}%] Building CXX object src/mod_{i}.cc.o" for i in range(150))),
}
NEED = ["Count how many entries in this output end in .txt.", "How many requests returned status 500? Give the exact number.", "List every file whose name contains 'a'.", "Find the exact line for spec_77 and tell me its duration.", "How many objects were built in total?", "Does the entry for 'Berlin' exist? I need a definite yes or no."]
SKIM = ["Give me a rough idea of what this output contains.", "Skim this and tell me if anything looks broken.", "What kind of output is this? One sentence.", "Is the command working, roughly?", "Summarize what this shows in general terms.", "Does this look like a normal run?"]
Q = {"need": {"type": "choice", "instructions": "To answer the request, how much of the output has to be read?", "criteria": {"every line": "the answer depends on counting, exact lookup or completeness over the whole output", "a sample": "a general idea, a summary or a check for obvious problems is enough"}}}


def ask(request, name):
    cmd, text = outs[name]
    state = f"Request: {request}\nBash: {cmd}\n---\n{text[:1500]}\n…\n{text[-500:]}"
    r = urllib.request.Request(URL, json.dumps({"state": state, "questions": Q}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=120))["answers"]["need"]["probabilities"]["every line"]


res = {"need": [], "skim": []}
for name in outs:
    res["need"] += [ask(p, name) for p in NEED]
    res["skim"] += [ask(p, name) for p in SKIM]
for th in (0.3, 0.4, 0.5, 0.6, 0.7):
    keep = sum(p >= th for p in res["need"])
    cut = sum(p < th for p in res["skim"])
    print(f"every-line >= {th}: kept whole when needed {keep}/{len(res['need'])}, cut when a skim is enough {cut}/{len(res['skim'])}")
