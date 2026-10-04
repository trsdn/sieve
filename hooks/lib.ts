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
