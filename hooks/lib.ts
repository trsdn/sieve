export const RESULT_LIMIT = 6000
export const AUTO_INDEX_LIMIT = 12000

export const sqlQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`

export const ftsQuery = (q: string, join: 'AND' | 'OR' = 'OR'): string =>
  (q.match(/[\p{L}\p{N}_]{2,}/gu) ?? []).map(t => `"${t}"`).join(` ${join} `)

export type Chunk = { title: string; body: string }

export const chunkText = (text: string, fallbackTitle: string, max = 1800): Chunk[] => {
  const chunks: Chunk[] = []
  let title = fallbackTitle
  let buf: string[] = []
  let size = 0
  const flush = () => {
    const body = buf.join('\n').trim()
    if (body) chunks.push({ title, body })
    buf = []
    size = 0
  }
  for (const line of text.split('\n')) {
    const heading = /^#{1,4}\s+(.*)/.exec(line)
    if (heading) {
      flush()
      title = heading[1]!.slice(0, 120)
    }
    buf.push(line)
    size += line.length + 1
    if (size >= max) flush()
  }
  flush()
  return chunks
}

export const headTail = (text: string, limit = RESULT_LIMIT): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit / 2)}\n… [${text.length - limit} chars omitted] …\n${text.slice(-limit / 2)}`

export const interpreter = (language: string, code: string): string[] | undefined => {
  switch (language) {
    case 'shell':
    case 'bash':
    case 'sh':
      return ['/bin/sh', '-c', code]
    case 'python':
      return ['python3', '-c', code]
    case 'javascript':
    case 'js':
      return ['node', '-e', code]
    default:
      return undefined
  }
}

// Commands whose output is large by nature, so no model call is needed to say so.
const BULKY =
  /^\s*(git\s+(log|diff|show)(?!.*(-n\s*\d|--stat|--oneline.*-\d|-\d+\b))|find\s|ls\s+-\w*R|tree\b|docker\s+logs|kubectl\s+(logs|get\s+.*-o\s*(yaml|json))|npm\s+(ls|list)\b|pip\s+freeze|cat\s+\S+\.(log|json|csv|lock))/
const HAS_LIMIT = /\|\s*(head|tail|wc|grep|rg|jq|awk|sed|sort\s.*\|\s*head)\b|>\s*\S+|--max-count|-n\s*\d+/

export const isBulkyCommand = (command: string): boolean =>
  BULKY.test(command) && !HAS_LIMIT.test(command)

export const isRawFetch = (command: string): boolean =>
  /^\s*(curl|wget)\b/.test(command) && !/(\s-o\s|\s-O\b|--output|>\s*\S+|\|\s*(head|jq|grep|wc))/.test(command)

export type SessionEvent = { kind: string; data: string }

// A resume note small enough to ride in the system prompt after a compaction.
export const buildSnapshot = (events: SessionEvent[], compactCount: number, max = 2000): string => {
  const of = (kind: string) => events.filter(e => e.kind === kind).map(e => e.data)
  const last = (xs: string[], n: number) => [...new Set(xs)].slice(-n)
  const lines = [
    `<resume compactions="${compactCount}">`,
    ...last(of('prompt'), 4).map(p => `  <ask>${p}</ask>`),
    ...last(of('file'), 15).map(f => `  <edited>${f}</edited>`),
    ...last(of('error'), 4).map(c => `  <failed>${c}</failed>`),
    ...last(of('command'), 5).map(c => `  <ran>${c}</ran>`),
    ...last(of('cut'), 8).map(c => `  <indexed>${c}</indexed>`),
    '</resume>',
  ]
  let out = lines.join('\n')
  while (out.length > max && lines.length > 2) {
    lines.splice(1, 1)
    out = lines.join('\n')
  }
  return out
}

// Lines in a cut-out middle that must survive: failures are what the model reads logs for.
const SIGNAL = /\b(error|fail(ed|ure|ing)?|fatal|panic|exception|traceback|warn(ing)?|denied|refused|timeout|not found|cannot|unable)\b/i

