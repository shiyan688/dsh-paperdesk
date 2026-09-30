/**
 * dsh-paperdesk — 浏览器半区（工作台界面）。
 *
 * 形态与这套宿主上的社区插件一致（未复制其代码，只沿用公开约定）：
 *   - 通过 `window.__ModuleLoader__.load({ id, factory })` 自我注册；
 *   - React 由 factory 的 `require('react')` 注入，**不是**全局变量；
 *   - 侧栏入口挂 `sidebar.footer.action`，面板本体挂 `shell.overlay`；
 *   - 数据只用 `fetch('/paperdesk/api/*')`，不碰宿主的任何内部对象。
 *
 * 两个刻意的选择：
 *   1. **样式全部内联**，不注入 CSS、不依赖类名。加载顺序、HMR、样式隔离怎么变，
 *      界面都不会变成一坨没有样式的 HTML。
 *   2. 主题色用 CSS 变量并**同时兼容两代 token 名**（`--dsw-alias-*` 与
 *      `--dsh-color-*`），再兜一层硬编码颜色。换 DSH 版本时界面不会掉色。
 */

window.__ModuleLoader__.load({
  id: 'dsh-paperdesk',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    const NS = 'dsh-paperdesk'
    /**
     * 宿主 API 的基址。网页版就是当前 origin；**桌面版（DSH Studio）页面是 file://**，
     * `location.origin` 会变成字符串 "null"，相对路径会被当成文件路径、请求全部打空。
     * 与 dsh 自带的 dsh-client-connection / dsh-client-file-upload 同一套做法：
     * 退回 `http://dsh.internal`，由桌面外壳转发给宿主。
     */
    const HOST_BASE = (() => {
      const loc = globalThis.location
      return loc !== undefined && loc !== null && typeof loc.origin === 'string' && loc.origin !== 'null' ? loc.origin : 'http://dsh.internal'
    })()
    const API = new URL('/paperdesk/api', HOST_BASE).toString()

    /**
     * 客户端上下文的持有处。
     *
     * 组件与工厂函数定义在 factory 作用域，而 `ctx` 只在 `apply(ctx)` 的参数里 ——
     * 组件里直接写 `ctx` 会 ReferenceError（这个错曾被测试逮到）。
     * 所以 apply 时把它存到这里，组件通过 `hostCtx` 取可选服务。
     */
    let hostCtx = null

    // ── 主题色：两代 token 名 + 硬兜底 ─────────────────────────────────────
    const C = {
      bg: 'var(--dsw-alias-bg-base, var(--dsh-color-bg-primary, #ffffff))',
      surface: 'var(--dsw-alias-bg-layer-1, var(--dsh-color-bg-secondary, #f7f8fa))',
      surface2: 'var(--dsw-alias-bg-layer-2, var(--dsh-color-bg-tertiary, #eef0f4))',
      text: 'var(--dsw-alias-label-primary, var(--dsh-color-text-primary, #14161a))',
      dim: 'var(--dsw-alias-label-secondary, var(--dsh-color-text-secondary, #6b7280))',
      line: 'var(--dsw-alias-border-l1, var(--dsh-color-border, rgba(0,0,0,.12)))',
      line2: 'var(--dsw-alias-border-l2, var(--dsh-color-border-strong, rgba(0,0,0,.22)))',
      accent: 'var(--dsw-alias-brand-primary, var(--dsh-color-brand, #4d6bfe))',
      ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
    }

    const S = {
      backdrop: {
        position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'stretch',
        justifyContent: 'flex-end', background: 'rgba(0,0,0,.34)',
      },
      panel: {
        width: 'min(1180px, 97vw)', height: '100%', display: 'flex', flexDirection: 'column',
        background: C.bg, color: C.text, borderLeft: `1px solid ${C.line}`, fontSize: 13,
        boxShadow: '-8px 0 28px rgba(0,0,0,.18)',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 14px', borderBottom: `1px solid ${C.line}`, flex: 'none',
      },
      title: { fontSize: 14, fontWeight: 600 },
      tabs: { display: 'flex', gap: 2, background: C.surface2, padding: 2, borderRadius: 8 },
      tab: {
        padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: 'transparent', color: C.dim, fontSize: 12, fontFamily: 'inherit',
      },
      tabOn: { background: C.surface, color: C.text },
      spacer: { flex: 1 },
      stat: { color: C.dim, fontSize: 11.5 },
      body: { flex: 1, display: 'flex', minHeight: 0 },
      list: { flex: 1, overflow: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
      side: { width: 430, flex: 'none', borderLeft: `1px solid ${C.line}`, overflow: 'auto', padding: '12px 14px' },
      card: { border: `1px solid ${C.line}`, borderRadius: 8, padding: '10px 12px', background: C.surface },
      cardHead: { margin: '0 0 4px', fontSize: 13, fontWeight: 600, lineHeight: 1.45 },
      meta: { color: C.dim, fontSize: 11.5, lineHeight: 1.7, wordBreak: 'break-word' },
      abs: { color: C.dim, fontSize: 12, lineHeight: 1.65, marginTop: 6, maxHeight: 58, overflow: 'hidden' },
      row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
      chip: {
        fontSize: 11, padding: '1px 7px', borderRadius: 999, background: C.surface2, color: C.dim,
        border: 'none', fontFamily: 'inherit',
      },
      chipOn: { background: C.accent, color: '#fff' },
      btn: {
        border: `1px solid ${C.line}`, background: C.surface, color: C.text, borderRadius: 6,
        padding: '3px 9px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
      },
      btnPrimary: { background: C.accent, borderColor: 'transparent', color: '#fff' },
      btnDanger: { color: C.danger },
      input: {
        background: C.surface, border: `1px solid ${C.line}`, color: C.text, borderRadius: 6,
        padding: '5px 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
      },
      ta: {
        width: '100%', boxSizing: 'border-box', minHeight: 92, resize: 'vertical', background: C.surface,
        border: `1px solid ${C.line}`, borderRadius: 6, color: C.text, fontSize: 12.5, lineHeight: 1.7,
        padding: 8, fontFamily: 'inherit', outline: 'none',
      },
      label: { display: 'block', fontSize: 11.5, color: C.dim, marginBottom: 4, lineHeight: 1.6 },
      field: { marginBottom: 10 },
      hr: { height: 1, background: C.line, margin: '12px 0' },
      empty: { color: C.dim, fontSize: 12.5, padding: '28px 16px', textAlign: 'center', lineHeight: 1.9, whiteSpace: 'pre-line' },
      foot: {
        flex: 'none', padding: '6px 14px', borderTop: `1px solid ${C.line}`, color: C.dim,
        fontSize: 11.5, minHeight: 18,
      },
      fullText: {
        whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.75, background: C.surface,
        border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, maxHeight: 340, overflow: 'auto',
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
      link: { color: C.accent, textDecoration: 'none', fontSize: 12 },
    }

    const STATUS_TEXT = { unread: '未读', reading: '在读', read: '已读' }

    // ── 极简跨 slot 状态：侧栏按钮与浮层面板是两个 slot，需要共享一个开关 ──
    const listeners = new Set()
    let shared = { open: false }
    function setShared(patch) {
      shared = { ...shared, ...patch }
      for (const listener of listeners) listener()
    }
    function useShared() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((n) => n + 1)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return shared
    }

    /**
     * 调宿主半区的回环 API。错误一律收敛成 `{ error }`，界面只需要判一次。
     * @param {string} path
     * @param {object} [body]
     * @param {'GET'|'POST'} [method]
     */
    async function call(path, body, method) {
      const verb = method ?? (body === undefined ? 'GET' : 'POST')
      try {
        const response = await fetch(API + path, {
          method: verb,
          headers: verb === 'POST' ? { 'content-type': 'application/json' } : undefined,
          body: verb === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        })
        const data = await response.json().catch(() => ({ error: `响应不是 JSON（HTTP ${response.status}）` }))
        return data ?? {}
      } catch (error) {
        return { error: `无法连接宿主半区：${error?.message ?? error}` }
      }
    }

    function stars(rating) {
      const value = Math.min(5, Math.max(0, Math.round(Number(rating) || 0)))
      return '★'.repeat(value) + '☆'.repeat(5 - value)
    }

    // ── 侧栏入口 ──────────────────────────────────────────────────────────
    function FooterAction() {
      const state = useShared()
      return h('button', {
        type: 'button',
        style: { ...S.btn, display: 'flex', alignItems: 'center', gap: 4 },
        title: '论文工作台：arXiv 检索 → 本地文库 → 三层精读笔记',
        onClick: () => setShared({ open: !state.open }),
      }, '📚 论文')
    }

    // ── 浮层宿主 ──────────────────────────────────────────────────────────
    function OverlayHost() {
      const state = useShared()
      if (!state.open) return null
      return h(Panel, null)
    }

    // ── 面板 ─────────────────────────────────────────────────────────────
    function Panel() {
      const [tab, setTab] = useState('library')
      const [papers, setPapers] = useState([])
      const [stats, setStats] = useState(null)
      const [health, setHealth] = useState(null)
      const [msg, setMsg] = useState('正在连接宿主半区…')
      const [busy, setBusy] = useState('')
      const [query, setQuery] = useState('')
      const [maxResults, setMaxResults] = useState('8')
      const [results, setResults] = useState([])
      const [selected, setSelected] = useState(null)
      const [notes, setNotes] = useState({ quick: '', understand: '', critique: '' })
      const [dirty, setDirty] = useState(false)
      const [tagsDraft, setTagsDraft] = useState('')
      const [filter, setFilter] = useState('all')
      const [needle, setNeedle] = useState('')
      const [importDir, setImportDir] = useState('')
      const [importPath, setImportPath] = useState('')
      const [scanned, setScanned] = useState([])
      const [reader, setReader] = useState(null)

      async function refresh(silent) {
        const state = await call('/state', undefined, 'GET')
        if (state.error !== undefined) {
          setMsg(`⚠ ${state.error}`)
          return
        }
        setPapers(state.papers ?? [])
        setStats(state.stats ?? null)
        if (!silent) setMsg(`文库 ${state.root} · 共 ${(state.papers ?? []).length} 篇`)
      }

      useEffect(() => {
        let alive = true
        void (async () => {
          const info = await call('/health', undefined, 'GET')
          if (!alive) return
          setHealth(info.error !== undefined ? null : info)
          await refresh(true)
          if (!alive) return
          setMsg(info.error !== undefined
            ? `⚠ ${info.error}`
            : `就绪 · 抽取器 ${info.extractor?.note ?? '未探测'}${(info.warnings ?? []).length > 0 ? ` · ${info.warnings.length} 条提示（见状态）` : ''}`)
        })()
        // Esc 关闭面板：浮层不给键盘出口会很难用
        const onKey = (event) => { if (event.key === 'Escape') setShared({ open: false }) }
        if (typeof window !== 'undefined') window.addEventListener('keydown', onKey)
        return () => {
          alive = false
          if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey)
        }
      }, [])

      async function openDetail(id) {
        const data = await call('/detail', { id })
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        const paper = data.paper
        setSelected(paper)
        setNotes({
          quick: paper.notes?.quick ?? '',
          understand: paper.notes?.understand ?? '',
          critique: paper.notes?.critique ?? '',
        })
        setTagsDraft((paper.tags ?? []).join(', '))
        setDirty(false)
        setReader(null)
      }

      async function doSearch() {
        if (query.trim() === '') { setMsg('请输入检索词'); return }
        setBusy('search'); setMsg('正在检索 arXiv…')
        const data = await call('/search', { query, max: Number(maxResults) || 8 })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setResults(data.results ?? [])
        setMsg(`「${query}」命中 ${(data.results ?? []).length} 条，选一篇入库`)
      }

      async function doAdd(arxivId, download) {
        setBusy(`add:${arxivId}`)
        setMsg(`正在入库 ${arxivId}${download ? '（含 PDF 与全文，稍候）' : ''}…`)
        const data = await call('/add', { arxivId, download })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setMsg(data.warning ? `已入库，但有提示：${data.warning}` : `已入库：${data.paper?.title ?? arxivId}`)
        await refresh(true)
        if (data.paper !== undefined) { setTab('library'); await openDetail(data.paper.id) }
      }

      async function saveNotes() {
        if (selected === null) return
        setBusy('notes')
        const data = await call('/notes', { id: selected.id, notes })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setSelected(data.paper)
        setDirty(false)
        setMsg(`三层笔记已保存 → notes/${selected.id}.md`)
        await refresh(true)
      }

      async function patchPaper(patch, done) {
        if (selected === null) return
        const data = await call('/update', { id: selected.id, patch })
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setSelected(data.paper)
        setTagsDraft((data.paper.tags ?? []).join(', '))
        await refresh(true)
        if (done !== undefined) setMsg(done)
      }

      async function doExtract() {
        if (selected === null) return
        setBusy('extract'); setMsg('正在下载/解析 PDF 全文…')
        const data = await call('/extract', { id: selected.id })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setSelected(data.paper)
        await refresh(true)
        setMsg(`全文就绪：${data.chars} 字 / ${data.pages} 页（${data.engine}）${data.warning ? ` ⚠ ${data.warning}` : ''}`)
        void loadText(0)
      }

      async function loadText(offset) {
        if (selected === null) return
        const data = await call('/text', { id: selected.id, offset, limit: 12000 })
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setReader({ text: data.text ?? '', total: data.total ?? 0, offset: data.offset ?? 0 })
      }

      async function doDownload() {
        if (selected === null) return
        setBusy('pdf'); setMsg('正在下载 PDF…')
        const data = await call('/download', { id: selected.id })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setSelected(data.paper)
        await refresh(true)
        setMsg(`PDF 已就绪：${Math.round((data.bytes ?? 0) / 1024)} KB`)
      }

      async function doRemove() {
        if (selected === null) return
        setBusy('remove')
        const data = await call('/remove', { id: selected.id, withFiles: true })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setMsg(`已移出文库：${selected.id}`)
        setSelected(null); setReader(null)
        await refresh(true)
      }

      async function scanDir(dir) {
        setBusy('scan'); setMsg(`正在扫描 ${dir || '（默认目录）'}…`)
        const data = await call('/scan', { dir })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return [] }
        const files = data.files ?? []
        setScanned(files)
        setMsg(`扫描到 ${files.length} 个 PDF`)
        return files
      }

      async function doScan() { await scanDir(importDir) }

      /**
       * 用宿主提供的目录选择器挑文件夹 —— 就是系统原生的「选择文件夹」对话框，
       * 不用再手打路径。挑完直接扫描该目录。
       * `uiWorkspace` 是可选服务：宿主没提供时退回手工填路径，不报错。
       */
      async function pickFolder() {
        const ui = hostCtx === null ? undefined : hostCtx.get('uiWorkspace')
        if (ui === undefined || typeof ui.pickDirectory !== 'function') {
          setMsg('当前宿主没有提供目录选择器，请手工填写路径')
          return
        }
        try {
          const dir = await ui.pickDirectory()
          if (dir === null || dir === undefined || dir === '') { setMsg('已取消选择'); return }
          setImportDir(dir)
          await scanDir(dir)
        } catch (error) {
          setMsg(`⚠ 打开目录选择器失败：${error?.message ?? error}`)
        }
      }

      /** 把扫描到的 PDF 全部导入（导入按 id 幂等，重复点不会产生重复记录）。 */
      async function importAll() {
        if (scanned.length === 0) return
        setBusy('import')
        let ok = 0
        for (let i = 0; i < scanned.length; i += 1) {
          setMsg(`正在导入 ${i + 1}/${scanned.length}：${scanned[i].name}`)
          const data = await call('/import', { path: scanned[i].path })
          if (data.error === undefined) ok += 1
        }
        setBusy('')
        setMsg(`已导入 ${ok}/${scanned.length} 本`)
        await refresh(true)
      }

      async function doImport(path) {
        if (String(path ?? '').trim() === '') { setMsg('请填写 PDF 的绝对路径'); return }
        setBusy('import'); setMsg('正在导入…')
        const data = await call('/import', { path })
        setBusy('')
        if (data.error !== undefined) { setMsg(`⚠ ${data.error}`); return }
        setMsg(data.warning ? `已导入，但有提示：${data.warning}` : `已导入：${data.paper?.title ?? path}`)
        await refresh(true)
        if (data.paper !== undefined) { setTab('library'); await openDetail(data.paper.id) }
      }

      // ── 渲染 ────────────────────────────────────────────────────────────
      const filtered = papers.filter((paper) => {
        if (filter !== 'all' && (paper.status ?? 'unread') !== filter) return false
        const text = needle.trim().toLowerCase()
        if (text === '') return true
        const haystack = [paper.title, paper.id, paper.arxivId, (paper.authors ?? []).join(' '), (paper.tags ?? []).join(' ')]
          .join(' ').toLowerCase()
        return haystack.includes(text)
      })

      function tabButton(id, label) {
        return h('button', {
          key: id, type: 'button',
          style: tab === id ? { ...S.tab, ...S.tabOn } : S.tab,
          onClick: () => setTab(id),
        }, label)
      }

      function filterChip(id, label) {
        return h('button', {
          key: id, type: 'button',
          style: filter === id ? { ...S.chip, ...S.chipOn, cursor: 'pointer' } : { ...S.chip, cursor: 'pointer' },
          onClick: () => setFilter(id),
        }, label)
      }

      function paperCard(paper) {
        const isSelected = selected !== null && selected.id === paper.id
        const chips = [h('span', { key: 's', style: S.chip }, STATUS_TEXT[paper.status] ?? '未读')]
        if (paper.rating > 0) chips.push(h('span', { key: 'r', style: S.chip }, stars(paper.rating)))
        for (const [index, tag] of (paper.tags ?? []).entries()) chips.push(h('span', { key: `t${index}`, style: S.chip }, tag))
        if (paper.hasPdf) chips.push(h('span', { key: 'p', style: S.chip }, 'PDF'))
        if (paper.hasText) chips.push(h('span', { key: 'x', style: S.chip }, '全文'))
        if (paper.hasNote) chips.push(h('span', { key: 'n', style: S.chip }, '笔记'))
        return h('div', {
          key: paper.id,
          style: isSelected ? { ...S.card, borderColor: C.accent, cursor: 'pointer' } : { ...S.card, cursor: 'pointer' },
          onClick: () => { void openDetail(paper.id) },
        },
        h('div', { style: S.cardHead }, paper.title || paper.id),
        h('div', { style: S.meta }, metaLine(paper)),
        h('div', { style: S.row }, chips))
      }

      function metaLine(paper) {
        const authors = (paper.authors ?? []).slice(0, 3).join(', ') + ((paper.authorCount ?? 0) > 3 ? ' 等' : '')
        return [paper.id, authors, paper.year, paper.cat, paper.pages > 0 ? `${paper.pages} 页` : '']
          .filter((x) => x !== undefined && x !== null && String(x) !== '').join(' · ')
      }

      function libraryTab() {
        return h('div', { style: S.list },
          h('div', { style: { ...S.row, marginTop: 0 } },
            filterChip('all', '全部'), filterChip('unread', '未读'), filterChip('reading', '在读'), filterChip('read', '已读'),
            h('input', {
              style: { ...S.input, flex: 1, minWidth: 140 },
              placeholder: '筛选标题 / 作者 / 标签 / 编号',
              value: needle,
              onChange: (event) => setNeedle(event.target.value),
            })),
          filtered.length === 0
            ? h('div', { style: S.empty }, papers.length === 0
              ? '文库还是空的。\n切到「arXiv 检索」找论文，或「导入 PDF」收进已有文献。'
              : '没有匹配的论文。')
            : null,
          filtered.map(paperCard))
      }

      function searchTab() {
        const cards = results.map((item) => {
          const key = item.baseId ?? item.arxivId
          const working = busy === `add:${key}`
          const authors = item.authors.slice(0, 4).join(', ') + (item.authors.length > 4 ? ' 等' : '')
          return h('div', { key, style: S.card },
            h('div', { style: S.cardHead }, item.title),
            h('div', { style: S.meta }, `[${key}] ${authors || '—'} · ${item.published} · ${item.primaryCategory}`),
            h('div', { style: S.abs }, item.abstract),
            h('div', { style: S.row },
              h('button', {
                type: 'button', style: { ...S.btn, ...S.btnPrimary }, disabled: working,
                onClick: () => { void doAdd(key, true) },
              }, working ? '入库中…' : '入库 + 下载全文'),
              h('button', {
                type: 'button', style: S.btn, disabled: working,
                onClick: () => { void doAdd(key, false) },
              }, '仅题录'),
              h('a', { style: { ...S.btn, ...S.link }, href: item.url, target: '_blank', rel: 'noreferrer' }, 'arXiv 页面')))
        })
        return h('div', { style: S.list },
          h('div', { style: { ...S.row, marginTop: 0 } },
            h('input', {
              style: { ...S.input, flex: 1, minWidth: 180 },
              placeholder: '关键词，或 arXiv 语法：ti:"world model" AND cat:cs.LG',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void doSearch() },
            }),
            h('input', {
              style: { ...S.input, width: 56 },
              value: maxResults,
              onChange: (event) => setMaxResults(event.target.value),
            }),
            h('button', {
              type: 'button', style: { ...S.btn, ...S.btnPrimary }, disabled: busy === 'search',
              onClick: () => { void doSearch() },
            }, busy === 'search' ? '检索中…' : '检索')),
          results.length === 0 ? h('div', { style: S.empty }, '输入关键词检索 arXiv。\n入库后可在这里一键下载 PDF 并抽取全文。') : null,
          cards)
      }

      function importTab() {
        const rows = scanned.map((file) => h('div', { key: file.path, style: S.card },
          h('div', { style: S.cardHead }, file.name),
          h('div', { style: S.meta }, file.path),
          h('div', { style: S.row },
            h('button', {
              type: 'button', style: { ...S.btn, ...S.btnPrimary }, disabled: busy === 'import',
              onClick: () => { void doImport(file.path) },
            }, '导入这本'))))
        const hasPicker = (() => {
          const ui = hostCtx === null ? undefined : hostCtx.get('uiWorkspace')
          return ui !== undefined && typeof ui.pickDirectory === 'function'
        })()
        return h('div', { style: S.list },
          h('div', { style: { ...S.row, marginTop: 0 } },
            hasPicker
              ? h('button', {
                type: 'button', style: { ...S.btn, ...S.btnPrimary }, disabled: busy === 'scan',
                onClick: () => { void pickFolder() },
              }, '选择文件夹…')
              : null,
            h('input', {
              style: { ...S.input, flex: 1, minWidth: 180 },
              placeholder: hasPicker ? '目录（也可点左侧按钮选择）' : '扫描目录（留空 = 文库根目录）',
              value: importDir,
              onChange: (event) => setImportDir(event.target.value),
            }),
            h('button', { type: 'button', style: S.btn, disabled: busy === 'scan', onClick: () => { void doScan() } },
              busy === 'scan' ? '扫描中…' : '扫描 PDF'),
            scanned.length > 1
              ? h('button', {
                type: 'button', style: S.btn, disabled: busy === 'import',
                onClick: () => { void importAll() },
              }, `全部导入（${scanned.length}）`)
              : null),
          h('div', { style: { ...S.row, marginTop: 0 } },
            h('input', {
              style: { ...S.input, flex: 1, minWidth: 180 },
              placeholder: '或直接粘贴单个 PDF 的完整路径，如 D:/papers/foo.pdf',
              value: importPath,
              onChange: (event) => setImportPath(event.target.value),
            }),
            h('button', {
              type: 'button', style: { ...S.btn, ...S.btnPrimary }, disabled: busy === 'import',
              onClick: () => { void doImport(importPath) },
            }, '导入')),
          rows.length === 0
            ? h('div', { style: S.empty },
              '导入会把 PDF 复制进文库、抽取全文，并用首页正文推断标题。\n'
              + (hasPicker ? '点「选择文件夹…」挑一个目录，或手工填路径后扫描。' : '先「扫描 PDF」列出候选文件。'))
            : null,
          rows)
      }

      function detailPane() {
        if (selected === null) {
          return h('div', { style: S.side },
            h('div', { style: S.empty }, '左侧点选一篇论文：\n查看题录、标记状态、写 L1/L2/L3 三层笔记、读全文。'))
        }
        const paper = selected
        function layerField(key, labelText) {
          return h('div', { key, style: S.field },
            h('label', { style: S.label }, labelText),
            h('textarea', {
              style: S.ta,
              value: notes[key],
              onChange: (event) => {
                setNotes({ ...notes, [key]: event.target.value })
                setDirty(true)
              },
            }))
        }
        return h('div', { style: S.side },
          h('div', { style: { ...S.cardHead, lineHeight: 1.5 } }, paper.title || paper.id),
          h('div', { style: S.meta }, metaLine(paper)),
          paper.abstract ? h('div', { style: S.abs }, paper.abstract) : null,
          h('div', { style: S.row },
            h('button', { type: 'button', style: paper.status === 'unread' ? { ...S.btn, ...S.btnPrimary } : S.btn, onClick: () => { void patchPaper({ status: 'unread' }, '状态：未读') } }, '未读'),
            h('button', { type: 'button', style: paper.status === 'reading' ? { ...S.btn, ...S.btnPrimary } : S.btn, onClick: () => { void patchPaper({ status: 'reading' }, '状态：在读') } }, '在读'),
            h('button', { type: 'button', style: paper.status === 'read' ? { ...S.btn, ...S.btnPrimary } : S.btn, onClick: () => { void patchPaper({ status: 'read' }, '状态：已读') } }, '已读'),
            h('span', { style: S.stat }, '评级'),
            [1, 2, 3, 4, 5].map((value) => h('button', {
              key: `r${value}`, type: 'button', style: { ...S.btn, padding: '3px 6px' },
              onClick: () => { void patchPaper({ rating: value === paper.rating ? 0 : value }, '评级已更新') },
            }, value <= paper.rating ? '★' : '☆'))),
          h('div', { style: { ...S.field, marginTop: 10 } },
            h('label', { style: S.label }, '标签（逗号分隔）'),
            h('div', { style: { ...S.row, marginTop: 0 } },
              h('input', { style: { ...S.input, flex: 1 }, value: tagsDraft, onChange: (event) => setTagsDraft(event.target.value) }),
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => { void patchPaper({ tags: tagsDraft.split(/[,，;；]/).map((x) => x.trim()).filter((x) => x !== '') }, '标签已保存') },
              }, '存标签'))),
          h('div', { style: S.hr }),
          layerField('quick', 'L1 速览 · 这篇论文说了什么（问题 / 结论 / 一句话贡献）'),
          layerField('understand', 'L2 理解 · 它凭什么成立（方法、关键设计、实验证据）'),
          layerField('critique', 'L3 批判 · 局限、可疑点、可迁移到本课题的地方'),
          h('div', { style: S.row },
            h('button', {
              type: 'button', style: { ...S.btn, ...S.btnPrimary }, disabled: !dirty || busy === 'notes',
              onClick: () => { void saveNotes() },
            }, dirty ? (busy === 'notes' ? '保存中…' : '保存三层笔记') : '笔记已保存'),
            h('button', { type: 'button', style: S.btn, disabled: busy === 'extract', onClick: () => { void doExtract() } },
              paper.hasText ? '重新解析全文' : '解析全文'),
            h('button', { type: 'button', style: S.btn, disabled: busy === 'pdf', onClick: () => { void doDownload() } },
              paper.hasPdf ? '重下 PDF' : '下载 PDF'),
            h('button', {
              type: 'button', style: S.btn,
              onClick: async () => { const data = await call('/reveal', { id: paper.id }); setMsg(data.ok === true ? '已打开所在目录' : `⚠ ${data.error ?? '打开目录失败'}`) },
            }, '打开所在目录'),
            h('button', { type: 'button', style: { ...S.btn, ...S.btnDanger }, disabled: busy === 'remove', onClick: () => { void doRemove() } }, '移出文库')),
          h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.btn, disabled: !paper.hasText,
              onClick: () => { void loadText(0) },
            }, '在面板里读全文')),
          reader === null ? null : h('div', null,
            h('div', { style: S.hr }),
            h('label', { style: S.label }, `全文 ${reader.offset} - ${reader.offset + reader.text.length} / ${reader.total} 字`),
            h('div', { style: S.fullText }, reader.text),
            h('div', { style: S.row },
              h('button', {
                type: 'button', style: S.btn, disabled: reader.offset <= 0,
                onClick: () => { void loadText(Math.max(0, reader.offset - 12000)) },
              }, '上一段'),
              h('button', {
                type: 'button', style: S.btn, disabled: reader.offset + reader.text.length >= reader.total,
                onClick: () => { void loadText(reader.offset + reader.text.length) },
              }, '下一段'))),
          h('div', { style: S.hr }),
          h('div', { style: S.meta }, `想让我精读：在对话框里发「精读 ${paper.id}」，我会读全文并把上面三层笔记写好；你在这里直接改。`),
          health !== null && (health.warnings ?? []).length > 0
            ? h('div', { style: { ...S.meta, marginTop: 8, color: C.warn } }, `环境提示：${health.warnings[0]}`)
            : null)
      }

      return h('div', { style: S.backdrop, onClick: (event) => { if (event.target === event.currentTarget) setShared({ open: false }) } },
        h('div', { style: S.panel },
          h('div', { style: S.head },
            h('div', { style: S.title }, '📚 论文工作台'),
            h('div', { style: S.tabs },
              tabButton('library', `文库 ${papers.length}`),
              tabButton('search', 'arXiv 检索'),
              tabButton('import', '导入 PDF')),
            h('div', { style: S.spacer }),
            stats === null ? null : h('div', { style: S.stat },
              `未读 ${stats.unread} · 在读 ${stats.reading} · 已读 ${stats.read} · 全文 ${stats.text} · 笔记 ${stats.noted}`),
            health === null ? null : h('div', {
              style: { ...S.stat, color: health.ok === true ? C.dim : C.danger },
              title: [...(health.errors ?? []), ...(health.warnings ?? [])].join('\n'),
            }, health.ok === true ? `DSH ${health.dshVersion}` : `环境异常（${(health.errors ?? []).length}）`),
            h('button', { type: 'button', style: S.btn, onClick: () => { void refresh(false) } }, '刷新'),
            h('button', { type: 'button', style: S.btn, onClick: () => setShared({ open: false }) }, '关闭')),
          h('div', { style: S.body },
            tab === 'library' ? libraryTab() : (tab === 'search' ? searchTab() : importTab()),
            tab === 'library' ? detailPane() : null),
          h('div', { style: S.foot }, msg)))
    }

    const plugin = {
      name: NS,
      // `slots` 必须声明：客户端 runner 的服务门禁按插件对象上的 inject 判定
      // （它的报错文案写的就是 `{ inject: ['slots'], apply(ctx) { … } }`）。
      // 不声明的话，一旦 apply 执行时 slots 尚未就绪，`ctx.get('slots')` 拿到 undefined，
      // 插件就此静默地什么都不注册，而且永远不会被重新激活 —— 这是最难查的一类失败。
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx
        const slots = ctx.get('slots')
        if (slots === undefined) {
          // 宁可吵，也不要静默：这一行是「界面里什么都没有」时唯一能查的线索
          console.error(`[${NS}] slots 服务不可用，侧栏入口与面板都未注册`)
          return
        }
        slots.inject('sidebar.footer.action', () =>
          slots.register({ name: 'sidebar.footer.action', id: NS, order: 12 }, () => h(FooterAction, null)))
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: NS, order: 30 }, () => h(OverlayHost, null)))
        // 每次启动一行：这是「界面里看不到入口」时区分
        // 「模块没执行 / apply 没跑 / 注册成功但渲染有问题」的唯一信号。
        console.info(`[${NS}] 客户端半区已挂载：侧栏入口 + 工作台面板`)
      },
    }

    // 两种约定都满足：模块加载器无论取「factory 的返回值」还是 `module.exports`，
    // 拿到的都是同一个插件对象；`exports.inject` 也一并给出，与内置插件一致。
    exports.name = plugin.name
    exports.inject = plugin.inject
    exports.apply = plugin.apply
    return plugin
  },
})
