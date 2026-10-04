import type { Register } from 'claude-code'
import {
  LIMITS,
  buildSnapshot,
  chunkText,
  compactText,
  filterCommand,
  ftsQuery,
  isRepetitive,
  judgeSize,
  projectKey,
  signature,
  sqlQuote,
  summarize,
  summarizeJson,
} from './lib'

const PORT = 8765
const DECIDER = `http://127.0.0.1:${PORT}/v1/systemone`
// At or above this, the request is a lookup or a count, and the output stays whole.
// Chosen on four prompt sets (125 requests that need the whole output, none cut); see eval/need_eval2.py and need_eval3.py.
const LOOKUP_AT = 0.5
const SEARCH = 'mcp__sieve__search'
const KEEP_DAYS = 14
// New topic: suggest a reset only when the decider is this sure (no follow-up was ever called new at 0.8,
// eval/roles_eval.py). Reminder: a missed reminder costs more than a needless line, so the bar is low.
const SWITCH_AT = 0.8
// Lower the effort only for a session whose first request is clearly simple (no hard request was called
// simple at 0.7, eval/effort_eval.py). Set once: changing effort invalidates the prompt cache.
const SIMPLE_AT = 0.8
const REMIND_AT = 0.4
const REMINDER = 'sieve: this request will likely run tests, builds or logs. Write their output to a file and print only the summary and failures (cmd > /tmp/out.log 2>&1; echo exit=$?; tail -n 15 /tmp/out.log; grep -E "FAIL|ERROR" /tmp/out.log).'
// The one thing context-mode's start-up text gets right, in a few words: plan commands so only
// the answer comes back. Fixed text in the system prompt, so it is cached after the first request.
const GUIDE = 'Tool output stays in every later request, so ask commands for the answer, not the data. For test runs, builds and long logs, write the output to a file and print only what you need, for example: cmd > /tmp/out.log 2>&1; echo exit=$?; tail -n 15 /tmp/out.log; grep -E "FAIL|ERROR|skipped" /tmp/out.log. This matters most when a command fails: Claude Code then cuts the middle of its output, where the failures usually are. Long results may come back summarised by sieve with the path of the full output: query that file instead of running the command again.'
// Command filters apply from this size on; a type of call cut wrongly this often is never cut again.
const FILTER_MIN = 2000
const WRONG_LIMIT = 2
// A decider that does not answer in time counts as down: it must never hold up a prompt or a tool call.
const DECIDER_MS = 1500
const MUTATING = ['Edit', 'Write', 'NotebookEdit']

const text = (t: string) => ({ result: [{ type: 'text', text: t }] })

const S = {
  checkedAt: 0,
  useDecider: true,
  guide: true,
  session: '',
  db: '',
  deciderReady: false,
  dir: '',
  out: '',
  cuts: [] as { what: string; sig: string; left: number }[],
  recut: 0,
  restored: 0,
  prompt: '',
  prompts: 0,
  effort: undefined as undefined | 'low',
  useEffort: true,
  switches: 0,
  reminders: 0,
  seen: 0,
  kept: 0,
  compacted: 0,
  asked: 0,
  askedYes: 0,
  indexed: 0,
  // Real-use measurement: a holdout session only logs what it would have done; bench runs are marked.
  holdout: false,
  cutPaths: [] as string[],
  bench: false,
  project: '',
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

async function index($: any, source: string, content: string): Promise<number> {
  const chunks = chunkText(content, source)
  const rows = chunks
    .map(c => `insert into chunks values (${sqlQuote(source)}, ${sqlQuote(c.title)}, ${sqlQuote(c.body)});`)
    .join('\n')
  const ts = await $.clock.now()
  await sql($, `begin;\ndelete from chunks where source = ${sqlQuote(source)};\n${rows}\ninsert or replace into sources values (${sqlQuote(source)}, ${ts});\ncommit;`)
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

// $.http.fetch has no timeout of its own: undefined when the answer takes longer than DECIDER_MS.
async function fetchWithin($: any, url: string, init?: Record<string, unknown>) {
  return Promise.race([$.http.fetch(url, init), $.clock.sleep(DECIDER_MS).then(() => undefined)])
}

async function markDown($: any) {
  S.deciderReady = false
  S.checkedAt = await $.clock.now()
}

async function deciderUp($: any): Promise<boolean> {
  if (!S.useDecider) return false
  const now = await $.clock.now()
  if (S.deciderReady || now - S.checkedAt < 30000) return S.deciderReady
  S.checkedAt = now
  try {
    S.deciderReady = (await fetchWithin($, `http://127.0.0.1:${PORT}/health`))?.ok === true
  } catch {
    S.deciderReady = false
  }
  return S.deciderReady
}

async function ask($: any, state: string, questions: Record<string, unknown>) {
  if (!(await deciderUp($))) return undefined
  try {
    const res = await fetchWithin($, DECIDER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions }),
    })
    if (!res) {
      // hung or slow: off for 30 s, then checked again
      await markDown($)
      return undefined
    }
    return res.ok ? (JSON.parse(res.text).answers as Record<string, any>) : undefined
  } catch {
    await markDown($)
    return undefined
  }
}