export type CompactOptions = { head: number; tail: number; signal: number }

export const compactText = (text: string, { head, tail, signal }: CompactOptions): string => {
  if (text.length <= head + tail) return text
  const lines = text.split('\n')
  let start = 0
  let used = 0
  while (start < lines.length && used + lines[start]!.length < head) used += lines[start++]!.length + 1
  let end = lines.length
  used = 0
  while (end > start && used + lines[end - 1]!.length < tail) {
    end -= 1
    used += lines[end]!.length + 1
  }
  const middle = lines.slice(start, end)
  const hits = middle.filter(l => SIGNAL.test(l)).slice(0, signal).map(l => l.slice(0, 200))
  const note = `… [${middle.length} lines / ${middle.join('\n').length} chars omitted${hits.length ? `; ${hits.length} signal line(s) kept below` : ''}] …`
  return [...lines.slice(0, start), note, ...hits, ...(hits.length ? ['…'] : []), ...lines.slice(end)].join('\n')
}

// Characters a result may carry before it is cut (`soft`), and above which it is cut without
// asking the decider (`hard`). Glob counts paths, not characters.
export const LIMITS: Record<string, { soft: number; hard: number }> = {
  Bash: { soft: 4000, hard: 30000 },
  Grep: { soft: 4000, hard: 30000 },
  WebFetch: { soft: 3000, hard: 12000 },
  Glob: { soft: 150, hard: 300 },
  Read: { soft: 80000, hard: 80000 },
  // Any MCP result made of text, and a Playwright snapshot file read back: data, not code.
  // No blind cut here: the decider always weighs the request first (a blind cut at 30000 gave wrong answers in the browser test).
  mcp: { soft: 4000, hard: 1000000 },
  ReadSnapshot: { soft: 4000, hard: 1000000 },
}

export type Verdict = 'pass' | 'ask' | 'compact'

// Pure size rule; the decider only ever sees the `ask` band.
export const judgeSize = (tool: string, size: number, isError: boolean, factor = 1): Verdict => {
  const limit = LIMITS[tool]
  if (!limit) return 'pass'
  const soft = limit.soft * factor
  const hard = limit.hard * factor
  if (size <= soft) return 'pass'
  if (size > hard) return 'compact'
  return isError ? 'pass' : 'ask'
}

// ---- structure-aware summaries -------------------------------------------------------------

// A line with its variable parts blanked: "GET /items/17 200 12ms" and "GET /items/9 200 7ms" share one.
export const template = (line: string): string =>
  line
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .slice(0, 120)

// Coarser still: every word is "w", so "numpy 2.1.0" and "torch 2.14.0" are one shape. Lists of
// names (a directory, installed packages) repeat at this level though no two lines are alike.
const coarse = (line: string): string =>
  line.replace(/[A-Za-z_][\w.-]*/g, 'w').replace(/\d+/g, '#').replace(/\s+/g, ' ').replace(/(w[ ./-]?)+/g, 'W').slice(0, 60)

export type Shape = { lines: number; distinct: number; top3: number; coarseTop3: number }

export const lineShape = (text: string): Shape => {
  const counts = new Map<string, number>()
  const rough = new Map<string, number>()
  const lines = text.split('\n').filter(l => l.trim())
  for (const l of lines) {
    counts.set(template(l), (counts.get(template(l)) ?? 0) + 1)
    rough.set(coarse(l), (rough.get(coarse(l)) ?? 0) + 1)
  }
  const share = (m: Map<string, number>) => ([...m.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0) / Math.max(lines.length, 1))
  return { lines: lines.length, distinct: counts.size, top3: share(counts), coarseTop3: share(rough) }
}

