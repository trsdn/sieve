#!/usr/bin/env python3
"""A harder set for the 'need every line?' question: no stock phrases like 'how many' or 'what is this'.

Needs-all prompts include edits and checks that depend on one specific line; skim prompts are phrased as worries and decisions.
"""
import json, importlib.util, os, sys
spec = importlib.util.spec_from_file_location("ne2", os.path.join(os.path.dirname(__file__), "need_eval2.py"))
src = open(spec.origin).read().split("res = {}")[0]  # reuse outs, variants and ask() without running the sweep
ns = {}; exec(compile(src, "need_eval2", "exec"), ns)
outs, V, POS, ask = ns["outs"], ns["V"], ns["POS"], ns["ask"]
NEED = [
    "Before I delete this, make sure nothing in there refers to a module numbered 88.",
    "The third entry looks wrong; give me its exact text so I can fix it.",
    "I need the slowest or largest item in this output, not an approximation.",
    "Compare the first and the last entry for me and quote both.",
    "Is the total here above 150? I'm going to put that number in a report.",
    "Pull out every line that breaks the pattern of the others.",
    "Can I rely on this being complete? Check that nothing is missing between the first and the last item.",
    "Rewrite the entry for number 42 with a new value, so show me exactly what it says now.",
]
SKIM = [
    "I'm about to merge. Anything here I should worry about?",
    "Just checking in: did that command behave itself?",
    "Is this the kind of output I'd expect from that command?",
    "Tell me in a sentence whether I can move on.",
    "Is it noisy? I only care about the overall feel.",
    "Does anything look off at first glance?",
    "My colleague asked what the command printed. Give me something to say to them.",
    "Worth reading closely, or can I ignore it?",
]
for vn in ("A current", "D question type"):
    q = V[vn]; need = [ask(q, p, o)[POS[vn]] for o in outs for p in NEED]; skim = [ask(q, p, o)[POS[vn]] for o in outs for p in SKIM]
    print(vn)
    for th in (0.4, 0.5, 0.6, 0.7, 0.8):
        print(f"  >= {th}: kept whole when needed {sum(p >= th for p in need)}/{len(need)}, cut when a sample is enough {sum(p < th for p in skim)}/{len(skim)}")
