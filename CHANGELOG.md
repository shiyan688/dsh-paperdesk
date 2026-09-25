# 更新日志

本文件记录所有值得用户注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-25

首个版本。

### 新增

- **宿主半区**（`lib/index.js` + `lib/core/**`）
  - 本地文库：`state/index.json` 作为唯一事实来源，`pdf/` `text/` `notes/` 三个目录；
    索引带 schema 版本与迁移表，读到更高版本时拒绝读取而不是削掉新字段。
  - arXiv：检索（自然语言或 arXiv 语法）、按编号取元数据、Atom 解析；
    文库 id 用不带版本号的编号，先收 v7 后更新到 v8 不会变成两条记录。
  - PDF：`fetch` 下载（校验 `%PDF-` 魔数、限制体积）；全文抽取按
    `pdfCommand` → python(PyMuPDF/pypdf) → `pdftotext` 的顺序自动探测，
    退出码非 0 但拿到文本视为成功（MiKTeX 版 pdftotext 的已知收尾崩溃）。
  - 回环 HTTP API `/paperdesk/api/*`（14 个端点），逐请求校验来源必须是本机。
  - 7 个模型工具：`paper_search` `paper_add` `paper_list` `paper_read` `paper_note` `paper_pdf` `paper_import`。
- **浏览器半区**（`lib/client.js`）
  - 侧栏入口 + 工作台浮层；库内筛选、arXiv 检索与入库、按目录导入 PDF、
    详情面板内编辑 L1/L2/L3 三层笔记、分段读全文、状态/评级/标签管理。
- **兼容层**（`lib/core/compat.js`）：软版本门 + 能力探测 + `health` 报告；不阻止启动，只如实降级。
- **测试**：`node:test` 零框架测试套件，含 arXiv 解析、索引迁移、三层笔记渲染、配置解析、
  兼容层、PDF 探测与降级、工具定义（两条注册路径）、HTTP API 全链路、宿主入口接线、
  客户端组件渲染（自带迷你 React 替身）以及仓库级静态守卫。
- **文档**：`README.md` / `README.en.md` / `COMPATIBILITY.md` / 本文件；`scripts/check-dsh-compat.mjs`
  可在本机核对宿主是否满足插件依赖的服务与接口，`--profile <名字>` 还会核对 profile 的 bundle 登记
  —— 这是「装上了但静默不加载」这个失败模式的唯一检查点（`dsh plugin add` 只在依赖能被解析出
  `dsh.bundle.patch` 时才把它登记进 `dsh.profile.bundles`，否则只当普通依赖装进去，不报错也不加载）。

### 设计决定（写给未来的自己）

- **不做构建步骤**：`lib/` 里的文件就是发布出去、也是运行的文件。代价是没有 TypeScript 类型检查，
  收益是审计、调试、打补丁都不需要工具链 —— 对「装在别人机器上、由别人长期维护」的插件更重要。
- **core 层零外部依赖**：`lib/core/**` 只 import `node:` 与彼此，因此可以脱离 DSH 单独单测。
- **界面用浮层而不是主面板**：`sidebar.footer.action` + `shell.overlay` 是社区插件已验证的组合，
  比 `main` 面板的 keyed 分发更不容易随版本变化。
- **peerDependencies 写 `*`**：耦合点是服务契约而非版本号，理由见 `COMPATIBILITY.md`。
