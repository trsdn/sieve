#!/usr/bin/env python3
"""Question variants for 'does the request need every line?', judged on three prompt sets.

dev: used to pick a variant. hold-out 1: seen once already. hold-out 2: written after the variants, never used for choosing.
A variant is acceptable only if it keeps the output whole whenever the request needs it, on every set.
"""
import json, os, subprocess, urllib.request

URL = "http://127.0.0.1:8765/v1/systemone"
sh = lambda c: subprocess.run(c, shell=True, capture_output=True, text=True).stdout
outs = {
    "find": ("find /usr/lib -maxdepth 4", sh("find /usr/lib -maxdepth 4")[:7500]),
    "ls": ("ls -laR /usr/share/zoneinfo", sh("ls -laR /usr/share/zoneinfo")[:7500]),
    "log": ("docker logs web", "\n".join(f"2026-10-04T10:{i//60:02d}:{i%60:02d}Z INFO request handled path=/api/v1/items/{i} status={200 if i % 37 else 500} ms={i%40}" for i in range(110))),
    "tests": ("npm test", "\n".join(f"  PASS src/unit/spec_{i}.test.ts ({i%9+1}.{i%10} s)" for i in range(170))),
    "make": ("make build", "\n".join(f"[{i%100:3d}%] Building CXX object src/mod_{i}.cc.o" for i in range(150))),
}
SETS = {
    "dev": (["Count how many entries in this output end in .txt.", "How many requests returned status 500? Give the exact number.", "List every file whose name contains 'a'.", "Find the exact line for spec_77 and tell me its duration.", "How many objects were built in total?", "Does the entry for 'Berlin' exist? I need a definite yes or no."],
            ["Give me a rough idea of what this output contains.", "Skim this and tell me if anything looks broken.", "What kind of output is this? One sentence.", "Is the command working, roughly?", "Summarize what this shows in general terms.", "Does this look like a normal run?"]),
    "hold-out 1": (["How many lines are there in total?", "Give me the exact count of entries containing the digit 7.", "Is 'spec_12' in this output? Answer definitely.", "What is the very last entry?", "Count the lines with status 500."],
                   ["What am I looking at here?", "Anything alarming in this?", "Describe the general pattern of these lines.", "Is this roughly what a healthy run looks like?", "Give me the gist."]),
    "hold-out 2": (["Which entry has the highest number? Give it exactly.", "Tell me how many distinct directories appear.", "Does any line contain the word 'Zulu'? Yes or no, I must be sure.", "List all lines that mention a duration over 8 s.", "How many of these entries are for src/mod_1x files?", "What is the 40th line?"],
                   ["Does this look like a normal build or something odd?", "Briefly, what is this output about?", "Is there any sign of trouble here, in general?", "Characterize this output in a few words.", "Does the run seem to have gone fine overall?", "What's the overall picture?"]),
}
V = {
    "A current": {"type": "choice", "instructions": "To answer the request, how much of the output has to be read?",
                  "criteria": {"every line": "the answer depends on counting, exact lookup or completeness over the whole output", "a sample": "a general idea, a summary or a check for obvious problems is enough"}},
    "B precision wording": {"type": "choice", "instructions": "Could the request be answered correctly from a few example lines plus a description of the pattern?",
                            "criteria": {"no": "it asks for a count, a total, an exact value, a specific line, or whether something exists anywhere in the output", "yes": "it asks only what the output is, what it looks like, or whether it looks healthy"}},
    "C two-way contrast": {"type": "choice", "instructions": "What kind of answer does the request want from this output?",
                           "criteria": {"exact": "an exact number, an exact line or item, a complete list, or a certain yes or no about the whole output", "impression": "an impression, a gist, a description, or a rough health check"}},
    "D question type": {"type": "choice", "instructions": "Which kind of question is the request?",
                        "criteria": {"lookup or count": "how many, which one, list all, find, exists, exact", "overview": "what is this, summarize, describe, does it look ok, any sign of trouble"}},
}
POS = {"A current": "every line", "B precision wording": "no", "C two-way contrast": "exact", "D question type": "lookup or count"}


def ask(q, request, name):
    cmd, text = outs[name]
    state = f"Request: {request}\nBash: {cmd}\n---\n{text[:1500]}\n…\n{text[-500:]}"
    r = urllib.request.Request(URL, json.dumps({"state": state, "questions": {"q": q}}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=120))["answers"]["q"]["probabilities"]


res = {}
for vn, q in V.items():
    for sn, (need, skim) in SETS.items():
        n = [ask(q, p, o)[POS[vn]] for o in outs for p in need]
        s = [ask(q, p, o)[POS[vn]] for o in outs for p in skim]
        res[(vn, sn)] = (n, s)
for vn in V:
    print(vn)
    for th in (0.5, 0.6, 0.7, 0.8, 0.9):
        row = []
        for sn in SETS:
            n, s = res[(vn, sn)]
            row.append(f"{sn}: kept {sum(p >= th for p in n)}/{len(n)}, cut {sum(p < th for p in s)}/{len(s)}")
        print(f"  >= {th}  " + "   ".join(row))
