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
- The tool prefix is `mcp__sieve__`; renaming the plugin renames every tool.
- A capture or snapshot failure must never break a tool call: wrap in try/catch and carry on.
- The decider is optional (`SIEVE_DECIDER=0` turns it off). Every use has a rule-based fallback and a measured threshold (see README); re-run `eval/*.py` before changing a question or a threshold.
- Results are rewritten, never refused. Never cut code or config on size alone: that cost extra turns in the benchmark.
- The decider is one shared LaunchAgent (`launchd/`); the mod never starts it. Do not run `strands-decider` per call (it loads a 2B model).
- The mod API is early access and moves; the declaration file written by the skill is the authority.
