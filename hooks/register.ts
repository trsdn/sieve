import type { Register } from 'claude-code'
import {
  LIMITS,
  RESULT_LIMIT,
  buildSnapshot,
  chunkText,
  compactText,
  ftsQuery,
  headTail,
  interpreter,
  judgeSize,
  sqlQuote,
} from './lib'

const PORT = 8765
const DECIDER = `http://127.0.0.1:${PORT}/v1/systemone`
// Decider confidence needed before it may cut a mid-sized result / reshape the cut for a task.
const VERBOSE_AT = 0.8
const TASK_AT = 0.6
const SEARCH = 'mcp__sieve__search'

const text = (t: string) => ({ result: [{ type: 'text', text: t }] })

const TASKS = {
  explore: 'reading or searching code to understand it',
  debug: 'investigating an error, failing test or log output',
  implement: 'writing or changing code',
  review: 'reviewing a diff, a PR or existing work',
  question: 'a short question that needs an answer, not tool work',
}

// How much of a result the current task tolerates: exploring wants less, debugging more.
const FACTOR: Record<string, number> = { explore: 0.6, debug: 1.5 }

const S = {
  checkedAt: 0,
  inner: false,
  useDecider: true,
  session: '',
  db: '',
  deciderReady: false,
  factor: 1,
  seen: 0,
  kept: 0,
  compacted: 0,
  asked: 0,
  askedYes: 0,
  indexed: 0,
}

async function sql($: any, script: string) {
  const ran = await $.process.run(['sqlite3', S.db], { stdin: script, timeoutMs: 60000 })
  if (ran.exitCode !== 0) throw new Error(`sqlite3: ${ran.stderr.trim()}`)
  return ran.stdout as string
}

async function record($: any, kind: string, data: string) {
  if (!S.session || !data) return
  const ts = await $.clock.now()
  await sql($, `insert into events values (${sqlQuote(S.session)}, ${ts}, ${sqlQuote(kind)}, ${sqlQuote(data.slice(0, 300))});`)
}

async function snapshot($: any): Promise<string> {
  const raw = await sql($, `.mode json\nselect kind, data from events where session = ${sqlQuote(S.session)} order by ts;`)
  const events = raw.trim() ? JSON.parse(raw) : []
  const compactions = await sql($, `select count from resume where session = ${sqlQuote(S.session)};`)
  return events.length ? buildSnapshot(events, Number(compactions.trim() || 0) + 1) : ''
}

async function permitted($: any, tool: string, input: Record<string, unknown>): Promise<string | undefined> {
  const { decision } = await $.tool.check({ tool, input })
  return decision === 'allow' ? undefined : `sieve: ${tool} ${decision === 'deny' ? 'is denied by your permission rules' : 'needs your approval; run it through the normal tool'}.`
}

// Runs a command in the sandbox when the rules allow it outright. When they would ask, the
// real Bash tool carries the call so the person sees the dialog; the output is still ours.
async function exec($: any, command: string, argv: string[], timeoutMs: number): Promise<{ output: string; exit: string } | { denied: string }> {
  const { decision } = await $.tool.check({ tool: 'Bash', input: { command } })
  if (decision === 'deny') return { denied: 'sieve: denied by your permission rules.' }
  if (decision === 'allow') {
    const ran = await $.process.run(argv, { timeoutMs })
    return { output: `${ran.stdout}${ran.stderr ? `\n[stderr]\n${ran.stderr}` : ''}`.trim(), exit: String(ran.exitCode) }
  }
  S.inner = true
  try {
    const r = await $.tool.call({ tool: 'Bash', command, timeout: timeoutMs })
    return r.deny === undefined ? { output: String(r.text ?? '').trim(), exit: r.isError ? 'error' : '0' } : { denied: r.deny }
  } finally {
    S.inner = false
  }
}

async function index($: any, source: string, content: string): Promise<number> {
  const chunks = chunkText(content, source)
  const rows = chunks
    .map(c => `insert into chunks values (${sqlQuote(source)}, ${sqlQuote(c.title)}, ${sqlQuote(c.body)});`)
    .join('\n')
  await sql($, `begin;\ndelete from chunks where source = ${sqlQuote(source)};\n${rows}\ncommit;`)
  S.indexed += chunks.length
  return chunks.length
}

async function search($: any, queries: string[], limit = 3): Promise<string> {
  const out: string[] = []
  for (const q of queries) {
    if (!ftsQuery(q)) continue
    let rows: { source: string; title: string; hit: string }[] = []
    // All terms first; any term only when nothing holds them all together.
    for (const join of ['AND', 'OR'] as const) {
      const raw = await sql(
        $,
        `.mode json\nselect source, title, snippet(chunks, 2, '[', ']', '…', 40) as hit from chunks where chunks match ${sqlQuote(ftsQuery(q, join))} order by bm25(chunks) limit ${limit};`,
      )
      rows = raw.trim() ? JSON.parse(raw) : []
      if (rows.length) break
    }
    out.push(
      `## ${q}\n` +
        (rows.map(r => `- ${r.source} › ${r.title}\n  ${r.hit.replaceAll('\n', ' ')}`).join('\n') || '(no matches)'),
    )
  }
  return out.join('\n\n')
}

