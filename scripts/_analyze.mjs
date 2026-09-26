/**
 * Analyze the served client bundle (ASCII-only source: PowerShell mangles non-ASCII
 * in inline scripts, so CJK markers use \u escapes).
 *
 * The question this answers: is the plugin's ACTUAL CODE inside the bundle, or does
 * the bundle merely contain the module id in the loader's registry table?
 */

import { readFileSync, statSync } from 'node:fs'

const path = process.argv[2] ?? '.test-tmp/bundle.js'

let text
try {
  text = readFileSync(path, 'utf8')
} catch (error) {
  console.log('cannot read bundle:', error.message)
  process.exit(0)
}

console.log('bundle file   :', path, statSync(path).size, 'bytes,', text.length, 'chars')
console.log('')

// CJK written as escapes so this file stays pure ASCII
const PANEL_TITLE = '\u8bba\u6587\u5de5\u4f5c\u53f0' // "paper workbench" (panel heading)
const SIDEBAR_LABEL = '\uD83D\uDCDA \u8bba\u6587' // book emoji + "papers"

const markers = [
  ['loader wrapper            ', '__ModuleLoader__'],
  ['my api prefix             ', 'paperdesk/api'],
  ['my panel title (CJK)      ', PANEL_TITLE],
  ['my sidebar label (emoji)  ', SIDEBAR_LABEL],
  ['my slot name              ', 'sidebar.footer.action'],
  ['my plugin id              ', 'dsh-paperdesk'],
  ['taste-loop api (control)  ', 'taste-loop/api'],
  ['novel-craft (control)     ', 'novel-craft'],
]

for (const [label, needle] of markers) {
  const at = text.indexOf(needle)
  console.log(`  ${at >= 0 ? 'YES' : 'no '}  ${label}  ${at >= 0 ? `(first at char ${at})` : ''}`)
}

console.log('')
for (const needle of ['dsh-paperdesk', 'paperdesk/api']) {
  const at = text.indexOf(needle)
  if (at < 0) continue
  const from = Math.max(0, at - 500)
  console.log(`---- window around "${needle}" (chars ${from}..${from + 1100}) ----`)
  console.log(text.slice(from, from + 1100))
  console.log('---- end ----')
  console.log('')
}

// Where does our module sit relative to the modules the loader actually instantiates?
const registryHits = [...text.matchAll(/dsh-paperdesk/g)].length
console.log('occurrences of "dsh-paperdesk":', registryHits)