// Which size limits apply to a call: any MCP result, a Playwright snapshot file read back, or the built-in tool.
function limitKey(e: any): string {
  if (e.tool.startsWith('mcp__')) return 'mcp'
  if (e.tool === 'Read' && /\/\.playwright-mcp\//.test(String(e.file_path))) return 'ReadSnapshot'
  return e.tool
}

const blocksOf = (r: any): any[] | undefined => (Array.isArray(r) ? r : Array.isArray(r?.content) ? r.content : undefined)

// What a result carries as text, and the same result with that text replaced.
function textOf(e: any, r: any): string | undefined {
  if (e.tool.startsWith('mcp__')) {
    const blocks = blocksOf(r)
    return blocks && blocks.length && blocks.every(b => b?.type === 'text' && typeof b.text === 'string') ? blocks.map(b => b.text).join('\n\n') : undefined
  }
  switch (e.tool) {
    // A command that failed comes back as one string, already cut in the middle by the harness.
    case 'Bash': return typeof r === 'string' ? r : r.stdout
    case 'Grep': return r.content
    case 'WebFetch': return r.result
    case 'Read': return r.file?.content
    case 'Glob': return Array.isArray(r.filenames) ? r.filenames.join('\n') : undefined
    default: return undefined
  }
}

function withText(e: any, r: any, t: string): any {
  if (e.tool.startsWith('mcp__')) return Array.isArray(r) ? [{ type: 'text', text: t }] : { ...r, content: [{ type: 'text', text: t }] }
  switch (e.tool) {
    case 'Bash': return typeof r === 'string' ? { stdout: t, stderr: '', interrupted: false } : { ...r, stdout: t, persistedOutputPath: undefined, persistedOutputSize: undefined }
    case 'Grep': return { ...r, content: t }
    case 'WebFetch': return { ...r, result: t }
    case 'Read': return { ...r, file: { ...r.file, content: t } }
    default: return { ...r, filenames: t.split('\n'), truncated: true }
  }
}

// A short, stable label for what was called: how a repeat is recognised.
function describe(e: any): string {
  const { tool, tool_use_id, consent, ...input } = e
  return String(e.command ?? e.pattern ?? e.url ?? e.file_path ?? `${tool} ${JSON.stringify(input).slice(0, 160)}`)
}

// What a learned rule is keyed on: the command's tool and subcommand, or the tool.
function sigOf(e: any): string {
  return e.tool === 'Bash' ? `Bash:${signature(String(e.command))}` : e.tool
}

async function wrongCuts($: any, sig: string): Promise<number> {
  const all = ((await $.store.get('wrongCuts')) ?? {}) as Record<string, number>
  return all[sig] ?? 0
}

async function learnWrongCut($: any, sig: string) {
  const all = ((await $.store.get('wrongCuts')) ?? {}) as Record<string, number>
  all[sig] = (all[sig] ?? 0) + 1
  await $.store.set('wrongCuts', all)
}

// The decider's one job on a result: does the request need every line of it? The rule has
// already said the output is repetitive; code and prose never get here.
async function needsEveryLine($: any, e: any, full: string): Promise<boolean> {
  if (!S.prompt) return true
  const answers = await ask($, `Request: ${S.prompt}\n${e.tool}: ${describe(e)}\n---\n${full.slice(0, 1500)}\n…\n${full.slice(-500)}`, {
    kind: {
      type: 'choice',
      instructions: 'Which kind of question is the request?',
      criteria: {
        'lookup or count': 'how many, which one, list all, find, exists, exact',
        overview: 'what is this, summarize, describe, does it look ok, any sign of trouble',
      },
    },
  })
  const p = answers?.kind?.probabilities?.['lookup or count']
  S.asked += 1
  // No answer means keep it whole: a wrong cut costs a round trip, a missed cut only some bytes.
  if (typeof p !== 'number' || p >= LOOKUP_AT) return true
  S.askedYes += 1
  return false
}

// What the session has been doing, for the decider to compare a new request against.
async function recentWork($: any): Promise<string> {
  const raw = await sql($, `.mode json\nselect kind, data from events where session = ${sqlQuote(S.session)} and kind in ('prompt','file','command') order by ts desc limit 12;`)
  const rows: { kind: string; data: string }[] = raw.trim() ? JSON.parse(raw) : []
  const of = (k: string, n: number) => rows.filter(r => r.kind === k).slice(0, n).map(r => r.data.slice(0, 160))
  return `Recent requests: ${of('prompt', 3).map(p => `'${p}'`).join(', ') || 'none'}. Recently edited: ${of('file', 4).join(', ') || 'nothing'}. Recently ran: ${of('command', 3).join('; ') || 'nothing'}.`
}

async function isNewTask($: any, text: string): Promise<boolean> {
  const answers = await ask($, `${await recentWork($)}\nNew request: ${text.slice(0, 600)}`, {
    q: {
      type: 'choice',
      instructions: 'Does the new request continue the recent work, or start a different, unrelated task?',
      criteria: {
        continue: 'a follow-up, fix, extension, question or action about the same work',
        'new task': 'a different topic, project or kind of work that does not need the recent context',
      },
    },
  })
  const p = answers?.q?.probabilities?.['new task']
  return typeof p === 'number' && p >= SWITCH_AT
}

// Both questions read the same state (the request alone), so they share one decider call.
async function promptSignals($: any, text: string): Promise<{ simple?: number; remind?: number }> {
  const answers = await ask($, text.slice(0, 600), {
    simple: {
      type: 'choice',
      instructions: 'How much reasoning does this request need?',
      criteria: {
        simple: 'a lookup, a count, a one-line change, a rename, a quick factual question or running one command',
        complex: 'debugging, designing, a change across several files, an unclear cause, or anything that needs careful thought',
      },
    },
    remind: {
      type: 'choice',
      instructions: 'Will answering this request involve running tests, builds, installs or reading long logs?',
      criteria: {
        yes: 'it runs a test suite, a build or compile, an install, a linter, or reads logs or CI output',
        no: 'it reads or edits code, explains, writes text, or answers a question',
      },
    },
  })
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
  return { simple: num(answers?.simple?.probabilities?.simple), remind: num(answers?.remind?.probabilities?.yes) }
}

async function logUsage($: any, line: Record<string, unknown>) {
  try {
    const tag = { s: S.session, p: S.project, ...(S.holdout ? { holdout: true } : {}), ...(S.bench ? { bench: true } : {}) }
    await $.process.run(['sh', '-c', 'cat >> "$0"', `${S.dir}/usage.jsonl`], { stdin: `${JSON.stringify({ t: await $.clock.now(), ...tag, ...line })}\n` })
  } catch {
    // measurement must never get in the way
  }
}

// A cut followed within two calls by the same call again was a wrong cut: the repeat gets the
// whole output, and the type of call is remembered across sessions. An edit in between makes the
// repeat a new measurement (pytest, Edit, pytest), not a wrong cut.
function watchRepeat(e: any): string | undefined {
  if (MUTATING.includes(e.tool)) {
    S.cuts = []
    return undefined
  }
  const what = describe(e)
  let hit: string | undefined
  for (const c of S.cuts) {
    if (c.left <= 0) continue
    if (c.what === what) hit = c.sig
    c.left -= 1
  }
  S.cuts = S.cuts.filter(c => c.left > 0 && c.what !== what)
  if (hit) S.recut += 1
  return hit
}

// Cuts a large result in place: the model gets a summary of its structure, the whole output
// stays in a file and in the index. Undefined means leave the result as it is.
async function compact($: any, e: any, ran: any): Promise<any | undefined> {
  const r = ran.result
  const key = limitKey(e)
  if (ran.deny !== undefined || !r || !LIMITS[key]) return undefined
  let full = textOf(e, r)
  if (typeof full !== 'string') {
    await logUsage($, { tool: e.tool, unreadable: typeof r, keys: r && typeof r === 'object' ? Object.keys(r).slice(0, 12) : [], isError: ran.isError === true, textLen: String(ran.text ?? '').length })
    return undefined
  }
  // Bash keeps a long output in a file and hands back a preview: use the file, not the preview.
  let path: string | undefined = typeof r === 'object' ? r.persistedOutputPath : undefined
  if (path) {
    try {
      full = await $.fs.read(path)
    } catch {
      // over 4 MiB or gone: the preview is what there is
    }
  }
  const sig = sigOf(e)
  if ((await wrongCuts($, sig)) >= WRONG_LIMIT) {
    await logUsage($, { tool: key === 'mcp' ? 'mcp' : e.tool, size: full.length, verdict: 'learned-keep' })
    return undefined
  }
  // A known command gets its own filter: failures, totals and warnings stay, the rest is noise.
  const filtered = e.tool === 'Bash' && full.length > FILTER_MIN ? filterCommand(String(e.command), full) : undefined
  const size = e.tool === 'Glob' ? r.filenames.length : full.length
  const verdict = filtered ? 'filter' : judgeSize(key, size, ran.isError === true, 1)
  // JSON is data, never code: it gets a schema summary and counts as repetitive for the decider.
  const json = filtered || size <= (LIMITS[key]?.soft ?? Infinity) ? undefined : summarizeJson(full)
  const repetitive = e.tool === 'Glob' || json !== undefined || isRepetitive(full)
  let cut = verdict === 'compact' || verdict === 'filter'
  if (verdict === 'ask' && repetitive) cut = !(await needsEveryLine($, e, full))
  await logUsage($, { tool: key === 'mcp' ? 'mcp' : e.tool, sig, size, verdict, repetitive, json: json !== undefined, cut })
  if (!cut || S.holdout) return undefined

  const source = `${e.tool}:${(await $.clock.now()).toString(36)}${++S.seen}`.replace(/[^\w.:-]/g, '_')
  if (!path) {
    path = `${S.out}/sieve-${source.replace(/:/g, '-')}.txt`
    await $.fs.write(path, full)
  }
  S.cutPaths.push(path.split('/').pop()!)
  const foot = `[sieve: ${full.length} chars summarised. Full output: ${path}. For exact counts or lookups run grep/wc/awk on that file; ${SEARCH} finds passages. Repeat the same call to get everything.]`
  const short = filtered ? `${filtered}\n${foot}` : json ? `${json}\n${foot}` : repetitive ? `${summarize(e.tool, full)}\n${foot}` : `${compactText(full, { head: 1800, tail: 1200, signal: 15 })}\n${foot}`
  await index($, source, full)
  await record($, 'cut', `${source} ${describe(e)}`)
  S.cuts.push({ what: describe(e), sig, left: 2 })
  S.kept += full.length - short.length
  S.compacted += 1
  $.ui.status(`sieve: ${Math.round(S.kept / 1000)}k chars kept out`)
  return { result: withText(e, r, short) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    S.useDecider = (await $.env.get('SIEVE_DECIDER')) !== '0'
    S.guide = (await $.env.get('SIEVE_GUIDE')) !== '0'
    S.useEffort = (await $.env.get('SIEVE_EFFORT')) !== '0'
    // SIEVE_HOLDOUT=0.2: one session in five changes nothing and only logs, the control group for real use.
    S.holdout = Math.random() < Number((await $.env.get('SIEVE_HOLDOUT')) ?? 0)
    S.bench = (await $.env.get('SIEVE_BENCH')) === '1' || /\/(sieve-bench-runs|\.scratch)\//.test(`${e.cwd}/`)
    S.project = projectKey(e.cwd)
    // The harness's own slug for its projects folder (S.out must match it); the index gets a collision-free key.
    const slug = e.cwd.replace(/[/.]/g, '-')
    S.dir = `${home}/.claude/sieve`
    S.db = `${S.dir}/${projectKey(e.cwd)}.db`
    S.session = await $.session.id()
    // The harness's own folder for long outputs: the model may read it without asking.
    S.out = `${home}/.claude/projects/${slug}/${S.session}/tool-results`
    await $.process.run(['mkdir', '-p', S.dir, S.out])
    const cutoff = (await $.clock.now()) - KEEP_DAYS * 86400000
    await sql(
      $,
      `create virtual table if not exists chunks using fts5(source, title, body, tokenize='porter unicode61');
create table if not exists sources (source text primary key, ts integer);
create table if not exists events (session text, ts integer, kind text, data text);
create table if not exists resume (session text primary key, snapshot text, count integer);
delete from chunks where source in (select source from sources where ts < ${cutoff});
delete from sources where ts < ${cutoff};
delete from events where ts < ${cutoff};`,
    )
    await $.process.run(['find', `${home}/.claude/projects`, '-name', 'sieve-*.txt', '-mtime', `+${KEEP_DAYS}`, '-delete'])

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
      text: `sieve: ${S.compacted} results cut this session, ~${Math.round(S.kept / 1000)}k chars kept out of context; ${S.restored} repeated calls got the whole output; ${S.reminders} reminders, ${S.switches} new-task hints; ${chunks} chunks from ${sources} sources indexed (this project); decider ${S.deciderReady ? `ready, asked ${S.asked}x, allowed a cut ${S.askedYes}x` : 'off'}.`,
    }
  })

  on('tool.call', { tool: 'mcp__sieve__search' }, async ($, e: any) => {
    await logUsage($, { event: 'search' })
    return text(await search($, e.queries, e.limit ?? 3))
  })

  // Every result passes here: recorded for the resume note, cut when it is large.
  on('tool.call', async ($, e: any, next) => {
    if (e.tool.startsWith('mcp__sieve__')) return next(e)
    // The model going back to a cut output: the summary was not enough on its own.
    const called = JSON.stringify(e)
    if (S.cutPaths.some(f => called.includes(f))) await logUsage($, { event: 'followup', tool: e.tool })
    const repeat = watchRepeat(e)
    const ran = await next(e)
    if (!LIMITS[limitKey(e)]) await logUsage($, { tool: e.tool, size: String(ran.text ?? '').length })
    try {
      if (['Edit', 'Write', 'NotebookEdit'].includes(e.tool) && ran.deny === undefined) await record($, 'file', e.file_path ?? e.notebook_path)
      else if (e.tool === 'Bash' && ran.deny === undefined) await record($, ran.isError ? 'error' : 'command', e.command)
      if (repeat) {
        S.restored += 1
        await learnWrongCut($, repeat)
        await logUsage($, { tool: e.tool, sig: repeat, restored: true })
        return ran
      }
      return (await compact($, e, ran)) ?? ran
    } catch (err) {
      // never break a tool call; but say why nothing was cut
      await logUsage($, { tool: e.tool, error: String(err).slice(0, 300) })
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
      const guide = S.guide && !S.holdout ? [{ id: 'sieve:guide', text: GUIDE, scope: 'session' as const }] : []
      const resume = note ? [{ id: 'sieve:resume', text: `Before the last compaction, this session had:\n${note}`, scope: 'session' as const }] : []
      return { sections: [...composed.sections, ...guide, ...resume] }
    } catch {
      // no note, no section
    }
    return composed
  })

  // The main loop's requests carry the session's effort; subagents keep their own.
  on('turn.step', async function* ($, e, next) {
    if (S.effort && !e.agentId) return yield* next({ ...e, effort: S.effort })
    return yield* next(e)
  })

  // The request is what the decider weighs results against; it also decides whether this turn
  // starts a new topic (suggest a reset) and whether it needs the one-line reminder.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text
    S.prompt = text.slice(0, 500)
    let context = e.context ?? []
    try {
      // earlier prompts of this session, from the record: a resumed session starts a new process
      const prior = Number((await sql($, `select count(*) from events where session = ${sqlQuote(S.session)} and kind = 'prompt';`)).trim() || 0)
      const sig = await promptSignals($, text)
      await logUsage($, { event: 'prompt', n: prior, simple: sig.simple, remind: sig.remind })
      // Effort is decided once, at the first request, and kept for the session (a resumed one included).
      if (prior === 0) {
        if (S.useEffort && (sig.simple ?? 0) >= SIMPLE_AT) {
          await logUsage($, { event: 'effort-low' })
          if (!S.holdout) {
            S.effort = 'low'
            await record($, 'effort', 'low')
          }
        }
      } else {
        const kept = (await sql($, `select data from events where session = ${sqlQuote(S.session)} and kind = 'effort' order by ts desc limit 1;`)).trim()
        S.effort = kept === 'low' ? 'low' : undefined
      }
      if (prior >= 2 && (await isNewTask($, text))) {
        S.switches += 1
        await logUsage($, { event: 'new-task' })
        if (!S.holdout)
        // Effort stays low for the session (changing it breaks the cache); /clear is the clean place to reset it.
        $.ui.toast(
          S.effort === 'low'
            ? 'sieve: this looks like a new task, and this session runs at low effort. /clear keeps the earlier work out of every request and restores normal effort.'
            : 'sieve: this looks like a new task. /clear (or /compact) would keep the earlier work out of every request.',
        )
      }
      if (S.guide && (sig.remind ?? 0) >= REMIND_AT) {
        S.reminders += 1
        await logUsage($, { event: 'reminder' })
        if (!S.holdout) context = [...context, REMINDER]
      }
    } catch {
      // the decider is optional
    }
    S.prompts += 1
    await record($, 'prompt', text.slice(0, 200)).catch(() => {})
    return next(context === e.context ? e : { ...e, context })
  })
}
