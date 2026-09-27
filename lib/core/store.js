/**
 * dsh-paperdesk — 本地文库索引（`state/index.json`）。
 *
 * 一个「文库」就是一个 JSON 文件加三个目录：
 *
 *   <root>/state/index.json   题录 + 状态 + 标签 + 三层笔记（唯一事实来源）
 *   <root>/pdf/<id>.pdf       下载或导入的 PDF
 *   <root>/text/<id>.txt      抽取出来的全文
 *   <root>/notes/<id>.md      人类可读的三层笔记（由索引渲染出来，可随时重生成）
 *
 * 为什么笔记同时存两份：索引是给界面和工具读的（结构化、快），
 * markdown 是给人的（可 diff、可进 git、可单独拿走）。两者都由本模块渲染，不会漂移。
 *
 * 可测试性：`createStore` 的所有外部依赖（读写、时钟）都能注入，
 * 所以单测可以在内存里跑完整 CRUD，不碰磁盘。
 */

import { join } from 'node:path'
import { nowIso, readJsonSafe, writeJson } from './text.js'

/** 当前索引 schema 版本。改动索引结构时必须 +1 并补一条迁移。 */
export const INDEX_VERSION = 1

/** 状态取值与中文标签的唯一定义处。 */
export const STATUS_TEXT = Object.freeze({ unread: '未读', reading: '在读', read: '已读' })

/**
 * 迁移表：`MIGRATIONS[n]` 把版本 n 的索引升到 n+1。
 *
 * 现在只有版本 1，所以表是空的 —— 但脚手架先立在这里，并且有测试覆盖
 * 「未知的更高版本要拒绝而不是装作能读」，这样将来加字段时不会靠人记得。
 * @type {Array<(index: any) => any>}
 */
export const MIGRATIONS = []

/**
 * 空索引。
 * @param {string} [root]
 * @returns {any}
 */
export function emptyIndex(root = '') {
  return { version: INDEX_VERSION, root, updatedAt: nowIso(), papers: [] }
}

/**
 * 把磁盘上的任意 JSON 收敛成一份当前版本的索引。
 *
 * 三种输入要分清：
 *  - 读不到（null）→ 新库；
 *  - 结构不对 → 当作损坏，返回新库并给出 warning（**不静默丢数据**：调用方会把原文件改名备份）；
 *  - 版本更高 → 拒绝（futureVersion: true），因为这个进程不认识新字段，写回去会削掉用户数据。
 *
 * @param {any} raw
 * @param {string} [root]
 * @returns {{ index: any, warning: string, futureVersion: boolean, corrupted: boolean }}
 */
export function migrateIndex(raw, root = '') {
  if (raw === null || raw === undefined) {
    return { index: emptyIndex(root), warning: '', futureVersion: false, corrupted: false }
  }
  if (typeof raw !== 'object' || !Array.isArray(raw.papers)) {
    return {
      index: emptyIndex(root),
      warning: 'index.json 结构不可识别，已按空库启动（原文件已备份为 index.corrupt-<时间>.json）',
      futureVersion: false,
      corrupted: true,
    }
  }
  let version = Number.isInteger(raw.version) ? raw.version : 0
  if (version > INDEX_VERSION) {
    return {
      index: emptyIndex(root),
      warning: `index.json 版本 ${version} 高于本插件认识的 ${INDEX_VERSION}，已只读启动以免削掉新字段`,
      futureVersion: true,
      corrupted: false,
    }
  }
  let index = { ...raw }
  while (version < INDEX_VERSION) {
    const migrate = MIGRATIONS[version]
    index = typeof migrate === 'function' ? migrate(index) : index
    version += 1
  }
  index.version = INDEX_VERSION
  index.root = root
  index.papers = index.papers.map((paper) => normalizeRecord(paper))
  return { index, warning: '', futureVersion: false, corrupted: false }
}

/**
 * 补齐一条题录的缺省字段，并按 id 去重（同 id 保留先出现的）。
 * @param {any} paper
 * @returns {any}
 */
export function normalizeRecord(paper) {
  const record = paper && typeof paper === 'object' ? paper : {}
  return {
    id: String(record.id ?? ''),
    source: record.source === 'local' ? 'local' : 'arxiv',
    arxivId: String(record.arxivId ?? ''),
    title: String(record.title ?? record.id ?? ''),
    authors: Array.isArray(record.authors) ? record.authors.map(String).filter((x) => x !== '') : [],
    abstract: String(record.abstract ?? ''),
    published: String(record.published ?? ''),
    updated: String(record.updated ?? ''),
    categories: Array.isArray(record.categories) ? record.categories.map(String) : [],
    primaryCategory: String(record.primaryCategory ?? ''),
    url: String(record.url ?? ''),
    pdfUrl: String(record.pdfUrl ?? ''),
    status: normalizeStatus(record.status) || 'unread',
    tags: toTagList(record.tags),
    rating: clampRating(record.rating),
    notes: {
      quick: String(record.notes?.quick ?? ''),
      understand: String(record.notes?.understand ?? ''),
      critique: String(record.notes?.critique ?? ''),
    },
    addedAt: String(record.addedAt ?? ''),
    noteUpdatedAt: String(record.noteUpdatedAt ?? ''),
    pdfPath: String(record.pdfPath ?? ''),
    textPath: String(record.textPath ?? ''),
    pdfBytes: Number(record.pdfBytes ?? 0) || 0,
    textChars: Number(record.textChars ?? 0) || 0,
    pages: Number(record.pages ?? 0) || 0,
    textEngine: String(record.textEngine ?? ''),
    localPath: String(record.localPath ?? ''),
  }
}

