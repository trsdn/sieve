#!/usr/bin/env python3
"""Two new decider roles, judged before they are built.

switch: given the recent work and a new request, does the request start an unrelated task? (a 'yes' may suggest compacting)
  Safety: a continuation must never be called new. dev picks the threshold, hold-out checks it.
remind: will this request run tests, builds or read long logs? (a 'yes' adds one reminder line to the turn)
"""
import json, urllib.request

URL = "http://127.0.0.1:8765/v1/systemone"


def ask(state, q):
    r = urllib.request.Request(URL, json.dumps({"state": state, "questions": {"q": q}}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=120))["answers"]["q"]


WORK = {
    "auth": "Recent requests: 'Add JWT refresh tokens to the auth service', 'Why does the token test fail?'. Recently edited: src/auth/tokens.ts, tests/auth/tokens.test.ts. Recently ran: npm test -- auth.",
    "billing": "Recent requests: 'The invoice PDF shows the wrong VAT', 'Fix the rounding in calculateVat'. Recently edited: billing/vat.py. Recently ran: pytest tests/test_vat.py.",
    "infra": "Recent requests: 'Write a Dockerfile for the API', 'The container exits immediately, why?'. Recently edited: Dockerfile, docker-compose.yml. Recently ran: docker compose up.",
    "ui": "Recent requests: 'Make the settings page responsive', 'The sidebar overlaps on mobile'. Recently edited: src/pages/Settings.tsx, src/styles/sidebar.css.",
    "data": "Recent requests: 'Load the sales CSV into a dataframe', 'Plot monthly revenue'. Recently edited: notebooks/sales.ipynb. Recently ran: python analyze.py.",
    "docs": "Recent requests: 'Rewrite the README install section', 'Add a troubleshooting part'. Recently edited: README.md.",
}
CONT = {  # follow-ups: must never be called new
    "dev": ["Now also handle the case where the token is expired.", "That didn't work, the test still fails with the same error.", "Can you add a test for that?", "Commit this with a good message.", "Also do the same for the other file.", "Why did you change that line?", "Run it again and show me the output.", "Looks good, now clean up the code a bit.", "What about the edge case with zero?", "Undo the last change, it broke something else.", "Explain what you just did.", "Great. Next, update the docs to match."],
    "hold": ["Hmm, now it fails differently.", "Ok and the second issue I mentioned?", "Make it a bit more robust.", "Push it.", "Can we simplify that function?", "Same problem on staging."],
}
NEW = {  # clearly unrelated to the work above
    "dev": ["Write me a bash script that renames all my photos by date.", "What's the difference between TCP and UDP?", "Set up a new Next.js project for my blog.", "Translate this email to French: Thanks for the meeting today.", "Help me plan a database schema for a library app.", "How do I configure SSH keys for GitHub on a new laptop?", "Create a Python CLI that converts Markdown to PDF.", "Explain how Kubernetes ingress works.", "Draft a LinkedIn post about our product launch.", "Write a regex that matches German postal codes.", "Start a new Rust project that parses log files.", "What is a good name for a coffee shop?"],
    "hold": ["Build a small Flask app that tracks my workouts.", "How do vaccines train the immune system?", "Write unit tests for an unrelated string utils module in another repo.", "Summarize the plot of Dune.", "Create a GitHub Action that lints YAML files for a different project.", "Give me a weekly meal plan."],
}
SWITCH = {"type": "choice", "instructions": "Does the new request continue the recent work, or start a different, unrelated task?",
          "criteria": {"continue": "a follow-up, fix, extension, question or action about the same work", "new task": "a different topic, project or kind of work that does not need the recent context"}}

RUNS = {  # requests that will run tests, builds or read long logs
    "dev": ["Run the test suite and tell me what fails.", "Build the project and fix any compiler errors.", "Why is CI red? Check the logs.", "Run pytest for the billing module.", "Does the app still compile after my change?", "Check the server logs for errors from last night.", "Run the linter and fix the warnings.", "Install the dependencies and start the dev server.", "Execute the integration tests against staging.", "Find out why the docker build fails."],
    "hold": ["Make sure all tests pass before I merge.", "The nightly job crashed, look at its output.", "Compile it in release mode and see if warnings remain.", "Try running the benchmark suite.", "See whether npm install works now."],
}
OTHER = {
    "dev": ["Rename the function getUser to fetchUser.", "Explain what this regex does.", "Write a docstring for the parse function.", "What does HTTP 418 mean?", "Add a column 'email' to the users table schema.", "Refactor this class into two smaller ones.", "Which file defines the routes?", "Write a commit message for these changes.", "Change the button color to blue.", "Summarize the README."],
    "hold": ["Add type hints to utils.py.", "What is a monad?", "Move the constants into a config file.", "Draft the release notes from this list.", "Where is the login form rendered?"],
}
REMIND = {"type": "choice", "instructions": "Will answering this request involve running tests, builds, installs or reading long logs?",
          "criteria": {"yes": "it runs a test suite, a build or compile, an install, a linter, or reads logs or CI output", "no": "it reads or edits code, explains, writes text, or answers a question"}}


def sweep(name, pos, neg, label, ths):
    for th in ths:
        hit = sum(p >= th for p in pos); false = sum(p >= th for p in neg)
        print(f"  {name} >= {th}: {label} {hit}/{len(pos)}, false alarms {false}/{len(neg)}")


for part in ("dev", "hold"):
    print(f"== {part}")
    new_p = [ask(f"{w}\nNew request: {p}", SWITCH)["probabilities"]["new task"] for w in WORK.values() for p in NEW[part]]
    cont_p = [ask(f"{w}\nNew request: {p}", SWITCH)["probabilities"]["new task"] for w in WORK.values() for p in CONT[part]]
    sweep("switch", new_p, cont_p, "new tasks found", (0.5, 0.6, 0.7, 0.8, 0.9))
    yes = [ask(p, REMIND)["probabilities"]["yes"] for p in RUNS[part]]
    no = [ask(p, REMIND)["probabilities"]["yes"] for p in OTHER[part]]
    sweep("remind", yes, no, "runs found", (0.4, 0.5, 0.6, 0.7, 0.8))