// Many lines built from a few shapes: a listing, a log, progress output. Code and prose are not.
export const isRepetitive = (text: string): boolean => {
  const s = lineShape(text)
  return s.lines >= 30 && (s.distinct / s.lines <= 0.3 || s.top3 >= 0.6 || s.coarseTop3 >= 0.9)
}

const SIGNAL_LINE = /\b(fail(ed|ure|ing)?|fatal|panic|exception|traceback|denied|refused|timed? ?out)\b|Error\b|error:/i

const clip = (l: string, n = 200) => (l.length > n ? `${l.slice(0, n)}…` : l)

const isPath = (l: string) => /^[\w@.~/-][^\s:]*\/[^\s:]*$/.test(l.trim())
const isGrepLine = (l: string) => /^[^\s:]+:\d+[:-]/.test(l)

export const kindOf = (tool: string, text: string): 'listing' | 'grep' | 'lines' => {
  const lines = text.split('\n').filter(l => l.trim())
  const share = (f: (l: string) => boolean) => lines.filter(f).length / Math.max(lines.length, 1)
  if (tool === 'Glob' || share(isPath) >= 0.8) return 'listing'
  if (tool === 'Grep' || share(isGrepLine) >= 0.8) return 'grep'
  return 'lines'
}

const top = <T>(m: Map<T, number>, n: number): [T, number][] => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)

const treeSummary = (text: string): string => {
  const paths = text.split('\n').filter(l => l.trim())
  const ext = new Map<string, number>()
  for (const p of paths) {
    const m = /\.([A-Za-z0-9]+)$/.exec(p)
    ext.set(m ? `.${m[1]}` : '(none)', (ext.get(m ? `.${m[1]}` : '(none)') ?? 0) + 1)
  }
  // The deepest directory level that still gives at most 40 groups.
  let groups = new Map<string, number>()
  for (let depth = 1; depth <= 12; depth++) {
    const g = new Map<string, number>()
    for (const p of paths) {
      const dir = p.split('/').slice(0, depth).join('/')
      g.set(dir, (g.get(dir) ?? 0) + 1)
    }
    if (g.size > 40 && depth > 1) break
    groups = g
  }
  return [
    `${paths.length} paths. By extension: ${top(ext, 10).map(([e, n]) => `${e} ${n}`).join(', ')}`,
    'By directory:',
    ...[...groups.entries()].map(([d, n]) => `  ${d}  ${n}`),
    `first: ${paths[0]}`,
    `last: ${paths[paths.length - 1]}`,
  ].join('\n')
}

const grepSummary = (text: string): string => {
  const files = new Map<string, number>()
  const first = new Map<string, string>()
  for (const l of text.split('\n')) {
    const m = /^([^\s:]+):\d+[:-]/.exec(l)
    if (!m) continue
    files.set(m[1]!, (files.get(m[1]!) ?? 0) + 1)
    if (!first.has(m[1]!)) first.set(m[1]!, clip(l, 160))
  }
  const total = [...files.values()].reduce((a, b) => a + b, 0)
  return [
    `${total} matches in ${files.size} files. Per file (most first), with its first hit:`,
    ...top(files, 30).map(([f, n]) => `  ${n}×  ${first.get(f)}`),
  ].join('\n')
}

// Frequent shapes as a table; shapes seen once or twice, and failure lines, verbatim.
const linesSummary = (text: string, rareCap = 25): string => {
  const lines = text.split('\n')
  const counts = new Map<string, number>()
  const example = new Map<string, string>()
  for (const l of lines) {
    if (!l.trim()) continue
    const t = template(l)
    counts.set(t, (counts.get(t) ?? 0) + 1)
    if (!example.has(t)) example.set(t, clip(l, 140))
  }
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (!l.trim()) return
    if (i < 4 || i >= lines.length - 4) keep.add(i)
    else if (counts.get(template(l))! <= 2 || SIGNAL_LINE.test(l)) keep.add(i)
  })
  const kept = [...keep].sort((a, b) => a - b)
  const picked = kept.length > rareCap + 8 ? [...kept.slice(0, 4), ...kept.slice(4, -4).slice(0, rareCap), ...kept.slice(-4)] : kept
  return [
    `${lines.filter(l => l.trim()).length} lines, ${counts.size} distinct shapes. Most frequent:`,
    ...top(counts, 10).map(([t, n]) => `  ${n}×  ${example.get(t)}`),
    `Rare and failure lines, in order (${picked.length} of ${kept.length}):`,
    ...picked.map(i => `  ${clip(lines[i]!)}`),
  ].join('\n')
}

