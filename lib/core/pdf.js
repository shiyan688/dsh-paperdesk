/**
 * dsh-paperdesk — PDF 下载与全文抽取。
 *
 * 全文抽取没有「一种到处都能用」的办法，所以这里是**探测 + 降级链**：
 *
 *   1. 配置里指定的 `pdfCommand`（pdftotext 兼容的 CLI）
 *   2. python（pymupdf → pypdf），脚本随插件落到 `<root>/.tools/extract_pdf.py`
 *   3. PATH 上的 `pdftotext`（poppler / MiKTeX 都带）
 *
 * 探测只在启动时做一次，结果进 /paperdesk/api/health，用户能看见自己机器上到底用的哪条路。
 *
 * 两个真实的坑，已在这里处理：
 *  - MiKTeX 的 pdftotext 在**抽完文本之后**会因为写不了日志目录而崩（Windows 上退出码
 *    是个负数），但 stdout 是完整的。所以判据是「stdout 有没有东西」，不是退出码。
 *  - 所有子进程都用 `spawn(command, args)` 数组形式调用，不经过 shell：路径里的空格、
 *    中文、引号都不会变成命令注入。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { nowIso } from './text.js'

/** PDF 体积上限：超过这个大小的「论文」几乎一定是错的（arXiv 上限约 50MB）。 */
export const MAX_PDF_BYTES = 80 * 1024 * 1024

/** 抽取出的全文上限（字符），防止把整个上下文撑爆。 */
export const MAX_TEXT_CHARS = 4_000_000

/**
 * 随插件落盘的 python 抽取脚本。
 *
 * 注意：这是 JS 模板字符串里的 python 源码，所以 python 的 `\n` 必须写成 `\\n`
 * （否则 JS 会先把它变成真换行，python 那边就成了语法错误）。改这一段时务必小心。
 */
export const EXTRACT_SCRIPT = `# dsh-paperdesk PDF 全文抽取（由插件自动生成，可安全删除后重新生成）
# 用法: python extract_pdf.py <pdf路径> <输出txt路径> [最大页数]
import sys, json


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    return 0


def main():
    if len(sys.argv) < 3:
        return emit({'ok': False, 'error': 'usage: extract_pdf.py <pdf> <out.txt> [maxPages]'})
    src, dest = sys.argv[1], sys.argv[2]
    max_pages = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    text = ''
    engine = ''
    pages = 0
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(src)
        pages = doc.page_count if max_pages <= 0 else min(max_pages, doc.page_count)
        text = '\\n'.join(doc[i].get_text('text') for i in range(pages))
        engine = 'pymupdf'
    except Exception as first:
        try:
            from pypdf import PdfReader
            reader = PdfReader(src)
            all_pages = reader.pages
            pages = len(all_pages) if max_pages <= 0 else min(max_pages, len(all_pages))
            text = '\\n'.join((all_pages[i].extract_text() or '') for i in range(pages))
            engine = 'pypdf'
        except Exception as second:
            return emit({'ok': False, 'error': 'PDF 解析失败: %s | %s' % (first, second)})
    # 目标目录必须先建出来：调用方可能只建了 pdf/ 与 state/，text/ 不存在
    # —— 曾经因此让「解析全文」以 FileNotFoundError 静默失败。
    pathlib.Path(dest).parent.mkdir(parents=True, exist_ok=True)
    with open(dest, 'w', encoding='utf-8') as handle:
        handle.write(text)
    return emit({'ok': True, 'engine': engine, 'pages': pages, 'chars': len(text)})


if __name__ == '__main__':
    sys.exit(main())
`

/**
 * python 解释器候选顺序（配置优先，然后是三大平台的常见命令）。
 * @param {string} configured
 * @returns {string[]}
 */
export function pythonCandidates(configured = '') {
  const list = []
  if (String(configured).trim() !== '') list.push(String(configured).trim())
  for (const candidate of ['python', 'python3', 'py']) {
    if (!list.includes(candidate)) list.push(candidate)
  }
  return list
}

/**
 * pdftotext 候选顺序。
 * @param {string} configured
 * @returns {string[]}
 */
