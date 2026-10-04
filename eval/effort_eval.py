#!/usr/bin/env python3
"""Can the decider tell a simple request (lookup, tiny edit, quick question) from one that needs real reasoning?
A 'simple' verdict would lower the effort for the session, so calling a hard request simple is the failure that matters."""
import json, urllib.request
URL = "http://127.0.0.1:8765/v1/systemone"
Q = {"type": "choice", "instructions": "How much reasoning does this request need?",
     "criteria": {"simple": "a lookup, a count, a one-line change, a rename, a quick factual question or running one command",
                  "complex": "debugging, designing, a change across several files, an unclear cause, or anything that needs careful thought"}}
SIMPLE = {"dev": ["What's the current git branch?", "Rename the variable tmp to buffer in utils.py.", "How many files are in src/?", "Show me the last 5 commits.", "What does the --verbose flag do in this CLI?", "Add a newline at the end of README.md.", "Which Python version does this project require?", "Run the formatter.", "Bump the version in package.json to 2.1.0.", "Is there a LICENSE file?", "Print the contents of .env.example.", "What port does the dev server use?"],
          "hold": ["List the npm scripts.", "Fix the typo 'recieve' in the docs.", "Who wrote the last commit?", "Delete the unused import in main.py.", "What's in the Makefile?", "Show the open TODO comments."]}
COMPLEX = {"dev": ["The app leaks memory after a few hours; find out why.", "Design a caching layer for our API and implement it.", "Tests pass locally but fail in CI intermittently. Investigate.", "Refactor the auth module to support OAuth and keep backwards compatibility.", "Why is this query slow, and how do we fix it without changing the schema?", "Migrate the project from webpack to vite.", "There is a race condition somewhere in the job scheduler. Find and fix it.", "Add multi-tenant support to the data model.", "Our build output is wrong only on Windows. Figure out the cause.", "Implement undo/redo for the editor.", "Find the cause of the failing tests and fix it.", "Review this PR for security problems."],
           "hold": ["Users report wrong totals sometimes. Track it down.", "Split the monolith service into two services.", "Make the parser handle malformed input gracefully everywhere.", "Why does the login break after the latest deploy?", "Port this module from Python to Rust.", "Optimize the startup time; it doubled since last month."]}

def p_simple(t):
    r = urllib.request.Request(URL, json.dumps({"state": t, "questions": {"q": Q}}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=120))["answers"]["q"]["probabilities"]["simple"]

for part in ("dev", "hold"):
    s = [p_simple(t) for t in SIMPLE[part]]; c = [p_simple(t) for t in COMPLEX[part]]
    print(f"== {part}")
    for th in (0.6, 0.7, 0.8, 0.9):
        print(f"  simple >= {th}: simple found {sum(p >= th for p in s)}/{len(s)}, hard called simple {sum(p >= th for p in c)}/{len(c)}")
