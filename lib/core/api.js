/**
 * dsh-paperdesk — 浏览器半区用的回环 HTTP API。
 *
 * 为什么走 HTTP 而不是别的：这是社区插件在这套宿主上被验证过的做法
 * （dsh-novel-craft / dsh-taste-loop 都这么干），而且它把两个半区解耦得最干净 ——
 * 宿主半区只暴露 JSON，浏览器半区只 `fetch`，中间不需要任何跨版本易变的对象。
 *
 * 安全：**每一个**请求都要过 `isLoopback()`。这个 API 能读写你磁盘上的文库，
 * 绑定在 127.0.0.1 也不代表可以免检 —— 浏览器里的任意页面都能向 localhost 发请求，
 * 所以「来源是不是本机」是必须自己判的，不能指望网络层。
 */

import { toTagList } from './store.js'

/** API 前缀；客户端与路由都用这一个常量。 */
export const API_PREFIX = '/paperdesk/api'

/** 请求体上限（三层笔记可能挺长，但也不该无上限）。 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 判断请求是否来自本机。
 *
 * 注意 IPv4-mapped IPv6：Node 在双栈 socket 上把 127.0.0.1 报成 `::ffff:127.0.0.1`，
 * 只比对 `127.0.0.1` 会把正常请求全挡掉。
 *
 * @param {{ socket?: { remoteAddress?: string } }} req
 * @returns {boolean}
 */
export function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.')
}

/**
 * 读 JSON 请求体。
 * @param {any} req
 * @param {{ maxBytes?: number }} [deps]
 * @returns {Promise<Record<string, any>>} 失败时返回 `{ __error: '...' }`
 */
export function readJsonBody(req, deps = {}) {
  const maxBytes = deps.maxBytes ?? MAX_BODY_BYTES
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        resolve({ __error: `请求体超过 ${Math.round(maxBytes / 1024)}KB` })
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({ __error: '请求体不是合法 JSON' })
      }
    })
    req.on('error', () => resolve({ __error: '读取请求体失败' }))
  })
}

/**
 * 路由表：`<method> <sub path>` → 处理函数。
 *
 * 做成表而不是一长串 if：`/health` 可以直接把这张表报出来，
 * 测试也能遍历它确保每个端点都有覆盖。
 *
 * 每个处理函数只做「取参数 → 调 service → 返回数据」，不做业务判断。
 */
export function buildRoutes(service, extra = {}) {
  return {
    'GET /health': async () => extra.health?.() ?? { ok: true },
    'GET /state': async () => service.state(),
    'POST /detail': async (body) => service.detail(body.id),
    'POST /search': async (body) => service.search(body.query, body.max),
    'POST /add': async (body) => service.add(body.arxivId, { download: body.download !== false, tags: parseTags(body.tags) }),
    'POST /download': async (body) => service.download(body.id),
    'POST /extract': async (body) => service.extract(body.id, body.maxPages),
    'POST /text': async (body) => service.read(body.id, { offset: body.offset, limit: body.limit }),
    'POST /update': async (body) => service.update(body.id, body.patch),
    'POST /notes': async (body) => service.saveNotes(body.id, body.notes),
    'POST /import': async (body) => service.importPdf(body.path),
    'POST /remove': async (body) => service.remove(body.id, { withFiles: body.withFiles !== false }),
    'POST /scan': async (body) => service.scan(body.dir, body.limit),
    'POST /reveal': async (body) => service.reveal(body.id),
  }
}

/**
 * 逗号分隔的标签串 → 数组（中英文逗号、分号都认）。
 *
 * 实现收口在 store.js 的 `toTagList`：UI 走 HTTP 传数组、模型工具按 schema 传字符串，
 * 两条路必须共用同一套归一化规则，否则会出现「一边生效一边静默丢弃」的偏差。
 *
 * 这里用 `import` + 包装函数，而不是 `export { toTagList as parseTags } from './store.js'`：
 * 后者只对外导出，**不会在本模块作用域里建立名字**，下面 buildRoutes 按裸名调用会
 * `ReferenceError: parseTags is not defined`。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseTags(value) {
  return toTagList(value)
}

/**
 * 造一个路由 handler，交给 `ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })`。
 *
 * @param {{
 *   service: any,
 *   health?: () => any,
 *   enabled?: () => boolean,
 *   log?: (...args: unknown[]) => void,
 * }} input
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApiHandler(input) {
  const service = input.service
  const log = input.log ?? (() => {})
  const routes = buildRoutes(service, { health: input.health })
  const enabled = input.enabled ?? (() => true)

  return async function handle(req, res) {
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    if (!isLoopback(req)) {
      send(403, { error: 'paperdesk api 只接受本机请求' })
      return
    }
    if (!enabled()) {
      send(503, { error: 'paperdesk 已在配置里关闭（registerApi: false）' })
      return
    }

    let pathname = '/'
    try {
      pathname = new URL(String(req.url ?? '/'), 'http://127.0.0.1').pathname
    } catch {
      send(400, { error: '无法解析请求路径' })
      return
    }
    const sub = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
    const method = String(req.method ?? 'GET').toUpperCase()
    const key = `${method} ${sub === '' ? '/' : sub}`
    const handler = routes[key]
    if (handler === undefined) {
      send(404, { error: `未知端点：${key}`, routes: Object.keys(routes) })
      return
    }

    let body = {}
    if (method === 'POST') {
      body = await readJsonBody(req)
      if (typeof body.__error === 'string') {
        send(413, { error: body.__error })
        return
      }
    }

    try {
      const data = await handler(body)
      send(200, { ok: true, ...(data ?? {}) })
    } catch (error) {
      const message = String(error?.message ?? error)
      log(`[paperdesk] ${key} 失败：${message}`)
      send(400, { error: message })
    }
  }
}
