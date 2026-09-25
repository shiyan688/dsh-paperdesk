/**
 * dsh-paperdesk — arXiv 客户端（检索 / 按号取元数据 / 解析 Atom）。
 *
 * 为什么手写 Atom 解析而不用 XML 库：arXiv 的 feed 结构固定（entry/title/summary/
 * author/name/category/link），手写正则换来的是**零运行时依赖**和可单测的纯函数。
 * 代价是它只认这一种 feed —— 所以解析失败时宁可返回空数组，也不猜。
 *
 * 网络走全局 `fetch`（Node >= 20）。`fetchImpl` 可注入，单测不发真实请求。
 */

import { flat, tagText } from './text.js'

/** arXiv API 入口。 |
 * 用 http 是因为 export.arxiv.org 在部分地区 https 握手不稳，且这里只读公开元数据。
 */
export const ARXIV_API = 'http://export.arxiv.org/api/query?'

/** 单次检索的条数上限（arXiv 自己限制 30000，这里给一个对人类友好的上限）。 */
export const MAX_RESULTS = 50

/**
 * 归一化用户给的 arXiv 编号：接受完整链接、带版本号、带 `.pdf`、带 `arXiv:` 前缀。
 * @param {unknown} input
 * @returns {string} 形如 `1706.03762v7` 或 `1706.03762`；无法识别时返回空串
 */
export function normalizeArxivId(input) {
  let text = String(input ?? '').trim()
  text = text.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
  text = text.replace(/^arxiv:/i, '')
  text = text.replace(/\.pdf$/i, '')
  text = text.trim()
  return /^[a-z.-]+\/\d{7}$|^\d{4}\.\d{4,5}(v\d+)?$/i.test(text) ? text : ''
}

/**
 * 去掉版本号：`1706.03762v7` → `1706.03762`。文库 id 用不带版本的形式，
 * 这样「先收 v7、后来更新到 v8」不会变成两条记录。
 * @param {unknown} id
 * @returns {string}
 */
export function baseArxivId(id) {
  return String(id ?? '').replace(/v\d+$/i, '')
}

/**
 * 归一化检索条数：
 * - 没给 / 给了非数字 → 默认 8（这是「顺手搜一下」的合理默认）
 * - 显式给了 0 或负数 → 夹到 1（用户明确要了一个下限，不该被放大成 8）
 * - 超过上限 → 夹到 MAX_RESULTS
 * @param {unknown} max
 * @returns {number}
 */
export function normalizeLimit(max) {
  if (max === undefined || max === null || max === '') return 8
  const value = Number(max)
  if (!Number.isFinite(value)) return 8
  return Math.min(MAX_RESULTS, Math.max(1, Math.round(value)))
}

/**
 * 构造检索 URL。
 * @param {string} query 自然语言或 arXiv 语法（含 `:` 时按原样传，否则按 `all:` 字段）
 * @param {number} max
 * @param {{ api?: string }} [deps]
 * @returns {string}
 */
export function buildSearchUrl(query, max, deps = {}) {
  const api = deps.api ?? ARXIV_API
  const text = String(query ?? '').trim()
  const expression = text.includes(':') ? text : `all:${text}`
  return `${api}search_query=${encodeURIComponent(expression)}`
    + `&start=0&max_results=${normalizeLimit(max)}&sortBy=relevance&sortOrder=descending`
}

/**
 * 构造按编号取元数据的 URL（一次可给多个，逗号分隔）。
 * @param {string|string[]} ids
 * @param {{ api?: string }} [deps]
 * @returns {string}
 */
export function buildIdUrl(ids, deps = {}) {
  const api = deps.api ?? ARXIV_API
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter((x) => x !== '')
  return `${api}id_list=${encodeURIComponent(list.join(','))}&max_results=${Math.max(1, list.length)}`
}

