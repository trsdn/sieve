// Does the line-shape rule tell repetitive output (1) from distinct content (0)? No model involved.
// node --experimental-strip-types eval/rule_eval.mjs
import { readFileSync } from 'node:fs'
import { isRepetitive, lineShape, summarize } from '../hooks/lib.ts'

const samples = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url)))
let right = 0
for (const s of samples) {
  const said = isRepetitive(s.text) ? 1 : 0
  right += said === s.label
  if (said !== s.label) console.log('MISS', s.label, s.tool, s.desc.slice(0, 50), JSON.stringify(lineShape(s.text)))
}
console.log(`rule accuracy ${right}/${samples.length}`)
const verbose = samples.filter(s => s.label === 1)
const ratio = verbose.map(s => summarize(s.tool, s.text).length / s.text.length)
console.log(`summary size on repetitive samples: median ${(ratio.sort()[ratio.length >> 1] * 100).toFixed(0)}% of the original`)
