/**
 * dsh-paperdesk — 领域服务层。
 *
 * 这里是插件的**全部业务逻辑**，且刻意不依赖 DSH：
 * 输入是 `{ store, options, extractor }` 加几个可注入的副作用（fetch / 子进程 / 时钟），
 * 输出是纯数据。模型工具（tools.js）与浏览器 API（api.js）都只是它的两层薄壳，
 * 于是同一份逻辑既能被 `node --test` 直接测，也不会出现「界面上能用、工具里行为不一致」。
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { lookupArxiv, searchArxiv } from './arxiv.js'
import { validateImportPath } from './config.js'
import { noteMarkdown, noteProgress } from './notes.js'
import { downloadToFile, extractPdfText } from './pdf.js'
import { indexStats, liteRecord, normalizeStatus, recordFromLocal } from './store.js'
import { isPdfName, nowIso, readTextSafe, slugify, stamp, writeAtomic } from './text.js'

/** 一次读取全文的默认/最大字符数。 */
export const READ_DEFAULT_CHARS = 24000
export const READ_MAX_CHARS = 40000

/** 扫描导入候选时的上限。 */
export const SCAN_MAX_FILES = 300
export const SCAN_MAX_DEPTH = 3

/**
 * 建领域服务。
 *
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   options: ReturnType<import('./config.js').resolveOptions>,
 *   extractor?: { kind: string, command: string, engine: string, note: string },
 *   deps?: {
 *     fetchImpl?: typeof fetch, run?: Function, now?: () => string,
 *     spawnDetached?: (command: string, args: string[]) => void,
 *     readText?: (path: string) => Promise<string|null>,
 *   },
 *   log?: (...args: unknown[]) => void,
 * }} input
 */
