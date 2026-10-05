import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { askNeed } from '../copilot/decider.mjs';
import { classifyRequest, prioritizeRequest } from '../copilot/intent.mjs';
import { LOOKUP_AT, needState, filterCommand } from '../hooks/lib.ts';

const data = await readFile(new URL('./copilot_decider_cases.json', import.meta.url), 'utf8');
const sets = JSON.parse(data);
const devOnly = process.argv.includes('--dev-only');
const holdoutOnly = process.argv.includes('--holdout-only');
const holdout2Only = process.argv.includes('--holdout2-only');
assert.ok([devOnly, holdoutOnly, holdout2Only].filter(Boolean).length <= 1, 'select only one case set');
const selected = devOnly ? ['dev'] : holdoutOnly ? ['holdout'] : holdout2Only ? ['holdout2'] : ['dev', 'holdout', 'holdout2'];
const command = 'node checks.mjs';
const output = Array.from({ length: 120 }, (_, i) =>
  `PASS test_${i} metric_${i} ms=${i === 61 ? 9013 : 1 + i % 97} completed successfully`)
  .join('\n') + '\nTests: 120 passed, 0 failed';
assert.ok(filterCommand(command, output));
const results = [];
for (const set of selected) {
  for (const [index, item] of sets[set].entries()) {
    const intent = classifyRequest(item.prompt);
    for (const variant of index % 2 ? ['prepared', 'original'] : ['original', 'prepared']) {
      const start = performance.now();
      let decision;
      if (intent === 'lookup' || intent === 'summary') {
        decision = { status: 'rule', action: intent === 'lookup' ? 'keep' : 'filter' };
      } else {
        const fetchImpl = variant === 'original' ? (url, options) => {
          const body = JSON.parse(options.body);
          body.state = needState(item.prompt, 'Bash', command, output);
          return fetch(url, { ...options, body: JSON.stringify(body) });
        } : fetch;
        decision = await askNeed(item.prompt, command, output, { fetchImpl });
        decision.action = decision.status === 'ready' && decision.lookupProbability < LOOKUP_AT ? 'filter' : 'keep';
      }
      const row = { set, index, variant, need: item.need, intent,
        reordered: prioritizeRequest(item.prompt) !== item.prompt,
        seconds: (performance.now() - start) / 1000, ...decision };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
const groups = selected.flatMap(set => ['original', 'prepared'].map(variant => {
  const rows = results.filter(row => row.set === set && row.variant === variant);
  return { set, variant, needed: rows.filter(row => row.need).length,
    unsafeCuts: rows.filter(row => row.need && row.action === 'filter').length,
    overview: rows.filter(row => !row.need).length,
    overviewFilters: rows.filter(row => !row.need && row.action === 'filter').length,
    rpcReady: rows.filter(row => row.status === 'ready').length,
    rpcUnavailable: rows.filter(row => row.status === 'unavailable').length };
}));
const report = {
  question: 'Unchanged shared lookup/overview question', threshold: LOOKUP_AT, timeoutMs: 1500,
  casesSha256: createHash('sha256').update(data).digest('hex'), groups, results,
  holdoutSha256: createHash('sha256').update(JSON.stringify(sets.holdout)).digest('hex'),
  limitations: 'Small hand-written bilingual dev/holdout sets with one test-output shape. Sequential, counterbalanced original/prepared requests; unavailable decisions keep output and are not retried. Not a Copilot token benchmark.',
  comparison: 'Both arms use current raw-request safety guards; original/prepared compare ordering only, not v0.2.0 versus the candidate.',
};
const reportArg = process.argv.find(arg => arg.startsWith('--report='));
if (reportArg) await writeFile(reportArg.slice('--report='.length), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(groups, null, 2));
if (groups.some(group => group.variant === 'prepared' && group.unsafeCuts)) {
  console.error('Unsafe cuts observed; candidate is not safe to ship.');
  process.exitCode = 1;
} else if (groups.some(group => group.rpcUnavailable)) {
  console.error('Decider availability prevented complete coverage; this evaluation is inconclusive.');
  process.exitCode = 2;
}
