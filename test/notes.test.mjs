/**
 * 三层笔记渲染的单测。
 *
 * 这里断言的是**格式契约**：`notes/<id>.md` 是给人看的长期资产，
 * 标题层级、三层顺序、「未填写」的显式标记都不能随便变 ——
 * 变了的话，已经攒了半年的笔记目录会突然变得不一致。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { noteMarkdown, noteProgress, ratingStars } from '../lib/core/notes.js'
import { normalizeRecord } from '../lib/core/store.js'

const PAPER = normalizeRecord({
  id: '1706.03762',
  source: 'arxiv',
  arxivId: '1706.03762v7',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer'],
  abstract: 'The dominant sequence transduction models…',
  published: '2017-06-12',
  primaryCategory: 'cs.CL',
  url: 'https://arxiv.org/abs/1706.03762v7',
  status: 'reading',
  tags: ['transformer', 'attention'],
  rating: 4,
  addedAt: '2025-01-01T00:00:00.000Z',
  noteUpdatedAt: '2025-01-02T03:04:05.000Z',
  pdfPath: 'pdf/1706.03762.pdf',
  textPath: 'text/1706.03762.txt',
  textChars: 41234,
  pages: 15,
})

test('noteMarkdown 输出题录、三层小节与原文摘要', () => {
  const text = noteMarkdown(PAPER)

  assert.ok(text.startsWith('# Attention Is All You Need\n'))
  assert.match(text, /- 编号: `1706\.03762` · arXiv: 1706\.03762v7/)
  assert.match(text, /- 作者: Ashish Vaswani, Noam Shazeer/)
  assert.match(text, /- 发表: 2017-06-12 · cs\.CL/)
  assert.match(text, /- 链接: https:\/\/arxiv\.org\/abs\/1706\.03762v7/)
  assert.match(text, /- 状态: 在读 · 评级: ★★★★☆/)
  assert.match(text, /- 标签: transformer, attention/)
  assert.match(text, /- PDF: `pdf\/1706\.03762\.pdf`/)
  assert.match(text, /- 全文: `text\/1706\.03762\.txt`（41234 字 \/ 15 页）/)

  // 三层小节必须按 L1 → L2 → L3 顺序出现，且都在「摘要（原文）」之前
  const l1 = text.indexOf('## L1 速览')
  const l2 = text.indexOf('## L2 理解')
  const l3 = text.indexOf('## L3 批判')
  const abstract = text.indexOf('## 摘要（原文）')
  assert.ok(l1 > 0 && l2 > l1 && l3 > l2, '三层必须按 L1/L2/L3 顺序出现')
  assert.ok(abstract > l3, '原文摘要放在三层之后，避免抢走注意力')
})

test('没写的层显式标成「未填写」而不是留白', () => {
  const text = noteMarkdown({ ...PAPER, notes: { quick: '已写', understand: '', critique: '' } })
  assert.match(text, /## L1 速览[\s\S]*?已写/)
  const blanks = text.match(/_\(未填写\)_/g) ?? []
  assert.equal(blanks.length, 2, 'L2/L3 各一个未填写标记')
  // 未填写的层带一条提示注释，方便直接在该文件里补
  assert.match(text, /<!-- 提示：/)
})

test('noteMarkdown 是纯函数：同样输入逐字节相同', () => {
  assert.equal(noteMarkdown(PAPER), noteMarkdown(PAPER))
})

test('没有作者/标签/PDF 时不留空壳行', () => {
  const bare = normalizeRecord({ id: 'local-1', source: 'local', title: 'Scanned Paper' })
  const text = noteMarkdown(bare)
  assert.ok(!text.includes('- 作者:'))
  assert.ok(!text.includes('- 标签: —') === false, '标签行用 — 占位，保持字段完整')
  assert.ok(!text.includes('- PDF:'))
  assert.match(text, /- 编号: `local-1` · 本地导入/)
})

test('noteProgress 统计每层字数与完成度', () => {
  assert.deepEqual(noteProgress({ notes: { quick: ' a ', understand: '', critique: 'cc' } }), {
    quick: 1,
    understand: 0,
    critique: 2,
    filled: 2,
    done: false,
  })
  assert.equal(noteProgress({ notes: { quick: 'a', understand: 'b', critique: 'c' } }).done, true)
  // 只有空白字符不算写过
  assert.equal(noteProgress({ notes: { quick: '   ', understand: '', critique: '' } }).filled, 0)
})

test('ratingStars 处理越界与非法值', () => {
  assert.equal(ratingStars(0), '☆☆☆☆☆')
  assert.equal(ratingStars(3), '★★★☆☆')
  assert.equal(ratingStars(9), '★★★★★')
  assert.equal(ratingStars(-2), '☆☆☆☆☆')
  assert.equal(ratingStars('x'), '☆☆☆☆☆')
})
