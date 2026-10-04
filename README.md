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

Built-in results (Bash, Grep, Glob, WebFetch, Read) are rewritten in place after they ran: the model sees head, tail and the failure lines of the middle, the whole output goes into a local FTS5 index, and `mcp__sieve__search` queries it. Nothing is refused and nothing needs to be learned.

- Up to 4000 chars (Glob: 150 paths) a result is left alone. Above 30000 it is cut. In between the decider decides, with the user's request in view:
  - *what is it*: repetitive (listing, log, progress) or distinct (code, config, a stack trace)? Cut only if repetitive, at 0.6.
  - *what does the request need*: every line (counting, exact lookup) or a sample? Keep whole if every line, at 0.7.
- The decider also classifies each prompt; exploring cuts harder (x0.6), debugging less (x1.5), at confidence 0.4.
- Thresholds come from `eval/decider_eval.py`, `eval/task_eval.py`, `eval/need_eval.py` (small hand-labelled sets, 24-36 samples each; tuned on the same data, so optimistic).

## Benchmark (`eval/bench.py`, `eval/report.py`)

13 tasks on a generated project (`eval/make_fixture.py`) with large logs, data, file trees, test output and git history; 4 setups; 3 repetitions each (156 headless runs, `claude -p`). Per-task medians, summed:

| Setup | Correct | Tokens | vs base | Cost | Turns |
| --- | --- | --- | --- | --- | --- |
| base (no plugin) | 100% | 611,936 | | $0.203 | 31 |
| context-mode | 100% | 677,773 | +10.8% | $0.518 | 30 |
| sieve, rules only | 100% | 594,406 | -2.9% | $0.162 | 30 |
| sieve, with decider | 97% | 582,568 | -4.8% | $0.169 | 30 |

Read with care:
- Each run carries about 37k tokens of fixed system prompt, so the percentages understate what happens to the variable part. Largest effects: `run-log` 57.9k -> 37.1k tokens (-36%), `tests` 66.2k -> 57.7k with the decider (rules only: no change).
- The one "wrong" run is a keyword check missing a correct answer (it said "package", the check wanted "pkg").
- Cost is noisy: prompt-cache hits depend on timing. Tokens and turns are steadier.
- context-mode pays its tool descriptions in every session (about +6k tokens) and its start-up was about 134 s per fresh `-p` session against 7 s; in a long interactive session that is paid once.
- Most tasks are solved by the model with a small command (`grep -c`), leaving nothing to cut. The decider helps only where a large output is unavoidable. Cutting a listing the task must count made the model need twice the turns until the request-aware check was added.
- Not measured: interactive sessions, long sessions with compaction, other models, and the approval path of `execute`.

## Status

Tested in live `claude -p --plugin-dir .` sessions and the benchmark above. Missing against context-mode: project-boundary path checks and per-project index separation; the compaction resume note is unit-tested but not exercised live.
