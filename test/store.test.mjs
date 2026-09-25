/**
 * 文库索引（store）的单测：迁移、CRUD、去重、统计。
 *
 * 全部用内存 io —— 不碰磁盘，所以这些测试既快又不依赖临时目录清理。
 * 迁移是重点：文库是**用户的长期资产**，一个读错版本的 bug 就是丢数据。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  INDEX_VERSION,
  clampRating,
  createStore,
  emptyIndex,
  indexStats,
  liteRecord,
  migrateIndex,
  normalizeRecord,
  normalizeStatus,
  recordFromArxiv,
  recordFromLocal,
} from '../lib/core/store.js'

/** 造一个内存 store。 */
function memoryStore(initial = null, now = () => '2025-01-01T00:00:00.000Z') {
  let disk = initial
  const store = createStore({
    paths: {
      root: '/lib',
      indexPath: '/lib/state/index.json',
      pdfDir: '/lib/pdf',
      textDir: '/lib/text',
      notesDir: '/lib/notes',
    },
    io: {
      readJson: async () => disk,
      writeJson: async (_path, value) => { disk = JSON.parse(JSON.stringify(value)) },
    },
    now,
  })
  return { store, disk: () => disk }
}

const META = {
  arxivId: '1706.03762v7',
  baseId: '1706.03762',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer'],
  abstract: 'The Transformer.',
  published: '2017-06-12',
  updated: '2023-08-02',
  primaryCategory: 'cs.CL',
  categories: ['cs.CL', 'cs.LG'],
  url: 'https://arxiv.org/abs/1706.03762v7',
  pdfUrl: 'https://arxiv.org/pdf/1706.03762v7',
}

test('migrateIndex：读不到就是新库', () => {
  const result = migrateIndex(null, '/lib')
  assert.equal(result.corrupted, false)
  assert.equal(result.warning, '')
  assert.equal(result.index.version, INDEX_VERSION)
  assert.deepEqual(result.index.papers, [])
  assert.equal(result.index.root, '/lib')
})

test('migrateIndex：结构损坏时给告警而不是静默当空库', () => {
  const result = migrateIndex({ papers: 'not-an-array' }, '/lib')
  assert.equal(result.corrupted, true)
  assert.match(result.warning, /备份/)
  assert.deepEqual(result.index.papers, [])
})

test('migrateIndex：更高版本拒绝读取（避免写回去削掉新字段）', () => {
  const result = migrateIndex({ version: INDEX_VERSION + 5, papers: [{ id: 'x' }] }, '/lib')
  assert.equal(result.futureVersion, true)
  assert.match(result.warning, /高于本插件认识的/)
  assert.deepEqual(result.index.papers, [])
})

test('migrateIndex：旧记录被补齐字段而不是丢弃', () => {
  const result = migrateIndex({ version: 0, papers: [{ id: 'a', title: 'Old', status: '已读', rating: '4' }] }, '/lib')
  const paper = result.index.papers[0]
  assert.equal(paper.status, 'read')
  assert.equal(paper.rating, 4)
  assert.deepEqual(paper.notes, { quick: '', understand: '', critique: '' })
  assert.equal(paper.source, 'arxiv')
  assert.deepEqual(paper.tags, [])
})

test('normalizeRecord 把脏字段收敛成可用值', () => {
  const paper = normalizeRecord({
    id: 'x',
    authors: ['a', '', 3],
    tags: Array.from({ length: 30 }, (_, i) => `t${i}`),
    rating: 99,
    status: '???',
    notes: { quick: 'q' },
  })
  assert.deepEqual(paper.authors, ['a', '3'])
  assert.equal(paper.tags.length, 20)
  assert.equal(paper.rating, 5)
  assert.equal(paper.status, 'unread')
  assert.equal(paper.notes.quick, 'q')
  assert.equal(paper.notes.critique, '')
})

test('normalizeStatus / clampRating 接受中文与越界值', () => {
  assert.equal(normalizeStatus('在读'), 'reading')
  assert.equal(normalizeStatus('已读'), 'read')
  assert.equal(normalizeStatus('未读'), 'unread')
  assert.equal(normalizeStatus('nonsense'), '')
  assert.equal(clampRating(-3), 0)
  assert.equal(clampRating(2.6), 3)
  assert.equal(clampRating('abc'), 0)
})

test('upsertArxiv：新条目入库，重复条目只刷新题录、不动用户数据', async () => {
  const { store } = memoryStore({ version: INDEX_VERSION, root: '/lib', papers: [] })
  const index = await store.load()

  const first = store.upsertArxiv(index, META)
  assert.equal(first.existed, false)
  assert.equal(index.papers.length, 1)

  // 用户改了状态、标签、笔记
  store.patch(first.paper, { status: 'reading', tags: ['transformer'], rating: 5 })
  store.writeNotes(first.paper, { quick: '我的速览' })

  const again = store.upsertArxiv(index, { ...META, title: 'Attention Is All You Need (v8)', arxivId: '1706.03762v8' })
  assert.equal(again.existed, true)
  assert.equal(index.papers.length, 1)
  assert.equal(again.paper.title, 'Attention Is All You Need (v8)')
  assert.equal(again.paper.arxivId, '1706.03762v8')
  // 这三样必须原样保留 —— 这是「刷新题录」和「覆盖用户工作」的分界线
  assert.equal(again.paper.status, 'reading')
  assert.deepEqual(again.paper.tags, ['transformer'])
  assert.equal(again.paper.notes.quick, '我的速览')
})

