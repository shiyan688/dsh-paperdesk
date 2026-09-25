/**
 * arXiv 解析与检索的单测。
 *
 * 这些测试**不发真实网络请求**：feed 用一份贴近真实的 Atom 片段，
 * fetch 用假的实现。理由很实际 —— 打真实 arXiv 的测试在 CI 里要么慢要么随机失败，
 * 而真正容易写错的是解析（属性顺序、实体转义、缺字段），那部分恰好是纯函数。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  baseArxivId,
  buildIdUrl,
  buildSearchUrl,
  fetchText,
  lookupArxiv,
  normalizeArxivId,
  parseFeed,
  searchArxiv,
} from '../lib/core/arxiv.js'

/** 一份贴近真实的 arXiv Atom feed（含两个条目、多作者、多分类、实体转义）。 */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query: search_query=all:attention</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:00:00Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks &amp; attention. We propose the Transformer.
  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <author><name>Niki Parmar</name></author>
    <author><name>Jakob Uszkoreit</name></author>
    <author><name>Llion Jones</name></author>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <published>2024-01-22T10:00:00Z</published>
    <title>Revisiting &lt;World Models&gt; for Control</title>
    <summary>A short abstract.</summary>
    <author><name>Someone Else</name></author>
    <arxiv:primary_category term="cs.LG"/>
    <link href="http://arxiv.org/pdf/2401.12345v2" title="pdf" rel="related"/>
  </entry>
</feed>`

test('parseFeed 抽出条目、作者、分类与 https 链接', () => {
  const results = parseFeed(FEED)
  assert.equal(results.length, 2)

  const first = results[0]
  assert.equal(first.arxivId, '1706.03762v7')
  assert.equal(first.baseId, '1706.03762')
  assert.equal(first.title, 'Attention Is All You Need')
  assert.deepEqual(first.authors.slice(0, 2), ['Ashish Vaswani', 'Noam Shazeer'])
  assert.equal(first.authors.length, 5)
  assert.equal(first.primaryCategory, 'cs.CL')
  assert.deepEqual(first.categories, ['cs.CL', 'cs.LG'])
  assert.equal(first.published, '2017-06-12')
  assert.equal(first.url, 'https://arxiv.org/abs/1706.03762v7')
  // feed 给的是 http，统一升到 https；两种 link 属性顺序都要认
  assert.equal(first.pdfUrl, 'https://arxiv.org/pdf/1706.03762v7')
  assert.equal(results[1].pdfUrl, 'https://arxiv.org/pdf/2401.12345v2')
})

test('parseFeed 解开实体并折叠摘要里的换行', () => {
  const first = parseFeed(FEED)[0]
  assert.ok(first.abstract.includes('networks & attention'))
  assert.ok(!first.abstract.includes('\n'))
  assert.equal(parseFeed(FEED)[1].title, 'Revisiting <World Models> for Control')
})

test('parseFeed 对垃圾输入返回空数组而不是抛错', () => {
  assert.deepEqual(parseFeed(''), [])
  assert.deepEqual(parseFeed('<feed></feed>'), [])
  assert.deepEqual(parseFeed(null), [])
  // 缺 id 或缺 title 的条目直接丢掉：宁可少一条，也不要 id 为空的记录进文库
  assert.deepEqual(parseFeed('<feed><entry><title>No id</title></entry></feed>'), [])
})

test('normalizeArxivId 接受各种写法，拒绝看不懂的输入', () => {
  assert.equal(normalizeArxivId('1706.03762'), '1706.03762')
  assert.equal(normalizeArxivId('1706.03762v7'), '1706.03762v7')
  assert.equal(normalizeArxivId('https://arxiv.org/abs/1706.03762'), '1706.03762')
  assert.equal(normalizeArxivId('https://arxiv.org/pdf/1706.03762v7.pdf'), '1706.03762v7')
  assert.equal(normalizeArxivId('arXiv:1706.03762'), '1706.03762')
  assert.equal(normalizeArxivId('cs/0701001'), 'cs/0701001')
  assert.equal(normalizeArxivId('hello world'), '')
  assert.equal(normalizeArxivId(''), '')
})

test('baseArxivId 去掉版本号', () => {
  assert.equal(baseArxivId('1706.03762v7'), '1706.03762')
  assert.equal(baseArxivId('1706.03762'), '1706.03762')
})

test('buildSearchUrl：自然语言走 all:，含冒号的原样传，条数被夹住', () => {
  const natural = buildSearchUrl('diffusion policy robot', 8)
  assert.ok(natural.includes(`search_query=${encodeURIComponent('all:diffusion policy robot')}`))
  assert.ok(natural.includes('max_results=8'))

  const syntax = buildSearchUrl('ti:"world model" AND cat:cs.LG', 8)
  assert.ok(syntax.includes(encodeURIComponent('ti:"world model" AND cat:cs.LG')))

  assert.ok(buildSearchUrl('x', 9999).includes('max_results=50'))
  assert.ok(buildSearchUrl('x', 0).includes('max_results=1'))
})

test('buildIdUrl 支持多个编号', () => {
  assert.ok(buildIdUrl(['1706.03762', '2401.12345']).includes(encodeURIComponent('1706.03762,2401.12345')))
})

test('fetchText 对非 2xx 抛带状态码的错，超时抛超时错', async () => {
  await assert.rejects(
    () => fetchText('http://example.invalid', { fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'busy' }) }),
    /503/,
  )
  await assert.rejects(
    () => fetchText('http://example.invalid', {
      fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error },
      timeoutMs: 50,
    }),
    /超时/,
  )
})

test('searchArxiv / lookupArxiv 走假 fetch 也能串起来', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => FEED })
  const results = await searchArxiv('attention', 5, { fetchImpl })
  assert.equal(results.length, 2)

  const one = await lookupArxiv('1706.03762v7', { fetchImpl })
  assert.equal(one.baseId, '1706.03762')

  const missing = await lookupArxiv('1706.03762', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<feed></feed>' }) })
  assert.equal(missing, null)

  await assert.rejects(() => searchArxiv('   ', 5, { fetchImpl }), /关键词/)
  await assert.rejects(() => lookupArxiv('not-an-id', { fetchImpl }), /无法识别/)
})
