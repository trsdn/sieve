import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NEED_QUESTION, LOOKUP_AT, needState } from '../hooks/lib.ts';
import { classifyRequest } from './intent.mjs';
import { askNeed } from './decider.mjs';
import { runHook } from './hook.mjs';
import { install } from './install.mjs';

const response = probability => new Response(JSON.stringify({ answers: { kind: {
  probabilities: { 'lookup or count': probability, overview: 1 - probability },
} } }), { status: 200 });
const output = Array.from({ length: 120 }, (_, i) =>
  `PASS test_${i} ${i === 60 ? 'LOOKUP_TOKEN=preserve-this-detail' : 'completed successfully with synthetic progress output'}`)
  .join('\n') + '\nTests: 120 passed, 0 failed\n<shellId: 0 completed with exit code 0>';
const unavailable = async () => { throw new Error('server unavailable'); };

async function context(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'sieve-copilot-test-'));
  t.after(() => rm(cwd, { recursive: true }));
  const event = { cwd, sessionId: randomUUID(), toolName: 'bash',
    toolArgs: { command: 'node test-runner.mjs' },
    toolResult: { resultType: 'success', textResultForLlm: output } };
  return { cwd, event };
}

for (const [prompt, intent] of [
  ['Summarize the test output.', 'summary'],
  ['Report the passed and failed test totals and the shell exit code.', 'summary'],
  ['Bitte fasse die Testausgabe kurz zusammen.', 'summary'],
  ['Gib mir einen kurzen Überblick der Testergebnisse.', 'summary'],
  ['Determine the exact LOOKUP_TOKEN value.', 'lookup'],
  ['Welcher Test liefert genau diesen Token?', 'lookup'],
  ['Summarize the output and give me the exact token.', 'lookup'],
  ['Summarize the output. Also include metric_61.', 'unknown'],
  ['Summarize the output. Do not omit metric_61.', 'unknown'],
  ['Summarize the output. You may include metric_61.', 'unknown'],
  ['Summarize the output. Final answer must include the token.', 'lookup'],
  ['Summarize the output. Do not summarize, but give me the exact token.', 'lookup'],
  ['Do not look up or report LOOKUP_TOKEN. Summarize the output.', 'summary'],
  ["I'm just checking in: did that command behave itself?", 'unknown'],
  ['Run the tests.', 'unknown'],
  ['', 'unknown'],
]) test(`request intent: ${prompt}`, () => assert.equal(classifyRequest(prompt), intent));

