#!/usr/bin/env python3
"""Does the decider tell exploring / debugging / other prompts apart, and how sure is it?"""
import json, urllib.request

URL = "http://127.0.0.1:8765/v1/systemone"
P = {
 "explore": ["Where is the auth middleware defined and how does it work?", "Give me an overview of how the billing module is structured.", "Which files import the Config class?", "Walk me through what happens when a user signs up.", "Find all places where we call the payments API.", "How is caching implemented in this repo?", "What does the build pipeline do, step by step?", "Show me how the plugin loader discovers plugins."],
 "debug": ["Why does my test suite fail with a timeout in CI?", "The app crashes with a segfault when I upload a large file, find out why.", "Tests pass locally but fail on the runner, figure out the cause.", "I get 'connection reset' errors in the logs every few minutes, investigate.", "This function returns None sometimes, debug it.", "The deploy job is failing at the migration step, look at the output.", "Why is the memory usage growing over time?", "pytest shows 3 failures, what is going wrong?"],
 "other": ["Add a retry flag to the upload function.", "Rename the User class to Account everywhere.", "What does HTTP 418 mean?", "Write a README section about installation.", "Refactor the parser into two modules.", "Review this pull request for style issues.", "Create a new endpoint for listing invoices.", "Explain the difference between a mutex and a semaphore."],
}
CRIT = {"explore": "reading or searching code to understand it", "debug": "investigating an error, failing test or log output", "implement": "writing or changing code", "review": "reviewing a diff, a PR or existing work", "question": "a short question that needs an answer, not tool work"}
CRIT2 = {"explore": "the user wants to find or understand code and will read many files or search results", "debug": "something is failing and the user wants the cause, from errors, logs or test output", "other": "anything else: making a change, a review, or a plain question"}
V = {"A five classes": CRIT, "B three classes": CRIT2}

def ask(crit, text):
    q = {"type": "choice", "instructions": "What kind of work does this request mainly ask for?", "criteria": crit}
    req = urllib.request.Request(URL, json.dumps({"state": text, "questions": {"t": q}}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))["answers"]["t"]

for name, crit in V.items():
    rows = []
    for label, prompts in P.items():
        for p in prompts:
            a = ask(crit, p)
            c = a["choice"]
            mapped = c if c in ("explore", "debug") else "other"
            rows.append((label, mapped, a["confidence"]))
    print(name)
    for th in (0.0, 0.4, 0.5, 0.6, 0.7):
        act = [(l, m) for l, m, c in rows if c >= th and m != "other"]
        right = sum(1 for l, m in act if l == m)
        wrong_dir = sum(1 for l, m in act if l != m and l != "other")
        false_alarm = sum(1 for l, m in act if l == "other")
        print(f"  conf >= {th}: acts on {len(act)}/24, right {right}, swapped explore/debug {wrong_dir}, fired on 'other' {false_alarm}")