export function createService(input) {
  const store = input.store
  const options = input.options
  const log = input.log ?? (() => {})
  const deps = input.deps ?? {}
  const now = deps.now ?? nowIso
  const readText = deps.readText ?? readTextSafe

  /** 探测结果可被上层替换（重探时用）。 */
  let extractor = input.extractor ?? { kind: 'none', command: '', engine: '', note: '尚未探测' }

  const arxivDeps = { timeoutMs: options.requestTimeoutMs, fetchImpl: deps.fetchImpl }

  const abs = (relative) => join(options.root, relative)

  /** 确保文库目录存在。 */
  async function ensureLayout() {
    for (const dir of [options.stateDir, options.pdfDir, options.textDir, options.notesDir, options.toolsDir]) {
      await mkdir(dir, { recursive: true })
    }
  }

  /** 记一条日志（带插件前缀，便于在宿主日志里 grep）。 */
  function note(message) {
    log(`[paperdesk] ${message}`)
  }

  /**
   * 写一份笔记 markdown 镜像。失败只记日志：**索引才是事实来源**，
   * 不能让「给人看的那份」写失败连带把入库/保存笔记整个操作判死。
   */
  async function mirrorNotes(paper) {
    try {
      // 目录可能不存在（例如文库目录被外部删过、或进程启动后一直没写过笔记）：
      // 每次写之前补建，别赌启动时那一次。
      await mkdir(options.notesDir, { recursive: true })
      await writeAtomic(abs(store.noteRelative(paper.id)), noteMarkdown(paper))
    } catch (error) {
      note(`写 notes/${paper.id}.md 失败：${error?.message ?? error}`)
    }
  }

  /** 下载 PDF 到文库（就地修改 paper 对象，不落盘）。 */
  async function fetchPdf(paper) {
    const url = paper.pdfUrl !== '' ? paper.pdfUrl : `https://arxiv.org/pdf/${paper.arxivId || paper.id}`
    const dest = abs(store.pdfRelative(paper.id))
    const result = await downloadToFile(url, dest, { timeoutMs: Math.max(60000, options.requestTimeoutMs * 2), fetchImpl: deps.fetchImpl })
    paper.pdfPath = store.pdfRelative(paper.id)
    paper.pdfBytes = result.bytes
    return paper
  }

  /** 抽取全文（就地修改 paper 对象，不落盘）。 */
  async function runExtract(paper, maxPages = 0) {
    // 自愈：不假设启动时建过目录。文库目录被外部删改过时，这一步是唯一的补救点。
    await ensureLayout()
    const pdfAbs = abs(paper.pdfPath)
    const destAbs = abs(store.textRelative(paper.id))
    const result = await extractPdfText(pdfAbs, destAbs, {
      plan: extractor,
      scriptPath: options.extractScriptPath,
      maxPages,
      run: deps.run,
      timeoutMs: Math.max(120000, options.requestTimeoutMs * 4),
    })
    if (!result.ok) throw new Error(result.error)
    paper.textPath = store.textRelative(paper.id)
    paper.textChars = result.chars
    paper.pages = result.pages > 0 ? result.pages : paper.pages
    paper.textEngine = result.engine
    paper.textAt = now()
    if (result.warning !== '') note(result.warning)
    return result
  }

  const service = {
    options,
    store,

    /** 换一个抽取器（启动探测后 / 重探时调用）。 */
    setExtractor(next) {
      extractor = next
    },
    get extractor() {
      return extractor
    },

    ensureLayout,

    /** 文库总览（列表 + 统计），界面首屏用。 */
    async state() {
      const index = await store.load()
      return {
        root: options.root,
        stats: indexStats(index),
        papers: index.papers.map(liteRecord),
        extractor: { kind: extractor.kind, note: extractor.note, engine: extractor.engine },
        indexWarning: store.warning,
      }
    },

    /** 单篇详情（含摘要与三层笔记全文）。 */
    async detail(id) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`未找到论文：${id}`)
      return { paper, progress: noteProgress(paper) }
    },

    /** arXiv 检索。 */
    async search(query, max) {
      const limit = Math.min(options.maxSearchResults, Math.max(1, Math.round(Number(max) || 8)))
      const results = await searchArxiv(query, limit, arxivDeps)
      return { query: String(query), count: results.length, results }
    },

    /** 入库一篇 arXiv 论文；返回可读的回执数据。 */
    async add(arxivId, { download = true, tags = [] } = {}) {
      const meta = await lookupArxiv(arxivId, arxivDeps)
      if (meta === null) throw new Error(`arXiv 上找不到 ${arxivId}`)
      const index = await store.load()
      const { paper, existed } = store.upsertArxiv(index, meta)
      if (Array.isArray(tags) && tags.length > 0) {
        const merged = [...paper.tags]
        for (const tag of tags) {
          if (!merged.includes(tag)) merged.push(tag)
        }
        paper.tags = merged.slice(0, 20)
      }
      let warning = ''
      let pdf = false
      let text = false
      if (download) {
        try {
          await fetchPdf(paper)
          pdf = true
          await runExtract(paper, 0)
          text = true
        } catch (error) {
          warning = `题录已保存，但 PDF/全文处理失败：${error?.message ?? error}`
          note(warning)
        }
      }
      await store.save(index)
      return { paper, existed, pdf, text, warning }
    },

    /** 单独下载 PDF（入库时跳过了下载的情况）。 */
    async download(id) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`未找到论文：${id}`)
      await fetchPdf(paper)
      await store.save(index)
      return { paper, bytes: paper.pdfBytes }
    },

    /** 单独抽取全文。 */
    async extract(id, maxPages = 0) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`未找到论文：${id}`)
      if (paper.pdfPath === '') {
        await fetchPdf(paper)
        await store.save(index)
      }
      const result = await runExtract(paper, maxPages)
      await store.save(index)
      return { paper, engine: result.engine, pages: paper.pages, chars: paper.textChars, warning: result.warning }
    },

    /**
     * 读全文的一个窗口。没有 PDF 就先去拿，没有全文就现抽 —— 工具调用不该
     * 要求模型先记得「哦我还没抽全文」。
     */
    async read(id, { offset = 0, limit = READ_DEFAULT_CHARS } = {}) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`文库里没有「${id}」，先用 paper_search 检索或 paper_add 入库`)
      if (paper.textPath === '') {
        if (paper.pdfPath === '') await fetchPdf(paper)
        await runExtract(paper, 0)
        await store.save(index)
      }
      const full = await readText(abs(paper.textPath))
      if (full === null) throw new Error(`全文文件缺失（${paper.textPath}），请重新抽取`)
      const total = full.length
      const start = Math.max(0, Math.min(total, Math.round(Number(offset) || 0)))
      const size = Math.max(500, Math.min(READ_MAX_CHARS, Math.round(Number(limit) || READ_DEFAULT_CHARS)))
      return { paper, text: full.slice(start, start + size), total, offset: start }
    },

    /** 写三层笔记（只覆盖显式给出的层），并镜像 markdown。 */
    async saveNotes(id, notes) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`未找到论文：${id}`)
      store.writeNotes(paper, notes)
      await store.save(index)
      await mirrorNotes(paper)
      return { paper, progress: noteProgress(paper) }
    },

    /** 改状态 / 标签 / 评级 / 标题。 */
    async update(id, patch) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`未找到论文：${id}`)
      store.patch(paper, patch)
      await store.save(index)
      if (paper.notes.quick !== '' || paper.notes.understand !== '' || paper.notes.critique !== '') await mirrorNotes(paper)
      return { paper }
    },

    /** 移出文库（默认连文件一起删）。 */
    async remove(id, { withFiles = true } = {}) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`未找到论文：${id}`)
      index.papers = index.papers.filter((item) => item !== paper)
      await store.save(index)
      if (withFiles) {
        for (const relative of [store.pdfRelative(paper.id), store.textRelative(paper.id), store.noteRelative(paper.id)]) {
          try {
            await rm(abs(relative), { force: true })
          } catch (error) {
            note(`删除 ${relative} 失败：${error?.message ?? error}`)
          }
        }
      }
      return { id: paper.id, title: paper.title }
    },

    /** 列表（可按状态 / 关键词 / 标签筛）。 */
    async list({ status = '', query = '', tag = '', limit = 50 } = {}) {
      const index = await store.load()
      const wantStatus = String(status ?? '').trim() === '' ? '' : normalizeStatus(status)
      const needle = String(query ?? '').trim().toLowerCase()
      const wantTag = String(tag ?? '').trim()
      const cap = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)))
      const rows = index.papers.filter((paper) => {
        if (wantStatus !== '' && paper.status !== wantStatus) return false
        if (wantTag !== '' && !paper.tags.includes(wantTag)) return false
        if (needle !== '') {
          const haystack = [paper.title, paper.id, paper.arxivId, paper.authors.join(' '), paper.tags.join(' ')].join(' ').toLowerCase()
          if (!haystack.includes(needle)) return false
        }
        return true
      }).slice(0, cap)
      return { stats: indexStats(index), total: index.papers.length, rows: rows.map(liteRecord) }
    },

    /** 导入本地 PDF：复制进文库、抽全文、用首页正文首行当标题。 */
    async importPdf(inputPath) {
      const checked = validateImportPath(inputPath)
      if (!checked.ok) throw new Error(checked.error)
      let info
      try {
        info = await stat(checked.path)
      } catch {
        throw new Error(`文件不存在：${checked.path}`)
      }
      if (!info.isFile()) throw new Error(`不是文件：${checked.path}`)

      const id = `local-${stamp()}-${slugify(checked.path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? '', 24)}`
      await ensureLayout()
      await mkdir(options.pdfDir, { recursive: true })
      const pdfAbs = abs(store.pdfRelative(id))
      await copyFile(checked.path, pdfAbs)

      const paper = recordFromLocal({
        id,
        title: checked.path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? id,
        localPath: checked.path,
        pdfPath: store.pdfRelative(id),
      })
      paper.pdfBytes = info.size

      let warning = ''
      try {
        await runExtract(paper, 0)
        const text = await readText(abs(paper.textPath))
        const derived = deriveTitle(text)
        if (derived !== '') paper.title = derived
      } catch (error) {
        warning = `已导入 PDF，但全文抽取失败：${error?.message ?? error}`
        note(warning)
      }

      const index = await store.load()
      const { paper: stored, existed } = store.insertLocal(index, paper)
      await store.save(index)
      return { paper: stored, existed, warning }
    },

    /** 扫描目录，列出可导入的 PDF（浅层、有上限，避免扫爆大目录）。 */
    async scan(dir, limit = SCAN_MAX_FILES) {
      const root = String(dir ?? '').trim() === '' ? options.root : String(dir).trim()
      const cap = Math.max(1, Math.min(SCAN_MAX_FILES, Math.round(Number(limit) || SCAN_MAX_FILES)))
      const found = []
      const queue = [{ dir: root, depth: 0 }]
      while (queue.length > 0 && found.length < cap) {
        const node = queue.shift()
        let entries
        try {
          entries = await readdir(node.dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (found.length >= cap) break
          if (entry.isDirectory()) {
            if (node.depth >= SCAN_MAX_DEPTH) continue
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
            queue.push({ dir: join(node.dir, entry.name), depth: node.depth + 1 })
          } else if (entry.isFile() && isPdfName(entry.name)) {
            found.push({ path: join(node.dir, entry.name), name: entry.name })
          }
        }
      }
      return { dir: root, count: found.length, files: found }
    },

    /** 打开文件所在目录（尽力而为：只在宿主与浏览器同机时有意义）。 */
    async reveal(id) {
      const index = await store.load()
      const paper = store.find(index, id)
      if (paper === null) throw new Error(`未找到论文：${id}`)
      const target = paper.pdfPath !== '' ? abs(paper.pdfPath) : options.root
      const spawnDetached = deps.spawnDetached ?? defaultReveal
      try {
        await spawnDetached(target)
        return { ok: true, target }
      } catch (error) {
        return { ok: false, target, error: `打开目录失败（仅本机可用）：${error?.message ?? error}` }
      }
    },

    /** 一次性返回当前状态 + 兼容性信息，给 /health。 */
    health(extra = {}) {
      return {
        plugin: 'dsh-paperdesk',
        version: extra.pluginVersion ?? '0.1.0',
        root: options.root,
        extractor: { kind: extractor.kind, engine: extractor.engine, command: extractor.command, note: extractor.note },
        ...extra,
      }
    },
  }

  return service
}

