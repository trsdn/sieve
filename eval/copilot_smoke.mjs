import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { install } from '../copilot/install.mjs';

const root = join(homedir(), 'dev', 'sieve-bench-runs', `copilot-v0.2.0-${Date.now()}`);
const cases = [
  {
    name: 'summary',
    request: 'Report the passed and failed test totals and the shell exit code.',
    format: 'Final answer must be only one JSON object with integer keys "passed", "failed", and "exit", with no prose or code fences.',
    expected: { passed: 120, failed: 0, exit: 0 }, verdict: 'rule-filter',
  },
  {
    name: 'lookup',
    request: 'Determine the exact LOOKUP_TOKEN value emitted in a passing test line.',
    format: 'Final answer must be only one JSON object with the key "token" and its string value, with no prose or code fences.',
    verdict: 'lookup-keep',
  },
  {
    name: 'large-failure',
    request: 'Report the passed and failed test totals and the shell exit code.',
    format: 'Final answer must be only one JSON object with integer keys "passed", "failed", and "exit", with no prose or code fences.',
    expected: { passed: 18000, failed: 1, exit: 1 }, verdict: 'rule-filter',
    count: 18000, failure: true,
  },
  {
    name: 'disabled',
    request: "I'm just checking in: did that command behave itself?",
    format: 'Answer only a JSON object with "status" set to "ok" if the command succeeded, otherwise "failed".',
    expected: { status: 'ok' }, verdict: 'decider-disabled-keep', deciderEnabled: false,
  },
  {
    name: 'decider',
    request: "I'm just checking in: did that command behave itself?",
    format: 'Answer only a JSON object with "status" set to "ok" if the command succeeded, otherwise "failed".',
    expected: { status: 'ok' }, verdict: 'decider-filter',
  },
];
const requested = process.argv.slice(2);
assert.ok(requested.every(name => cases.some(scenario => scenario.name === name)), 'unknown smoke case');
const results = [];
for (const scenario of cases.filter(item => !requested.length || requested.includes(item.name))) {
  const cwd = join(root, scenario.name);
  await mkdir(cwd, { recursive: true });
  const token = randomUUID();
  const count = scenario.count ?? 120;
  await writeFile(join(cwd, 'sample-test-output.mjs'), `
for (let i = 0; i < ${count}; i++) console.log('PASS test_' + i + ' ' + (i === 60 ? 'LOOKUP_TOKEN=${token}' : 'completed successfully with synthetic progress output'));
${scenario.failure ? "console.log('FAIL synthetic_case: expected 41, received 42');" : ''}
console.log('Tests: ${count} passed, ${scenario.failure ? 1 : 0} failed');
process.exitCode = ${scenario.failure ? 1 : 0};
`);
  const config = await install(cwd);
  const prompt = `${scenario.request} Run exactly \`node sample-test-output.mjs\` once, synchronously, without redirection or pipes. Do not read source, edit files, delegate, or use the network. ${scenario.format}`;
  let stdout = '';
  let stderr = '';
  let killTimer;
  const child = spawn('copilot', [
    '-p', prompt, '--model', 'gpt-6-luna', '--reasoning-effort', 'high',
    '--available-tools', 'bash', 'view', '--disable-builtin-mcps', '--no-auto-update',
    '--no-remote-export', '--output-format', 'json', '--log-dir', join(cwd, 'logs'),
  ], { cwd, env: { ...process.env, COPILOT_ALLOW_ALL: 'true',
    SIEVE_DECIDER: scenario.deciderEnabled === false ? '0' : '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, 180000);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    await writeFile(join(cwd, 'events.jsonl'), stdout);
    await writeFile(join(cwd, 'stderr.txt'), stderr);
    assert.equal(code, 0, stderr);
    const events = stdout.trim().split('\n').map(JSON.parse);
    const answer = JSON.parse(events.findLast(event => event.type === 'assistant.message').data.content);
    assert.deepEqual(answer, scenario.expected ?? { token });
    const calls = events.filter(event => event.type === 'tool.execution_start');
    assert.equal(calls.length, 1, 'the installed adapter must avoid an extra round trip');
    assert.equal(calls[0].data.arguments.command, 'node sample-test-output.mjs');
    const usage = (await readFile(join(cwd, '.sieve', 'usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(usage.at(-1).verdict, scenario.verdict);
    const toolResult = events.find(event => event.type === 'tool.execution_complete').data.result.content;
    const filtered = scenario.verdict.endsWith('-filter');
    assert.equal(toolResult.includes(`LOOKUP_TOKEN=${token}`), !filtered);
    if (filtered) {
      const original = /full original: (.+?)\. Use grep/.exec(toolResult)?.[1];
      assert.ok(original, 'a filtered result must name a retained original');
      assert.ok((await readFile(original, 'utf8')).includes(`LOOKUP_TOKEN=${token}`));
    }
    if (scenario.failure) assert.ok(toolResult.includes('FAIL synthetic_case: expected 41, received 42'));
    results.push({ scenario: scenario.name, correct: true, toolCalls: calls.length,
      verdict: usage.at(-1).verdict, lookupProbability: usage.at(-1).lookupProbability });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    await unlink(config);
  }
}
await writeFile(join(root, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Installed-adapter smoke results: ${root}`);