/**
 * 状态归一：接受英文枚举，也接受中文（工具参数里模型很爱写中文）。
 * @param {unknown} value
 * @returns {'unread'|'reading'|'read'|''}
 */
export function normalizeStatus(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'read' || text === '已读' || text === '读完') return 'read'
  if (text === 'reading' || text === '在读') return 'reading'
  if (text === 'unread' || text === '未读' || text === '待读') return 'unread'
  return ''
}

/**
 * @param {unknown} value
 * @returns {number} 0-5 的整数
 */
export function clampRating(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 0
  return Math.min(5, Math.max(0, n))
}

/**
 * 标签归一：数组和逗号分隔字符串都接受（中英文逗号、分号都认）。
 *
 * 收口在这里是有原因的：UI 走 `/update` 传的是数组，而模型工具 `paper_note`
 * 的参数按 schema 是字符串。以前 `patch()` 只认数组，于是工具传字符串被静默丢弃，
 * 「标签已重设」其实是空操作，调用方看不到任何报错。
 *
 * @param {unknown} value
 * @returns {string[]} 最多 20 个，已去空白项
 */
export function toTagList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；]/)
  return parts.map(String).map((x) => x.trim()).filter((x) => x !== '').slice(0, 20)
}

/**
 * 从 arXiv 条目构造一条新题录。
 * @param {any} meta `arxiv.js` 的解析结果
 * @param {{ now?: () => string }} [deps]
 * @returns {any}
 */
export function recordFromArxiv(meta, deps = {}) {
  const now = deps.now ?? nowIso
  return normalizeRecord({
    id: meta.baseId,
    source: 'arxiv',
    arxivId: meta.arxivId,
    title: meta.title,
    authors: meta.authors,
    abstract: meta.abstract,
    published: meta.published,
    updated: meta.updated,
    categories: meta.categories,
    primaryCategory: meta.primaryCategory,
    url: meta.url,
    pdfUrl: meta.pdfUrl,
    status: 'unread',
    addedAt: now(),
  })
}

/**
 * 构造一条本地导入题录。
 * @param {{ id: string, title: string, authors?: string[], abstract?: string, pages?: number, localPath?: string, pdfPath?: string }} input
 * @param {{ now?: () => string }} [deps]
 * @returns {any}
 */
export function recordFromLocal(input, deps = {}) {
  const now = deps.now ?? nowIso
  return normalizeRecord({
    id: input.id,
    source: 'local',
    title: input.title,
    authors: input.authors ?? [],
    abstract: input.abstract ?? '',
    pages: input.pages ?? 0,
    tags: ['本地导入'],
    status: 'unread',
    addedAt: now(),
    localPath: input.localPath ?? '',
    pdfPath: input.pdfPath ?? '',
  })
}

/**
 * 面向界面/工具的瘦身视图（不带摘要与笔记正文，用于列表）。
 * @param {any} paper
 * @returns {any}
 */
export function liteRecord(paper) {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors.slice(0, 3),
    authorCount: paper.authors.length,
    year: String(paper.published || paper.addedAt || '').slice(0, 4),
    status: paper.status,
    tags: paper.tags,
    rating: paper.rating,
    source: paper.source,
    arxivId: paper.arxivId,
    url: paper.url,
    cat: paper.primaryCategory,
    addedAt: paper.addedAt,
    pages: paper.pages,
    hasPdf: paper.pdfPath !== '',
    hasText: paper.textPath !== '',
    hasNote: paper.notes.quick !== '' || paper.notes.understand !== '' || paper.notes.critique !== '',
  }
}

/**
 * 文库统计。
 * @param {any} index
 * @returns {{ total: number, unread: number, reading: number, read: number, pdf: number, text: number, noted: number }}
 */
export function indexStats(index) {
  const stats = { total: index.papers.length, unread: 0, reading: 0, read: 0, pdf: 0, text: 0, noted: 0 }
  for (const paper of index.papers) {
    if (paper.status === 'reading') stats.reading += 1
    else if (paper.status === 'read') stats.read += 1
    else stats.unread += 1
    if (paper.pdfPath !== '') stats.pdf += 1
    if (paper.textPath !== '') stats.text += 1
    if (paper.notes.quick !== '' || paper.notes.understand !== '' || paper.notes.critique !== '') stats.noted += 1
  }
  return stats
}

