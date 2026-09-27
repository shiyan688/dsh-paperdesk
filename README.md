# dsh-paperdesk

[![npm](https://img.shields.io/npm/v/dsh-paperdesk?registry_uri=https%3A%2F%2Fregistry.npmjs.org)](https://www.npmjs.com/package/dsh-paperdesk)
[![license](https://img.shields.io/npm/l/dsh-paperdesk?registry_uri=https%3A%2F%2Fregistry.npmjs.org)](./LICENSE)

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**论文工作台**：
> arXiv 检索 → 本地文库（题录 / PDF / 全文）→ L1-L2-L3 三层精读笔记。
> 宿主半区与浏览器半区在同一个包里，**没有构建步骤**，`lib/` 里的文件就是跑起来的文件。

> 已发布到 npm：`dsh-paperdesk@0.1.0`（MIT）。线上产物与仓库源码逐字节一致
> （`dist.shasum` 与本地 `npm pack` 相同），并已在一个干净 profile 上按普通用户路径
> 安装、启动、验证通过。

---

## 它解决什么问题

读论文的真实流程不是「下载」这一件事，而是三段：

1. **收集** —— 在 arXiv 上找到它，存下来，别再靠浏览器书签；
2. **读** —— 有全文可读，而不是只有一个摘要；
3. **记住** —— 写点只有自己看得懂的东西，否则三个月后等于没读。

多数工具只做第 1 段。dsh-paperdesk 把三段接起来，并且**第 3 段用固定结构逼你写**：

| 层 | 回答什么 | 为什么必须单独一层 |
| --- | --- | --- |
| **L1 速览** | 这篇说了什么？一句话贡献是什么？ | 筛掉不值得往下读的 |
| **L2 理解** | 它凭什么成立？方法、关键设计、哪张表撑住了结论？ | 区分「看懂了摘要」和「看懂了工作」 |
| **L3 批判** | 假设成立吗？哪里可疑？哪些能搬回我自己的课题？ | **大多数「读了但没读进去」的论文，缺的都是这一层** |

界面和模型工具读写的是同一份文库，所以你可以手点，也可以直接说「精读 1706.03762」。

---

## 安装

```sh
dsh plugin --profile web add dsh-paperdesk
```

`dsh plugin` 会把包装进 profile 的 `node_modules`，并把它在 `package.json` 的 `dsh.profile.bundles` 里登记；
包内自带的 `cordis.patch.yml` 作为一层 patch 被应用，把插件行插进组合配置：

```yaml
- insert:
    - id: dsh-paperdesk
      name: 'dsh-paperdesk'
      config:
        root: ''          # 文库根目录；留空 = <dsh 进程工作目录>/.dsh-paperdesk
        pdfCommand: ''    # 自定义 PDF 抽取命令（pdftotext 兼容）；留空 = 自动探测
        pythonCommand: '' # 自定义 python 解释器；留空 = 自动探测 python/python3/py
```

### ⚠️ 装完必须确认这一步（否则插件会静默不加载）

`dsh plugin add` 的工作方式是：装完包之后，**按安装状态对账** `dsh.profile.bundles` ——
只有当一个依赖能被解析出来、并且它的 `package.json` 里声明了 `dsh.bundle.patch`，它才会入栈成为一层。
如果这一步没成功，包会作为**普通依赖**装进去：不报错、不加载、界面上什么都不会发生。

> 实测记录：在**全新初始化**的 profile 上出现过这个失败（包写进了 `dependencies`，`dsh.profile.bundles` 没变）；
> 在一个已经在用的 profile 上，同样的 `file:` 安装一次就对账成功。所以这不是 `file:` 安装本身的问题，
> 但「新 profile + 首次安装」这个组合值得多看一眼。

所以请核对一次：

```sh
node node_modules/dsh-paperdesk/scripts/check-dsh-compat.mjs --profile web
```

它会把「依赖是否登记」「是否在 `dsh.profile.bundles` 里」逐条报出来。
如果报 `不在 dsh.profile.bundles 里`，手工把包名追加到 `$DSH_HOME/profiles/web/package.json` 的数组末尾即可：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-paperdesk"] } }
```

然后**重启 profile**（`dsh web`）。侧栏底部会出现 **📚 论文** 入口；启动日志里应能看到一行：

```
[paperdesk] 0.1.0 就绪 · 文库 <root> · 抽取器 <抽取器> · 工具 7 个 · 界面接口 已挂载
```

装好后，权威的健康检查是 `GET http://127.0.0.1:<端口>/paperdesk/api/health`（需要带上浏览器用的 token）。

卸载：

```sh
dsh plugin --profile web remove dsh-paperdesk
```

---

## 用它

### 界面（侧栏 📚 论文）

- **文库**：按状态（未读 / 在读 / 已读）、标题、作者、标签筛选；右侧是详情与三层笔记编辑框。
- **arXiv 检索**：关键词或 arXiv 语法（`ti:"world model" AND cat:cs.LG`）；一键「入库 + 下载全文」或「仅题录」。
- **导入 PDF**：点**「选择文件夹…」**用系统目录选择器挑目录（选完自动扫描），也可手工填路径；
  扫到多个 PDF 可一键全部导入。导入会抽取全文，并用首页正文推断标题。

详情面板里还能：切状态、打星、改标签、在面板内分段读全文、打开文件所在目录、把论文移出文库。

### 模型工具

装好以后 Agent 会多出 7 个工具（同一份文库，和界面完全互通）：

| 工具 | 用途 |
| --- | --- |
| `paper_search` | 在 arXiv 上检索，返回编号 / 标题 / 作者 / 分类 / 摘要片段 |
| `paper_add` | 入库一篇（默认同时下载 PDF 并抽取全文） |
| `paper_list` | 列出文库，可按状态 / 关键词 / 标签筛 |
| `paper_read` | 读全文（没有 PDF 会自动下载、没有全文会自动抽取，分页返回） |
| `paper_note` | 写 L1 / L2 / L3 三层笔记，或改状态、评级、标签 |
| `paper_pdf` | 单独下载 PDF 并抽取全文 |
| `paper_import` | 把本地已有的 PDF 收进文库 |

于是可以直接说：

> 找 5 篇 diffusion policy 的论文收进来
> 精读 1706.03762，写完三层笔记
> 我读过但没写笔记的有哪些？

---

## 数据落在哪

```
<root>/
  state/index.json     题录 + 状态 + 标签 + 三层笔记（唯一事实来源）
  pdf/<id>.pdf         下载或导入的 PDF
  text/<id>.txt        抽取出来的全文
  notes/<id>.md        人类可读的三层笔记（可 diff、可进 git、可单独拿走）
  .tools/extract_pdf.py  自动生成的 python 抽取脚本（可随时删除，会重新生成）
```

`<id>` 对 arXiv 论文是**不带版本号**的编号（`1706.03762`），所以「先收 v7、后来更新到 v8」不会变成两条记录。
索引里的路径都是相对路径，整个 `<root>` 可以直接拷到别的机器。

---

## 依赖

- **Node ≥ 20**（用到全局 `fetch`）。
- **运行时零第三方依赖**：宿主半区只用 `node:` 内置模块；唯一的外部 import 是 `@deepseek-ai/schemastery`，
  它用来声明组合配置的 schema，属于宿主自带的 peer dependency。
- **PDF 全文抽取需要一个外部工具**（只在用到时才有要求），按以下顺序自动探测：

  1. 配置里的 `pdfCommand`（任何 pdftotext 兼容 CLI）
  2. `python` / `python3` / `py` + **PyMuPDF**（`pip install pymupdf`）或 **pypdf**
  3. PATH 上的 **pdftotext**（poppler 或 MiKTeX 都带）

  一个都没有也能用：题录、检索、笔记、导入全部正常，只有「抽取全文」会失败并在 `/paperdesk/api/health` 里说明原因。

---

## 兼容性

跨 DSH 版本的策略只有三条，细节见 **[COMPATIBILITY.md](./COMPATIBILITY.md)**：

1. **软版本门**：声明支持区间只用来提示，**从不阻止插件启动**；
2. **能力探测优先**：需要的服务逐个 `typeof` 检查，缺哪个降级哪个，结果通过 `/paperdesk/api/health` 如实报出；
3. **只用最稳的接口面**：`ctx.tools.register` / `ctx.webServer.register` / `ctx.get`——
   不碰只在动态插件里存在的 `harness.*`，也不碰任何 `@deepseek-ai/dsh-*` 的内部符号。

`peerDependencies` 一律写 `*`：这个插件与宿主的耦合点是**服务契约**而不是版本号，写死范围只会在能用的组合上误报。

---

## 安全

- 浏览器半区只通过 `/paperdesk/api/*` 与宿主通信，且该 API **逐请求校验来源必须是本机**
  （`127.0.0.1` / `::1` / IPv4-mapped）。绑定到回环地址不等于安全：浏览器里的任意页面都能向 localhost 发请求。
- 导入功能会读你显式给出的**绝对路径** —— 这是它的功能，不是漏洞。相对路径被拒绝，因为相对路径的含义取决于宿主进程的 cwd。
- 所有子进程都用 `spawn(command, args)` 数组形式调用，不经过 shell：带空格、中文、引号的路径不会变成命令注入。
- 下载的 PDF 会校验 `%PDF-` 魔数并限制体积，避免把 HTML 错误页存成一个打不开的「论文」。

---

## 开发

```sh
npm test          # node --test test/  （零测试框架依赖）
npm run compat    # 在当前机器上核对本插件依赖的服务/接口是否齐备
```

架构分三层，改动时请守住边界：

```
lib/index.js        接线：解析服务 → 建 service → 注册工具与路由（唯一 import @deepseek-ai 的地方）
lib/core/service.js 业务逻辑：不依赖 DSH，可注入副作用，能被单测直接跑
lib/core/*.js       纯逻辑：text / store / arxiv / notes / pdf / config / compat / api / tools
lib/client.js       浏览器半区：自注册到 __ModuleLoader__，内联样式，只 fetch 回环 API
```

`test/static-guard.test.mjs` 会强制这些不变量：core 层不得出现 `@deepseek-ai/`、宿主半区不得碰浏览器全局、
`package.json` 的 `files` 必须覆盖运行时文件、`cordis.patch.yml` 里的配置键必须被 schema 认识、两处版本号必须一致。

改了行为就更新 `CHANGELOG.md`；改了兼容面就更新 `COMPATIBILITY.md`。

---

## 已知限制

- **界面是浮层面板**，不是中央主面板：这是为了用社区插件已验证过的 `sidebar.footer.action` + `shell.overlay`
  两个插槽组合，跨版本最稳。
- **`打开所在目录` 只在宿主与浏览器同机时有意义**（远端部署时点它没用）。
- **不做去重合并**：同一篇论文的 arXiv 版与会议版会是两条记录，标签是你的手段。
- **全文抽取质量取决于 PDF**：双栏排版、扫描件、公式密集的页面会有噪声；这是 PDF 文本层的固有限制。

---

## 许可

[MIT](./LICENSE)。欢迎 issue 与 PR：提 bug 时请附上 `/paperdesk/api/health` 的输出，它包含版本、能力探测与抽取器状态。
