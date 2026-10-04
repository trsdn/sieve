import { test, expect } from 'claude-code/testing'
import { buildSnapshot, chunkText, compactText, judgeSize, ftsQuery, headTail, interpreter, isBulkyCommand, isRawFetch, sqlQuote } from './lib'

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
  expect(judgeSize('Bash', 20000, true)).toBe('compact')
  expect(judgeSize('Bash', 6000, false, 0.5)).toBe('compact')
  expect(judgeSize('Edit', 999999, false)).toBe('pass')
})

test('fts query joins terms with the asked operator', () => {
  expect(ftsQuery('log line 22222', 'AND')).toBe('"log" AND "line" AND "22222"')
  expect(ftsQuery('log line')).toBe('"log" OR "line"')
})