export const summarize = (tool: string, text: string): string => {
  const kind = kindOf(tool, text)
  return kind === 'listing' ? treeSummary(text) : kind === 'grep' ? grepSummary(text) : linesSummary(text)
}

// ---- command-specific filters (the RTK idea, inside the mod) --------------------------------

// "cd x && git log --stat -n 5" -> "git log": what a learned rule or a filter is keyed on.
export const signature = (command: string): string => {
  const last = command.split(/&&|;|\|\|/).map(s => s.trim()).filter(Boolean).filter(s => !/^cd\s/.test(s))[0] ?? ''
  const words = last.replace(/^(sudo|time|env(\s+\w+=\S+)+)\s+/, '').split(/\s+/)
  const tool = (words[0] ?? '').split('/').pop() ?? ''
  const sub = words.slice(1).find(w => !w.startsWith('-')) ?? ''
  const withSub = ['git', 'npm', 'pnpm', 'yarn', 'uv', 'pip', 'pip3', 'cargo', 'go', 'docker', 'kubectl', 'poetry', 'bun']
  if (/^python3?$/.test(tool) && words[1] === '-m') return `python -m ${words[2] ?? ''}`
  return withSub.includes(tool) && sub ? `${tool} ${sub}` : tool
}

const TEST_CMD = /^(pytest|py\.test|python -m (pytest|unittest)|jest|vitest|mocha|cargo test|go test|npm test|pnpm test|yarn test|bun test|npm run|pnpm run|yarn run|mvn|gradle|rspec|phpunit|tox|nox|make)$/
const PASS_LINE = /^\s*(PASS\b|✓|✔|ok\b|\.+$|test \S+ \.\.\. ok$|\S+\s+\.\.\.\s+ok$|.*\bPASSED\b|=== RUN\b|--- PASS\b)/
const FAIL_LINE = /\b(FAIL(ED)?|ERROR|Error|Exception|Traceback|panic|AssertionError|assert|✗|✕|×)\b|^\s*E\s{2,}/
const SKIP_LINE = /\b(skip(ped)?|xfail|xpass|expected failure|warn(ing)?|deprecat\w*)\b/i
const SUMMARY_LINE = /\b(\d+ (passed|failed|errors?|skipped|tests?|suites?)|Ran \d+ tests?|^OK\b|^FAILED\b|Tests?:|Test Suites:|test result:|Summary)\b/i

// Passing tests and progress dots go; failures keep their block, totals stay.
export const filterTests = (text: string): string => {
  const lines = text.split('\n')
  const keep: string[] = []
  let dropped = 0
  let block = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const passing = PASS_LINE.test(l) && !FAIL_LINE.test(l)
    if (FAIL_LINE.test(l) && !PASS_LINE.test(l)) block = 25
    // a passing line never belongs to a failure block, wherever it stands
    if (passing && !SUMMARY_LINE.test(l) && i < lines.length - 6) {
      dropped++
      continue
    }
    if (block > 0 || SUMMARY_LINE.test(l) || SKIP_LINE.test(l) || i >= lines.length - 6) {
      keep.push(l)
      block = l.trim() === '' && block < 20 ? 0 : block - 1
    } else if (PASS_LINE.test(l) || l.trim() === '') dropped++
    else if (i < 4) keep.push(l)
    else dropped++
  }
  return `${keep.join('\n')}\n[sieve: ${dropped} passing or progress lines left out]`
}