export function pdfTextCandidates(configured = '') {
  const list = []
  if (String(configured).trim() !== '') list.push(String(configured).trim())
  for (const candidate of ['pdftotext']) {
    if (!list.includes(candidate)) list.push(candidate)
  }
  return list
}

/**
 * 跑一个子进程并收全 stdout/stderr。
 *
 * 永远不 reject：spawn 失败（命令不存在）返回 `spawnError`，超时返回 `timedOut`，
 * 非零退出码如实返回。调用方按「有没有输出」判断成败，而不是按退出码。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBytes?: number, spawnImpl?: typeof spawn }} [deps]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string }>}
 */
export function runCommand(command, args, deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn
  const timeoutMs = deps.timeoutMs ?? 120000
  const maxBytes = deps.maxBytes ?? 64 * 1024 * 1024

  return new Promise((resolve) => {
    let settled = false
    let child
    let timer = null
    let out = ''
    let err = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }

    try {
      child = spawnImpl(command, args, { windowsHide: true })
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: String(error?.message ?? error) })
      return
    }

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程可能已经退出；杀不掉也不影响返回结果
      }
      finish({ code: null, signal: null, stdout: out, stderr: err, timedOut: true, spawnError: '' })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (out.length < maxBytes) out += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (err.length < 8192) err += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ code: null, signal: null, stdout: out, stderr: err, timedOut: false, spawnError: String(error?.message ?? error) })
    })
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout: out, stderr: err, timedOut: false, spawnError: '' })
    })
  })
}

/** python 探测脚本：打印可用的 PDF 引擎名（没有则空串）。 */
const PY_PROBE = "import importlib.util as u;print('pymupdf' if u.find_spec('fitz') else ('pypdf' if u.find_spec('pypdf') else ''))"

/**
 * 探测本机可用的抽取方案。返回结果可缓存，不要每次抽全文都探一遍。
 *
 * @param {{
 *   pdfCommand?: string, pythonCommand?: string,
 *   run?: typeof runCommand, timeoutMs?: number,
 * }} [deps]
 * @returns {Promise<{
 *   kind: 'python'|'pdftotext'|'none', command: string, engine: string, note: string, probedAt: string,
 * }>}
 */
export async function detectExtractor(deps = {}) {
  const run = deps.run ?? runCommand
  const probedAt = nowIso()

  for (const python of pythonCandidates(deps.pythonCommand ?? '')) {
    const probe = await run(python, ['-c', PY_PROBE], { timeoutMs: 20000 })
    if (probe.spawnError !== '') continue
    const engine = probe.stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
    if (engine === 'pymupdf' || engine === 'pypdf') {
      return { kind: 'python', command: python, engine, note: `python + ${engine}`, probedAt }
    }
  }

  for (const command of pdfTextCandidates(deps.pdfCommand ?? '')) {
    const probe = await run(command, ['-v'], { timeoutMs: 20000 })
    // 只要不是「命令不存在」就算可用 —— pdftotext -v 在 MiKTeX 下会非零退出，但东西是好的。
    if (probe.spawnError === '') {
      return { kind: 'pdftotext', command, engine: 'pdftotext', note: 'pdftotext CLI', probedAt }
    }
  }

  return {
    kind: 'none',
    command: '',
    engine: '',
    note: '未找到 PDF 抽取器：可安装 python(pymupdf/pypdf) 或 poppler 的 pdftotext，'
      + '也可在插件配置里用 pdfCommand/pythonCommand 指定路径。',
    probedAt,
  }
}

/**
 * 下载一个 URL 到本地文件（原子写）。
 *
 * 会检查 PDF 魔数：arXiv 在网络受限或论文不存在时会返回 HTML 错误页，
 * 存下来只会变成一个「打不开的 pdf」，所以这里直接失败并说清原因。
 *
 * @param {string} url
 * @param {string} dest
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, maxBytes?: number }} [deps]
 * @returns {Promise<{ bytes: number, contentType: string }>}
 */
