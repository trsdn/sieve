import type { Register } from 'claude-code'
import {
  AUTO_INDEX_LIMIT,
  RESULT_LIMIT,
  chunkText,
  ftsQuery,
  headTail,
  interpreter,
  isBulkyCommand,
  isRawFetch,
  buildSnapshot,
  sqlQuote,
} from './lib'

const PORT = 8765
const CHECKPOINT = 'StrandsAgents/strands-decider-2B-hobson-v19'
const DECIDER = `http://127.0.0.1:${PORT}/v1/systemone`
const TOOL = (name: string) => `mcp__sieve__${name}`

const text = (t: string) => ({ result: [{ type: 'text', text: t }] })

const TASKS = {
  explore: 'reading or searching code to understand it',
  debug: 'investigating an error, failing test or log output',
  implement: 'writing or changing code',
  review: 'reviewing a diff, a PR or existing work',
  question: 'a short question that needs an answer, not tool work',
}

const S = { inner: false, session: '', db: '', deciderReady: false, kept: 0, indexed: 0, nudged: new Set<string>() }

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

// The sandbox runs code the model wrote, so it answers to the same permission rules as Bash.
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
    const match = ftsQuery(q)
    if (!match) continue
    const raw = await sql(
      $,
      `.mode json\nselect source, title, snippet(chunks, 2, '[', ']', '…', 40) as hit from chunks where chunks match ${sqlQuote(match)} order by bm25(chunks) limit ${limit};`,
    )
    const rows: { source: string; title: string; hit: string }[] = raw.trim() ? JSON.parse(raw) : []
    out.push(
      `## ${q}\n` +
        (rows.map(r => `- ${r.source} › ${r.title}\n  ${r.hit.replaceAll('\n', ' ')}`).join('\n') || '(no matches)'),
    )
  }
  return out.join('\n\n')
}

