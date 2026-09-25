/**
 * 配置解析与路径安全的单测。
 *
 * 这一层管的是「文件到底写到哪儿去了」。插件会往用户磁盘上写东西，
 * 路径解析错了是最难排查的一类问题，所以默认值、相对/绝对、越界钳制都逐条钉住。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isAbsolute } from 'node:path'

import { DEFAULT_ROOT_DIRNAME, MAX_SEARCH_LIMIT, buildConfigSchema, resolveOptions, validateImportPath } from '../lib/core/config.js'

const CWD = process.platform === 'win32' ? 'D:\\work' : '/work'

test('root 留空时落在 <cwd>/.dsh-paperdesk', () => {
  const options = resolveOptions({}, { cwd: CWD })
  assert.ok(options.root.endsWith(DEFAULT_ROOT_DIRNAME), options.root)
  assert.ok(isAbsolute(options.root))
})

test('相对 root 相对 cwd 解析，绝对 root 原样使用', () => {
  const relative = resolveOptions({ root: 'papers/lib' }, { cwd: CWD })
  assert.ok(relative.root.startsWith(CWD), relative.root)
  assert.ok(relative.root.includes('papers'))

  const absolute = process.platform === 'win32' ? 'E:\\papers' : '/mnt/papers'
  assert.equal(resolveOptions({ root: absolute }, { cwd: CWD }).root, absolute)
})

test('所有子目录都由 root 派生，不能各配各的', () => {
  const options = resolveOptions({ root: process.platform === 'win32' ? 'D:\\lib' : '/lib' }, { cwd: CWD })
  for (const key of ['stateDir', 'pdfDir', 'textDir', 'notesDir', 'toolsDir', 'indexPath', 'extractScriptPath']) {
    assert.ok(options[key].startsWith(options.root), `${key} 必须位于 root 之下：${options[key]}`)
  }
  assert.ok(options.indexPath.includes('index.json'))
  assert.ok(options.extractScriptPath.endsWith('.py'))
})

test('数值配置被夹到合理区间', () => {
  assert.equal(resolveOptions({ requestTimeoutMs: 1 }, { cwd: CWD }).requestTimeoutMs, 3000)
  assert.equal(resolveOptions({ requestTimeoutMs: 10 ** 9 }, { cwd: CWD }).requestTimeoutMs, 300000)
  assert.equal(resolveOptions({}, { cwd: CWD }).requestTimeoutMs, 30000)
  assert.equal(resolveOptions({ requestTimeoutMs: 'abc' }, { cwd: CWD }).requestTimeoutMs, 30000)
  assert.equal(resolveOptions({ maxSearchResults: 9999 }, { cwd: CWD }).maxSearchResults, MAX_SEARCH_LIMIT)
})

test('开关默认打开，显式 false 才关', () => {
  const defaults = resolveOptions({}, { cwd: CWD })
  assert.equal(defaults.registerTools, true)
  assert.equal(defaults.registerApi, true)
  assert.equal(resolveOptions({ registerTools: false }, { cwd: CWD }).registerTools, false)
  assert.equal(resolveOptions({ registerApi: false }, { cwd: CWD }).registerApi, false)
})

test('命令覆盖项被 trim，空串表示自动探测', () => {
  const options = resolveOptions({ pdfCommand: '  pdftotext  ', pythonCommand: '' }, { cwd: CWD })
  assert.equal(options.pdfCommand, 'pdftotext')
  assert.equal(options.pythonCommand, '')
})

test('buildConfigSchema 给出一份与 resolveOptions 默认值一致的 schema', () => {
  const z = {
    object: (shape) => ({ shape }),
    string: () => ({ type: 'string', default: (v) => ({ type: 'string', default: v }) }),
    number: () => ({ type: 'number', default: (v) => ({ type: 'number', default: v }) }),
    boolean: () => ({ type: 'boolean', default: (v) => ({ type: 'boolean', default: v }) }),
  }
  const schema = buildConfigSchema(z)
  assert.deepEqual(Object.keys(schema.shape).sort(), [
    'maxSearchResults', 'pdfCommand', 'pythonCommand', 'registerApi', 'registerTools', 'requestTimeoutMs', 'root',
  ])
  assert.equal(schema.shape.root.default, '')
  assert.equal(schema.shape.requestTimeoutMs.default, 30000)
  assert.equal(schema.shape.registerTools.default, true)
})

test('validateImportPath 只接受绝对路径', () => {
  const absolute = process.platform === 'win32' ? 'D:\\papers\\a.pdf' : '/papers/a.pdf'
  const relative = process.platform === 'win32' ? 'papers\\a.pdf' : 'papers/a.pdf'

  assert.deepEqual(validateImportPath(absolute), { ok: true, path: absolute })
  // 顺手去掉复制粘贴常见的外层引号
  assert.deepEqual(validateImportPath(`"${absolute}"`), { ok: true, path: absolute })

  assert.equal(validateImportPath('').ok, false)
  assert.match(validateImportPath(relative).error, /绝对路径/)
  assert.match(validateImportPath('a\0b').error, /非法字符/)
  assert.equal(validateImportPath(undefined).ok, false)
})
