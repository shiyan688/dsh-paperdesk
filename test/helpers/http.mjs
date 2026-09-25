/**
 * 假的 HTTP 请求/响应，用于在没有网络栈的情况下驱动路由 handler。
 *
 * 请求体用 `Readable` 发 Buffer（和真实请求一致 —— 发字符串会让
 * `Buffer.concat` 直接炸，那就测不出真实行为了）。
 */

import { Readable } from 'node:stream'

/**
 * @param {{ method?: string, url?: string, body?: string|object, remoteAddress?: string }} [input]
 * @returns {any}
 */
export function makeRequest(input = {}) {
  const body = input.body === undefined
    ? ''
    : (typeof input.body === 'string' ? input.body : JSON.stringify(input.body))
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')])
  stream.method = input.method ?? 'GET'
  stream.url = input.url ?? '/'
  stream.socket = { remoteAddress: input.remoteAddress ?? '127.0.0.1' }
  return stream
}

/**
 * @returns {any} 记录了状态码、头与响应体的假响应对象
 */
export function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
      this.finished = true
    },
  }
}

/**
 * 发一个请求并解析 JSON 响应。
 * @param {(req: any, res: any) => Promise<void>} handler
 * @param {{ method?: string, url?: string, body?: string|object, remoteAddress?: string }} [input]
 * @returns {Promise<{ status: number, headers: Record<string, string>, json: any, raw: string }>}
 */
export async function callRoute(handler, input = {}) {
  const request = makeRequest(input)
  const response = makeResponse()
  await handler(request, response)
  let json = null
  try {
    json = JSON.parse(response.body)
  } catch {
    json = null
  }
  return { status: response.statusCode, headers: response.headers, json, raw: response.body }
}