/**
 * 解析 arXiv Atom feed。
 *
 * 每个结果都保证有 `baseId`（无版本）与 `title`；缺这两样的条目直接丢掉 ——
 * 宁可少一条，也不要一条 id 是空串的记录进文库（那会让后续所有读写都找错文件）。
 *
 * @param {unknown} xml
 * @returns {Array<{
 *   arxivId: string, baseId: string, title: string, authors: string[], abstract: string,
 *   published: string, updated: string, primaryCategory: string, categories: string[],
 *   url: string, pdfUrl: string,
 * }>}
 */
export function parseFeed(xml) {
  const text = String(xml ?? '')
  const blocks = text.split('<entry>').slice(1).map((chunk) => chunk.split('</entry>')[0])
  const results = []

  for (const block of blocks) {
    const idText = tagText(block, 'id')
    const absMatch = idText.match(/abs\/([^<\s]+)/)
    const arxivId = absMatch ? absMatch[1] : ''
    const baseId = baseArxivId(arxivId)
    const title = tagText(block, 'title')
    if (baseId === '' || title === '') continue

    const primaryMatch = block.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)
    const categories = (block.match(/<category[^>]*term="([^"]+)"/g) ?? [])
      .map((chunk) => (chunk.match(/term="([^"]+)"/) ?? [])[1])
      .filter((value) => typeof value === 'string' && value !== '')

    // link 的属性顺序不保证，两种写法都试。
    const pdfFirst = block.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/)
    const pdfSecond = block.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/)
    const pdfRaw = pdfFirst?.[1] ?? pdfSecond?.[1] ?? ''

    const authors = (block.match(/<name>[\s\S]*?<\/name>/g) ?? [])
      .map((chunk) => flat(chunk.replace(/<\/?name>/g, '')))
      .filter((value) => value !== '')

    results.push({
      arxivId,
      baseId,
      title,
      authors,
      abstract: tagText(block, 'summary'),
      published: tagText(block, 'published').slice(0, 10),
      updated: tagText(block, 'updated').slice(0, 10),
      primaryCategory: primaryMatch !== null ? primaryMatch[1] : (categories[0] ?? ''),
      categories,
      // feed 里给的是 http，统一升到 https：下载 PDF 时 https 更少被中间设备改写。
      url: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: (pdfRaw !== '' ? pdfRaw : `https://arxiv.org/pdf/${arxivId}`).replace(/^http:\/\//, 'https://'),
    })
  }

  return results
}

/**
 * 取一个 URL 的文本（超时可控，失败抛出带原因的错）。
 * @param {string} url
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, accept?: string }} [deps]
 * @returns {Promise<{ status: number, text: string }>}
 */
export async function fetchText(url, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 没有全局 fetch（需要 Node >= 20）')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30000)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'dsh-paperdesk (+https://github.com/deepseek-ai/deepseek-harness)',
        accept: deps.accept ?? 'application/atom+xml, application/xml, text/xml, */*',
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`arXiv 返回 ${response.status}：${text.slice(0, 200)}`)
    }
    return { status: response.status, text }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（${deps.timeoutMs ?? 30000}ms）：${url}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 检索 arXiv。
 * @param {string} query
 * @param {number} max
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, api?: string }} [deps]
 * @returns {Promise<ReturnType<typeof parseFeed>>}
 */
export async function searchArxiv(query, max, deps = {}) {
  if (String(query ?? '').trim() === '') throw new Error('请提供检索关键词')
  const { text } = await fetchText(buildSearchUrl(query, max, deps), deps)
  return parseFeed(text)
}

/**
 * 按编号取单条元数据；找不到返回 null（而不是抛错）。
 * @param {string} id
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, api?: string }} [deps]
 * @returns {Promise<any|null>}
 */
export async function lookupArxiv(id, deps = {}) {
  const normalized = normalizeArxivId(id)
  if (normalized === '') throw new Error(`无法识别的 arXiv 编号：${id}`)
  const { text } = await fetchText(buildIdUrl(normalized, deps), deps)
  const results = parseFeed(text)
  return results.length > 0 ? results[0] : null
}
