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
