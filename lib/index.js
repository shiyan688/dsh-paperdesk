/**
 * dsh-paperdesk — 宿主半区入口。
 *
 * 这个文件只做**接线**，不含业务逻辑：
 *
 *   ctx（服务解析，各自独立、缺谁降级谁）
 *     └─ 配置解析 → 文库 store → 领域 service
 *          ├─ ctx.tools.register    ← tools.js（7 个模型工具）
 *          └─ ctx.webServer.register ← api.js（回环 HTTP，给浏览器半区）
 *
 * 兼容性做法见 core/compat.js：服务缺失不抛错、只降级，并把降级结果如实报给
 * `/paperdesk/api/health`，让用户看得见「我这台机器上哪些能力没起来、为什么」。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { API_PREFIX, createApiHandler } from './core/api.js'
import { capabilityReport, probeCapabilities, PLUGIN_VERSION, TESTED_DSH_VERSION } from './core/compat.js'
import { buildConfigSchema, resolveOptions } from './core/config.js'
import { detectExtractor } from './core/pdf.js'
import { createService } from './core/service.js'
import { createStore } from './core/store.js'
import { createToolDefinitions, TOOL_NAMES } from './core/tools.js'

/** 插件行 id；与 cordis.patch.yml 里保持一致。 */
export const name = 'dsh-paperdesk'

/** 组合配置的 schema（loader 会按它校验 cordis.patch.yml 里的 config）。 */
export const Config = buildConfigSchema(z)

/** 启动时等服务的上限：等不到就降级启动，绝不无限等待。 */
const SERVICE_TIMEOUT_MS = 15000

/**
 * 等一个服务出现。
 *
 * 不用 `inject` 声明硬依赖，是因为这个插件「有工具注册表就能给模型用、有 webServer
 * 就能给界面用」，两者互不依赖：缺一个不该把另一个也拖死。等不到就返回 null，
 * 由调用方决定降级形态。
 *
 * @param {any} ctx
 * @param {string} key
 * @param {number} timeoutMs
 * @returns {Promise<any|null>}
 */
function awaitService(ctx, key, timeoutMs = SERVICE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      ctx.inject([key], (ready) => finish(ready?.[key] ?? null))
    } catch {
      finish(null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
  })
}

/**
 * 动态取 `defineTool`。
 *
 * 它在 `@deepseek-ai/dsh-tools` 里，是可选 peer dependency：拿不到就用
 * tools.js 里的本地编译器注册等价定义，并在健康检查里标注，而不是让插件起不来。
 * @returns {Promise<Function|null>}
 */
async function loadDefineTool() {
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    return typeof module?.defineTool === 'function' ? module.defineTool : null
  } catch {
    return null
  }
}

/**
 * 尽力识别当前 DSH 版本：环境变量 → 包元数据 → 从进程入口向上找 → unknown。
 *
 * 「版本未知」不是错误：这个插件真正依赖的是能力探测，版本号只用于给出
 * 「你不在我验证过的区间内」这类提示。所以找不到就照实写 unknown，不猜。
 * @returns {string}
 */
export function detectDshVersion() {
  const fromEnv = process.env.DSH_VERSION ?? process.env.DSH_CORE_VERSION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('@deepseek-ai/dsh/package.json')
    if (typeof pkg?.version === 'string') return pkg.version
  } catch {
    // 继续尝试下一条路
  }
  try {
    // dsh 的 bin 通常在 <pkg>/lib/bin.js，向上几层就能撞到它自己的 package.json。
    let dir = dirname(process.argv[1] ?? '')
    for (let depth = 0; depth < 6 && dir !== '' && dir !== dirname(dir); depth += 1) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
      dir = dirname(dir)
    }
  } catch {
    // 到这里就认不出来
  }
  return 'unknown'
}

/**
 * 插件入口。
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 */
export async function apply(ctx, config = {}) {
  const log = (...args) => console.log(...args)
  const options = resolveOptions(config)
  const store = createStore({ paths: options })
  const service = createService({ store, options, log })

  // 目录先建好：后面的探测、抽取、写索引都假设它们在。
  await service.ensureLayout()

  // 抽取器探测只做一次并缓存；探测失败不影响题录与检索。
  const extractor = await detectExtractor({
    pdfCommand: options.pdfCommand,
    pythonCommand: options.pythonCommand,
  })
  service.setExtractor(extractor)

  // 工具与路由各自独立解析：缺 tools 不影响界面，缺 webServer 不影响工具。
  const [tools, webServer] = await Promise.all([
    options.registerTools ? awaitService(ctx, 'tools') : Promise.resolve(undefined),
    options.registerApi ? awaitService(ctx, 'webServer') : Promise.resolve(undefined),
  ])

  let defineTool = null
  let toolNames = []
  if (typeof tools?.register === 'function') {
    defineTool = await loadDefineTool()
    try {
      const definitions = createToolDefinitions({ service, defineTool })
      for (const definition of definitions) {
        ctx.effect(() => tools.register(definition))
      }
      toolNames = TOOL_NAMES.slice()
    } catch (error) {
      log(`[paperdesk] 注册模型工具失败：${error?.message ?? error}`)
    }
  }

  // 健康检查：把「这台机器上实际是什么状态」一次说清。
  const health = () => {
    const capabilities = probeCapabilities(ctx, { extractor: extractor.kind })
    const report = capabilityReport({
      dshVersion: detectDshVersion(),
      pluginVersion: PLUGIN_VERSION,
      capabilities,
      wantTools: options.registerTools,
      wantApi: options.registerApi,
      extractorHint: extractor.note,
    })
    return {
      ...report,
      root: options.root,
      testedVersion: TESTED_DSH_VERSION,
      extractor: { kind: extractor.kind, engine: extractor.engine, command: extractor.command, note: extractor.note },
      tools: { registered: toolNames, schemaMode: defineTool === null ? 'builtin-compiler' : 'defineTool' },
      api: { prefix: API_PREFIX, routes: Object.keys(buildRouteList()) },
      indexWarning: store.warning,
    }
  }

  // 只用于 /health 里报路由清单，避免为了展示去启动 handler。
  function buildRouteList() {
    return {
      'GET /health': true,
      'GET /state': true,
      'POST /detail': true,
      'POST /search': true,
      'POST /add': true,
      'POST /download': true,
      'POST /extract': true,
      'POST /text': true,
      'POST /update': true,
      'POST /notes': true,
      'POST /import': true,
      'POST /remove': true,
      'POST /scan': true,
      'POST /reveal': true,
    }
  }

  if (typeof webServer?.register === 'function') {
    const handler = createApiHandler({ service, health, enabled: () => options.registerApi, log })
    ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
  }

  const missing = []
  if (options.registerTools && typeof tools?.register !== 'function') missing.push('ctx.tools')
  if (options.registerApi && typeof webServer?.register !== 'function') missing.push('ctx.webServer')
  log(
    `[paperdesk] ${PLUGIN_VERSION} 就绪 · 文库 ${options.root} · 抽取器 ${extractor.note}`
    + ` · 工具 ${toolNames.length} 个 · 界面接口 ${typeof webServer?.register === 'function' ? '已挂载' : '未挂载'}`
    + (missing.length > 0 ? ` · 缺失服务：${missing.join(', ')}` : ''),
  )
}
