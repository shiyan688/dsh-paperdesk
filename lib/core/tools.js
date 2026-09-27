/**
 * dsh-paperdesk — 模型工具定义。
 *
 * 七个工具对应「收集 → 读 → 记」的三步闭环，命名与参数刻意保持稳定：
 * 一旦发布，改工具名等于让所有存量提示词失效，所以只增不改。
 *
 * 关于 `defineTool`：它是 `@deepseek-ai/dsh-tools` 的导出，也是最规范的注册方式。
 * 但它属于可选的 peer dependency —— 万一将来包名/导出变了，插件不该整个起不来。
 * 所以这里是「有就用，没有就用本地编译器」，两条路的产物都是同一份 ToolDefinition，
 * 差别只在参数 schema 由谁校验（`/paperdesk/api/health` 里会如实标注用的是哪条路）。
 */

/**
 * 把作者视角的参数 spec 编译成原始 JSON Schema。
 *
 * 这是 `defineTool` 缺失时的兜底路径。作者 spec 的形状是：
 * `{ 字段名: { type, required?, description?, enum?, items?, properties?, additionalProperties? } }`
 *
 * @param {Record<string, any>} spec
 * @returns {{ type: 'object', properties: Record<string, any>, required?: string[] }}
 */
export function compileParameterSpec(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = node ?? {}
    properties[key] = compileValueSpec(rest)
    if (isRequired === true) required.push(key)
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/**
 * 编译一个值节点。
 * @param {any} node
 * @returns {any}
 */
export function compileValueSpec(node) {
  const spec = node ?? {}
  const out = {}
  if (typeof spec.type === 'string') out.type = spec.type
  if (typeof spec.description === 'string') out.description = spec.description
  if (Array.isArray(spec.enum)) out.enum = [...spec.enum]
  if (spec.type === 'array' && spec.items !== undefined) out.items = compileValueSpec(spec.items)
  if (spec.type === 'object') {
    if (spec.properties !== undefined) out.properties = compileParameterSpec(spec.properties).properties
    out.additionalProperties = spec.additionalProperties === true
    if (spec.properties !== undefined) {
      const required = Object.entries(spec.properties)
        .filter(([, value]) => value?.required === true)
        .map(([key]) => key)
      if (required.length > 0) out.required = required
    }
  } else if (spec.additionalProperties !== undefined) {
    out.additionalProperties = spec.additionalProperties
  }
  return out
}

/** 所有工具共用的输出 schema：模型看到的是人话，结构化数据留在文库里。 */
const TEXT_OUTPUT = { type: 'object', properties: { text: { type: 'string', required: true } }, additionalProperties: false }

/**
 * 造一个工具定义。
 * @param {{ defineTool?: Function }} deps
 * @param {{ name: string, description: string, parameters: Record<string, any>, execute: Function, render?: Function }} spec
 * @returns {any}
 */
function define(deps, spec) {
  const render = spec.render ?? ((_args, value) => [{ type: 'text', text: String(value?.text ?? '') }])
  if (typeof deps.defineTool === 'function') {
    return deps.defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: { schema: TEXT_OUTPUT, render },
      execute: spec.execute,
    })
  }
  return {
    name: spec.name,
    description: spec.description,
    parameters: compileParameterSpec(spec.parameters),
    output: { schema: compileValueSpec(TEXT_OUTPUT), render },
    execute: spec.execute,
  }
}

/**
 * 生成全部工具定义。
 * @param {{ service: any, defineTool?: Function }} input
 * @returns {any[]}
 */