test('insertLocal 幂等：同 id 不重复插', async () => {
  const { store } = memoryStore()
  const index = await store.load()
  const record = recordFromLocal({ id: 'local-1', title: 'Some PDF' })
  assert.equal(store.insertLocal(index, record).existed, false)
  assert.equal(store.insertLocal(index, record).existed, true)
  assert.equal(index.papers.length, 1)
})

test('find 支持 id / arXiv 号 / 标题片段', async () => {
  const { store } = memoryStore()
  const index = await store.load()
  store.upsertArxiv(index, META)
  assert.equal(store.find(index, '1706.03762').id, '1706.03762')
  assert.equal(store.find(index, '1706.03762v7').id, '1706.03762')
  assert.equal(store.find(index, 'attention is all').id, '1706.03762')
  assert.equal(store.find(index, 'ATTENTION IS ALL').id, '1706.03762')
  assert.equal(store.find(index, 'nothing here'), null)
  assert.equal(store.find(index, ''), null)
  // 太短的片段不参与匹配，避免「a」命中一切
  assert.equal(store.find(index, 'att'), null)
})

test('patch 只认白名单字段', async () => {
  const { store } = memoryStore()
  const index = await store.load()
  const { paper } = store.upsertArxiv(index, META)
  store.patch(paper, { status: 'read', tags: ['a', '', 'b'], rating: 3, title: '  New Title  ', id: 'hacked', pdfPath: '/etc/passwd' })
  assert.equal(paper.status, 'read')
  assert.deepEqual(paper.tags, ['a', 'b'])
  assert.equal(paper.rating, 3)
  assert.equal(paper.title, 'New Title')
  assert.equal(paper.id, '1706.03762', 'id 不能被打补丁改掉')
  assert.equal(paper.pdfPath, '', 'pdfPath 不能被打补丁改掉')
})

test('writeNotes 只覆盖显式给出的层，并盖时间戳', async () => {
  const { store } = memoryStore(null, () => '2025-02-02T00:00:00.000Z')
  const index = await store.load()
  const { paper } = store.upsertArxiv(index, META)
  store.writeNotes(paper, { quick: 'Q' })
  assert.equal(paper.notes.quick, 'Q')
  assert.equal(paper.notes.understand, '')
  store.writeNotes(paper, { critique: 'C' })
  assert.equal(paper.notes.quick, 'Q', '没给的层不能被清空')
  assert.equal(paper.notes.critique, 'C')
  assert.equal(paper.noteUpdatedAt, '2025-02-02T00:00:00.000Z')
})

test('save 会盖 version/root/updatedAt 并写盘', async () => {
  const { store, disk } = memoryStore(null, () => '2025-03-03T00:00:00.000Z')
  const index = emptyIndex('/wrong')
  index.version = 0
  await store.save(index)
  assert.equal(disk().version, INDEX_VERSION)
  assert.equal(disk().root, '/lib')
  assert.equal(disk().updatedAt, '2025-03-03T00:00:00.000Z')
})

test('indexStats 与 liteRecord 口径一致', async () => {
  const { store } = memoryStore()
  const index = await store.load()
  const { paper } = store.upsertArxiv(index, META)
  store.upsertArxiv(index, { ...META, baseId: '2401.12345', arxivId: '2401.12345v2', title: 'Second' })
  store.patch(paper, { status: 'read' })
  paper.pdfPath = 'pdf/1706.03762.pdf'
  paper.textPath = 'text/1706.03762.txt'
  store.writeNotes(paper, { quick: 'x' })

  const stats = indexStats(index)
  assert.deepEqual(stats, { total: 2, unread: 1, reading: 0, read: 1, pdf: 1, text: 1, noted: 1 })

  const lite = liteRecord(paper)
  assert.equal(lite.id, '1706.03762')
  assert.equal(lite.hasPdf, true)
  assert.equal(lite.hasText, true)
  assert.equal(lite.hasNote, true)
  assert.equal(lite.year, '2017')
  assert.equal(lite.authorCount, 2)
  assert.deepEqual(lite.authors, ['Ashish Vaswani', 'Noam Shazeer'])
})

test('recordFromArxiv / recordFromLocal 带上入库时间', () => {
  const fromArxiv = recordFromArxiv(META, { now: () => 'T' })
  assert.equal(fromArxiv.addedAt, 'T')
  assert.equal(fromArxiv.id, '1706.03762')
  assert.equal(fromArxiv.status, 'unread')

  const fromLocal = recordFromLocal({ id: 'local-1', title: 'X', pages: 12 }, { now: () => 'T' })
  assert.equal(fromLocal.source, 'local')
  assert.deepEqual(fromLocal.tags, ['本地导入'])
  assert.equal(fromLocal.pages, 12)
})
