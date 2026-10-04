# sieve

A Claude Code mod that lets the useful part of tool output through and keeps the rest out of the context. It replaces the `context-mode` plugin and adds [strands-decider](https://github.com/strands-labs/strands-decider) for the calls a fixed rule cannot make.

## What it does

| Part | What |
| --- | --- |
| Tools | `mcp__sieve__execute`, `batch`, `index`, `fetch`, `search`. Code runs in a sandbox, output over 6000 chars is indexed (SQLite FTS5) and cut to head and tail. |
| Routing | `curl`/`wget` and `WebFetch` are refused in favour of `fetch`. Bash commands that will print a lot get a one-time nudge; output over 12000 chars is indexed afterwards. |
| Decider | One shared `strands-decider serve` (MLX, 127.0.0.1:8765, a LaunchAgent, see `launchd/`) judges "will this command print more than 200 lines?" and classifies each prompt (explore, debug, implement, review, question). Below 0.9 / 0.8 confidence the fixed rules decide alone. |
| Session | Edited files, commands, failures and prompts are recorded; before a compaction a resume note (max 2000 chars) is stored and added to the system prompt afterwards. |
| Permissions | `execute`, `batch` and `index` run only when your Bash/Read rules say `allow`. |
| Command | `/sieve` shows index size, chars kept out of context, decider status. |

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

Built-in results (Bash, Grep, Glob, WebFetch, Read) are rewritten in place after they ran. Nothing is refused and the model has nothing to learn.

- Up to 4000 chars (Glob: 150 paths) a result is left alone; above 30000 it is cut. In between:
  1. **A rule** (`isRepetitive`, no model) decides whether the output is repetitive: many lines of few shapes (digits and words blanked), such as a listing, a log or progress output. Code, config and prose are never cut on size alone.
  2. **The decider** reads the request next to the output and answers one question: does answering need every line (counting, exact lookup) or is a sample enough? Cut only on "a sample" at 0.7. No answer means keep whole.
- A cut result becomes a **summary of its structure**, not head and tail: a directory tree with counts by extension and folder, a per-file match table for Grep, or a table of line shapes with the rare and failure lines kept verbatim. The footer gives the path of the full output, so the model can `grep`/`wc` it in one call; the output is also indexed (`mcp__sieve__search`, BM25).
- Session capture and resume note: edited files, commands, failures, prompts and what was indexed are recorded; before a compaction a note (max 2000 chars) is stored and added to the system prompt after it.
- Measurement: `~/.claude/sieve/usage.jsonl` records tool and result size (no content) per call; `eval/usage_report.py` shows where the bytes of real sessions are. `/sieve` shows cuts, kept chars, and wrong cuts (the same call repeated within two calls of a cut).
- `SIEVE_DECIDER=0` turns the decider off; the rule and size limits still apply.

### What was measured, and what was not

| Evaluation | Result |
| --- | --- |
| `eval/rule_eval.mjs`: rule vs 36 real outputs | 35/36 right; the miss is a stack trace repeated three times |
| `eval/need_eval.py`: keep whole when the request needs every line, dev prompts | 30/30 at 0.7; cut when a sample is enough 24/30 |
| same, hold-out prompts not used to pick the threshold | 25/25 kept whole; cut only 11/25, so recall is lower than the dev set suggested |
| `eval/decider_eval.py`, `eval/task_eval.py` | earlier question designs; kept as the record of why "repetitive" became a rule and the prompt-class factor was dropped (unproven) |

Higher thresholds cut more but stopped keeping everything the request needs (0.8: 23/25 on hold-out), so 0.7 stays: a wrong cut costs a round trip, a missed cut only some bytes.

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
- Not measured: interactive sessions, sessions long enough to compact, other models, the approval path of `execute`, wrong cuts in real use (`/sieve` counts them).

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

The same nine questions, phrased naturally ("how many lines contain ERROR?"), results in `eval/long_free_results.jsonl`.

| Setup | Window after step 1 | after step 5 | after step 9 | Session cost | Right |
| --- | --- | --- | --- | --- | --- |
| no plugin | 18,476 | 20,577 | 21,974 | $0.127 | 9/9 |
| context-mode (repaired) | 21,854 | 32,066 | 40,696 | $0.221 | 9/9 |
| sieve | 18,602 | 20,706 | 22,032 | $0.125 | 9/9 |

- When it is free to choose, the model picks small commands (`grep -c`, `find | wc -l`); a session is about 10 built-in tool calls in all three setups, and **no plugin tool is called**, `ctx_*` included. So there is almost nothing for sieve to cut: it ends within 0.3% of no plugin and costs the same. This is the honest picture of what sieve does: it is insurance for large output, with a fixed cost of about zero, and no gain on sessions where the model never produces any.
- context-mode ends 85% above no plugin and costs 74% more. The window grows by about 2.3k tokens per step, which points to its hooks rather than to tool output: its SessionStart hook injects about 5,000 characters of instructions, and its PreToolUse hooks attach a guidance note to every tool call (observed in a stream trace; the per-step growth was not itemised). In this setting it does not change what the model does, and the notes stay in the window.
- Together with the first long test: context-mode only helped (not at all, in fact) where the tools are used; sieve helped where output is large and cost nothing where it is not.

Caveats: 2 repetitions per setup, one generated project, one model, one kind of task.

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
- sieve does not touch MCP results or reads under 80,000 characters, so it should equal no plugin here; it ran 18% above on tokens, driven by one question (`top-customer`) where the model took a different route in 3 runs. Read that as variance, not as an effect. It also means sieve gives no help for this case.

### context-mode on this machine

The installed context-mode 1.0.169 (the latest release) did not start cleanly: its dependency install, `npm install better-sqlite3` inside the plugin folder, aborts with an npm-internal error (`Cannot read properties of null (reading 'edgesOut')`) because of the plugin's `package.json` (`devDependencies` / `packageManager`). Nothing is ever installed, so every session retries (about 70-130 s of start-up). Installing the production dependencies with a trimmed `package.json` fixes it (10 s, then 6-7 s start-up). The first benchmark run measured the broken state; those runs are kept apart in `eval/bench_v2_context-mode-broken-install.jsonl`.

## Status

Tested in live `claude -p --plugin-dir .` sessions and the benchmarks above. Missing against context-mode: project-boundary path checks and per-project index separation. The compaction resume note is unit-tested but not exercised live.

Its MCP server also checks for updates at start by fetching `https://registry.npmjs.org/context-mode/latest` directly (hard-coded, so it ignores `.npmrc` and any proxy). Behind a proxy that shows up as a blocked or unexpected npm request each time a context-mode instance starts. `eval/patch_context_mode_registry.py REGISTRY_URL PLUGIN_DIR` points the check at your registry (it reads `dist-tags.latest` from the package page, since many proxies do not serve `/latest`).
