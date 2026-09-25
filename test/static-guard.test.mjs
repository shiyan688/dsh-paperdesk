/**
 * 仓库级静态守卫。
 *
 * 这些断言与运行时行为无关，守的是**打包与架构的不变量**：
 * 发布出去的包里该有的文件有没有、组合配置里的键名对不对、两个半区有没有越界、
 * 版本号有没有两处不一致、core 层有没有偷偷依赖 DSH。
 *
 * 它们坏掉的时候往往没有任何报错 —— 只有用户装不上、或者配置改了没反应。
 * 所以宁可在这里多钉几条。
 */

import { strict as assert } from 'node:assert'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (relative) => readFile(join(root, relative), 'utf8')
const exists = (relative) => stat(join(root, relative)).then(() => true, () => false)

async function readJson(relative) {
  return JSON.parse(await read(relative))
}

async function coreFiles() {
  const entries = await readdir(join(root, 'lib', 'core'))
  return entries.filter((name) => name.endsWith('.js')).sort()
}

test('package.json：必填字段与 DSH 清单完整', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.name, 'dsh-paperdesk')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.engines.node, '>=20', '依赖全局 fetch，必须声明 Node 下限')
  assert.equal(pkg.private, false, '开源包不能是 private')

  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'client.inject 必须是数组（可以为空）')

  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools']) {
    assert.ok(pkg.peerDependencies[name] !== undefined, `peerDependencies 必须声明 ${name}`)
  }
})

test('package.json：每个 exports 目标都真实存在', async () => {
  const pkg = await readJson('package.json')
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === 'string' ? value : value.default
    assert.ok(await exists(target), `exports["${key}"] 指向的文件不存在：${target}`)
  }
})

test('package.json：files 覆盖运行时必需的一切', async () => {
  const pkg = await readJson('package.json')
  const files = pkg.files.join(' ')
  for (const required of ['lib/', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(required), `files 必须包含 ${required}，否则 npm 包里会缺文件`)
  }
  // 文档类文件也应当进包，用户在 npm 页面上要能直接读到
  for (const doc of ['README.md', 'README.en.md', 'COMPATIBILITY.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(await exists(doc), `缺少文档：${doc}`)
  }
})

test('cordis.patch.yml：行 id 与包名一致，config 键都在 schema 里', async () => {
  const pkg = await readJson('package.json')
  const patch = await read('cordis.patch.yml')

  assert.match(patch, new RegExp(`id:\\s*${pkg.name.replace('.', '\\.')}\\b`), 'patch 里的行 id 必须等于包名')
  assert.match(patch, new RegExp(`name:\\s*'${pkg.name.replace('.', '\\.')}'`), "patch 里的 name 必须能解析到这个包")

  // 取出 config 块下的键名
  const known = ['root', 'pdfCommand', 'pythonCommand', 'requestTimeoutMs', 'maxSearchResults', 'registerTools', 'registerApi']
  const configBlock = patch.split(/^\s*config:\s*$/m)[1]
  if (configBlock !== undefined) {
    const keys = [...configBlock.matchAll(/^\s{6,}([A-Za-z][\w]*):/gm)].map((m) => m[1])
    for (const key of keys) {
      assert.ok(known.includes(key), `patch 里的配置键 ${key} 不被 Config schema 认识（改了也不会生效）`)
    }
  }
})

test('lib/index.js：导出 name / Config / apply，且 name 与包名一致', async () => {
  const pkg = await readJson('package.json')
  const source = await read('lib/index.js')
  assert.match(source, /export const name = '([^']+)'/, '必须导出 name')
  assert.equal(source.match(/export const name = '([^']+)'/)[1], pkg.name)
  assert.match(source, /export const Config = /, '必须导出 Config（否则组合配置不被校验）')
  assert.match(source, /export async function apply\(/, '必须导出 apply')
})

test('两处版本号必须一致（package.json vs compat.PLUGIN_VERSION）', async () => {
  const pkg = await readJson('package.json')
  const compat = await read('lib/core/compat.js')
  const declared = compat.match(/export const PLUGIN_VERSION = '([^']+)'/)[1]
  assert.equal(declared, pkg.version, 'PLUGIN_VERSION 与 package.json 版本号漂移了（/health 会报错版本）')
})