export function createToolDefinitions(input) {
  const service = input.service
  const deps = { defineTool: input.defineTool }

  const search = define(deps, {
    name: 'paper_search',
    description: '在 arXiv 上检索论文，返回编号、标题、作者、分类与摘要片段。用于「帮我找某方向的论文」「收集某个主题的文献」。'
      + '返回的编号交给 paper_add 即可入库。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词。自然语言按 all: 字段检索（如 diffusion policy robot）；也支持 arXiv 语法，如 ti:"world model" AND cat:cs.LG。' },
      max: { type: 'integer', description: '返回条数，默认 8，上限 50。' },
    },
    async execute(args) {
      const result = await service.search(args.query, args.max)
      if (result.count === 0) return { text: `arXiv 上没有检索到「${args.query}」的结果，换个关键词或改用 arXiv 语法（如 ti:"..."）再试。` }
      const lines = result.results.map((item, i) => {
        const authors = item.authors.slice(0, 4).join(', ') + (item.authors.length > 4 ? ' 等' : '')
        const abstract = item.abstract.length > 260 ? `${item.abstract.slice(0, 260)}…` : item.abstract
        return `${i + 1}. [${item.baseId}] ${item.title}\n   ${authors || '—'} · ${item.published} · ${item.primaryCategory}\n   ${abstract}`
      })
      return {
        text: `arXiv 检索「${args.query}」共 ${result.count} 条：\n\n${lines.join('\n\n')}\n\n`
          + '下一步：paper_add(arxiv_id="编号") 入库；入库后 paper_read(id) 读全文、paper_note(id) 写三层笔记。',
      }
    },
  })

  const add = define(deps, {
    name: 'paper_add',
    description: '把一篇 arXiv 论文收进本地文库（题录 + PDF + 全文）。默认同时下载 PDF 并抽取全文，'
      + '之后可用 paper_read 精读、paper_note 写笔记。',
    parameters: {
      arxiv_id: { type: 'string', required: true, description: 'arXiv 编号，如 1706.03762 或 1706.03762v7，也可直接给 abs/pdf 链接。' },
      download: { type: 'boolean', description: '是否同时下载 PDF 并抽取全文，默认 true。' },
      tags: { type: 'string', description: '可选标签，逗号分隔。' },
    },
    async execute(args) {
      const result = await service.add(args.arxiv_id, { download: args.download !== false, tags: args.tags })
      const paper = result.paper
      const lines = [
        `${result.existed ? '已在文库中，题录已刷新' : '已入库'}：[${paper.id}] ${paper.title}`,
        `作者：${paper.authors.slice(0, 6).join(', ') || '—'} · 发表：${paper.published || '未知'} · 分类：${paper.primaryCategory || '—'}`,
        `PDF：${paper.pdfPath !== '' ? paper.pdfPath : '未下载'}`,
        `全文：${paper.textPath !== '' ? `${paper.textPath}（${paper.textChars} 字 / ${paper.pages} 页）` : '未抽取'}`,
      ]
      if (result.warning !== '') lines.push(`⚠ ${result.warning}`)
      lines.push('', `接下来建议：paper_read(id="${paper.id}") 读全文后立刻 paper_note 写 L1 速览 / L2 理解 / L3 批判。`)
      return { text: lines.join('\n') }
    },
  })

  const list = define(deps, {
    name: 'paper_list',
    description: '列出本地文库中的论文（可按状态 / 关键词 / 标签筛选），用于回顾已经收集了什么。',
    parameters: {
      status: { type: 'string', description: '筛选状态：unread / reading / read（也接受 未读 / 在读 / 已读）。' },
      query: { type: 'string', description: '按标题、作者、编号或标签模糊筛选。' },
      tag: { type: 'string', description: '按单个标签精确筛选。' },
      limit: { type: 'integer', description: '最多返回多少条，默认 50。' },
    },
    async execute(args) {
      const result = await service.list({ status: args.status, query: args.query, tag: args.tag, limit: args.limit })
      if (result.total === 0) return { text: `文库还是空的（${service.options.root}）。用 paper_search 找论文，再 paper_add 入库。` }
      const lines = result.rows.map((row) => {
        const marks = [row.hasPdf ? 'PDF' : '', row.hasText ? '全文' : '', row.hasNote ? '笔记' : ''].filter((x) => x !== '')
        const status = { unread: '未读', reading: '在读', read: '已读' }[row.status] ?? '未读'
        return `- [${row.id}] ${row.title} — ${row.authors.join(', ') || '—'} (${row.year}) · ${status}`
          + `${marks.length > 0 ? ` · ${marks.join('/')}` : ''}${row.tags.length > 0 ? ` · #${row.tags.join(' #')}` : ''}`
      })
      const stats = result.stats
      return {
        text: `文库共 ${stats.total} 篇（未读 ${stats.unread} / 在读 ${stats.reading} / 已读 ${stats.read}，含全文 ${stats.text} 篇，已写笔记 ${stats.noted} 篇）；`
          + `本次列出 ${result.rows.length} 篇：\n${lines.join('\n')}\n\n用 paper_read(id) 读全文，paper_note(id) 写三层笔记。`,
      }
    },
  })

  const read = define(deps, {
    name: 'paper_read',
    description: '读取文库中某篇论文的全文文本（没有 PDF 会自动下载、没有全文会自动抽取，结果分页返回）。'
      + '这是精读的主入口：读完必须用 paper_note 把 L1 速览 / L2 理解 / L3 批判写进文库。',
    parameters: {
      id: { type: 'string', required: true, description: '论文编号（如 1706.03762）或标题片段。' },
      offset: { type: 'integer', description: '从第几个字符开始读，默认 0。' },
      limit: { type: 'integer', description: '本次返回多少字符，默认 24000，上限 40000。' },
    },
    async execute(args) {
      const result = await service.read(args.id, { offset: args.offset, limit: args.limit })
      const end = result.offset + result.text.length
      const head = `《${result.paper.title}》[${result.paper.id}] 全文共 ${result.total} 字，本次返回 ${result.offset}-${end} 字：\n\n---\n${result.text}\n---\n`
      const tail = end < result.total
        ? `\n还有 ${result.total - end} 字未返回，继续读：paper_read(id="${result.paper.id}", offset=${end})。`
        : `\n已到全文末尾。现在用 paper_note(id="${result.paper.id}", quick=..., understand=..., critique=...) 落三层笔记。`
      return { text: head + tail }
    },
  })

  const note = define(deps, {
    name: 'paper_note',
    description: '把三层精读笔记写入文库（notes/<id>.md 与索引同时更新）。'
      + 'L1 速览=问题与结论；L2 理解=方法与它凭什么成立（关键设计、公式、实验证据）；'
      + 'L3 批判=局限、可疑之处、可迁移到自己研究里的点。只写确实读懂的内容，不确定就明说不确定。',
    parameters: {
      id: { type: 'string', required: true, description: '论文编号或标题片段。' },
      quick: { type: 'string', description: 'L1 速览：解决什么问题、核心结论、一句话贡献。' },
      understand: { type: 'string', description: 'L2 理解：方法怎么做、关键设计/公式、支撑结论的实验证据。' },
      critique: { type: 'string', description: 'L3 批判：假设是否成立、局限、可疑之处、可迁移到本课题的点。' },
      tags: { type: 'string', description: '可选，重设标签（逗号分隔）。' },
      status: { type: 'string', description: '可选，重设状态：unread / reading / read。' },
      rating: { type: 'integer', description: '可选，0-5 星评级。' },
    },
    async execute(args) {
      const hasNotes = typeof args.quick === 'string' || typeof args.understand === 'string' || typeof args.critique === 'string'
      const hasPatch = args.status !== undefined || args.rating !== undefined || args.tags !== undefined
      if (!hasNotes && !hasPatch) return { text: '没有提供任何笔记内容或状态变更，未做修改。' }
      let paper = null
      if (hasNotes) {
        const saved = await service.saveNotes(args.id, { quick: args.quick, understand: args.understand, critique: args.critique })
        paper = saved.paper
      }
      if (hasPatch) {
        // 空字符串不等于「清空标签」：工具调用里未使用的参数常被填成 ''，
        // 若当成清空就会把用户手写的标签抹掉。清空请走 UI。
        const tags = typeof args.tags === 'string' && args.tags.trim() !== '' ? args.tags : undefined
        const updated = await service.update(args.id, { status: args.status, rating: args.rating, tags })
        paper = updated.paper
      }
      const progress = { quick: paper.notes.quick.length, understand: paper.notes.understand.length, critique: paper.notes.critique.length }
      const filled = [progress.quick, progress.understand, progress.critique].filter((n) => n > 0).length
      return {
        text: `笔记已保存：[${paper.id}] ${paper.title}\n`
          + `- 文件：notes/${paper.id}.md\n`
          + `- L1 速览 ${progress.quick} 字 · L2 理解 ${progress.understand} 字 · L3 批判 ${progress.critique} 字（${filled}/3 层已写）\n`
          + `- 状态：${paper.status} · 评级：${paper.rating}/5`
          + (Array.isArray(paper.tags) && paper.tags.length > 0 ? ` · 标签：${paper.tags.join('、')}` : ''),
      }
    },
  })

  const pdf = define(deps, {
    name: 'paper_pdf',
    description: '下载文库中某篇论文的 PDF 并抽取全文（用于入库时跳过了下载、或需要重新解析的情况）。',
    parameters: {
      id: { type: 'string', required: true, description: '论文编号或标题片段。' },
    },
    async execute(args) {
      const downloaded = await service.download(args.id)
      const result = await service.extract(args.id, 0)
      return {
        text: `PDF 与全文已就绪：[${result.paper.id}]\n`
          + `- PDF：${downloaded.paper.pdfPath}（${Math.round((downloaded.bytes ?? 0) / 1024)} KB）\n`
          + `- 全文：${result.paper.textPath}（${result.chars} 字 / ${result.pages} 页，引擎 ${result.engine}）`,
      }
    },
  })

  const importTool = define(deps, {
    name: 'paper_import',
    description: '把本地已有的 PDF 收进文库（复制到 pdf/、抽取全文、用首页正文推断标题）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地 PDF 的绝对路径，如 D:/papers/foo.pdf。' },
    },
    async execute(args) {
      const result = await service.importPdf(args.path)
      const paper = result.paper
      const lines = [
        `${result.existed ? '文库中已有这份 PDF' : '已导入'}：[${paper.id}] ${paper.title}`,
        `- 页数：${paper.pages} · 全文：${paper.textChars} 字`,
        `- 笔记可写在：notes/${paper.id}.md`,
      ]
      if (result.warning !== '') lines.push(`⚠ ${result.warning}`)
      lines.push(`可用 paper_read(id="${paper.id}") 或 paper_note 继续处理。`)
      return { text: lines.join('\n') }
    },
  })

  return [search, add, list, read, note, pdf, importTool]
}

/** 工具名清单（用于 /health 与静态守卫测试）。 */
export const TOOL_NAMES = Object.freeze([
  'paper_search',
  'paper_add',
  'paper_list',
  'paper_read',
  'paper_note',
  'paper_pdf',
  'paper_import',
])