// One line per commit: hash, date, author, subject (and the stat line, if any).
export const filterGitLog = (text: string): string | undefined => {
  if (/^diff --git /m.test(text)) return undefined // a patch is code: never on size alone
  const out: string[] = []
  let cur: { h: string; a: string; d: string; s: string; st: string } | undefined
  const flush = () => cur && out.push(`${cur.h.slice(0, 9)} ${cur.d} ${cur.a}: ${cur.s}${cur.st ? `  (${cur.st})` : ''}`)
  for (const l of text.split('\n')) {
    const c = /^commit ([0-9a-f]{7,40})/.exec(l)
    if (c) { flush(); cur = { h: c[1]!, a: '', d: '', s: '', st: '' }; continue }
    if (!cur) continue
    const a = /^Author:\s+(.*?)\s*<.*>$/.exec(l) ?? /^Author:\s+(.*)$/.exec(l)
    if (a) cur.a = a[1]!.trim()
    else if (/^Date:\s+/.test(l)) cur.d = l.replace(/^Date:\s+/, '').trim().split(' ').slice(1, 5).join(' ')
    else if (!cur.s && /^\s{4}\S/.test(l)) cur.s = l.trim()
    else if (/\d+ files? changed/.test(l)) cur.st = l.trim()
  }
  flush()
  return out.length ? `${out.length} commits\n${out.join('\n')}` : undefined
}

// Installs and builds: warnings, errors and the closing summary; downloads and progress go.
export const filterNoise = (text: string): string => {
  const lines = text.split('\n')
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (/\b(warn(ing)?|error|ERR!|fail(ed)?|denied|not found|conflict|deprecated|vulnerab|added \d+|removed \d+|changed \d+|up to date|Successfully|Installed \d+|Resolved \d+|Finished|Compiled|built in|Done in)\b/i.test(l)) {
      for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k)
    }
    if (i < 3 || i >= lines.length - 8) keep.add(i)
  })
  const kept = [...keep].sort((a, b) => a - b).map(i => lines[i]!)
  return `${kept.join('\n')}\n[sieve: ${lines.length - kept.length} progress lines left out]`
}

// The filter for a command, if one is known and it actually shrinks the output.
export const filterCommand = (command: string, text: string): string | undefined => {
  const sig = signature(command)
  let out: string | undefined
  if (sig === 'git log') out = filterGitLog(text)
  else if (TEST_CMD.test(sig) && (sig !== 'make' && sig !== 'npm run' && sig !== 'pnpm run' && sig !== 'yarn run' || /\b(test|spec|check)\b/.test(command))) out = filterTests(text)
  else if (/^(npm|pnpm|yarn|bun) (install|i|add|ci|update)$|^(pip|pip3|uv|poetry) (install|add|sync|lock|update)$|^python -m pip$|^(make|tsc|webpack|vite|cargo build|go build|gradle|mvn|docker build)$/.test(sig) || /^(npm|pnpm|yarn) run$/.test(sig) && /\bbuild\b/.test(command)) out = filterNoise(text)
  // An unknown command whose output reads like a test run (many passing lines) gets the test filter.
  if (!out) {
    const lines = text.split('\n').filter(l => l.trim())
    if (lines.length >= 30 && lines.filter(l => PASS_LINE.test(l)).length / lines.length >= 0.5) out = filterTests(text)
  }
  return out && out.length < text.length * 0.7 ? out : undefined
}

// ---- project key ----------------------------------------------------------------------------

// "/a/b.c" and "/a/b-c" give the same slug; the folder name plus a hash of the whole path do not.
export const projectKey = (cwd: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < cwd.length; i++) h = Math.imul(h ^ cwd.charCodeAt(i), 0x01000193) >>> 0
  const base = (cwd.split('/').filter(Boolean).pop() ?? 'root').replace(/[^\w.-]/g, '_').slice(0, 40)
  return `${base}-${h.toString(16).padStart(8, '0')}`
}