async function deciderUp($: any): Promise<boolean> {
  if (!S.useDecider) return false
  const now = await $.clock.now()
  if (S.deciderReady || now - S.checkedAt < 30000) return S.deciderReady
  S.checkedAt = now
  try {
    S.deciderReady = (await $.http.fetch(`http://127.0.0.1:${PORT}/docs`)).ok
  } catch {
    S.deciderReady = false
  }
  return S.deciderReady
}

async function ask($: any, state: string, questions: Record<string, unknown>) {
  if (!(await deciderUp($))) return undefined
  try {
    const res = await $.http.fetch(DECIDER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions }),
    })
    return res.ok ? (JSON.parse(res.text).answers as Record<string, any>) : undefined
  } catch {
    S.deciderReady = false
    return undefined
  }
}

async function run($: any, language: string, code: string, timeoutMs: number, label: string) {
  const argv = interpreter(language, code)
  if (!argv) return `unsupported language: ${language} (shell, python, javascript)`
  const command = argv[0] === '/bin/sh' ? code : `${argv[0]} ${argv[1]} ${JSON.stringify(code)}`
  const ran = await exec($, command, argv, timeoutMs)
  if ('denied' in ran) return ran.denied
  const { output, exit } = ran
  if (output.length <= RESULT_LIMIT) return `${output || '(no output)'}\n[exit ${exit}]`
  S.kept += output.length - RESULT_LIMIT
  const chunks = await index($, label, output)
  return `${headTail(output)}\n[exit ${exit}] full output indexed as "${label}" (${chunks} chunks); use search to query it.`
}

// What a result carries as text, and the same result with that text replaced.
function textOf(tool: string, r: any): string | undefined {
  switch (tool) {
    case 'Bash': return r.stdout
    case 'Grep': return r.content
    case 'WebFetch': return r.result
    case 'Read': return r.file?.content
    case 'Glob': return Array.isArray(r.filenames) ? r.filenames.join('\n') : undefined
    default: return undefined
  }
}

function withText(tool: string, r: any, t: string): any {
  switch (tool) {
    case 'Bash': return { ...r, stdout: t, persistedOutputPath: undefined, persistedOutputSize: undefined }
    case 'Grep': return { ...r, content: t }
    case 'WebFetch': return { ...r, result: t }
    case 'Read': return { ...r, file: { ...r.file, content: t } }
    default: return { ...r, filenames: t.split('\n'), truncated: true }
  }
}

function describe(e: any): string {
  return String(e.command ?? e.pattern ?? e.url ?? e.file_path ?? e.tool)
}

// The decider's one job on a result: is this mostly repetition a short excerpt can stand for?
async function isVerbose($: any, e: any, full: string): Promise<boolean> {
  const answers = await ask($, `${e.tool}: ${describe(e)}\n---\n${full.slice(0, 1500)}\n…\n${full.slice(-500)}`, {
    verbose: {
      type: 'noul',
      instructions: 'Is this tool output mostly repetitive or low-value (logs, listings, progress, dependency trees), so that a short excerpt would be enough?',
      criteria: {
        true: 'long listings, logs, repeated lines, dependency trees, generated or minified data',
        false: 'code, configuration, a single error with its cause, or an answer the reader needs in full',
      },
    },
  })
  const p = answers?.verbose?.noul
  if (typeof p !== 'number') return false
  S.asked += 1
  if (p >= VERBOSE_AT) S.askedYes += 1
  return p >= VERBOSE_AT
}

