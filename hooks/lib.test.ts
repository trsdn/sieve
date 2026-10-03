import { test, expect } from 'claude-code/testing'
import { buildSnapshot, chunkText, ftsQuery, headTail, interpreter, isBulkyCommand, isRawFetch, sqlQuote } from './lib'

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