export async function downloadToFile(url, dest, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有全局 fetch（需要 Node >= 20）')
  const maxBytes = deps.maxBytes ?? MAX_PDF_BYTES

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120000)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-paperdesk (+https://github.com/deepseek-ai/deepseek-harness)', accept: 'application/pdf,*/*' },
    })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}（${url}）`)
    const declared = Number(response.headers?.get?.('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`PDF 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB（声明 ${Math.round(declared / 1024 / 1024)}MB）`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) throw new Error('下载到 0 字节')
    if (buffer.length > maxBytes) throw new Error(`PDF 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      const head = buffer.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')
      throw new Error(`下载到的不是 PDF（可能是错误页）：${head}`)
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buffer)
    return { bytes: buffer.length, contentType: String(response.headers?.get?.('content-type') ?? '') }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`下载超时（${deps.timeoutMs ?? 120000}ms）：${url}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抽取 PDF 全文，写到 `dest`，返回统计信息。
 *
 * @param {string} pdfPath
 * @param {string} dest
 * @param {{
 *   plan: { kind: string, command: string }, scriptPath: string, maxPages?: number,
 *   run?: typeof runCommand, timeoutMs?: number,
 * }} deps
 * @returns {Promise<{ ok: boolean, engine: string, pages: number, chars: number, warning: string, error: string }>}
 */
export async function extractPdfText(pdfPath, dest, deps) {
  const run = deps.run ?? runCommand
  const plan = deps.plan ?? { kind: 'none', command: '' }
  const timeoutMs = deps.timeoutMs ?? 180000
  const maxPages = Math.max(0, Math.round(Number(deps.maxPages) || 0))

  if (plan.kind === 'none') {
    return { ok: false, engine: '', pages: 0, chars: 0, warning: '', error: '没有可用的 PDF 抽取器（见 /paperdesk/api/health）' }
  }

  if (plan.kind === 'python') {
    // 脚本每次抽取前重写一遍：用户升级插件后旧脚本不会残留成「薛定谔的行为」。
    await mkdir(dirname(deps.scriptPath), { recursive: true })
    await writeFile(deps.scriptPath, EXTRACT_SCRIPT, 'utf8')
    // 输出目录同样要先建：python 侧也建了一次，这里是双保险（两边任一被改动都不会再出洞）
    await mkdir(dirname(dest), { recursive: true })
    const result = await run(plan.command, [deps.scriptPath, pdfPath, dest, String(maxPages)], { timeoutMs })
    const line = result.stdout.trim().split(/\r?\n/).filter((x) => x.startsWith('{')).pop() ?? ''
    let parsed = null
    try {
      parsed = line === '' ? null : JSON.parse(line)
    } catch {
      parsed = null
    }
    if (parsed === null || parsed.ok !== true) {
      const hint = parsed?.error ?? result.stderr.trim().slice(0, 300) ?? ''
      return { ok: false, engine: '', pages: 0, chars: 0, warning: '', error: `python 抽取失败（exit ${result.code}）：${hint || '无输出'}` }
    }
    return {
      ok: true,
      engine: String(parsed.engine ?? 'python'),
      pages: Number(parsed.pages ?? 0),
      chars: Number(parsed.chars ?? 0),
      warning: '',
      error: '',
    }
  }

  // pdftotext：输出到 stdout，由这里落盘。
  const result = await run(plan.command, ['-layout', '-enc', 'UTF-8', pdfPath, '-'], { timeoutMs })
  const text = result.stdout
  if (text.trim() === '') {
    return {
      ok: false,
      engine: 'pdftotext',
      pages: 0,
      chars: 0,
      warning: '',
      error: `pdftotext 没有输出（exit ${result.code}）：${result.stderr.trim().slice(0, 200)}`,
    }
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, text.slice(0, MAX_TEXT_CHARS), 'utf8')
  // 退出码非 0 但拿到文本：MiKTeX 版 pdftotext 的已知收尾崩溃，如实告知但不视为失败。
  const warning = result.code === 0
    ? ''
    : `pdftotext 退出码 ${result.code}，但已取得 ${text.length} 字符文本（已知的收尾日志问题，可忽略）`
  return { ok: true, engine: 'pdftotext', pages: 0, chars: Math.min(text.length, MAX_TEXT_CHARS), warning, error: '' }
}