// ---- JSON: schema, counts and outliers instead of lines --------------------------------------

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

const show = (v: unknown, n = 160): string => clip(JSON.stringify(v), n)

// An array of objects as a table: fields with type and presence, value counts for fields with few
// values, ranges for numbers, a few rows from the start and the rows that stand out.
const describeRows = (rows: Record<string, unknown>[], label: string): string => {
  const fields = new Map<string, { types: Set<string>; n: number; values: Map<string, number>; min: number; max: number }>()
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      let f = fields.get(k)
      if (!f) fields.set(k, (f = { types: new Set(), n: 0, values: new Map(), min: Infinity, max: -Infinity }))
      f.types.add(typeOf(v))
      f.n += 1
      if (typeof v === 'number') {
        f.min = Math.min(f.min, v)
        f.max = Math.max(f.max, v)
      }
      if (typeof v === 'string' || typeof v === 'boolean' || v === null) {
        const key = String(v).slice(0, 60)
        if (f.values.size <= 30 || f.values.has(key)) f.values.set(key, (f.values.get(key) ?? 0) + 1)
      }
    }
  }
  const lines = [`${label}: ${rows.length} objects, ${fields.size} fields`]
  // A field's rare values mark the rows worth showing (status "failed" among thousands of "ok").
  const rare: [string, string][] = []
  for (const [k, f] of [...fields.entries()].slice(0, 40)) {
    const presence = f.n < rows.length ? `, in ${f.n}` : ''
    const range = f.min <= f.max ? `, ${f.min}..${f.max}` : ''
    lines.push(`  ${k}: ${[...f.types].join('|')}${presence}${range}`)
    if (f.values.size >= 2 && f.values.size <= 12) {
      const counts = top(f.values, 12)
      lines.push(`    ${counts.map(([v, n]) => `${v} ${n}`).join(', ')}`)
      for (const [v, n] of counts) if (n <= Math.max(1, rows.length * 0.05)) rare.push([k, v])
    }
  }
  lines.push('first rows:', ...rows.slice(0, 3).map(r => `  ${show(r)}`))
  const odd = rows.filter((r, i) => i >= 3 && rare.some(([k, v]) => String(r[k]).slice(0, 60) === v)).slice(0, 5)
  if (odd.length) lines.push('rows with rare values:', ...odd.map(r => `  ${show(r)}`))
  return lines.join('\n')
}

const isRowArray = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length > 0 && v.every(x => typeOf(x) === 'object')

// A summary of a JSON document, or undefined when the text is not JSON (or is small and flat).
export const summarizeJson = (text: string): string | undefined => {
  const t = text.trim()
  if (!/^[[{]/.test(t)) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(t)
  } catch {
    return undefined
  }
  if (isRowArray(doc)) return describeRows(doc, 'JSON array')
  if (Array.isArray(doc)) return `JSON array: ${doc.length} items of ${[...new Set(doc.map(typeOf))].join('|')}\nfirst: ${show(doc.slice(0, 5), 400)}\nlast: ${show(doc.slice(-3), 300)}`
  if (typeOf(doc) !== 'object') return undefined
  // An object: its keys, and the largest array of objects in it as a table (a list response's "items").
  const obj = doc as Record<string, unknown>
  const keys = Object.entries(obj).map(([k, v]) => `  ${k}: ${Array.isArray(v) ? `array(${v.length})` : typeOf(v) === 'object' ? `object(${Object.keys(v as object).length} keys)` : show(v, 80)}`)
  const arrays = Object.entries(obj).filter(([, v]) => isRowArray(v)).sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length)
  const head = `JSON object, ${keys.length} keys:\n${keys.slice(0, 40).join('\n')}`
  return arrays.length ? `${head}\n${describeRows(arrays[0]![1] as Record<string, unknown>[], `.${arrays[0]![0]}`)}` : head
}