// Cuts a large built-in result in place: the model gets head, tail and the failure lines, the
// whole output goes into the index. Undefined means leave the result as it is.
async function compact($: any, e: any, ran: any): Promise<any | undefined> {
  const r = ran.result
  if (ran.deny !== undefined || !r || !LIMITS[e.tool]) return undefined
  let full = textOf(e.tool, r)
  if (typeof full !== 'string') return undefined
  // Bash keeps a long output in a file and hands back a preview: index the file, not the preview.
  if (r.persistedOutputPath) {
    try {
      full = await $.fs.read(r.persistedOutputPath)
    } catch {
      // over 4 MiB or gone: the preview is what there is
    }
  }
  const size = e.tool === 'Glob' ? r.filenames.length : full.length
  let verdict = judgeSize(e.tool, size, ran.isError === true, S.factor)
  if (verdict === 'ask') verdict = (await isVerbose($, e, full)) ? 'compact' : 'pass'
  if (verdict !== 'compact') return undefined

  const source = `${e.tool}:${(await $.clock.now()).toString(36)}${++S.seen}`
  const note = `[sieve: ${full.length} chars cut; the whole output is indexed as "${source}", query it with ${SEARCH}]`
  const short =
    e.tool === 'Glob'
      ? [...full.split('\n').slice(0, 100), `… ${size - 100} more paths omitted. ${note}`].join('\n')
      : `${compactText(full, { head: 1800, tail: 1200, signal: 15 })}\n${note}`
  await index($, source, full)
  S.kept += full.length - short.length
  S.compacted += 1
  return { result: withText(e.tool, r, short) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    S.useDecider = (await $.env.get('SIEVE_DECIDER')) !== '0'
    const dir = `${home}/.claude/sieve`
    S.db = `${dir}/index.db`
    S.session = await $.session.id()
    await $.process.run(['mkdir', '-p', dir])
    await sql(
      $,
      `create virtual table if not exists chunks using fts5(source, title, body, tokenize='porter unicode61');\ncreate table if not exists events (session text, ts integer, kind text, data text);\ncreate table if not exists resume (session text primary key, snapshot text, count integer);`,
    )

    await $.tool.register({
      name: 'execute',
      description:
        'Run code (shell, python, javascript) in a sandbox and return only its printed output. Use it when you want an answer computed from data rather than the data itself.',
      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['shell', 'python', 'javascript'] },
          code: { type: 'string' },
          intent: { type: 'string', description: 'What you are looking for in a long output.' },
          timeout_ms: { type: 'number' },
        },
        required: ['language', 'code'],
      },
    })
    await $.tool.register({
      name: 'search',
      description: 'Search output that was cut from earlier results (BM25). Pass several related queries at once.',
      inputSchema: {
        type: 'object',
        properties: { queries: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } },
        required: ['queries'],
      },
    })
    await $.command.register({ name: 'sieve', description: 'sieve: what was kept out of the context' })
    void deciderUp($)
    return next(e)
  })

  on('command.run', { command: 'sieve' }, async $ => {
    const raw = await sql($, `.mode json\nselect count(*) as chunks, count(distinct source) as sources from chunks;`)
    const { chunks, sources } = JSON.parse(raw)[0]
    return {
      text: `sieve: ${S.compacted} results cut this session, ~${Math.round(S.kept / 1000)}k chars kept out of context; ${chunks} chunks from ${sources} sources indexed; decider ${S.deciderReady ? `ready, asked ${S.asked}x, said cut ${S.askedYes}x` : 'off'}.`,
    }
  })

  on('tool.call', { tool: 'mcp__sieve__execute' }, async ($, e: any) => {
    const label = `execute:${e.language}:${(await $.clock.now()).toString(36)}`
    let out = await run($, e.language, e.code, e.timeout_ms ?? 30000, label)
    if (e.intent && out.includes('full output indexed')) out += `\n\n${await search($, [e.intent])}`
    return text(out)
  })

  on('tool.call', { tool: 'mcp__sieve__search' }, async ($, e: any) => text(await search($, e.queries, e.limit ?? 3)))

  // Every built-in result passes here: recorded for the resume note, cut when it is large.
  on('tool.call', async ($, e: any, next) => {
    const ran = await next(e)
    if (S.inner || e.tool.startsWith('mcp__sieve__')) return ran
    try {
      if (['Edit', 'Write', 'NotebookEdit'].includes(e.tool) && ran.deny === undefined) await record($, 'file', e.file_path ?? e.notebook_path)
      else if (e.tool === 'Bash' && ran.deny === undefined) await record($, ran.isError ? 'error' : 'command', e.command)
      return (await compact($, e, ran)) ?? ran
    } catch {
      return ran
    }
  })

  on('session.compact', async ($, e, next) => {
    try {
      const note = await snapshot($)
      if (note) {
        const n = await sql($, `select count from resume where session = ${sqlQuote(S.session)};`)
        await sql($, `insert or replace into resume values (${sqlQuote(S.session)}, ${sqlQuote(note)}, ${Number(n.trim() || 0) + 1});`)
      }
    } catch {
      // a failed snapshot only costs the resume note
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    try {
      const raw = await sql($, `.mode json\nselect snapshot from resume where session = ${sqlQuote(S.session)};`)
      const note = raw.trim() ? JSON.parse(raw)[0]?.snapshot : ''
      if (note) return { sections: [...composed.sections, { id: 'sieve:resume', text: `Before the last compaction, this session had:\n${note}`, scope: 'session' as const }] }
    } catch {
      // no note, no section
    }
    return composed
  })

  // The decider reads the prompt and sets how hard results are cut for this turn.
  on('prompt.submit', async ($, e, next) => {
    S.factor = 1
    await record($, 'prompt', e.text.slice(0, 200)).catch(() => {})
    const answers = await ask($, e.text.slice(0, 4000), {
      task: { type: 'choice', instructions: 'What kind of work does this request mainly ask for?', criteria: TASKS },
    })
    const task = answers?.task
    if (task && task.confidence >= TASK_AT && FACTOR[task.choice]) {
      S.factor = FACTOR[task.choice]!
      $.ui.status(`sieve: ${task.choice} ×${S.factor}`)
    } else {
      $.ui.status(undefined)
    }
    return next(e)
  })
}
