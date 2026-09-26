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

### 验证状态（0.1.0 发布前）

发布前实际跑过、并留下证据的部分（不是「设计上应该能用」）：

| 范围 | 验证方式与结果 |
| --- | --- |
| 宿主半区 | 在 DSH 0.1.5-rc.2 真实启动中挂载：出现就绪日志，7 个工具注册，`/paperdesk/api/health` 返回 `ok=true`、`errors=0` |
| 端到端 | 通过插件自己的 API 完成：真实 arXiv 入库 → PDF 2,215,244 字节落盘 → 全文 39,512 字 / 15 页（PyMuPDF）→ 三层笔记写入 → 文本读回 |
| 浏览器半区 | 在真实浏览器中确认侧栏入口出现、面板可用 |
| 发布产物 | 用 `npm pack` 出的真实 tarball（20 个文件 / 60.5 kB）装进干净 profile 启动：宿主就绪 + 接口 200 + 客户端模块被注入 |
| 自动化 | 109 项 `node --test`，含仓库静态守卫与客户端组件渲染 |

未验证的部分同样写明：`pdftotext` 回退路径只有单测覆盖，本机实测走的是 PyMuPDF；
macOS / Linux 只在 CI 里跑单测，没有真机挂载。

### 发布前修复（都在这一个版本里）

- **客户端半区「装了但界面不可见」**：插件对象原先没有声明 `inject`，只在 `dsh.client` 清单层声明。
  一旦 `apply` 执行时 `slots` 尚未就绪，`ctx.get('slots')` 拿到 undefined 就静默返回、什么都不注册，
  且不会被重新激活。现已声明 `inject: ['slots']`（同时给出 `exports.inject`），把缺失路径从静默改为
  `console.error`，并在挂载成功时打一行 `console.info` —— 使「模块没执行 / apply 没跑 /
  注册成功但渲染有问题」可以被二分定位。
- **发布产物卫生**：`npm pack` 实测发现调试脚本（`scripts/_*.mjs`、`_*.ps1`）会被
  `files: ["scripts/"]` 一并发布，已清除并加静态守卫。
- **测试稳定性**：一处固定 `sleep(20)` 在高负载下会偶发失败，改为有界轮询。
- **发布路径**：`publishConfig.registry` 写死官方源 —— 本机默认 registry 是只读镜像，
  不固定会把包发到用户装不到的地方。

### 设计决定（写给未来的自己）

- **不做构建步骤**：`lib/` 里的文件就是发布出去、也是运行的文件。代价是没有 TypeScript 类型检查，
  收益是审计、调试、打补丁都不需要工具链 —— 对「装在别人机器上、由别人长期维护」的插件更重要。
- **core 层零外部依赖**：`lib/core/**` 只 import `node:` 与彼此，因此可以脱离 DSH 单独单测。
- **界面用浮层而不是主面板**：`sidebar.footer.action` + `shell.overlay` 是社区插件已验证的组合，
  比 `main` 面板的 keyed 分发更不容易随版本变化。
- **peerDependencies 写 `*`**：耦合点是服务契约而非版本号，理由见 `COMPATIBILITY.md`。
