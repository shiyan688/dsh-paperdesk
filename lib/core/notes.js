/**
 * dsh-paperdesk — 三层精读笔记的渲染。
 *
 * 三层不是装饰，是**阅读纪律**：
 *   L1 速览 —— 这篇论文说了什么（问题、结论、一句话贡献）
 *   L2 理解 —— 它凭什么成立（方法、关键设计、实验证据）
 *   L3 批判 —— 局限、可疑点、以及能搬回自己课题的东西
 *
 * 大多数「读了但没读进去」的论文，缺的都是 L3。所以这里的模板把 L3 放在
 * 摘要之前，且不提供「留空也能算完成」的模糊态：没填就写「_(未填写)_」，
 * 一眼能看出哪篇其实没读。
 */

import { STATUS_TEXT, normalizeStatus } from './store.js'

/**
 * 星级字符串。
 * @param {number} rating 0-5
 * @returns {string}
 */
export function ratingStars(rating) {
  const value = Math.min(5, Math.max(0, Math.round(Number(rating) || 0)))
  return '★'.repeat(value) + '☆'.repeat(5 - value)
}

/**
 * 渲染一篇论文的 markdown 笔记（`notes/<id>.md` 的全部内容）。
 * 这个函数是纯函数：给定同一份题录，输出逐字节相同。
 * @param {any} paper 已归一化的题录（见 store.normalizeRecord）
 * @returns {string}
 */
export function noteMarkdown(paper) {
  const status = normalizeStatus(paper.status) || 'unread'
  const lines = []
  lines.push(`# ${paper.title || paper.id}`)
  lines.push('')

  const origin = paper.arxivId !== ''
    ? ` · arXiv: ${paper.arxivId}`
    : (paper.source === 'local' ? ' · 本地导入' : '')
  lines.push(`- 编号: \`${paper.id}\`${origin}`)
  if (paper.authors.length > 0) lines.push(`- 作者: ${paper.authors.join(', ')}`)
  if (paper.published !== '') {
    lines.push(`- 发表: ${paper.published}${paper.primaryCategory !== '' ? ` · ${paper.primaryCategory}` : ''}`)
  }
  if (paper.url !== '') lines.push(`- 链接: ${paper.url}`)
  lines.push(`- 状态: ${STATUS_TEXT[status]} · 评级: ${ratingStars(paper.rating)}`)
  lines.push(`- 标签: ${paper.tags.length > 0 ? paper.tags.join(', ') : '—'}`)
  const updated = String(paper.noteUpdatedAt ?? '').slice(0, 19).replace('T', ' ')
  lines.push(`- 入库: ${String(paper.addedAt ?? '').slice(0, 19).replace('T', ' ')}${updated !== '' ? ` · 笔记更新: ${updated}` : ''}`)
  if (paper.pdfPath !== '') lines.push(`- PDF: \`${paper.pdfPath}\``)
  if (paper.textPath !== '') lines.push(`- 全文: \`${paper.textPath}\`（${paper.textChars} 字 / ${paper.pages} 页）`)
  lines.push('')

  const sections = [
    ['L1 速览 · 这篇论文说了什么', paper.notes.quick, '问题是什么？结论是什么？一句话贡献。'],
    ['L2 理解 · 它凭什么成立', paper.notes.understand, '方法怎么做的？关键设计/公式是什么？哪张图哪张表撑住了结论？'],
    ['L3 批判 · 局限、可疑点与可迁移处', paper.notes.critique, '假设成立吗？哪里可疑？哪些能搬回自己的课题？'],
  ]
  for (const [heading, body, hint] of sections) {
    lines.push(`## ${heading}`)
    lines.push('')
    lines.push(body.trim() !== '' ? body.trim() : '_(未填写)_')
    lines.push('')
    if (body.trim() === '') {
      lines.push(`<!-- 提示：${hint} -->`)
      lines.push('')
    }
  }

  if (paper.abstract !== '') {
    lines.push('---')
    lines.push('')
    lines.push('## 摘要（原文）')
    lines.push('')
    lines.push(paper.abstract)
    lines.push('')
  }

  // 折叠多余空行：拼装过程中难免出现连续空行，markdown 里它们没有语义。
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 三层笔记的完成度统计，用于界面提示与工具回执。
 * @param {any} paper
 * @returns {{ quick: number, understand: number, critique: number, filled: number, done: boolean }}
 */
export function noteProgress(paper) {
  const notes = paper.notes ?? {}
  const quick = String(notes.quick ?? '').trim().length
  const understand = String(notes.understand ?? '').trim().length
  const critique = String(notes.critique ?? '').trim().length
  const filled = [quick, understand, critique].filter((n) => n > 0).length
  return { quick, understand, critique, filled, done: filled === 3 }
}
