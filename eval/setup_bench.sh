#!/bin/sh
# Rebuilds everything the benchmarks read, from nothing, into .scratch/ (or $SCRATCH).
#
#   sh eval/setup_bench.sh                  fixtures, web pages, both repository templates, Playwright config
#   sh eval/setup_bench.sh --context-mode   also a working copy of context-mode 1.0.169 for the comparisons
#
# Pinned: more-itertools at the commit the README's runs used, context-mode at the commit its
# marketplace install had. Each repository template is checked to fail exactly as the README says.
# Set NPM_REGISTRY to point context-mode's update check at your own npm registry or proxy.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
S=${SCRATCH:-$here/../.scratch}
MORE_ITERTOOLS_SHA=1ea82a711c69f590054987b5cb194157f8ce8ac4
CONTEXT_MODE_SHA=5a92b7caaf0086d04b87cc03a82505c891aa8254
mkdir -p "$S"

echo "fixture and web pages"
python3 "$here/make_fixture.py" "$S/fixture" > "$S/fixture_expected.json"
python3 "$here/make_web.py" "$S/web" > "$S/web_expected.json"

echo "more-itertools at $MORE_ITERTOOLS_SHA"
[ -d "$S/realrepo-src/.git" ] || git clone -q https://github.com/more-itertools/more-itertools "$S/realrepo-src"
git -C "$S/realrepo-src" fetch -q origin "$MORE_ITERTOOLS_SHA" 2>/dev/null || true
git -C "$S/realrepo-src" checkout -q -B master "$MORE_ITERTOOLS_SHA"
git -C "$S/realrepo-src" reset -q --hard

# The easy bug, left uncommitted: ilen() counts pairs instead of items.
rm -rf "$S/realrepo-template" && cp -R "$S/realrepo-src" "$S/realrepo-template"
perl -pi -e 's/return sum\(compress\(repeat\(1\), zip\(iterable\)\)\)/return sum(compress(repeat(1), zip(iterable, iterable)))/' "$S/realrepo-template/more_itertools/more.py"

# The hard bug, committed so git diff does not show it: windowed() pads one value too many.
rm -rf "$S/realrepo-hard" && cp -R "$S/realrepo-src" "$S/realrepo-hard"
perl -pi -e 's/padding = \(fillvalue,\) \* \(n - 1 if step >= n else step - 1\)/padding = (fillvalue,) * (n - 1 if step >= n else step)/' "$S/realrepo-hard/more_itertools/more.py"
GIT_AUTHOR_DATE="2026-10-04T23:37:57+0200" GIT_COMMITTER_DATE="2026-10-04T23:37:57+0200" \
  git -C "$S/realrepo-hard" -c user.name=Dev -c user.email=dev@example.com commit -q -am "Tidy up windowed padding"

check() {
  got=$(cd "$S/$1" && python3 -m unittest discover -s tests 2>&1 | tail -1)
  if [ "$got" != "$2" ]; then echo "unexpected test result in $1: '$got' (expected '$2')"; exit 1; fi
  echo "  $1: $got"
}
check realrepo-template "FAILED (failures=26, skipped=5)"
check realrepo-hard "FAILED (failures=10, skipped=5)"

printf '%s\n' '{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--headless", "--isolated"] } } }' > "$S/playwright-mcp.json"

if [ "${1:-}" = "--context-mode" ]; then
  echo "context-mode at $CONTEXT_MODE_SHA"
  [ -d "$S/context-mode/.git" ] || git clone -q https://github.com/mksglu/context-mode "$S/context-mode"
  git -C "$S/context-mode" fetch -q origin "$CONTEXT_MODE_SHA" 2>/dev/null || true
  git -C "$S/context-mode" checkout -q "$CONTEXT_MODE_SHA"
  # Its own start-up install fails inside the plugin folder (npm: "Cannot read properties of null
  # (reading 'edgesOut')"), so install the runtime dependencies with a trimmed package.json.
  cp "$S/context-mode/package.json" "$S/context-mode/package.json.full"
  python3 - "$S/context-mode/package.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
for k in ("devDependencies", "packageManager", "scripts", "overrides", "workspaces"):
    p.pop(k, None)
json.dump(p, open(sys.argv[1], "w"), indent=1)
PY
  (cd "$S/context-mode" && npm install --no-package-lock --no-audit --no-fund --silent)
  mv "$S/context-mode/package.json.full" "$S/context-mode/package.json"
  (cd "$S/context-mode" && node -e "new (require('better-sqlite3'))(':memory:').close()") && echo "  better-sqlite3 loads"
  if [ -n "${NPM_REGISTRY:-}" ]; then python3 "$here/patch_context_mode_registry.py" "$NPM_REGISTRY" "$S/context-mode"; fi
fi
echo "done: $S"
