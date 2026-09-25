/**
 * 宿主半区的集成测试：**真** service + **真** 文件系统 + **假** HTTP 与网络。
 *
 * 这一层是把「能跑」和「看起来能跑」区分开的地方：
 * 路由、服务、文库落盘三段真正串起来跑一遍，只有 arXiv 与 PDF 工具是假的
 * （那两样在单测里已经各自覆盖）。所以这里挂掉就意味着插件在真实宿主里也会挂。
 */

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { API_PREFIX, MAX_BODY_BYTES, buildRoutes, createApiHandler, isLoopback, parseTags } from '../lib/core/api.js'
import { resolveOptions } from '../lib/core/config.js'
import { createService } from '../lib/core/service.js'
import { createStore } from '../lib/core/store.js'
import { callRoute } from './helpers/http.mjs'
import { withTmpDir } from './helpers/tmp.mjs'

const FEED = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>The Transformer.</summary>
    <author><name>Ashish Vaswani</name></author>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7"/>
  </entry>
</feed>`

/**
 * 起一套「真 service + 假网络」的 API。
 * @param {string} dir
 * @param {{ feed?: string, fetchError?: Error }} [input]
 */
async function setup(dir, input = {}) {
  const options = resolveOptions({ root: dir }, { cwd: dir })
  const store = createStore({ paths: options })
  const fetchImpl = async (url) => {
    if (input.fetchError !== undefined) throw input.fetchError
    if (String(url).includes('export.arxiv.org')) return { ok: true, status: 200, text: async () => input.feed ?? FEED }
    return { ok: false, status: 404, text: async () => 'nope' }
  }
  const service = createService({
    store,
    options,
    extractor: { kind: 'none', command: '', engine: '', note: '测试环境无抽取器' },
    deps: { fetchImpl },
    log: () => {},
  })
  await service.ensureLayout()
  const handler = createApiHandler({
    service,
    health: () => ({ ok: true, plugin: 'dsh-paperdesk', root: options.root }),
    log: () => {},
  })
  return { handler, service, options, store }
}

test('isLoopback 认 IPv4、IPv6 与 IPv4-mapped', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.5' } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.7' } }), false)
  assert.equal(isLoopback({ socket: { remoteAddress: '10.0.0.1' } }), false)
  assert.equal(isLoopback({}), false)
})

test('parseTags 认中英文逗号分号，去重前先 trim', () => {
  assert.deepEqual(parseTags('a, b，c；d;e'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(parseTags([' x ', '', 'y']), ['x', 'y'])
  assert.deepEqual(parseTags(''), [])
  assert.deepEqual(parseTags(undefined), [])
})

test('buildRoutes 覆盖全部端点，且每个都返回数据', async () => {
  await withTmpDir(async (dir) => {
    const { service } = await setup(dir)
    const routes = buildRoutes(service, { health: () => ({ ok: true }) })
    assert.deepEqual(Object.keys(routes).sort(), [
      'GET /health', 'GET /state',
      'POST /add', 'POST /detail', 'POST /download', 'POST /extract', 'POST /import',
      'POST /notes', 'POST /remove', 'POST /reveal', 'POST /scan', 'POST /search', 'POST /text', 'POST /update',
    ])
  }, 'api-routes')
})

test('空文库：GET /state 返回根目录与零统计', async () => {
  await withTmpDir(async (dir) => {
    const { handler } = await setup(dir)
    const { status, json, headers } = await callRoute(handler, { method: 'GET', url: API_PREFIX + '/state' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.deepEqual(json.stats, { total: 0, unread: 0, reading: 0, read: 0, pdf: 0, text: 0, noted: 0 })
    assert.deepEqual(json.papers, [])
    assert.match(headers['content-type'], /application\/json/)
    assert.equal(headers['cache-control'], 'no-store')
  }, 'api-empty')
})

test('非本机请求一律 403（这个 API 能读写你的磁盘）', async () => {
  await withTmpDir(async (dir) => {
    const { handler } = await setup(dir)
    const { status, json } = await callRoute(handler, { method: 'GET', url: API_PREFIX + '/state', remoteAddress: '192.168.1.9' })
    assert.equal(status, 403)
    assert.match(json.error, /只接受本机/)
  }, 'api-403')
})

test('未知端点 404，并把可用端点列出来', async () => {
  await withTmpDir(async (dir) => {
    const { handler } = await setup(dir)
    const unknown = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/nope', body: {} })
    assert.equal(unknown.status, 404)
    assert.ok(unknown.json.routes.includes('POST /search'))

    // 方法不对也算未知端点
    const wrongMethod = await callRoute(handler, { method: 'GET', url: API_PREFIX + '/add' })
    assert.equal(wrongMethod.status, 404)
  }, 'api-404')
})

test('search → add → detail → notes → update → remove 全链路走通', async () => {
  await withTmpDir(async (dir) => {
    const { handler, options } = await setup(dir)

    // 1. 检索
    const search = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/search', body: { query: 'attention', max: 3 } })
    assert.equal(search.status, 200)
    assert.equal(search.json.count, 1)
    assert.equal(search.json.results[0].baseId, '1706.03762')

    // 2. 入库（仅题录，避免依赖本机 PDF 工具）
    const add = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/add', body: { arxivId: '1706.03762', download: false } })
    assert.equal(add.status, 200)
    assert.equal(add.json.paper.id, '1706.03762')
    assert.equal(add.json.pdf, false)

    // 3. 索引真的落到磁盘上了
    const index = JSON.parse(await readFile(options.indexPath, 'utf8'))
    assert.equal(index.version, 1)
    assert.equal(index.papers.length, 1)
    assert.equal(index.papers[0].title, 'Attention Is All You Need')

    // 4. 列表能看见
    const state = await callRoute(handler, { method: 'GET', url: API_PREFIX + '/state' })
    assert.equal(state.json.papers.length, 1)
    assert.equal(state.json.stats.unread, 1)

    // 5. 详情
    const detail = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/detail', body: { id: '1706.03762' } })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.paper.abstract, 'The Transformer.')
    assert.equal(detail.json.progress.filled, 0)

    // 6. 写三层笔记 → markdown 镜像必须出现
    const notes = await callRoute(handler, {
      method: 'POST',
      url: API_PREFIX + '/notes',
      body: { id: '1706.03762', notes: { quick: 'L1 内容', understand: 'L2 内容', critique: 'L3 内容' } },
    })
    assert.equal(notes.status, 200)
    assert.equal(notes.json.progress.done, true)
    const markdown = await readFile(join(options.notesDir, '1706.03762.md'), 'utf8')
    assert.match(markdown, /## L1 速览[\s\S]*L1 内容/)
    assert.match(markdown, /## L2 理解[\s\S]*L2 内容/)
    assert.match(markdown, /## L3 批判[\s\S]*L3 内容/)
    assert.match(markdown, /## 摘要（原文）[\s\S]*The Transformer\./)

    // 7. 改状态与评级（改状态也会刷新 markdown 头部的元信息）
    const update = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/update', body: { id: '1706.03762', patch: { status: '已读', rating: 5, tags: ['transformer'] } } })
    assert.equal(update.status, 200)
    assert.equal(update.json.paper.status, 'read')
    assert.equal(update.json.paper.rating, 5)
    const refreshed = await readFile(join(options.notesDir, '1706.03762.md'), 'utf8')
    assert.match(refreshed, /- 状态: 已读 · 评级: ★★★★★/)
    assert.match(refreshed, /- 标签: transformer/)

    // 8. 移出文库：索引清空，PDF/文本/笔记文件也被删
    const removed = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/remove', body: { id: '1706.03762' } })
    assert.equal(removed.status, 200)
    const after = await callRoute(handler, { method: 'GET', url: API_PREFIX + '/state' })
    assert.equal(after.json.papers.length, 0)
    await assert.rejects(() => readFile(join(options.notesDir, '1706.03762.md'), 'utf8'))
  }, 'api-flow')
})

test('错误以 400 + 人话返回，而不是 500 堆栈', async () => {
  await withTmpDir(async (dir) => {
    const { handler } = await setup(dir)

    const missing = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/detail', body: { id: 'nope' } })
    assert.equal(missing.status, 400)
    assert.match(missing.json.error, /未找到论文/)

    // 没有 PDF 时读全文要把下一步说清楚
    const add = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/add', body: { arxivId: '1706.03762', download: false } })
    assert.equal(add.status, 200)
    const text = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/text', body: { id: '1706.03762' } })
    assert.equal(text.status, 400)
    // 具体原因取决于本机有没有抽取器、下载能不能成，但必须是**人话**且指出下一步
    assert.match(text.json.error, /还没有 PDF|没有可用的 PDF 抽取器|下载失败/)

    // arXiv 挂了也要是人话
    const broken = await withTmpDir(async (dir2) => {
      const other = await setup(dir2, { fetchError: new Error('ENOTFOUND export.arxiv.org') })
      return callRoute(other.handler, { method: 'POST', url: API_PREFIX + '/search', body: { query: 'x' } })
    }, 'api-broken')
    assert.equal(broken.status, 400)
    assert.match(broken.json.error, /ENOTFOUND/)
  }, 'api-errors')
})

test('请求体不是 JSON / 过大 / 空体都能被收敛', async () => {
  await withTmpDir(async (dir) => {
    const { handler } = await setup(dir)

    const malformed = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/scan', body: '{not json' })
    assert.equal(malformed.status, 413)
    assert.match(malformed.json.error, /合法 JSON/)

    const huge = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/scan', body: 'x'.repeat(MAX_BODY_BYTES + 1024) })
    assert.equal(huge.status, 413)
    assert.match(huge.json.error, /超过/)

    // 空体按 {} 处理：scan 用默认目录
    const empty = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/scan', body: '' })
    assert.equal(empty.status, 200)
    assert.equal(empty.json.ok, true)
  }, 'api-body')
})

test('scan 能扫出目录里的 PDF（跳过隐藏目录与 node_modules）', async () => {
  await withTmpDir(async (dir) => {
    const { handler } = await setup(dir)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'papers', 'deep'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await mkdir(join(dir, '.hidden'), { recursive: true })
    await writeFile(join(dir, 'papers', 'a.pdf'), '%PDF-1.4')
    await writeFile(join(dir, 'papers', 'deep', 'b.pdf'), '%PDF-1.4')
    await writeFile(join(dir, 'papers', 'notes.txt'), 'x')
    await writeFile(join(dir, 'node_modules', 'c.pdf'), '%PDF-1.4')
    await writeFile(join(dir, '.hidden', 'd.pdf'), '%PDF-1.4')

    const scan = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/scan', body: { dir } })
    assert.equal(scan.status, 200)
    const names = scan.json.files.map((f) => f.name).sort()
    assert.deepEqual(names, ['a.pdf', 'b.pdf'])
  }, 'api-scan')
})

test('health 端点把宿主状态原样透出', async () => {
  await withTmpDir(async (dir) => {
    const { handler } = await setup(dir)
    const { status, json } = await callRoute(handler, { method: 'GET', url: API_PREFIX + '/health' })
    assert.equal(status, 200)
    assert.equal(json.plugin, 'dsh-paperdesk')
    assert.equal(json.root, dir)
  }, 'api-health')
})
