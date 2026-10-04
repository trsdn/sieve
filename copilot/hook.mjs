import { mkdir, readFile, writeFile, rename, appendFile, realpath } from 'node:fs/promises';
import { join, resolve, basename, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { filterCommand, LOOKUP_AT } from '../hooks/lib.ts';
import { classifyRequest } from './intent.mjs';
import { askNeed } from './decider.mjs';

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function storeFor(event, projectRoot) {
  if (typeof event.sessionId !== 'string' || !event.sessionId
    || typeof event.cwd !== 'string' || !isAbsolute(event.cwd)) {
    throw new Error('invalid hook session identity or cwd');
  }
  const project = await realpath(projectRoot ?? event.cwd);
  const store = join(project, '.sieve');
  await mkdir(store, { recursive: true, mode: 0o700 });
  if (await realpath(store) !== store) throw new Error('sieve data directory must not be a symlink');
  const sessions = join(store, 'sessions');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  if (await realpath(sessions) !== sessions) throw new Error('sieve sessions directory must not be a symlink');
  const session = join(sessions, createHash('sha256').update(event.sessionId).digest('hex'));
  await mkdir(session, { recursive: true, mode: 0o700 });
  if (await realpath(session) !== session) throw new Error('sieve session directory must not be a symlink');
  return { session, usage: join(store, 'usage.jsonl'), request: join(session, 'request.json'),
    cooldown: join(session, 'decider-down.json') };
}

async function log(files, data) {
  await appendFile(files.usage, `${JSON.stringify({ timestamp: Date.now(), ...data })}\n`, { mode: 0o600 });
}

export async function runHook(event, kind, {
  projectRoot, deciderEnabled = process.env.SIEVE_DECIDER !== '0', fetchImpl = fetch,
  timeoutMs = 1500, warn = message => console.error(message),
} = {}) {
  const files = await storeFor(event, projectRoot);
  if (kind === 'start' || kind === 'prompt') {
    if (kind === 'prompt' && typeof event.prompt !== 'string') throw new Error('missing user prompt');
    const prompt = kind === 'prompt' ? event.prompt : '';
    if (kind === 'prompt' || !await readJson(files.request)) {
      await atomicJson(files.request, { version: 1, intent: classifyRequest(prompt),
        prompt: prompt.slice(0, 500), truncated: prompt.length > 500 });
    }
    await log(files, { event: kind, promptChars: prompt.length });
    return {};
  }
  if (kind !== 'result') throw new Error(`unknown hook event: ${kind}`);
  if (!['bash', 'powershell'].includes(event.toolName)) return {};
  const command = event.toolArgs?.command;
  const raw = event.toolResult?.textResultForLlm;
  if (typeof command !== 'string' || typeof raw !== 'string'
    || event.toolResult.resultType !== 'success') throw new Error('invalid shell result payload');
  const request = await readJson(files.request);
  if (request && (request.version !== 1 || typeof request.prompt !== 'string' || typeof request.truncated !== 'boolean'
    || !['summary', 'lookup', 'unknown'].includes(request.intent))) throw new Error('invalid request state');
  const intent = request?.intent ?? 'unknown';
  const metric = { tool: event.toolName, intent, inputChars: raw.length };
  if (intent === 'lookup' || !request?.prompt) {
    await log(files, { ...metric, verdict: intent === 'lookup' ? 'lookup-keep' : 'no-prompt-keep' });
    return {};
  }
  if (intent === 'unknown' && request.truncated) {
    await log(files, { ...metric, verdict: 'long-prompt-keep' });
    return {};
  }
  const persisted = /^Output too large to read at once .*\. Saved to: (.+)$/m.exec(raw)?.[1];
  const completion = /\n(<shellId: [^\n]+>)\s*$/.exec(raw)?.[1];
  let full = raw;
  if (persisted) {
    const path = resolve(persisted);
    if (!/^\d+-copilot-tool-output-[\w-]+\.txt$/.test(basename(path))) {
      throw new Error('unexpected Copilot persisted-output path');
    }
    const location = relative(await realpath(tmpdir()), await realpath(path));
    if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) {
      throw new Error('unexpected Copilot persisted-output path');
    }
    full = await readFile(path, 'utf8');
  }
  const body = completion && full.endsWith(completion) ? full.slice(0, -completion.length).trimEnd() : full;
  const candidate = body.length > 2000 ? filterCommand(command, body) : undefined;
  if (!candidate) {
    await log(files, { ...metric, fullChars: full.length, verdict: 'no-filter-keep' });
    return {};
  }
  let probability;
  if (intent !== 'summary') {
    if (!deciderEnabled) {
      await log(files, { ...metric, verdict: 'decider-disabled-keep' });
      return {};
    }
    const cooldown = await readJson(files.cooldown);
    if (cooldown && (typeof cooldown.until !== 'number' || !Number.isFinite(cooldown.until))) {
      throw new Error('invalid decider cooldown');
    }
    if (cooldown?.until > Date.now()) {
      await log(files, { ...metric, verdict: 'decider-cooldown-keep' });
      return {};
    }
    const decision = await askNeed(request.prompt, command, body, { fetchImpl, timeoutMs });
    if (decision.status !== 'ready') {
      await atomicJson(files.cooldown, { until: Date.now() + 30000 });
      warn(`sieve: ${decision.error}; keeping the original output`);
      await log(files, { ...metric, verdict: 'decider-unavailable-keep', error: decision.error });
      return {};
    }
    probability = decision.lookupProbability;
    if (probability >= LOOKUP_AT) {
      await log(files, { ...metric, verdict: 'decider-lookup-keep', lookupProbability: probability });
      return {};
    }
  }
  const original = join(files.session, `output-${randomUUID()}.txt`);
  await writeFile(original, full, { mode: 0o600 });
  const text = `${candidate}${completion ? `\n${completion}` : ''}\n[sieve: full original: ${original}. Use grep on that file for exact details; do not rerun the command.]`;
  await log(files, { ...metric, fullChars: full.length, outputChars: text.length,
    verdict: intent === 'summary' ? 'rule-filter' : 'decider-filter', lookupProbability: probability });
  return { modifiedResult: { resultType: 'success', textResultForLlm: text } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify(await runHook(JSON.parse(input), process.argv[2], { projectRoot: process.argv[3] })));
  } catch (error) {
    console.error(`sieve: ${String(error)}; keeping the original output`);
    console.log('{}');
  }
}
