/**
 * 宿主入口（lib/index.js）的接线测试。
 *
 * 用假 ctx 把 `apply()` 当普通函数跑：不启 DSH，但走的是**真实的注册路径** ——
 * 服务解析、工具注册、路由注册、配置解析、目录创建全都要真的发生，
 * 然后拿注册到的 handler 打一遍请求，验证「装进宿主以后能不能用」。
 *
 * 这是本地能拿到的最接近真实挂载的证据；真正的 `dsh` 挂载仍要在 profile 里做一次
 * （README 的验证清单）。
 *
 * `lib/index.js` 静态 import 了 `@deepseek-ai/schemastery`（peer dependency）。
 * 裸克隆仓库时它可能不在，此时整组接线测试**如实跳过**并说明要先 `npm install`，
 * 而不是伪装成通过、也不是让整个文件报错。
 */

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { API_PREFIX } from '../lib/core/api.js'
import { PLUGIN_VERSION } from '../lib/core/compat.js'
import { TOOL_NAMES } from '../lib/core/tools.js'
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
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7"/>
  </entry>
</feed>`

/**
 * 造一个假的宿主 context。
 * @param {{ tools?: any, webServer?: any }} [services]
 */
function fakeCtx(services = {}) {
  const state = { tools: [], routes: [], disposers: [] }
  const tools = services.tools === false ? undefined : {
    register(definition) {
      state.tools.push(definition)
      return () => {}
    },
  }
  const webServer = services.webServer === false ? undefined : {
    register(route) {
      state.routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    get: (key) => ({ tools, webServer })[key],
    // 真实的 Cordis inject：服务已在时同步回调
    inject: (keys, callback) => {
      const ready = {}
      for (const key of keys) ready[key] = { tools, webServer }[key]
      callback(ready)
    },
    effect: (fn) => {
      const disposer = fn()
      state.disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, state }
}

/** 允许测试替换全局 fetch，结束后恢复。 */
async function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

const arxivFetch = async (url) => {
  if (String(url).includes('export.arxiv.org')) return { ok: true, status: 200, text: async () => FEED }
  return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'nope' }
}

/** 测试环境里让抽取器探测迅速落到 none，避免依赖本机是否装了 python/pdftotext。 */
const NO_EXTRACTOR = { pythonCommand: 'definitely-not-real-python', pdfCommand: 'definitely-not-real-pdftotext' }

const loaded = await import('../lib/index.js').then(
  (module) => ({ module, error: null }),
  (error) => ({ module: null, error }),
)

if (loaded.module === null) {
  test('宿主接线测试（已跳过）', { skip: `无法导入 lib/index.js：${loaded.error?.message ?? loaded.error} —— 先跑 npm install 装上 peer 依赖` }, () => {})
} else {
  const { apply, name, Config, detectDshVersion } = loaded.module

  test('apply 注册 7 个工具与 1 条 API 路由，并建好文库目录', async () => {
    await withTmpDir(async (dir) => {
      assert.equal(name, 'dsh-paperdesk')
      // schemastery 的 Schema 是可调用的函数对象，所以这里不判 typeof
      assert.ok(Config !== undefined && Config !== null, '必须导出 Config，否则组合配置无法被校验')

      const { ctx, state } = fakeCtx()
      await apply(ctx, { root: dir, ...NO_EXTRACTOR })

      assert.deepEqual(state.tools.map((t) => t.name), [...TOOL_NAMES])
      assert.equal(state.routes.length, 1)
      assert.equal(state.routes[0].kind, 'prefix')
      assert.equal(state.routes[0].path, API_PREFIX)
      assert.equal(typeof state.routes[0].handler, 'function')

      // 目录要真的被建出来（索引文件在首次写入时才出现，这里只检查目录）
      await assert.doesNotReject(() => readFile(join(dir, 'state'), 'utf8').catch((error) => {
        // 目录存在但里面还没文件 → EISDIR，也算建好了
        if (error.code === 'EISDIR') return ''
        throw error
      }))
    }, 'wiring-basic')
  })

  test('注册的工具用完整的 ToolDefinition 形状（能被宿主直接消费）', async () => {
    await withTmpDir(async (dir) => {
      const { ctx, state } = fakeCtx()
      await apply(ctx, { root: dir, ...NO_EXTRACTOR })

      for (const tool of state.tools) {
        assert.equal(typeof tool.name, 'string')
        assert.equal(typeof tool.description, 'string')
        assert.equal(tool.parameters.type, 'object')
        assert.equal(typeof tool.parameters.properties, 'object')
        assert.equal(tool.output.schema.type, 'object')
        assert.equal(typeof tool.output.render, 'function')
        assert.equal(typeof tool.execute, 'function')
      }
    }, 'wiring-shape')
  })

  test('走真实注册的路由，完成 add → state → notes 全流程', async () => {
    await withTmpDir(async (dir) => {
      const { ctx, state } = fakeCtx()
      await apply(ctx, { root: dir, ...NO_EXTRACTOR })
      const handler = state.routes[0].handler

      await withFetch(arxivFetch, async () => {
        const add = await callRoute(handler, { method: 'POST', url: API_PREFIX + '/add', body: { arxivId: '1706.03762', download: false } })
        assert.equal(add.status, 200)
        assert.equal(add.json.paper.id, '1706.03762')

        const stateResponse = await callRoute(handler, { method: 'GET', url: API_PREFIX + '/state' })
        assert.equal(stateResponse.json.stats.total, 1)

        const notes = await callRoute(handler, {
          method: 'POST',
          url: API_PREFIX + '/notes',
          body: { id: '1706.03762', notes: { quick: '速览', understand: '理解', critique: '批判' } },
        })
        assert.equal(notes.status, 200)
        const markdown = await readFile(join(dir, 'notes', '1706.03762.md'), 'utf8')
        assert.match(markdown, /## L3 批判[\s\S]*批判/)
      })
    }, 'wiring-flow')
  })

  test('health 报出版本、能力、抽取器与 schema 模式', async () => {
    await withTmpDir(async (dir) => {
      const { ctx, state } = fakeCtx()
      await apply(ctx, { root: dir, ...NO_EXTRACTOR })

      const health = await callRoute(state.routes[0].handler, { method: 'GET', url: API_PREFIX + '/health' })
      assert.equal(health.status, 200)
      const json = health.json
      assert.equal(json.pluginVersion, PLUGIN_VERSION)
      assert.equal(json.root, dir)
      assert.equal(json.capabilities.tools, true)
      assert.equal(json.capabilities.webServer, true)
      // 测试环境里两个抽取命令都不存在，必须如实报 none 而不是假装能用
      assert.equal(json.extractor.kind, 'none')
      assert.match(json.extractor.note, /pymupdf|pdftotext/)
      assert.deepEqual(json.tools.registered, [...TOOL_NAMES])
      // dsh-tools 可解析时走 defineTool，解析不到时走内置编译器，两者都合法
      assert.ok(['defineTool', 'builtin-compiler'].includes(json.tools.schemaMode), json.tools.schemaMode)
      assert.equal(json.api.prefix, API_PREFIX)
      assert.ok(json.api.routes.includes('POST /notes'))
      assert.equal(json.ok, true, `health 不该报错：${JSON.stringify(json.errors)}`)
    }, 'wiring-health')
  })

  test('缺少 ctx.tools 时仍挂载 API，并在 health 里说明缺了什么', async () => {
    await withTmpDir(async (dir) => {
      const { ctx, state } = fakeCtx({ tools: false })
      await apply(ctx, { root: dir, ...NO_EXTRACTOR })

      assert.equal(state.tools.length, 0)
      assert.equal(state.routes.length, 1, '缺工具注册表不该连累界面')

      const health = await callRoute(state.routes[0].handler, { method: 'GET', url: API_PREFIX + '/health' })
      assert.equal(health.json.ok, false)
      assert.match(health.json.errors.join('\n'), /ctx\.tools/)
    }, 'wiring-no-tools')
  })

  test('缺少 ctx.webServer 时仍注册工具（两半互不拖累）', async () => {
    await withTmpDir(async (dir) => {
      const { ctx, state } = fakeCtx({ webServer: false })
      await apply(ctx, { root: dir, ...NO_EXTRACTOR })

      assert.deepEqual(state.tools.map((t) => t.name), [...TOOL_NAMES])
      assert.equal(state.routes.length, 0)
    }, 'wiring-no-webserver')
  })

  test('registerTools/registerApi 关掉时对应的一半完全不注册', async () => {
    await withTmpDir(async (dir) => {
      const off = fakeCtx()
      await apply(off.ctx, { root: dir, registerTools: false, registerApi: false, ...NO_EXTRACTOR })
      assert.equal(off.state.tools.length, 0)
      assert.equal(off.state.routes.length, 0)

      const toolsOnly = fakeCtx()
      await apply(toolsOnly.ctx, { root: dir, registerApi: false, ...NO_EXTRACTOR })
      assert.equal(toolsOnly.state.tools.length, TOOL_NAMES.length)
      assert.equal(toolsOnly.state.routes.length, 0)
    }, 'wiring-toggle')
  })

  test('detectDshVersion 在认不出来时如实返回 unknown', () => {
    const version = detectDshVersion()
    assert.equal(typeof version, 'string')
    assert.ok(version.length > 0)
    // 本机跑测试时进程入口不是 dsh，所以多半是 unknown；但也可能通过 node_modules 解析到
    assert.ok(version === 'unknown' || /\d+\.\d+/.test(version), version)
  })
}
