# sieve

A Claude Code mod that lets the useful part of tool output through and keeps the rest out of the context. It replaces the `context-mode` plugin and adds [strands-decider](https://github.com/strands-labs/strands-decider) for the calls a fixed rule cannot make.

## What it does

| Part | What |
| --- | --- |
| Results | Bash, Grep, Glob, WebFetch, text MCP results and Playwright snapshot reads are rewritten in place after they ran: large ones become a structural summary, the whole output goes to a file and an SQLite FTS5 index. Nothing is refused. |
| Tool | `mcp__sieve__search` (BM25 over what was cut). |
| Decider | One shared `strands-decider serve` (MLX, 127.0.0.1:8765, a LaunchAgent, see `launchd/`) makes the small calls a rule cannot: lookup or overview, new task, reminder, effort. It answers within 1.5 s or counts as down for 30 s; without it only the rules decide. |
| Session | Edited files, commands, failures and prompts are recorded; before a compaction a resume note (max 2000 chars) is stored and added to the system prompt afterwards. |
| Command | `/sieve` shows cuts, chars kept out of context, index size, decider status. |

## Requirements

- Claude Code with function-hook mods (`plugin-authoring`), `sqlite3` with FTS5, `node`, `python3`
- `strands-decider` with the `mlx` extra at `~/.local/bin/strands-decider`, run as a shared service: `sh launchd/install.sh` (optional; without it only the rules route)

## Install

```
claude --plugin-dir ~/dev/sieve
```

Disable the old plugin: set `"context-mode@context-mode": false` in `~/.claude/settings.json`.

## Develop

```
claude plugin validate .
claude plugin test .
```

Pure logic lives in `hooks/lib.ts` with tests in `hooks/lib.test.ts`. Everything that takes `$` stays in `hooks/register.ts`, as top-level functions: the validator refuses `$` passed to closures.

## How it works

A short fixed guide in the system prompt (about 110 tokens, cached after the first request) asks the model to plan commands so only the answer comes back, with one concrete pattern: write test, build and log output to a file and print the summary and failures. This is the part of context-mode's start-up text that changes behaviour, without its 5,000 characters and its note on every tool call. `SIEVE_GUIDE=0` turns it off.

Results of Bash, Grep, Glob, WebFetch, any MCP tool that returns text, and Playwright snapshot files read back with `Read` are rewritten in place after they ran. Nothing is refused and the model has nothing to learn; the only tool is `mcp__sieve__search`.

- Up to 4000 chars (Glob: 150 paths) a result is left alone. Other `Read`s are only cut above 80000 chars: code must stay whole.
- In between, two checks, both must agree before anything is cut:
  1. **A rule** (`isRepetitive`, no model): many lines of few shapes (digits and words blanked), such as a listing, a log, progress output or a table dump. Code, config and prose never pass.
  2. **The decider** reads the request next to the output and answers one question: is it a *lookup or count* (how many, which, list all, find, exact) or an *overview* (what is this, does it look ok)? Cut only on overview. Anything at 0.5 or above for lookup keeps the output whole; no answer keeps it whole.
- Above 30000 chars Bash and Grep results are cut without asking (the harness caps them anyway). MCP results and snapshot reads are never cut blind, up to 1 MB: a blind cut gave wrong answers in the browser test.
- **Known commands get their own filter** (the RTK idea, inside the mod): test runners keep failures with their block, skips, warnings and totals and drop passing lines; `git log` becomes one line per commit (a patch is never filtered); installs and builds keep warnings, errors and the closing summary. Unnamed test scripts are recognised by their output. Applied from 2000 chars, without the decider.
- A command that fails comes back from Claude Code as text already cut in the middle (about 10,000 chars), where failures usually are; sieve cannot recover that part, it can only filter what is left. The guide exists to avoid this case.
- **Learned keep**: a call that is repeated right after a cut counts as a wrong cut for its type (`git log`, `python -m pytest`, a tool name); after two, that type is never cut again, across sessions (`$.store`). An Edit, Write or NotebookEdit in between makes the repeat a new measurement, not a wrong cut (`pytest`, fix, `pytest` is the normal loop).
- **JSON** (a Bash or MCP result that parses) becomes a schema: fields with type, presence and number ranges, value counts for fields with few values, the first rows and the rows with rare values (`status: failed` among thousands of `ok`). For an object, its keys and its largest array of objects as such a table. It counts as data, so the decider weighs it like a repetitive result.
- A cut result becomes a **summary of its structure**: a directory tree with counts by extension and folder, a per-file match table for Grep, or a table of line shapes with the rare and failure lines kept verbatim. The footer names the file with the whole output, so the model can `grep`/`wc` it; the output is also indexed (`mcp__sieve__search`, BM25).
- **A repeated call** within two calls of a cut gets the whole output: the repeat is the signal that the cut was wrong.
- The full output is written to `~/.claude/projects/<project>/<session>/tool-results/sieve-*.txt`, the harness's own folder, because the model can read it there with narrow permissions (tested with `Bash(grep:*)` only: 3.5 MB of Grep output became 3 KB and the model counted 39,946 matches in the file).
- The index is one SQLite file per project (`~/.claude/sieve/<folder>-<hash of the path>.db`; the hash avoids the slug collision of `/a/b.c` and `/a/b-c`); rows and files older than 14 days are deleted at session start.
- Session capture and resume note: edited files, commands, failures, prompts and what was indexed; before a compaction a note (max 2000 chars) is stored and added to the system prompt after it.
- Measurement: `~/.claude/sieve/usage.jsonl` (tool, size, verdict; no content), `eval/usage_report.py`; `/sieve` shows cuts, chars kept out, repeated calls restored, decider use; the status line shows chars kept out. `SIEVE_DECIDER=0` turns the decider off (the rule and size limits still apply, but then nothing in the middle band is cut).
- There is no `execute` tool any more: it was never called in any test.

### The decider's jobs

The decider makes small, fast, local decisions that a rule cannot make and that would be too slow or too expensive for a model call. Each job was tested on its own prompt set before it was built (`eval/`), with a hold-out part that was not used to pick the threshold, and each errs on the safe side.

| Job | Question | Action | Test (dev / hold-out) |
| --- | --- | --- | --- |
| Lookup or overview | Is the request a lookup or count, or an overview? | cut a repetitive mid-sized result only for an overview | kept 125/125 needed outputs; harder set 40/40 kept, 35/40 cut |
| New task | Does the request continue the recent work or start an unrelated task? | a toast suggesting `/clear` or `/compact` (never automatic) | at 0.8: 68/72 and 35/36 new tasks found, no follow-up ever called new |
| Reminder | Will the request run tests, builds, installs or read logs? | one reminder line in that turn (new text only, so the cache is untouched) | at 0.4: 10/10 and 5/5 found, no false alarm |
| Effort | Does the session's first request need real reasoning? | `low` effort for the whole session when it is clearly simple | at 0.7: 18/18 simple found, no hard request called simple; 0.8 is used |

Effort is set once per session and kept (a resumed session reads it back), because the API invalidates the prompt cache whenever effort or thinking settings change; switching per step would cost more than it saves. The new-task check reads earlier prompts from the session record, so it also works when a session is resumed in a new process. `SIEVE_EFFORT=0` turns the effort job off.

Measured effects:
- Effort, single quick questions on the real repository (12 sessions per setup): output tokens median 165 with the effort job, 194 without, 234 for no plugin; all 36 answers right; cost about 3% lower (short sessions are dominated by input).
- Effort, the five-step repository session (3 sessions each, side by side): the first request is simple, so effort was `low` for all three sessions, including the bug fix. All 15 steps right in both; cost $0.154 against $0.196 (-21%), window-turns 206,565 against 235,578 (-12%). The bug is easy; a session that starts simple and turns hard is the risk, and it is not measured yet.
- Reminder, the verbose test step (5 runs): no gain over the guide alone (38k against 37k window-turns); the guide already does that work there. Kept because it costs one line.
- New task, live over a resumed five-prompt session: only the unrelated prompt (a haiku in the middle of a bug fix) was flagged; the follow-ups before and after were not.

### What was measured, and what was not

| Evaluation | Result |
| --- | --- |
| `eval/rule_eval.mjs`: repetitive-or-not rule vs 36 real outputs | 35/36 right; the miss is a stack trace repeated three times |
| `eval/need_eval2.py`: four question wordings, three prompt sets | The first wording (`every line` / `a sample`) kept the output whole every time but cut only 11-24 of 25-30 skim cases at a safe threshold. The wording "kind of question: lookup or count / overview" kept 85/85 whole at 0.5 and cut 83-85 of 85 |
| `eval/need_eval3.py`: a harder set with no stock phrases (edits, checks on one line, worries) | lookup/overview at 0.5: kept whole 40/40, cut 35/40. The first wording at its safe threshold: kept 40/40, cut 20/40. Higher thresholds for the new wording lose needed output (0.7: 30/40 kept) |
| `eval/decider_eval.py`, `eval/task_eval.py` | earlier designs; the record of why "repetitive" became a rule and the prompt-class factor was dropped |

Over four prompt sets the chosen setting kept all 125 requests that need the whole output; the 0.5 threshold was picked on those same sets, and the first three sets share phrasing with the criteria, so read the cut rate (83-100%) as optimistic and the harder set (88%) as the better estimate. All prompts and outputs are small, hand-written and from one person.

## Real use (`eval/real_report.py`)

Benchmarks are written by the people who build the tool; real sessions are the test that counts. Load sieve in every session and keep a control group:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/dev/sieve", "SIEVE_HOLDOUT": "0.2" }
```

in `~/.claude/settings.json`. With `SIEVE_HOLDOUT=0.2` one session in five is a holdout: no cuts, no guide, no effort change, no reminder, no toast; it only logs what it would have done. Every line of `usage.jsonl` carries the session id and a project key; bench runs (cwd under `sieve-bench-runs` or `.scratch`, or `SIEVE_BENCH=1`) are marked and left out. Logged per session: each prompt's p(simple) and p(reminder) (one decider call for both), cuts and would-be cuts, follow-ups (a later call that reads a cut output's file), searches, restored repeats.

`python3 eval/real_report.py [--days N] [--sessions]` joins that log with Claude Code's own transcripts (`~/.claude/projects/*/<session>.jsonl`, token usage per model call) and compares active sessions with the holdout: window-turns, per call, output tokens, calls; how often the model went back to a cut output; and how many low-effort sessions later had a request with p(simple) < 0.3 (the effort job's known risk).

## Benchmark (`eval/bench.py`, `eval/report.py`)

13 tasks on a generated project (`eval/make_fixture.py`) with large logs, data, file trees, test output and git history, headless `claude -p`, medians. **Incomplete**: 151 of 260 planned runs (`eval/bench_v2.jsonl`; the script resumes where it stopped).

| Setup (about 43 runs each, same tasks) | Correct | Tokens | Context at the end |
| --- | --- | --- | --- |
| no plugin | 100% | 42,756 | 18,844 |
| sieve, rules only | 100% | 42,913 | 18,934 |
| sieve, rules + decider | 100% | 37,844 | 18,937 |

- Where the output is large and the request does not need all of it, sieve saves tokens (`mid-find-skim` 37.8k vs 42.7k; `run-log` 37.1k vs 57.9k in the earlier run). Where the model already asks for a small output, nothing changes, which is most tasks.
- The decider's share: about 5k tokens (-12%) over rules alone on the tasks run so far; one more check with 5 repetitions per cell is still due.
- context-mode, 5-task check after repairing its install (1 run per cell, so no more than a sanity check): all correct, about 6.4k tokens more per session than no plugin (tool descriptions), same turns.
- Single runs vary a lot (`tests` took 3 to 7 turns for the same setup because the model explores differently), so differences under about 10% are noise. Cost is noisy too (prompt-cache hits); tokens and turns are steadier.
- Not measured: interactive sessions (approval dialogs), sessions long enough to compact, other models, the approval path of `execute`, wrong cuts in real use (`/sieve` counts them).

### Real repository session (`eval/repobench.py`, `eval/repo_report.py`)

The closest to normal work: a copy of [more-itertools](https://github.com/more-itertools/more-itertools) (933 tests, 2,503 commits) with one injected bug, and a five-step session: run the tests verbosely and count skipped and failed, find and fix the bug (judged by running the suite afterwards, tests untouched), find the most-changed file in the last 200 commits, count the public functions in a 175 KB module, recall the bug. Each run gets its own copy. "Window-turns" sums the context size over every model call: what the window costs over the session.

| Run | Setup | Right | Window-turns | Uncached input | Cost |
| --- | --- | --- | --- | --- | --- |
| first, 4 setups at once | no plugin | 15/15 | 254,883 | 11,340 | $0.200 |
| | context-mode | 15/15 | 275,059 | 21,995 | $0.288 |
| | sieve without the guide | 15/15 | 258,501 | 11,872 | $0.211 |
| side by side, final code | no plugin | 15/15 | 259,318 | 5,319 | $0.163 |
| | **sieve with the guide** | 15/15 | **207,173 (-20%)** | **4,125 (-22%)** | **$0.130 (-20%)** |
| side by side, ablation | sieve | 15/15 | 229,347 | 4,255 | $0.135 |
| | sieve, decider off | 15/15 | 256,474 | 5,096 | $0.161 |

- **Repeated with Claude Code 2.1.289** (3 sessions each, side by side, `eval/repo_results_v3.jsonl`): no plugin 202,387 window-turns, sieve 204,484 (+1%), both 15/15 right, same calls. The guide's earlier gain is gone: the no-plugin run itself now keeps the verbose test run small (step 1: 2 calls, 36k window-turns, as with the guide). Session cost is bimodal in both setups ($0.09 or $0.16 per session, the same windows and uncached input), so it is prompt-cache state, not the setup.
- context-mode won the first step (verbose test run: 2 calls and 43k window-turns against 4 calls and 78k) because its start-up text makes the model write the output to a file and grep it; it lost the other steps to its overhead. The guide copies that behaviour: step 1 alone, 5 runs each, 37k against 78k window-turns, all right.
- Without the guide sieve equals no plugin here: in a normal session the outputs that would be cut are rare.
- **The decider's share is not shown by this session.** In the ablation it made one decision in 25 minutes and kept that output whole; the 11% between the two lines is run-to-run variance. With the guide the model asks for small outputs, so the middle band where the decider works stays almost empty. Its value is in the cases measured further down (overview questions over large output), not in this one.
- Costs move with prompt-cache state (compare the two no-plugin rows), so only rows run side by side are compared. 3 sessions per row.

### Long session (`eval/longbench.py`, `eval/long_report.py`)

One session per setup, nine steps one after another (`--resume`): eight commands with large, unavoidable output (the prompt names the exact command, no pipes), then a recall question ("which test failed earlier, expected and actual?"). 2 repetitions per setup, so 6 sessions; results in `eval/long_results.jsonl`.

| Setup | Window after step 1 | after step 5 | after step 9 | Session cost | Right |
| --- | --- | --- | --- | --- | --- |
| no plugin | 19,856 | 55,299 | 61,153 | $0.452 | 9/9 |
| context-mode (repaired) | 23,414 | 55,568 | 71,012 | $0.479 | 9/9 |
| sieve | 19,124 | 40,278 | 43,450 | $0.319 | 9/9 |

sieve ends the session with a window 29% smaller than no plugin and a session 29% cheaper; all nine steps were right in every session, including the recall question, so the cuts did not cost the model what it needed. context-mode ends 16% above no plugin.

Why context-mode does not help here, as far as the traces show: in two probe runs the model made only plain Bash and Grep calls and never a `ctx_*` call, so context-mode contributed its fixed cost (about 3-6k tokens of tool descriptions and routing text) and no cuts. Its method depends on the model choosing its tools, and a prompt that dictates the command overrides that. These prompts dictate the command by design (so large output cannot be avoided), which is not how context-mode is meant to be used: this test favours a transparent approach, and a fairer test for context-mode would let the model pick its own commands. Not run.

### Long session, model chooses its own commands (`LONG_FREE=1`)

**v3** (Claude Code 2.1.289, 3 repetitions, `eval/long_free_results_v3.jsonl`): window after step 9: no plugin 22,768, sieve 22,490, context-mode 42,062; cost $0.136, $0.136, $0.293; 9/9 right in all. Same picture as before: with free choice sieve neither helps nor costs; context-mode costs twice as much.

The same nine questions, phrased naturally ("how many lines contain ERROR?"), results in `eval/long_free_results.jsonl`.

| Setup | Window after step 1 | after step 5 | after step 9 | Session cost | Right |
| --- | --- | --- | --- | --- | --- |
| no plugin | 18,476 | 20,577 | 21,974 | $0.127 | 9/9 |
| context-mode (repaired) | 21,854 | 32,066 | 40,696 | $0.221 | 9/9 |
| sieve | 18,602 | 20,706 | 22,032 | $0.125 | 9/9 |

- When it is free to choose, the model picks small commands (`grep -c`, `find | wc -l`); a session is about 10 built-in tool calls in all three setups, and **no plugin tool is called**, `ctx_*` included. So there is almost nothing for sieve to cut: it ends within 0.3% of no plugin and costs the same. This is the honest picture of what sieve does: it is insurance for large output, with a fixed cost of about zero, and no gain on sessions where the model never produces any.
- context-mode ends 85% above no plugin and costs 74% more. The window grows by about 2.3k tokens per step, which points to its hooks rather than to tool output: its SessionStart hook injects about 5,000 characters of instructions, and its PreToolUse hooks attach a guidance note to every tool call (observed in a stream trace; the per-step growth was not itemised). In this setting it does not change what the model does, and the notes stay in the window.
- Together with the first long test: context-mode only helped (not at all, in fact) where the tools are used; sieve helped where output is large and cost nothing where it is not.

**Repeated with the final code, 3 repetitions, no plugin vs sieve** (`eval/long_results_v2.jsonl`): window after step 9 49,113 vs 45,737 tokens (-7%), session cost $0.343 vs $0.331, sieve right in 27/27 steps, no plugin in 25/27 (twice the model could not find the failing test because the harness cut the test output in the middle; sieve's summary keeps rare and failure lines). The gap to the first batch is the no-plugin session: it ended at 61k tokens in the first batch and 49k in the second, because the model solved some steps with smaller commands. Treat the saving as somewhere between 7% and 29% on this fixture, not as a number.

Caveats: 2 repetitions per setup, one generated project, one model, one kind of task.

**Repeated after the edit-repeat fix, the decider timeout and JSON summaries** (Claude Code 2.1.289, 3 repetitions, `eval/long_results_v3.jsonl`): window after step 9 84,223 (no plugin) vs 34,638 (sieve), -59%; session cost $0.970 vs $0.356; 9/9 right in every session for both. The biggest single gap is the verbose test run (step 3: +38k tokens without sieve, +1.9k with its test filter). No repeated call was restored, so no learned keep was triggered; the JSON summary handled `records.json` and the model still found the record by id from the full-output file. Decider off (`sieve-rules`, same 3 repetitions): 59,169 tokens at the end, $0.720. The decider cut nothing here (no result fell into the middle band); the gap opens at step 3, where 2 of 3 decider-off sessions also read and grepped the source after the failing test (+25k), and no decider-on session did. Those sessions run at low effort (the first request is simple), so this is most likely the effort job, measured on 3 sessions. In the repo session decider on and off are even (204,484 vs 207,428 window-turns). context-mode 1.0.169 (repaired install, same runs): long session 71,570 tokens at the end, $0.498, repo session 263,862 window-turns (+30% over no plugin) and twice the uncached input (20,517 vs 9,805); 0 `ctx_*` calls in either, all answers right.

### Browser test: large pages through the Playwright MCP (`eval/webbench.py`, `eval/web_report.py`)

The case context-mode's README is about: a 20-40 KB page that arrives as a snapshot. Two generated pages (450 order rows, 140 changelog entries), three questions that need all rows, served locally; the model reads them through the Playwright MCP and picks its own method. 3 repetitions per cell, 36 runs per table; "context-mode-told" adds one sentence to the prompt asking the model to use the `ctx_*` tools (a diagnostic, not a fair free-choice setup). Results in `eval/web_results.jsonl` and `eval/web_snapshot_results.jsonl`.

**With page scripting allowed** (`browser_evaluate` available): every setup, including no plugin, answers by running a small script inside the page, so the raw rows never reach the context. All 36 runs correct; tokens no plugin 100k, sieve 100k, context-mode 119k, context-mode-told 121k. Zero `ctx_*` calls in any setup, even when told: the browser tool already does the job. context-mode's method ("think in code") is what the model does anyway here.

**With `browser_evaluate` blocked** (the model must read the snapshot):

| Setup | Correct | Tokens | Context at the end | `ctx_*` calls |
| --- | --- | --- | --- | --- |
| no plugin | 100% | 103,390 | 32,265 | 0 |
| context-mode, free choice | 100% | 161,557 | 47,232 | 0 |
| context-mode, told to use its tools | 100% | 102,210 | 27,710 | 18 |
| sieve | 100% | 122,411 | 33,188 | 0 |

- When the model uses the `ctx_*` tools the saving is real: the end context is 14% below no plugin, and on the question that needs a computation over every row (`orders-over-500`) tokens drop from 145k to 101k (-31%). So the README's claim holds for the case it describes **if the tools are used**.
- Left to itself the model did not use them (0 calls), and then context-mode was clearly worse than no plugin here (+56% tokens, +15k tokens of end context; why the end context is larger was not investigated).
- Over all three questions the told setup only breaks even with no plugin on tokens (102k vs 103k): the saving appears on the compute-heavy question and vanishes on the others.
- sieve, first version (no MCP handling): equal to no plugin, as expected.
- sieve with MCP and snapshot handling, **first try: 44% correct** (`eval/web_snapshot_v2.jsonl`, no plugin 100%, 9 runs each). Cause: a 41 KB snapshot was above a blind-cut limit of 30,000 characters and was summarised although the question needed every row, so the numbers were wrong. Fix: MCP results and snapshot reads are never cut without the decider (see above). **After the fix: 9/9 correct**, tokens equal to no plugin (147k, `eval/web_snapshot_v3.jsonl`). So sieve keeps these pages whole when the question needs them and saves nothing here; it would cut only for an overview question.

### context-mode on this machine

The installed context-mode 1.0.169 (the latest release) did not start cleanly: its dependency install, `npm install better-sqlite3` inside the plugin folder, aborts with an npm-internal error (`Cannot read properties of null (reading 'edgesOut')`) because of the plugin's `package.json` (`devDependencies` / `packageManager`). Nothing is ever installed, so every session retries (about 70-130 s of start-up). Installing the production dependencies with a trimmed `package.json` fixes it (10 s, then 6-7 s start-up). The first benchmark run measured the broken state; those runs are kept apart in `eval/bench_v2_context-mode-broken-install.jsonl`.

## Status

Tested in live `claude -p --plugin-dir .` sessions and the benchmarks above. Missing against context-mode: project-boundary path checks. The compaction resume note is unit-tested but not exercised live.

Its MCP server also checks for updates at start by fetching `https://registry.npmjs.org/context-mode/latest` directly (hard-coded, so it ignores `.npmrc` and any proxy). Behind a proxy that shows up as a blocked or unexpected npm request each time a context-mode instance starts. `eval/patch_context_mode_registry.py REGISTRY_URL PLUGIN_DIR` points the check at your registry (it reads `dist-tags.latest` from the package page, since many proxies do not serve `/latest`).