/**
 * 从全文里猜标题：取前面若干行里第一行「像标题」的文本。
 * 规则故意保守 —— 猜错一个标题比留空更让人困惑，所以只在足够像的时候才采用。
 * @param {string|null} text
 * @returns {string}
 */
export function deriveTitle(text) {
  if (text === null) return ''
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim())
  for (const line of lines.slice(0, 40)) {
    if (line.length < 12 || line.length > 160) continue
    if (/^arxiv:/i.test(line)) continue
    if (/^\d+$/.test(line)) continue
    if (/^(abstract|introduction|keywords|contents|references)\b/i.test(line)) continue
    if (/[\u4e00-\u9fff]/.test(line) && line.length < 16) continue
    const letters = (line.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length
    if (letters / line.length < 0.6) continue
    return line
  }
  return ''
}

/**
 * 默认的「打开目录」实现：三个平台各一条命令，全部 detach，失败不影响插件。
 * @param {string} target
 * @returns {Promise<void>}
 */
async function defaultReveal(target) {
  const { spawn } = await import('node:child_process')
  const { dirname } = await import('node:path')
  const platform = process.platform
  const child = platform === 'win32'
    ? spawn('explorer', ['/select,', target], { detached: true, stdio: 'ignore', windowsHide: true })
    : platform === 'darwin'
      ? spawn('open', ['-R', target], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' })
  child.unref()
}