test('the shared decider question, state and threshold retain the measured wording', async () => {
  assert.equal(LOOKUP_AT, 0.5);
  assert.deepEqual(NEED_QUESTION.kind, {
    type: 'choice', instructions: 'Which kind of question is the request?',
    criteria: {
      'lookup or count': 'how many, which one, list all, find, exists, exact',
      overview: 'what is this, summarize, describe, does it look ok, any sign of trouble',
    },
  });
  let calls = 0;
  const decision = await askNeed('request', 'node script.mjs', output, {
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:8765/v1/systemone');
      assert.deepEqual(JSON.parse(options.body), {
        state: needState('request', 'Bash', 'node script.mjs', output),
        questions: NEED_QUESTION,
      });
      return response(0.2);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(decision, { status: 'ready', lookupProbability: 0.2 });
});

test('bad HTTP, JSON and probabilities are explicit unavailable results', async () => {
  for (const fetchImpl of [
    async () => new Response('down', { status: 503 }),
    async () => new Response('invalid JSON'),
    async () => new Response(JSON.stringify({ answers: {} })),
    async () => new Response(JSON.stringify({ answers: { kind: {
      probabilities: { 'lookup or count': 0.2, overview: 0.2 },
    } } })),
    async () => response(-0.1),
    unavailable,
  ]) {
    const result = await askNeed('request', 'node tests.mjs', output, { fetchImpl });
    assert.equal(result.status, 'unavailable');
    assert.ok(result.error);
  }
});

test('a stalled decider is aborted', async () => {
  const decision = await askNeed('request', 'node tests.mjs', output, {
    timeoutMs: 10,
    fetchImpl: async (_, { signal }) => new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  });
  assert.deepEqual(decision, { status: 'unavailable', error: 'decider timed out' });
});

test('clear lookups preserve output without consulting the decider or opening previews', async t => {
  const { event } = await context(t);
  await runHook({ ...event, prompt: 'Give me the exact token.' }, 'prompt');
  const fetchImpl = async () => { assert.fail('lookup must not call decider'); };
  assert.deepEqual(await runHook(event, 'result', { fetchImpl }), {});
  assert.deepEqual(await runHook({ ...event, toolResult: { resultType: 'success',
    textResultForLlm: 'Output too large to read at once (1 MB). Saved to: /missing/output.txt',
  } }, 'result', { fetchImpl }), {});
});

test('clear summaries retain totals, original output and shell metadata', async t => {
  const { cwd, event } = await context(t);
  await runHook({ ...event, prompt: 'Summarize the test output.' }, 'prompt');
  const result = await runHook(event, 'result', {
    fetchImpl: async () => { assert.fail('rule summary does not need a decider'); },
  });
  const text = result.modifiedResult.textResultForLlm;
  assert.ok(text.length < output.length / 3);
  assert.ok(text.includes('Tests: 120 passed, 0 failed'));
  assert.ok(text.includes('<shellId: 0 completed with exit code 0>'));
  assert.ok(!text.includes('LOOKUP_TOKEN='));
  const path = /full original: (.+?)\. Use grep/.exec(text)[1];
  assert.equal(await readFile(path, 'utf8'), output);
  const metrics = (await readFile(join(cwd, '.sieve', 'usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(metrics.at(-1).verdict, 'rule-filter');
});

test('an unknown overview actually uses the decider before filtering', async t => {
  const { cwd, event } = await context(t);
  await runHook({ ...event, prompt: "I'm just checking in: did that command behave itself?" }, 'prompt');
  let calls = 0;
  const result = await runHook(event, 'result', { fetchImpl: async () => {
    calls++;
    return response(0.2);
  } });
  assert.equal(calls, 1);
  assert.ok(result.modifiedResult);
  const metrics = (await readFile(join(cwd, '.sieve', 'usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(metrics.at(-1).verdict, 'decider-filter');
  assert.equal(metrics.at(-1).lookupProbability, 0.2);
});

test('lookup probability at and above the measured threshold keeps output', async t => {
  const { event } = await context(t);
  await runHook({ ...event, prompt: 'Can I move on?' }, 'prompt');
  for (const probability of [0.5, 0.7, 1]) {
    assert.deepEqual(await runHook(event, 'result', { fetchImpl: async () => response(probability) }), {});
  }
});

test('failure gives a warning, keeps output and applies a thirty-second cooldown', async t => {
  const { event } = await context(t);
  await runHook({ ...event, prompt: 'Can I move on?' }, 'prompt');
  let calls = 0;
  const warnings = [];
  const options = { warn: message => warnings.push(message), fetchImpl: async () => {
    calls++;
    throw new Error('server unavailable');
  } };
  assert.deepEqual(await runHook(event, 'result', options), {});
  assert.deepEqual(await runHook(event, 'result', options), {});
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeping the original output/);
});

test('disabled decider, missing state and overlong unknown prompts keep output', async t => {
  const { event } = await context(t);
  const fetchImpl = async () => { assert.fail('must not ask the decider'); };
  assert.deepEqual(await runHook(event, 'result', { fetchImpl }), {});
  await runHook({ ...event, prompt: 'Can I move on?' }, 'prompt');
  assert.deepEqual(await runHook(event, 'result', { deciderEnabled: false, fetchImpl }), {});
  await runHook({ ...event, prompt: 'Can I move on? '.repeat(100) }, 'prompt');
  assert.deepEqual(await runHook(event, 'result', { fetchImpl }), {});
});

test('follow-up prompts replace summary intent and sessions stay isolated', async t => {
  const { event } = await context(t);
  await runHook({ ...event, prompt: 'Summarize the output.' }, 'prompt');
  assert.ok((await runHook(event, 'result')).modifiedResult);
  await runHook({ ...event, prompt: 'Give me the exact token.' }, 'prompt');
  assert.deepEqual(await runHook(event, 'result'), {});
  assert.deepEqual(await runHook({ ...event, sessionId: randomUUID() }, 'result'), {});
  await runHook(event, 'start');
  assert.deepEqual(await runHook(event, 'result'), {});
});

test('a late session-start hook does not erase an already submitted request', async t => {
  const { event } = await context(t);
  await runHook({ ...event, prompt: 'Summarize the output.' }, 'prompt');
  await runHook(event, 'start');
  assert.ok((await runHook(event, 'result')).modifiedResult);
});

test('code and a git patch remain unchanged even under summary intent', async t => {
  const { event } = await context(t);
  await runHook({ ...event, prompt: 'Summarize the output.' }, 'prompt');
  for (const text of [
    Array.from({ length: 200 }, (_, i) => `export const value_${i} = ${i};`).join('\n'),
    'diff --git a/main.ts b/main.ts\n' + Array.from({ length: 200 }, (_, i) => `+const item_${i} = ${i};`).join('\n'),
  ]) assert.deepEqual(await runHook({ ...event, toolArgs: { command: 'git log -p' },
    toolResult: { resultType: 'success', textResultForLlm: text } }, 'result'), {});
});

test('spilled failure output is loaded without losing exit code or diagnostics', async t => {
  const { cwd, event } = await context(t);
  const path = join(cwd, `${Date.now()}-copilot-tool-output-123-${randomUUID()}.txt`);
  const full = output.replace('Tests: 120 passed, 0 failed\n<shellId: 0 completed with exit code 0>',
    'FAIL synthetic_case: expected 41, received 42\nTests: 120 passed, 1 failed');
  await writeFile(path, full);
  await runHook({ ...event, prompt: 'Summarize the test output.' }, 'prompt');
  const result = await runHook({ ...event, toolName: 'powershell', toolArgs: { command: './tests.ps1' },
    toolResult: { resultType: 'success', textResultForLlm:
      `Output too large to read at once (100 KB). Saved to: ${path}\nPreview\n<shellId: 7 completed with exit code 1>` },
  }, 'result');
  assert.ok(result.modifiedResult.textResultForLlm.includes('FAIL synthetic_case: expected 41, received 42'));
  assert.ok(result.modifiedResult.textResultForLlm.includes('Tests: 120 passed, 1 failed'));
  assert.ok(result.modifiedResult.textResultForLlm.includes('<shellId: 7 completed with exit code 1>'));
});

test('unsafe persisted paths, corrupt state and data symlinks are errors, not cuts', async t => {
  const { cwd, event } = await context(t);
  await runHook({ ...event, prompt: 'Summarize the output.' }, 'prompt');
  await assert.rejects(runHook({ ...event, toolResult: { resultType: 'success',
    textResultForLlm: 'Output too large to read at once (1 MB). Saved to: /outside/output.txt',
  } }, 'result'), /unexpected Copilot persisted-output path/);
  const [session] = await readdir(join(cwd, '.sieve', 'sessions'));
  await writeFile(join(cwd, '.sieve', 'sessions', session, 'request.json'), '{"version":7}');
  await assert.rejects(runHook(event, 'result'), /invalid request state/);
  const other = await context(t);
  await symlink(cwd, join(other.cwd, '.sieve'));
  await assert.rejects(runHook(other.event, 'start'), /must not be a symlink/);
});

test('installer packages runnable hooks, preserves other config and is idempotent', async t => {
  const { cwd, event } = await context(t);
  await writeFile(join(cwd, '.gitignore'), 'keep-this-pattern\n');
  await mkdir(join(cwd, '.github', 'hooks'), { recursive: true });
  await writeFile(join(cwd, '.github', 'hooks', 'custom.json'), '{"keep":true}');
  const config = await install(cwd);
  await install(cwd);
  assert.equal(await readFile(join(cwd, '.github', 'hooks', 'custom.json'), 'utf8'), '{"keep":true}');
  assert.equal(await readFile(join(cwd, '.gitignore'), 'utf8'), 'keep-this-pattern\n/.sieve/\n');
  const hooks = JSON.parse(await readFile(config, 'utf8')).hooks;
  const invoke = (hook, payload) => {
    const result = spawnSync(hook.exec, hook.args, { cwd, input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  invoke(hooks.sessionStart[0], event);
  invoke(hooks.userPromptSubmitted[0], { ...event, prompt: 'Summarize the output.' });
  assert.ok(invoke(hooks.postToolUse[0], event).modifiedResult);
  invoke(hooks.userPromptSubmitted[0], { ...event, prompt: 'Give me the exact token.' });
  assert.deepEqual(invoke(hooks.postToolUse[0], event), {});
});

test('installer refuses an unrelated existing hook file', async t => {
  const { cwd } = await context(t);
  await mkdir(join(cwd, '.github', 'hooks'), { recursive: true });
  const path = join(cwd, '.github', 'hooks', 'sieve-copilot.json');
  await writeFile(path, '{"version":1,"hooks":{}}');
  await assert.rejects(install(cwd), /refusing to overwrite/);
  assert.equal(await readFile(path, 'utf8'), '{"version":1,"hooks":{}}');
});

test('installer preserves additional hooks inside an extended managed file', async t => {
  const { cwd } = await context(t);
  const path = await install(cwd);
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.hooks.postToolUse.push({ type: 'command', exec: 'custom-command' });
  const extended = JSON.stringify(config);
  await writeFile(path, extended);
  await assert.rejects(install(cwd), /refusing to overwrite/);
  assert.equal(await readFile(path, 'utf8'), extended);
});

test('session directory symlinks are rejected before creating external state', async t => {
  const { cwd, event } = await context(t);
  const other = await context(t);
  await mkdir(join(cwd, '.sieve'));
  await symlink(other.cwd, join(cwd, '.sieve', 'sessions'));
  await assert.rejects(runHook(event, 'start'), /must not be a symlink/);
  assert.deepEqual(await readdir(other.cwd), []);
});

test('a persisted-output symlink cannot escape the temporary directory', async t => {
  const { cwd, event } = await context(t);
  const path = join(cwd, `${Date.now()}-copilot-tool-output-${randomUUID()}.txt`);
  await symlink(process.execPath, path);
  await runHook({ ...event, prompt: 'Summarize the output.' }, 'prompt');
  await assert.rejects(runHook({ ...event, toolResult: { resultType: 'success',
    textResultForLlm: `Output too large to read at once (1 MB). Saved to: ${path}`,
  } }, 'result'), /unexpected Copilot persisted-output path/);
});

test('live shared decider selects a measured overview without starting a service', {
  skip: process.env.SIEVE_LIVE_DECIDER !== '1',
}, async t => {
  const { event } = await context(t);
  await runHook({ ...event, prompt: "I'm just checking in: did that command behave itself?" }, 'prompt');
  assert.ok((await runHook(event, 'result')).modifiedResult);
  const decision = await askNeed('The third entry looks wrong; give me its exact text so I can fix it.',
    event.toolArgs.command, output);
  assert.equal(decision.status, 'ready');
  assert.ok(decision.lookupProbability >= LOOKUP_AT);
});
