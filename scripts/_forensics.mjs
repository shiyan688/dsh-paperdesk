/**
 * Deeper bundle forensics (ASCII-only source).
 *
 * Questions:
 *  1. Is the bundle truncated at the end (a truncated tail would be a parse error and
 *     would kill every module, so this also tells us whether that theory is dead)?
 *  2. In which ORDER do modules register, and where does dsh-paperdesk sit?
 *     If modules AFTER ours do appear in the UI, then a load-time abort is ruled out.
 *  3. Does the extracted segment of our module parse as valid JS on its own?
 */

import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2] ?? '.test-tmp/bundle.js'
const text = readFileSync(path, 'utf8')

console.log('=== 1. tail of the bundle (truncation check) ===')
console.log(JSON.stringify(text.slice(-260)))
console.log('')

console.log('=== 2. registration order (id: "..." in bundle order) ===')
const ids = [...text.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1])
console.log('  total registrations found:', ids.length)
ids.forEach((id, i) => {
  const flag = id === 'dsh-paperdesk' ? '   <<< OURS' : ''
  console.log(`  ${String(i + 1).padStart(3)}. ${id}${flag}`)
})

console.log('')
console.log('=== 3. extract our module segment and syntax-check it ===')
const MARK = 'dsh-paperdesk \u2014 \u6d4f\u89c8\u5668\u534a\u533a' // "dsh-paperdesk — browser half"
const start = text.indexOf(MARK)
if (start < 0) {
  console.log('  marker comment not found; falling back to the load() call')
}
const loadAt = text.indexOf("window.__ModuleLoader__.load({", Math.max(0, start - 50))
console.log('  segment starts at char', loadAt, 'of', text.length)

// find the matching end: our module is followed by the next module's comment or EOF.
// Simply take everything from loadAt and let node's parser tell us if it is complete.
const segment = text.slice(loadAt)
console.log('  segment length:', segment.length)
const candidate = '.test-tmp/segment.mjs'
writeFileSync(candidate, segment, 'utf8')
console.log('  written to', candidate)
console.log('')
console.log('  --- last 200 chars of the segment ---')
console.log(JSON.stringify(segment.slice(-200)))