async function ask($: any, state: string, questions: Record<string, unknown>) {
  if (!S.deciderReady) return undefined
  try {
    const res = await $.http.fetch(DECIDER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions }),
    })
    return res.ok ? (JSON.parse(res.text).answers as Record<string, any>) : undefined
  } catch {
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const dir = `${home}/.claude/sieve`
    S.db = `${dir}/index.db`
    S.session = await $.session.id()
    await $.process.run(['mkdir', '-p', dir])
    await sql(
      $,
      `create virtual table if not exists chunks using fts5(source, title, body, tokenize='porter unicode61');\ncreate table if not exists events (session text, ts integer, kind text, data text);\ncreate table if not exists resume (session text primary key, snapshot text, count integer);`,
    )

    const schema = (props: Record<string, unknown>, required: string[]) => ({
      type: 'object',
      properties: props,
      required,
    })
    await $.tool.register({
      name: 'execute',
      description:
        'Run code (shell, python, javascript) in a sandbox and return only its printed output. Large output is indexed and cut to head and tail; pass `intent` to get matching passages back. Use instead of Bash when you only need an answer derived from data.',
      inputSchema: schema(
        {
          language: { type: 'string', enum: ['shell', 'python', 'javascript'] },
          code: { type: 'string' },
          intent: { type: 'string', description: 'What you are looking for in the output.' },
          timeout_ms: { type: 'number' },
        },
        ['language', 'code'],
      ),
    })
    await $.tool.register({
      name: 'batch',
      description:
        'Run several shell commands, index every output, then answer `queries` from the index in one round trip.',
      inputSchema: schema(
        {
          commands: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, command: { type: 'string' } }, required: ['label', 'command'] },
          },
          queries: { type: 'array', items: { type: 'string' } },
        },
        ['commands', 'queries'],
      ),
    })
    await $.tool.register({
      name: 'index',
      description: 'Index a local file or inline content for later search.',
      inputSchema: schema(
        { path: { type: 'string' }, content: { type: 'string' }, source: { type: 'string' } },
        ['source'],
      ),
    })
    await $.tool.register({
      name: 'fetch',
      description: 'Fetch a URL, index the page, and return only a short preview. Query it with search.',
      inputSchema: schema({ url: { type: 'string' }, source: { type: 'string' } }, ['url']),
    })
    await $.tool.register({
      name: 'search',
      description: 'Search everything indexed so far (BM25 over FTS5). Pass several related queries at once.',
      inputSchema: schema({ queries: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } }, ['queries']),
    })
    await $.command.register({ name: 'sieve', description: 'sieve: index size and decider status' })

    // The decider model loads once, here, and serves the whole session. A second session
    // finds the port taken and shares the first one's server.
    void (async () => {
      const bin = `${home}/.local/bin/strands-decider`
      const server = $.process.spawn({
        argv: [bin, 'serve', CHECKPOINT, '--device', 'mlx', '--port', String(PORT)],
      })
      void (async () => {
        for (let i = 0; i < 60 && !S.deciderReady; i++) {
          await $.clock.sleep(2000)
          try {
            S.deciderReady = (await $.http.fetch(`http://127.0.0.1:${PORT}/docs`)).ok
          } catch {
            S.deciderReady = false
          }
        }
      })()
      try {
        for await (const _ of server) {
          // drained so the child keeps running; its logs are not needed
        }
      } catch {
        // could not start: the rules still route, the decider just stays off
      }
      S.deciderReady = false
    })()

    return next(e)
  })

  on('command.run', { command: 'sieve' }, async $ => {
    const raw = await sql($, `.mode json\nselect count(*) as chunks, count(distinct source) as sources from chunks;`)
    const { chunks, sources } = JSON.parse(raw)[0]
    return {
      text: `sieve: ${chunks} chunks from ${sources} sources indexed; ~${Math.round(S.kept / 1000)}k chars kept out of context this session; decider ${S.deciderReady ? 'ready' : 'off'}.`,
    }
  })

  on('tool.call', { tool: 'mcp__sieve__execute' }, async ($, e: any) => {
    const label = `execute:${e.language}:${(await $.clock.now()).toString(36)}`
    let out = await run($, e.language, e.code, e.timeout_ms ?? 30000, label)
    if (e.intent && out.includes('full output indexed')) out += `\n\n${await search($, [e.intent])}`
    return text(out)
  })

  on('tool.call', { tool: 'mcp__sieve__batch' }, async ($, e: any) => {
    const parts: string[] = []
    for (const c of e.commands as { label: string; command: string }[]) {
      const ran = await exec($, c.command, ['/bin/sh', '-c', c.command], 60000)
      if ('denied' in ran) {
        parts.push(`${c.label}: ${ran.denied}`)
        continue
      }
      S.kept += ran.output.length
      parts.push(`${c.label}: ${await index($, c.label, ran.output)} chunks, ${ran.output.length} chars, exit ${ran.exit}`)
    }
    return text(`${parts.join('\n')}\n\n${await search($, e.queries)}`)
  })

  on('tool.call', { tool: 'mcp__sieve__index' }, async ($, e: any) => {
    if (e.path) {
      const denied = await permitted($, 'Read', { file_path: e.path })
      if (denied) return text(denied)
    }
    const content = e.content ?? (e.path ? await $.fs.read(e.path) : '')
    const n = await index($, e.source, String(content))
    S.kept += String(content).length
    return text(`indexed ${n} chunks as "${e.source}"`)
  })

  on('tool.call', { tool: 'mcp__sieve__fetch' }, async ($, e: any) => {
    const res = await $.http.fetch(e.url)
    const n = await index($, e.source ?? e.url, res.text)
    S.kept += res.text.length
    return text(`${res.status} ${e.url}: indexed ${n} chunks.\n${res.text.slice(0, 500)}`)
  })

  on('tool.call', { tool: 'mcp__sieve__search' }, async ($, e: any) =>
    text(await search($, e.queries, e.limit ?? 3)),
  )

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (S.inner) return next(e)
    const command: string = e.command
    if (isRawFetch(command))
      return { deny: `sieve: use ${TOOL('fetch')} for URLs, or send the output to a file or through head/jq.` }

    let bulky = isBulkyCommand(command)
    if (!bulky && command.length > 12 && !S.nudged.has(command)) {
      const answers = await ask($, command, {
        bulky: { type: 'noul', instructions: 'Will running this shell command print more than 200 lines of output?' },
      })
      bulky = (answers?.bulky?.noul ?? 0) >= 0.9
    }
    if (bulky && !S.nudged.has(command)) {
      S.nudged.add(command)
      return {
        deny: `sieve: this will likely print a lot. Run it through ${TOOL('execute')} with an \`intent\`, or limit it (head, grep, --stat). Repeat the same command to run it as is.`,
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && typeof ran.text === 'string' && ran.text.length > AUTO_INDEX_LIMIT) {
      S.kept += ran.text.length
      const source = `bash:${command.slice(0, 60)}`
      const n = await index($, source, ran.text)
      return {
        ...ran,
        context: [...(ran.context ?? []), `sieve: that output was ${ran.text.length} chars; indexed as "${source}" (${n} chunks). Query it with ${TOOL('search')} instead of rerunning.`],
      }
    }
    return ran
  })

  on('tool.call', { tool: 'WebFetch' }, async () => ({
    deny: `sieve: use ${TOOL('fetch')} then ${TOOL('search')}; it keeps the page out of the context.`,
  }))

  on('prompt.submit', async ($, e, next) => {
    await record($, 'prompt', e.text.slice(0, 200)).catch(() => {})
    const answers = await ask($, e.text.slice(0, 4000), {
      task: {
        type: 'choice',
        instructions: 'What kind of work does this request mainly ask for?',
        criteria: TASKS,
      },
    })
    const task = answers?.task
    if (task && task.confidence >= 0.8 && ['explore', 'debug', 'review'].includes(task.choice)) {
      $.ui.status(`ctx: ${task.choice} ${Math.round(task.confidence * 100)}%`)
      return next({
        ...e,
        context: [
          ...(e.context ?? []),
          `sieve: this looks like ${task.choice} work. Gather files, logs and command output with ${TOOL('batch')} or ${TOOL('execute')} and query the index, rather than reading raw output into the context.`,
        ],
      })
    }
    $.ui.status(undefined)
    return next(e)
  })

  on('tool.call', async ($, e: any, next) => {
    const ran = await next(e)
    try {
      if (['Edit', 'Write', 'NotebookEdit'].includes(e.tool) && ran.deny === undefined) await record($, 'file', e.file_path ?? e.notebook_path)
      else if (e.tool === 'Bash' && ran.deny === undefined) await record($, ran.isError ? 'error' : 'command', e.command)
    } catch {
      // capture must never break a tool call
    }
    return ran
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
}
