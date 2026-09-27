/**
 * 模型工具层的单测。
 *
 * 两条注册路径都要测：
 *  1. 有 `defineTool`（正常情况）—— 断言我们把作者视角的 spec 原样交给它；
 *  2. 没有 `defineTool`（peer dependency 缺失的降级）—— 断言本地编译器产出的
 *     确实是合法 JSON Schema，且 `required` / `enum` / 嵌套对象都正确。
 *
 * 第 2 条容易被忽略，但它正是「peer 包改名了插件还能用」这个承诺的实现处。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { TOOL_NAMES, compileParameterSpec, compileValueSpec, createToolDefinitions } from '../lib/core/tools.js'

/** 记录调用的假 defineTool。 */
function spyDefineTool() {
  const calls = []
  const defineTool = (spec) => { calls.push(spec); return { ...spec, __defined: true } }
  defineTool.calls = calls
  return defineTool
}

/** 一个够用的假 service；每个方法记录调用参数并返回形状正确的数据。 */
function fakeService(overrides = {}) {
  const calls = []
  const base = {
    options: { root: 'D:/lib' },
    async search(query, max) {
      calls.push(['search', query, max])
      return {
        count: 1,
        results: [{
          baseId: '1706.03762',
          arxivId: '1706.03762v7',
          title: 'Attention Is All You Need',
          authors: ['A', 'B', 'C', 'D', 'E'],
          abstract: 'x'.repeat(400),
          published: '2017-06-12',
          primaryCategory: 'cs.CL',
          url: 'https://arxiv.org/abs/1706.03762v7',
        }],
      }
    },
    async add(arxivId, options) {
      calls.push(['add', arxivId, options])
      return {
        existed: false,
        pdf: true,
        text: true,
        warning: '',
        paper: { id: '1706.03762', title: 'Attention Is All You Need', authors: ['A'], published: '2017-06-12', primaryCategory: 'cs.CL', pdfPath: 'pdf/1706.03762.pdf', textPath: 'text/1706.03762.txt', textChars: 100, pages: 3, notes: { quick: '', understand: '', critique: '' }, status: 'unread', rating: 0 },
      }
    },
    async list(input) {
      calls.push(['list', input])
      return {
        total: 1,
        stats: { total: 1, unread: 1, reading: 0, read: 0, pdf: 1, text: 1, noted: 0 },
        rows: [{ id: '1706.03762', title: 'Attention', authors: ['A'], year: '2017', status: 'unread', tags: ['t'], hasPdf: true, hasText: true, hasNote: false }],
      }
    },
    async read(id, input) {
      calls.push(['read', id, input])
      return { paper: { id: '1706.03762', title: 'Attention' }, text: 'FULL TEXT', total: 9, offset: 0 }
    },
    async saveNotes(id, notes) {
      calls.push(['saveNotes', id, notes])
      return { paper: { id: '1706.03762', title: 'Attention', notes: { quick: notes.quick ?? '', understand: notes.understand ?? '', critique: notes.critique ?? '' }, status: 'unread', rating: 0 } }
    },
    async update(id, patch) {
      calls.push(['update', id, patch])
      return { paper: { id: '1706.03762', title: 'Attention', notes: { quick: 'q', understand: '', critique: '' }, status: 'read', rating: 4 } }
    },
    async download(id) {
      calls.push(['download', id])
      return { paper: { id: '1706.03762', pdfPath: 'pdf/x.pdf' }, bytes: 2048 }
    },
    async extract(id) {
      calls.push(['extract', id])
      return { paper: { id: '1706.03762', textPath: 'text/x.txt' }, engine: 'pymupdf', pages: 3, chars: 999 }
    },
    async importPdf(path) {
      calls.push(['importPdf', path])
      return { existed: false, warning: '', paper: { id: 'local-1', title: 'Imported', pages: 7, textChars: 500 } }
    },
  }
  return { service: { ...base, ...overrides }, calls }
}