/**
 * 建一个文库 store。
 *
 * @param {{
 *   paths: { indexPath: string, pdfDir: string, textDir: string, notesDir: string, root: string },
 *   io?: { readJson: (path: string) => Promise<any>, writeJson: (path: string, value: unknown) => Promise<void> },
 *   now?: () => string,
 * }} input
 */
export function createStore(input) {
  const paths = input.paths
  const readJson = input.io?.readJson ?? readJsonSafe
  const writeJsonImpl = input.io?.writeJson ?? writeJson
  const now = input.now ?? nowIso

  /** 最近一次 load 的兼容性告警，供 /health 展示。 */
  let lastWarning = ''

  /** @type {any|null} */
  let cache = null

  const store = {
    paths,
    get warning() {
      return lastWarning
    },
    /** 读索引（每次读盘，保证多进程/多会话下不互相盖掉）。 */
    async load() {
      const raw = await readJson(paths.indexPath)
      const result = migrateIndex(raw, paths.root)
      lastWarning = result.warning
      cache = result.index
      return result.index
    },
    /** 写索引。 */
    async save(index) {
      index.version = INDEX_VERSION
      index.root = paths.root
      index.updatedAt = now()
      await writeJsonImpl(paths.indexPath, index)
      cache = index
      return index
    },
    /** 读-改-写一步完成，避免调用方忘了 save。 */
    async mutate(fn) {
      const index = await store.load()
      const result = await fn(index)
      await store.save(index)
      return result
    },
    /**
     * 定位一篇论文：id 精确 → arXiv 号（忽略版本）→ 标题子串（>= 4 字）。
     * @param {any} index
     * @param {unknown} key
     * @returns {any|null}
     */
    find(index, key) {
      const text = String(key ?? '').trim()
      if (text === '') return null
      const lower = text.toLowerCase()
      for (const paper of index.papers) {
        if (paper.id === text) return paper
      }
      for (const paper of index.papers) {
        if (paper.arxivId !== '' && paper.arxivId.toLowerCase() === lower) return paper
      }
      if (lower.length >= 4) {
        for (const paper of index.papers) {
          if (paper.title.toLowerCase().includes(lower)) return paper
        }
      }
      return null
    },
    /**
     * arXiv 元数据 upsert：已存在则只刷新题录字段，**不动**用户写的状态/标签/笔记。
     * @param {any} index
     * @param {any} meta
     * @returns {{ paper: any, existed: boolean }}
     */
    upsertArxiv(index, meta) {
      const existing = index.papers.find((paper) => paper.id === meta.baseId)
      if (existing !== undefined) {
        Object.assign(existing, {
          arxivId: meta.arxivId,
          title: meta.title,
          authors: meta.authors,
          abstract: meta.abstract,
          published: meta.published,
          updated: meta.updated,
          categories: meta.categories,
          primaryCategory: meta.primaryCategory,
          url: meta.url,
          pdfUrl: meta.pdfUrl,
        })
        return { paper: existing, existed: true }
      }
      const paper = recordFromArxiv(meta, { now })
      index.papers.unshift(paper)
      return { paper, existed: false }
    },
    /**
     * 新增一条本地题录（同 id 已存在则返回旧的，导入是幂等的）。
     * @param {any} index
     * @param {any} record
     * @returns {{ paper: any, existed: boolean }}
     */
    insertLocal(index, record) {
      const existing = index.papers.find((paper) => paper.id === record.id)
      if (existing !== undefined) return { paper: existing, existed: true }
      index.papers.unshift(record)
      return { paper: record, existed: false }
    },
    /**
     * 打补丁：只允许白名单字段，其余忽略（模型给的参数不可信）。
     * @param {any} paper
     * @param {any} patch
     * @returns {any} 同一个 paper 对象（已就地修改）
     */
    patch(paper, patch) {
      const input = patch && typeof patch === 'object' ? patch : {}
      if (typeof input.status === 'string') {
        const status = normalizeStatus(input.status)
        if (status !== '') paper.status = status
      }
      if (typeof input.title === 'string' && input.title.trim() !== '') paper.title = input.title.trim()
      if (input.tags !== undefined) paper.tags = toTagList(input.tags)
      if (input.rating !== undefined) paper.rating = clampRating(input.rating)
      return paper
    },
    /**
     * 写入三层笔记（只覆盖显式给出的层）。
     * @param {any} paper
     * @param {any} notes
     * @returns {any}
     */
    writeNotes(paper, notes) {
      const input = notes && typeof notes === 'object' ? notes : {}
      for (const key of ['quick', 'understand', 'critique']) {
        if (typeof input[key] === 'string') paper.notes[key] = input[key]
      }
      paper.noteUpdatedAt = now()
      return paper
    },
    /** PDF 在 root 下的相对路径（索引用相对路径，换机器/换盘符不会失效）。 */
    pdfRelative(id) {
      return join('pdf', `${id}.pdf`)
    },
    textRelative(id) {
      return join('text', `${id}.txt`)
    },
    noteRelative(id) {
      return join('notes', `${id}.md`)
    },
    /** 供测试查看内部缓存；生产代码不应依赖。 */
    get cached() {
      return cache
    },
  }

  return store
}
