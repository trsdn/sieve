import { test, expect } from 'claude-code/testing'
import { buildSnapshot, chunkText, filterCommand, signature, compactText, isRepetitive, judgeSize, summarize, ftsQuery, headTail, interpreter, isBulkyCommand, isRawFetch, sqlQuote } from './lib'

test('quotes sql and builds a safe fts query', () => {
  expect(sqlQuote("it's")).toBe("'it''s'")
  expect(ftsQuery('foo-bar "baz" x')).toBe('"foo" OR "bar" OR "baz"')
})

test('chunks by heading', () => {
  const chunks = chunkText('# A\none\n# B\ntwo', 'fallback')
  expect(chunks.map(c => c.title)).toEqual(['A', 'B'])
})

test('cuts long output to head and tail', () => {
  const out = headTail('x'.repeat(20000))
  expect(out.length).toBeLessThan(6200)
  expect(out).toContain('chars omitted')
})

test('routes bulky commands and raw fetches', () => {
  expect(isBulkyCommand('git log')).toBe(true)
  expect(isBulkyCommand('git log -n 5')).toBe(false)
  expect(isBulkyCommand('find . -name x | head')).toBe(false)
  expect(isRawFetch('curl https://x.dev')).toBe(true)
  expect(isRawFetch('curl -o a.json https://x.dev')).toBe(false)
  expect(interpreter('python', 'print(1)')).toEqual(['python3', '-c', 'print(1)'])
  expect(interpreter('ruby', '')).toBeUndefined()
})

test('builds a bounded resume snapshot', () => {
  const events = [
    { kind: 'prompt', data: 'fix the login bug' },
    { kind: 'file', data: 'src/login.ts' },
    { kind: 'error', data: 'npm test' },
  ]
  const note = buildSnapshot(events, 1)
  expect(note).toContain('<edited>src/login.ts</edited>')
  expect(note).toContain('<failed>npm test</failed>')
  expect(buildSnapshot([{ kind: 'cut', data: 'Bash:x1 find deps' }], 1)).toContain('<indexed>Bash:x1 find deps</indexed>')
  expect(buildSnapshot(Array.from({ length: 200 }, (_, i) => ({ kind: 'file', data: `f${i}`.padEnd(80, 'x') })), 1).length).toBeLessThanOrEqual(2000)
})

test('compacts to head and tail and keeps signal lines from the middle', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => (i === 1000 ? 'ERROR: disk full at block 7' : `line ${i} ok`))
  const out = compactText(lines.join('\n'), { head: 300, tail: 300, signal: 5 })
  expect(out.length).toBeLessThan(1200)
  expect(out).toContain('line 0 ok')
  expect(out).toContain('line 1999 ok')
  expect(out).toContain('ERROR: disk full at block 7')
  expect(out).toContain('omitted')
  expect(compactText('short', { head: 300, tail: 300, signal: 5 })).toBe('short')
})

test('judges size per tool, errors pass in the middle band', () => {
  expect(judgeSize('Bash', 100, false)).toBe('pass')
  expect(judgeSize('Bash', 6000, false)).toBe('ask')
  expect(judgeSize('Bash', 6000, true)).toBe('pass')
  expect(judgeSize('Bash', 40000, true)).toBe('compact')
  expect(judgeSize('Bash', 20000, false)).toBe('ask')
  expect(judgeSize('Bash', 20000, false, 0.5)).toBe('compact')
  expect(judgeSize('Edit', 999999, false)).toBe('pass')
})

test('fts query joins terms with the asked operator', () => {
  expect(ftsQuery('log line 22222', 'AND')).toBe('"log" AND "line" AND "22222"')
  expect(ftsQuery('log line')).toBe('"log" OR "line"')
})

test('tells repetitive output from code', () => {
  const log = Array.from({ length: 200 }, (_, i) => `2026-10-04 INFO handled /items/${i} status=200 ms=${i % 9}`).join('\n')
  const code = [
    'import { readFileSync } from "node:fs"', 'export class Cache<K, V> {', '  private store = new Map<K, V>()', '  constructor(private limit = 100) {}',
    '  get(key: K): V | undefined {', '    const hit = this.store.get(key)', '    if (hit !== undefined) { this.store.delete(key); this.store.set(key, hit) }',
    '    return hit', '  }', '  set(key: K, value: V) {', '    if (this.store.size >= this.limit) this.store.delete(this.store.keys().next().value)',
    '    this.store.set(key, value)', '  }', '}', '', 'function parse(line: string): [string, number] | null {', '  const m = /^(\\w+)=(\\d+)$/.exec(line)',
    '  return m ? [m[1], Number(m[2])] : null', '}', '', 'export async function load(path: string) {', '  const out: Record<string, number> = {}',
    '  for (const line of readFileSync(path, "utf8").split("\\n")) {', '    const kv = parse(line)', '    if (kv) out[kv[0]] = kv[1]', '  }', '  return out', '}',
    'const defaults = { retries: 3, timeout: 5000, verbose: false }', 'export const config = { ...defaults, ...process.env }', '// the end of the module',
    'if (require.main === module) console.log(await load(process.argv[2]))', 'export default Cache',
  ].join('\n')
  expect(isRepetitive(log)).toBe(true)
  expect(isRepetitive(code)).toBe(false)
  expect(isRepetitive('short')).toBe(false)
})