test('compileParameterSpec：required / enum / 嵌套对象 / 数组都编译正确', () => {
  const schema = compileParameterSpec({
    plain: { type: 'string', description: 'd' },
    need: { type: 'integer', required: true },
    pick: { type: 'string', enum: ['a', 'b'] },
    list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { k: { type: 'string', required: true } } } },
  })
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['need'])
  assert.deepEqual(schema.properties.plain, { type: 'string', description: 'd' })
  assert.deepEqual(schema.properties.need, { type: 'integer' })
  assert.deepEqual(schema.properties.pick.enum, ['a', 'b'])
  assert.equal(schema.properties.list.type, 'array')
  assert.equal(schema.properties.list.items.type, 'object')
  assert.equal(schema.properties.list.items.additionalProperties, false)
  assert.deepEqual(schema.properties.list.items.required, ['k'])
  // 空 spec 不该产出空 required 数组（有些校验器不喜欢）
  assert.equal(compileParameterSpec({}).required, undefined)
})

test('compileValueSpec 对未知形状保持宽容', () => {
  assert.deepEqual(compileValueSpec({}), {})
  assert.deepEqual(compileValueSpec(undefined), {})
  assert.equal(compileValueSpec({ type: 'object', properties: {} }).type, 'object')
})

test('有 defineTool 时把作者视角 spec 原样交给它', () => {
  const defineTool = spyDefineTool()
  const { service } = fakeService()
  const tools = createToolDefinitions({ service, defineTool })

  assert.equal(tools.length, TOOL_NAMES.length)
  assert.deepEqual(tools.map((t) => t.name), [...TOOL_NAMES])
  assert.equal(defineTool.calls.length, TOOL_NAMES.length)
  // 交给 defineTool 的必须是 spec（带 required 注解），不是编译后的 JSON Schema
  const search = defineTool.calls.find((c) => c.name === 'paper_search')
  assert.equal(search.parameters.query.required, true)
  assert.equal(search.output.schema.properties.text.required, true)
  assert.equal(typeof search.execute, 'function')
  assert.equal(typeof search.output.render, 'function')
})

