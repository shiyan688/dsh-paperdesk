/**
 * dsh-paperdesk — 文本与文件小工具。
 *
 * 这一层只依赖 `node:` 内置模块，所有函数要么是纯函数、要么只碰一个明确的路径，
 * 因此单测可以直接调用，不需要起 DSH、也不需要假 context。
 *
 * 设计约定：
 * - 落盘一律先写临时文件再 rename（`writeAtomic`），避免进程被杀时留下半截 JSON；
 * - 读一律给「读不到就返回 null」的版本（`readTextSafe` / `readJsonSafe`），
 *   把「文件不存在」和「文件坏了」都收敛成同一种可处理的结果，调用方不必 try/catch。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** @returns {string} 当前时间的 ISO 字符串。 */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * 生成适合放进文件名的时间戳（UTC，秒级）：`20250103T041516`。
 * @param {Date} [date]
 * @returns {string}
 */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', 'T')
}

/**
 * 读文本，读不到返回 null。
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function readTextSafe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 读 JSON，文件不存在或解析失败都返回 null。
 * @param {string} path
 * @returns {Promise<any|null>}
 */
export async function readJsonSafe(path) {
  const raw = await readTextSafe(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 原子写文本：先写同目录临时文件，再 rename 覆盖。
 * @param {string} path
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * 原子写 JSON（带尾换行，便于 git diff）。
 * @param {string} path
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJson(path, value) {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 按字符数截断，超长加省略号。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clip(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 折叠空白并 trim —— arXiv 的 Atom 字段里换行很多。
 * @param {unknown} value
 * @returns {string}
 */
export function flat(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 解开 XML 里常见的实体（arXiv 标题/摘要里 `&amp;` 很常见）。
 * @param {unknown} value
 * @returns {string}
 */
export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 取 XML 片段的某个标签文本（非贪婪）。只用正则，因为 Atom 结构简单且我们不做通用 XML。
 * @param {string} block
 * @param {string} tag
 * @returns {string}
 */
export function tagText(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? flat(decodeEntities(match[1])) : ''
}

/**
 * 文件名安全的 slug（保留中英文与数字，其余折成 `-`）。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function slugify(value, max = 60) {
  const slug = String(value ?? '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return slug === '' ? 'untitled' : slug
}

/**
 * 是否为 PDF 文件名。
 * @param {string} name
 * @returns {boolean}
 */
export function isPdfName(name) {
  return /\.pdf$/i.test(String(name ?? ''))
}

/**
 * 把毫秒数夹到合理区间。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