test('summarizes a listing as counts, a log as shapes plus rare lines', () => {
  const paths = Array.from({ length: 300 }, (_, i) => `deps/pkg_${i % 5}/lib/file_${i}.${i % 3 ? 'py' : 'txt'}`).join('\n')
  const tree = summarize('Bash', paths)
  expect(tree).toContain('300 paths')
  expect(tree).toContain('.py 200')
  expect(tree.length).toBeLessThan(1500)
  const log = [...Array.from({ length: 400 }, (_, i) => `PASS tests/t_${i}.py`), 'AssertionError: expected 10.05 got 10.04', ...Array.from({ length: 50 }, (_, i) => `PASS tests/u_${i}.py`)].join('\n')
  const s = summarize('Bash', log)
  expect(s).toContain('AssertionError: expected 10.05 got 10.04')
  expect(s).toContain('400×')
  expect(s.length).toBeLessThan(2500)
  const grep = Array.from({ length: 90 }, (_, i) => `src/m_${i % 3}.ts:${i}:  // TODO fix`).join('\n')
  expect(summarize('Grep', grep)).toContain('90 matches in 3 files')
})

test('a list of distinct names is still repetitive', () => {
  const names = Array.from({ length: 80 }, (_, i) => `${['numpy', 'torch', 'requests', 'click'][i % 4]}${'abcdefghij'[i % 10]}${'q'.repeat(i % 6)} ${i % 3}.${i % 7}.${i}`).join('\n')
  expect(isRepetitive(names)).toBe(true)
})

test('mcp results and playwright snapshots have their own limits', () => {
  expect(judgeSize('mcp', 2000, false)).toBe('pass')
  expect(judgeSize('mcp', 12000, false)).toBe('ask')
  expect(judgeSize('mcp', 40000, false)).toBe('ask')
  expect(judgeSize('mcp', 2000000, false)).toBe('compact')
  expect(judgeSize('ReadSnapshot', 12000, false)).toBe('ask')
  expect(judgeSize('Read', 12000, false)).toBe('pass')
})

test('signature keys a command on tool and subcommand', () => {
  expect(signature('cd repo && git log --stat -n 5')).toBe('git log')
  expect(signature('python3 -m pytest -q tests/')).toBe('python -m pytest')
  expect(signature('npm install --silent')).toBe('npm install')
  expect(signature('ls -la')).toBe('ls')
})

test('test output keeps failures and totals, drops passes', () => {
  const out = [...Array.from({ length: 300 }, (_, i) => `PASS tests/t_${i}.py::case_${i}`), 'FAIL tests/billing.py::refund', 'AssertionError: expected 10.05 got 10.04', '', '300 passed, 1 failed in 3.2s'].join('\n')
  const f = filterCommand('python -m pytest', out)!
  expect(f).toContain('AssertionError: expected 10.05 got 10.04')
  expect(f).toContain('300 passed, 1 failed')
  expect(f).not.toContain('t_150')
  expect(f.length).toBeLessThan(out.length / 5)
})

test('git log becomes one line per commit, patches are left alone', () => {
  const log = Array.from({ length: 50 }, (_, i) => `commit ${'a'.repeat(39)}${i % 10}\nAuthor: Mira Okafor <m@x.io>\nDate:   Sun Oct 4 10:00:00 2026 +0200\n\n    change number ${i}\n`).join('\n')
  const f = filterCommand('git log', log)!
  expect(f).toContain('50 commits')
  expect(f).toContain('Mira Okafor: change number 7')
  expect(filterCommand('git log -p', `${log}\ndiff --git a/x b/x\n+code`)).toBeUndefined()
})

test('installs keep warnings and the summary', () => {
  const log = [...Array.from({ length: 200 }, (_, i) => `Downloading package_${i}-1.0.tar.gz (12 kB)`), 'WARNING: package_7 is deprecated', 'Successfully installed 200 packages'].join('\n')
  const f = filterCommand('pip install -r requirements.txt', log)!
  expect(f).toContain('WARNING: package_7 is deprecated')
  expect(f).toContain('Successfully installed 200 packages')
  expect(f).not.toContain('package_100-1.0')
  expect(filterCommand('ls -la', log)).toBeUndefined()
})

test('an unnamed test script is recognised by its output', () => {
  const out = [...Array.from({ length: 100 }, (_, i) => `PASS tests/t_${i}.py`), 'FAIL tests/x.py::y', 'AssertionError: boom'].join('\n')
  expect(filterCommand('sh run_tests.sh', out)).toContain('AssertionError: boom')
  expect(filterCommand('sh run_tests.sh', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'))).toBeUndefined()
})

test('a failure header does not drag passing lines along', () => {
  const out = ['Error: Exit code 1', ...Array.from({ length: 200 }, (_, i) => `PASS tests/t_${i}.py`), 'done'].join('\n')
  const f = filterCommand('sh run_tests.sh', out)!
  expect(f).toContain('Error: Exit code 1')
  expect(f).not.toContain('t_3.py')
})

test('skipped tests survive the test filter', () => {
  const out = [...Array.from({ length: 200 }, (_, i) => `test_${i} (tests.test_more.Case.test_${i}) ... ok`), "test_x (tests.test_more.Case.test_x) ... skipped 'needs numpy'", 'Ran 201 tests in 1.0s', 'OK (skipped=1)'].join('\n')
  const f = filterCommand('python3 -m unittest discover -s tests -v', out)!
  expect(f).toContain("skipped 'needs numpy'")
  expect(f).toContain('Ran 201 tests')
  expect(f).not.toContain('test_150 ')
})