test('没有 defineTool 时本地编译器产出合法 JSON Schema', () => {
  const { service } = fakeService()
  const tools = createToolDefinitions({ service, defineTool: undefined })
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} 的参数根必须是 object`)
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.ok(!('required' in tool.parameters) || Array.isArray(tool.parameters.required))
    assert.equal(tool.output.schema.type, 'object')
    assert.deepEqual(tool.output.schema.required, ['text'])
    assert.equal(typeof tool.execute, 'function')
  }
  // 每个工具都必须写清用途，否则模型不知道什么时候用
  for (const tool of tools) assert.ok(tool.description.length > 20, `${tool.name} 的描述太短`)
})

test('每个工具 execute 都把参数正确转交给 service，并返回 { text }', async () => {
  const { service, calls } = fakeService()
  const tools = Object.fromEntries(createToolDefinitions({ service }).map((t) => [t.name, t]))

  const search = await tools.paper_search.execute({ query: 'attention', max: 3 })
  assert.ok(search.text.includes('1706.03762'))
  assert.ok(search.text.includes('paper_add'))
  assert.deepEqual(calls.at(-1), ['search', 'attention', 3])

  const add = await tools.paper_add.execute({ arxiv_id: '1706.03762', download: false, tags: 'a,b' })
  assert.ok(add.text.includes('已入库'))
  assert.deepEqual(calls.at(-1), ['add', '1706.03762', { download: false, tags: 'a,b' }])

  const list = await tools.paper_list.execute({ status: '未读', limit: 5 })
  assert.ok(list.text.includes('文库共 1 篇'))
  assert.equal(calls.at(-1)[1].status, '未读')

  const read = await tools.paper_read.execute({ id: '1706.03762', offset: 0, limit: 100 })
  assert.ok(read.text.includes('FULL TEXT'))
  assert.ok(read.text.includes('paper_note'))

  const note = await tools.paper_note.execute({ id: '1706.03762', quick: 'Q', understand: 'U', critique: 'C' })
  assert.ok(note.text.includes('3/3 层已写'))
  assert.deepEqual(calls.at(-1), ['saveNotes', '1706.03762', { quick: 'Q', understand: 'U', critique: 'C' }])

  const pdf = await tools.paper_pdf.execute({ id: '1706.03762' })
  assert.ok(pdf.text.includes('PDF 与全文已就绪'))

  const imported = await tools.paper_import.execute({ path: 'D:/a.pdf' })
  assert.ok(imported.text.includes('已导入'))
  assert.deepEqual(calls.at(-1), ['importPdf', 'D:/a.pdf'])
})

test('paper_note：没有内容也没有状态变更时明确拒绝', async () => {
  const { service, calls } = fakeService()
  const tools = Object.fromEntries(createToolDefinitions({ service }).map((t) => [t.name, t]))
  const result = await tools.paper_note.execute({ id: 'x' })
  assert.match(result.text, /未做修改/)
  assert.equal(calls.length, 0, '不该调用任何 service 方法')
})

test('paper_note：只给状态时走 update，不写笔记', async () => {
  const { service, calls } = fakeService()
  const tools = Object.fromEntries(createToolDefinitions({ service }).map((t) => [t.name, t]))
  const result = await tools.paper_note.execute({ id: 'x', status: 'read', rating: 4 })
  assert.deepEqual(calls.map((c) => c[0]), ['update'])
  assert.ok(result.text.includes('笔记已保存'))
})

test('paper_note：tags 字符串原样交给 update，空串不当清空', async () => {
  const seen = []
  const { service } = fakeService({
    async update(id, patch) {
      seen.push([id, patch])
      return {
        paper: {
          id,
          title: 'Attention',
          notes: { quick: 'q', understand: '', critique: '' },
          status: 'read',
          rating: 4,
          tags: ['教材', '可辨识性'],
        },
      }
    },
  })
  const tools = Object.fromEntries(createToolDefinitions({ service }).map((t) => [t.name, t]))

  const first = await tools.paper_note.execute({ id: 'x', tags: '教材,可辨识性' })
  assert.deepEqual(seen.at(-1), ['x', { status: undefined, rating: undefined, tags: '教材,可辨识性' }])
  assert.match(first.text, /标签：教材、可辨识性/, '标签有没有生效必须看得见，不能再静默')

  // 模型常给未使用的参数填 ''，那不该被当成「清空标签」抹掉用户手写的内容
  await tools.paper_note.execute({ id: 'x', status: 'read', tags: '' })
  assert.deepEqual(seen.at(-1), ['x', { status: 'read', rating: undefined, tags: undefined }])
})

test('render 把结构化结果转成文本块', async () => {
  const { service } = fakeService()
  const tools = createToolDefinitions({ service })
  const search = tools.find((t) => t.name === 'paper_search')
  const value = await search.execute({ query: 'x' })
  const blocks = search.output.render({ query: 'x' }, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, value.text)
})

test('检索无结果时给出可操作的下一步，而不是空字符串', async () => {
  const { service } = fakeService({ search: async () => ({ count: 0, results: [] }) })
  const tools = Object.fromEntries(createToolDefinitions({ service }).map((t) => [t.name, t]))
  const result = await tools.paper_search.execute({ query: 'zzz' })
  assert.match(result.text, /没有检索到/)
  assert.match(result.text, /arXiv 语法/)
})

test('读全文时把「还有多少字 / 已到末尾」说清楚', async () => {
  const { service } = fakeService({ read: async () => ({ paper: { id: 'a', title: 'T' }, text: 'PART', total: 100, offset: 0 }) })
  const tools = Object.fromEntries(createToolDefinitions({ service }).map((t) => [t.name, t]))
  const more = await tools.paper_read.execute({ id: 'a' })
  assert.match(more.text, /还有 96 字未返回/)
  assert.match(more.text, /offset=4/)

  const { service: done } = fakeService({ read: async () => ({ paper: { id: 'a', title: 'T' }, text: 'PART', total: 4, offset: 0 }) })
  const tools2 = Object.fromEntries(createToolDefinitions({ service: done }).map((t) => [t.name, t]))
  assert.match((await tools2.paper_read.execute({ id: 'a' })).text, /已到全文末尾/)
})
