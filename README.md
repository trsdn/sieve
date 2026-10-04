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
- Not measured: interactive sessions, long sessions with compaction, other models, the approval path of `execute`, wrong cuts in real use (`/sieve` counts them).

### context-mode on this machine

The installed context-mode 1.0.169 (the latest release) did not start cleanly: its dependency install, `npm install better-sqlite3` inside the plugin folder, aborts with an npm-internal error (`Cannot read properties of null (reading 'edgesOut')`) because of the plugin's `package.json` (`devDependencies` / `packageManager`). Nothing is ever installed, so every session retries (about 70-130 s of start-up). Installing the production dependencies with a trimmed `package.json` fixes it (10 s, then 6-7 s start-up). The first benchmark run measured the broken state; those runs are kept apart in `eval/bench_v2_context-mode-broken-install.jsonl`.

## Status

Tested in live `claude -p --plugin-dir .` sessions and the benchmarks above. Missing against context-mode: project-boundary path checks and per-project index separation. The compaction resume note is unit-tested but not exercised live.
