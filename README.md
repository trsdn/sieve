# sieve

A Claude Code mod that lets the useful part of tool output through and keeps the rest out of the context. It replaces the `context-mode` plugin and adds [strands-decider](https://github.com/strands-labs/strands-decider) for the calls a fixed rule cannot make.

## What it does

| Part | What |
| --- | --- |
| Tools | `mcp__sieve__execute`, `batch`, `index`, `fetch`, `search`. Code runs in a sandbox, output over 6000 chars is indexed (SQLite FTS5) and cut to head and tail. |
| Routing | `curl`/`wget` and `WebFetch` are refused in favour of `fetch`. Bash commands that will print a lot get a one-time nudge; output over 12000 chars is indexed afterwards. |
| Decider | A local `strands-decider serve` (MLX, port 8765) judges "will this command print more than 200 lines?" and classifies each prompt (explore, debug, implement, review, question). Below 0.9 / 0.8 confidence the fixed rules decide alone. |
| Session | Edited files, commands, failures and prompts are recorded; before a compaction a resume note (max 2000 chars) is stored and added to the system prompt afterwards. |
| Permissions | `execute`, `batch` and `index` run only when your Bash/Read rules say `allow`. |
| Command | `/sieve` shows index size, chars kept out of context, decider status. |

## Requirements

- Claude Code with function-hook mods (`plugin-authoring`), `sqlite3` with FTS5, `node`, `python3`
- `strands-decider` with the `mlx` extra at `~/.local/bin/strands-decider` (optional; without it only the rules route)

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

## Status

Tested in live `claude -p --plugin-dir .` sessions: `execute` (shell, python), `index`, `search`, `fetch` and `batch` work; the routing hooks (one-time nudge for bulky Bash, `curl`/`WebFetch` refusal) work; the mod starts and stops its own decider server (ready in about 9 s).

Known limits:
- The decider is conservative. On a handful of probes `find /` scored only 0.25 for "bulky" and most prompts classified below 0.8, so at the current thresholds the fixed rules do almost all of the routing. The thresholds are not tuned.
- `execute` returns head and tail up to 6000 chars, which saves little on small outputs.
- When a command needs approval, `execute` hands it to the real Bash tool; that path (the dialog) was not exercised headlessly.
- Missing against context-mode: project-boundary path checks, per-project index separation, compaction resume not exercised live.
