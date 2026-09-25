/**
 * dsh-paperdesk — 配置与路径解析。
 *
 * 兼容性策略：`Config` 用 schemastery 声明（宿主 loader 会按它校验/填默认值），
 * 但 `resolveOptions()` 完全不依赖 schemastery —— 它只吃一个普通对象，
 * 所以单测、以及将来 schemastery 缺失的降级路径都能用同一份逻辑。
 */

import { isAbsolute, join, resolve } from 'node:path'
import { clampNumber } from './text.js'

/** 文库默认目录名（相对 dsh 进程工作目录）。 */
export const DEFAULT_ROOT_DIRNAME = '.dsh-paperdesk'

/** 允许的检索条数上限。 */
export const MAX_SEARCH_LIMIT = 50

/**
 * 构造 schemastery 配置 schema。
 * 之所以用函数而不是顶层常量：schemastery 是可选 peer dependency，
 * 缺失时插件仍要能起来（走 resolveOptions 的默认值），不能因为 import 失败整个包炸掉。
 * @param {any} z schemastery 的默认导出
 * @returns {any}
 */
export function buildConfigSchema(z) {
  return z.object({
    root: z.string().default(''),
    pdfCommand: z.string().default(''),
    pythonCommand: z.string().default(''),
    requestTimeoutMs: z.number().default(30000),
    maxSearchResults: z.number().default(30),
    registerTools: z.boolean().default(true),
    registerApi: z.boolean().default(true),
  })
}

/**
 * 把「行配置」解析成一份完整的运行时选项。
 *
 * 路径规则：`root` 留空时落在 `<cwd>/.dsh-paperdesk`；
 * 给相对路径时相对 `cwd` 解析；给了绝对路径就用它。所有子目录都由 root 派生，
 * 不允许单独覆盖 —— 少一个可配项就少一类「文件写到别处去了」的 bug。
 *
 * @param {Record<string, unknown>} [config] 组合配置行里的 config
 * @param {{ cwd?: string }} [env]
 * @returns {{
 *   root: string, stateDir: string, pdfDir: string, textDir: string, notesDir: string,
 *   toolsDir: string, indexPath: string, extractScriptPath: string,
 *   requestTimeoutMs: number, maxSearchResults: number,
 *   pdfCommand: string, pythonCommand: string,
 *   registerTools: boolean, registerApi: boolean,
 * }}
 */
export function resolveOptions(config = {}, env = {}) {
  const cwd = env.cwd ?? process.cwd()
  const rawRoot = String(config.root ?? '').trim()
  const root = rawRoot === ''
    ? join(cwd, DEFAULT_ROOT_DIRNAME)
    : (isAbsolute(rawRoot) ? resolve(rawRoot) : resolve(cwd, rawRoot))

  const stateDir = join(root, 'state')
  const pdfDir = join(root, 'pdf')
  const textDir = join(root, 'text')
  const notesDir = join(root, 'notes')
  const toolsDir = join(root, '.tools')

  return {
    root,
    stateDir,
    pdfDir,
    textDir,
    notesDir,
    toolsDir,
    indexPath: join(stateDir, 'index.json'),
    extractScriptPath: join(toolsDir, 'extract_pdf.py'),
    requestTimeoutMs: clampNumber(config.requestTimeoutMs, 30000, 3000, 300000),
    maxSearchResults: clampNumber(config.maxSearchResults, 30, 1, MAX_SEARCH_LIMIT),
    pdfCommand: String(config.pdfCommand ?? '').trim(),
    pythonCommand: String(config.pythonCommand ?? '').trim(),
    registerTools: config.registerTools !== false,
    registerApi: config.registerApi !== false,
  }
}

/**
 * 校验一个「要读进来的 PDF 路径」。
 *
 * 这个插件会读用户显式给出的绝对路径（导入已有文献），这是它的功能而不是漏洞；
 * 但仍然拒绝空值、NUL 字节和相对路径 —— 相对路径的含义取决于宿主进程的 cwd，
 * 让用户以为自己在导入 A 却读到 B 是最糟的失败方式。
 *
 * @param {unknown} input
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function validateImportPath(input) {
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (raw === '') return { ok: false, error: '请提供 PDF 的绝对路径' }
  if (raw.includes('\0')) return { ok: false, error: '路径含非法字符' }
  if (!isAbsolute(raw)) return { ok: false, error: `需要绝对路径（收到 ${raw}）` }
  return { ok: true, path: raw }
}
