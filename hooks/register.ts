import type { Register } from 'claude-code'
import {
  LIMITS,
  isRepetitive,
  RESULT_LIMIT,
  buildSnapshot,
  chunkText,
  compactText,
  ftsQuery,
  headTail,
  interpreter,
  judgeSize,
  sqlQuote,
  summarize,
} from './lib'

const PORT = 8765
const DECIDER = `http://127.0.0.1:${PORT}/v1/systemone`
// Decider confidence needed before it may cut a mid-sized result / reshape the cut for a task.
// Above this, the request is read as needing every line, and the output stays whole.
const NEED_BELOW = 0.7
const SEARCH = 'mcp__sieve__search'

const text = (t: string) => ({ result: [{ type: 'text', text: t }] })

const S = {
  checkedAt: 0,
  inner: false,
  useDecider: true,
  session: '',
  db: '',
  deciderReady: false,
  dir: '',
  cuts: [] as { what: string; left: number }[],
  recut: 0,
  executed: 0,
  prompt: '',
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

// The decider's one job on a result: does the request need every line of it? The rule has
// already said the output is repetitive; code and prose never get here.
async function needsEveryLine($: any, e: any, full: string): Promise<boolean> {
  if (!S.prompt) return true
  const answers = await ask($, `Request: ${S.prompt}\n${e.tool}: ${describe(e)}\n---\n${full.slice(0, 1500)}\n…\n${full.slice(-500)}`, {
    need: {
      type: 'choice',
      instructions: 'To answer the request, how much of the output has to be read?',
      criteria: {
        'every line': 'the answer depends on counting, exact lookup or completeness over the whole output',
        'a sample': 'a general idea, a summary or a check for obvious problems is enough',
      },
    },
  })
  const p = answers?.need?.probabilities?.['every line']
  S.asked += 1
  // No answer means keep it whole: a wrong cut costs a round trip, a missed cut only some bytes.
  if (typeof p !== 'number' || p >= NEED_BELOW) return true
  S.askedYes += 1
  return false
}

async function logUsage($: any, line: Record<string, unknown>) {
  try {
    await $.process.run(['sh', '-c', 'cat >> "$0"', `${S.dir}/usage.jsonl`], { stdin: `${JSON.stringify({ t: await $.clock.now(), ...line })}\n` })
  } catch {
    // measurement must never get in the way
  }
}

// A cut that is followed within two calls by the same command or file read again was a wrong cut.
function watchRecut(e: any) {
  for (const c of S.cuts) {
    if (c.left <= 0) continue
    c.left -= 1
    if (describe(e) === c.what && c.left >= 0) S.recut += 1
  }
  S.cuts = S.cuts.filter(c => c.left > 0)
}

// Cuts a large built-in result in place: the model gets a summary of its structure, the whole
// output stays in a file and in the index. Undefined means leave the result as it is.
async function compact($: any, e: any, ran: any): Promise<any | undefined> {
  const r = ran.result
  if (ran.deny !== undefined || !r || !LIMITS[e.tool]) return undefined
  let full = textOf(e.tool, r)
  if (typeof full !== 'string') return undefined
  // Bash keeps a long output in a file and hands back a preview: use the file, not the preview.
  let path: string | undefined = r.persistedOutputPath
  if (path) {
    try {
      full = await $.fs.read(path)
    } catch {
      // over 4 MiB or gone: the preview is what there is
    }
  }
  const size = e.tool === 'Glob' ? r.filenames.length : full.length
  const verdict = judgeSize(e.tool, size, ran.isError === true, 1)
  const repetitive = e.tool === 'Glob' || isRepetitive(full)
  let cut = verdict === 'compact'
  if (verdict === 'ask' && repetitive) cut = !(await needsEveryLine($, e, full))
  await logUsage($, { tool: e.tool, size, verdict, repetitive, cut })
  if (!cut) return undefined

  const source = `${e.tool}:${(await $.clock.now()).toString(36)}${++S.seen}`
  if (!path) {
    path = `${S.dir}/out/${source.replace(/[^\w.-]/g, '_')}.txt`
    await $.fs.write(path, full)
  }
  const foot = `[sieve: ${full.length} chars summarised. Full output: ${path}. For exact counts or lookups run grep/wc/awk on that file; ${SEARCH} finds passages.]`
  const short = repetitive ? `${summarize(e.tool, full)}\n${foot}` : `${compactText(full, { head: 1800, tail: 1200, signal: 15 })}\n${foot}`
  await index($, source, full)
  await record($, 'cut', `${source} ${describe(e)}`)
  S.cuts.push({ what: describe(e), left: 2 })
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
    S.dir = dir
    S.session = await $.session.id()
    await $.process.run(['mkdir', '-p', `${dir}/out`])
    await $.process.run(['find', `${dir}/out`, '-type', 'f', '-mtime', '+7', '-delete'])
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
      text: `sieve: ${S.compacted} results cut this session, ~${Math.round(S.kept / 1000)}k chars kept out of context; ${chunks} chunks from ${sources} sources indexed; wrong cuts (same call repeated within 2) ${S.recut}; decider ${S.deciderReady ? `ready, asked ${S.asked}x, allowed a cut ${S.askedYes}x` : 'off'}.`,
    }
  })

  on('tool.call', { tool: 'mcp__sieve__execute' }, async ($, e: any) => {
    S.executed += 1
    await logUsage($, { tool: 'sieve.execute' })
    const label = `execute:${e.language}:${(await $.clock.now()).toString(36)}`
    let out = await run($, e.language, e.code, e.timeout_ms ?? 30000, label)
    if (e.intent && out.includes('full output indexed')) out += `\n\n${await search($, [e.intent])}`
    return text(out)
  })

  on('tool.call', { tool: 'mcp__sieve__search' }, async ($, e: any) => text(await search($, e.queries, e.limit ?? 3)))

  // Every built-in result passes here: recorded for the resume note, cut when it is large.
  on('tool.call', async ($, e: any, next) => {
    if (!S.inner && !e.tool.startsWith('mcp__sieve__')) watchRecut(e)
    const ran = await next(e)
    if (S.inner || e.tool.startsWith('mcp__sieve__')) return ran
    if (!LIMITS[e.tool]) await logUsage($, { tool: e.tool, size: String(ran.text ?? '').length })
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

  // The request is what the decider weighs a mid-sized result against.
  on('prompt.submit', async ($, e, next) => {
    S.prompt = e.text.slice(0, 500)
    await record($, 'prompt', e.text.slice(0, 200)).catch(() => {})
    return next(e)
  })
}