test('宿主半区不碰浏览器全局，浏览器半区不碰 node', async () => {
  const hostSources = [['lib/index.js', await read('lib/index.js')]]
  for (const name of await coreFiles()) hostSources.push([`lib/core/${name}`, await read(`lib/core/${name}`)])

  for (const [name, source] of hostSources) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/\bwindow\./.test(code), `${name} 不应使用 window`)
    assert.ok(!/\bdocument\./.test(code), `${name} 不应使用 document`)
    assert.ok(!code.includes('__ModuleLoader__'), `${name} 不应引用浏览器模块加载器`)
    assert.ok(!/\beval\(/.test(code), `${name} 不应使用 eval`)
    assert.ok(!/new Function\(/.test(code), `${name} 不应使用 new Function`)
  }

  const client = await read('lib/client.js')
  assert.ok(!/\bfrom\s*['"]node:/.test(client), 'lib/client.js 不应 import node 内置模块')
  assert.ok(!/require\(\s*['"]node:/.test(client), 'lib/client.js 不应 require node 内置模块')
})

test('core 层不依赖任何 @deepseek-ai 包（这样才能独立单测）', async () => {
  for (const name of await coreFiles()) {
    const source = await read(`lib/core/${name}`)
    // 只看代码：注释里提到包名是说明文档，不是依赖
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      !/from\s+'@deepseek-ai\//.test(code) && !/import\('@deepseek-ai\//.test(code),
      `lib/core/${name} 引入了 @deepseek-ai 依赖，core 层必须保持零外部依赖`,
    )
  }
})

test('core 层内部引用全部指向真实存在的文件，且没有孤儿模块', async () => {
  const files = await coreFiles()
  const imported = new Set()

  const scan = (source) => {
    // lib/index.js 用 './core/x.js'，core 内部用 './x.js'，两种都要认
    for (const match of source.matchAll(/from\s+'\.\/(?:core\/)?([\w.-]+)\.js'/g)) imported.add(`${match[1]}.js`)
  }
  scan(await read('lib/index.js'))
  for (const name of files) scan(await read(`lib/core/${name}`))

  for (const target of imported) {
    assert.ok(files.includes(target), `引用了不存在的模块：lib/core/${target}`)
  }
  const orphans = files.filter((name) => !imported.has(name))
  assert.deepEqual(orphans, [], `以下模块没有任何引用者，可能是改名后的残留：${orphans.join(', ')}`)
})

test('README 与 COMPATIBILITY 说明关键事实，不许留空壳', async () => {
  const readme = await read('README.md')
  for (const needle of ['dsh plugin', 'cordis.patch.yml', 'paper_search', '三层', 'peerDependencies']) {
    assert.ok(readme.includes(needle), `README 必须说明 ${needle}`)
  }
  const compat = await read('COMPATIBILITY.md')
  assert.ok(compat.includes('0.1.5-rc.2'), 'COMPATIBILITY 必须写明实测版本')
  assert.ok(/ctx\.tools|tools/.test(compat), 'COMPATIBILITY 必须列出依赖的服务')
})

test('CHANGELOG 记录当前版本', async () => {
  const pkg = await readJson('package.json')
  const changelog = await read('CHANGELOG.md')
  assert.ok(changelog.includes(pkg.version), `CHANGELOG 缺少 ${pkg.version} 的条目`)
})

test('LICENSE 是 MIT 且年份/作者占位已填', async () => {
  const license = await read('LICENSE')
  assert.match(license, /MIT License/)
  assert.ok(!license.includes('<YEAR>') && !license.includes('<AUTHOR>'), 'LICENSE 里还有未替换的占位符')
})
