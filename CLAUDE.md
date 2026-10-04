# sieve

Claude Code mod (function hooks, not command hooks). Replaces `context-mode`; see README.md.

## Layout
- `.claude-plugin/plugin.json`: manifest. `hooks/hooks.json`: names the one module `./register.ts`.
- `hooks/register.ts`: all hooks and anything that takes `$`.
- `hooks/lib.ts`: pure functions, no `$`; `hooks/lib.test.ts` tests them.

## Rules
- Run `claude plugin validate .` and `claude plugin test .` after every change to hooks.
- `$` goes only to top-level function declarations, never into closures inside `register`: the validator rejects it. Module state lives in the top-level object `S`.
- `on('tool.call', { tool })` matchers are string literals (a computed matcher validates as `tool=?`).
- The only tool is `mcp__sieve__search`; the prefix is `mcp__sieve__`, so renaming the plugin renames it. There is no `execute` tool (never called in any test).
- A capture or snapshot failure must never break a tool call: wrap in try/catch and carry on.
- The decider is optional (`SIEVE_DECIDER=0` turns it off). Every use has a rule-based fallback and a measured threshold (see README); re-run `eval/*.py` before changing a question or a threshold.
- Results are rewritten, never refused. Never cut code or config on size alone: that cost extra turns in the benchmark.
- The decider is one shared LaunchAgent (`launchd/`); the mod never starts it. Do not run `strands-decider` per call (it loads a 2B model).
- The mod API is early access and moves; the declaration file written by the skill is the authority.
- Results are cut for Bash, Grep, Glob, WebFetch, any MCP result made only of text blocks, and Playwright snapshot files read back with `Read` (`/.playwright-mcp/`). Other `Read`s are cut only above 80000 chars: code must stay whole.
- A repeated call within two calls of a cut gets the whole output (the repeat is the signal that the cut was wrong).
- The full output goes to `~/.claude/projects/<slug>/<session>/tool-results/sieve-*.txt`, the harness's own folder, because the model can read there with narrow permissions (tested with `Bash(grep:*)` only). Do not move it to a folder outside the project's allowed paths without repeating that test.
- The index is one SQLite file per project (`~/.claude/sieve/<slug>.db`); rows and files older than 14 days are deleted at session start.
- The guide (`GUIDE` in register.ts) carries most of the measured gain in a normal session; any change to it needs the repo benchmark (`eval/repobench.py`) run side by side with no plugin. Keep it fixed text: it sits in the cached part of the prompt.
- A failed Bash result arrives as a string; a hook must answer with the Bash object shape (`{ stdout, stderr, interrupted }`).
- Benchmark copies live in `~/dev/sieve-bench-runs`, not under a hidden folder: Claude Code asks before editing files in hidden folders, which a headless run treats as a refusal.
- Never change effort, thinking settings, tool definitions or earlier messages in the middle of a session: each invalidates the prompt cache (Anthropic docs, "What invalidates the cache"). Decide such things once, before the first request, and keep them.
- Every decider job has a prompt set in `eval/` with a hold-out part; a new job or a reworded question needs one before it ships, and the threshold is chosen so the unsafe error (cutting what is needed, calling a follow-up new, calling a hard request simple) does not occur on either part.
