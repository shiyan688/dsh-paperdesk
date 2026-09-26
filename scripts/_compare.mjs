/**
 * Structural comparison of every client module inside the served bundle (ASCII-only).
 *
 * All modules are concatenated into one script; each starts with
 * `window.__ModuleLoader__.load({`. Splitting on that marker gives one segment per
 * module, whose head carries the id and whose tail carries how the factory finishes.
 * Comparing a broken module against the working ones should show the difference.
 */

import { readFileSync } from 'node:fs'

const text = readFileSync(process.argv[2] ?? '.test-tmp/bundle.js', 'utf8')
const MARK = 'window.__ModuleLoader__.load({'

const segments = []
let index = text.indexOf(MARK)
while (index >= 0) {
  segments.push({ start: index, body: text.slice(index) })
  index = text.indexOf(MARK, index + MARK.length)
}

console.log('modules found:', segments.length)
console.log('')

const INTERESTING = [
  '@deepseek-ai/dsh-client-ui-brand-official',
  'dsh-novel-craft',
  'dsh-taste-loop',
  'dsh-paperdesk',
]

for (let i = 0; i < segments.length; i += 1) {
  const body = segments[i].body
  const end = i + 1 < segments.length ? segments[i + 1].start - segments[i].start : body.length
  const one = body.slice(0, end)
  const idMatch = one.match(/id:\s*["']([^"']+)["']/)
  const id = idMatch ? idMatch[1] : '(no id)'
  if (!INTERESTING.includes(id)) continue

  const head = one.slice(0, 220).replace(/\s+/g, ' ')
  const tail = one.slice(-420).replace(/\s+/g, ' ')
  console.log('==================================================')
  console.log('id       :', id)
  console.log('length   :', one.length, 'chars')
  console.log('head     :', head)
  console.log('tail     :', tail)
  console.log('')
}
