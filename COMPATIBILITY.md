# 兼容性

这个插件承诺的是「**在没验证过的 DSH 上也尽量能用，并且说清楚哪里不能用**」，而不是「只支持某一个版本」。
下面是这个承诺的具体内容。

## 支持矩阵

| DSH 版本 | 状态 | 说明 |
| --- | --- | --- |
| **0.1.5-rc.2** | ✅ **实测通过** | 宿主半区（工具注册 + 回环 API + 真实 arXiv 入库 / PDF 下载 / 全文抽取）与浏览器半区（侧栏入口在真实浏览器中出现）都在这个版本上实测 |
| `>=0.1.0 <0.2.0` | 🟡 声明支持 | 服务契约一致即应当可用；不在区间内只会产生一条 `health` 警告，不会阻止启动 |
| `<0.1.0` / `>=0.2.0` | ⚪ 未验证 | 可能可用，也可能某个服务改名了。先看 `/paperdesk/api/health`，它会说清楚缺什么 |
| 无 DSH（纯 Node） | ✅ 部分可用 | `lib/core/**` 全部可独立导入与单测；只有 `lib/index.js` 需要 `@deepseek-ai/schemastery` |

区间常量在 `lib/core/compat.js`：`SUPPORTED_DSH_RANGE` 与 `TESTED_DSH_VERSION`。

## 依赖的宿主接口

**硬依赖**（缺了就少了对应的一半能力，但插件仍会启动，并在 health 里报出来）：

| 接口 | 用途 | 缺失时的行为 |
| --- | --- | --- |
| `ctx.tools.register(definition)` | 注册 7 个模型工具 | 工具全部不注册；界面与 API 照常 |
| `ctx.webServer.register({ kind, path, handler })` | 挂载 `/paperdesk/api` 回环接口 | 界面拿不到数据；模型工具照常 |

**软依赖**（有就用，没有就退到等价实现）：

| 接口 | 用途 | 缺失时的行为 |
| --- | --- | --- |
| `@deepseek-ai/dsh-tools` 的 `defineTool` | 编译作者视角的参数 spec | 退到 `lib/core/tools.js` 里的内置编译器，产物是同一份 ToolDefinition；health 里标注 `schemaMode: "builtin-compiler"` |
| `@deepseek-ai/schemastery` | 声明行配置 schema | **这是唯一会在导入期报错的依赖**：没有它 `lib/index.js` 无法被 import（`lib/core/**` 不受影响） |
| `fs` / `shell` 服务 | —— | **不使用**。文件用 `node:fs`，子进程用 `node:child_process`，因此不受宿主文件沙箱策略变化的影响 |

**不用**的东西（这是刻意的，也是跨版本稳定的关键）：

- 动态插件专用的 `harness.handle` / `harness.defineTool` / `harness.registerTool`；
- 任何 `@deepseek-ai/dsh-*` 的内部符号（只 import `dsh-tools` 的公开 `defineTool`）；
- 宿主的 `ctx.fs` / `ctx.shell` / `ctx.settings` / `ctx.spill` / `ctx.session*`。

## 依赖的浏览器插槽

| 插槽 | 协议 | 注册参数 | 用途 |
| --- | --- | --- | --- |
| `sidebar.footer.action` | list | `{ id: 'dsh-paperdesk', order: 12 }` | 侧栏入口按钮 |
| `shell.overlay` | list | `{ id: 'dsh-paperdesk', order: 30 }` | 工作台浮层 |

两个插槽都是 `replaceRisk: none` 的**追加式**插槽，不替换任何既有 UI。
客户端模块通过 `window.__ModuleLoader__.load({ id, factory })` 自注册，`React` 由 factory 的 `require('react')` 注入
（不使用全局变量）。样式全部内联，不注入 CSS、不依赖类名，因此不受加载顺序与 HMR 影响。

主题色同时兼容两代 token 名（`--dsw-alias-*` 与 `--dsh-color-*`），并各有硬编码兜底色。

## 依赖的 Node 能力

| 能力 | 用途 | 缺失时的行为 |
| --- | --- | --- |
| `fetch`（Node ≥ 20） | arXiv 检索、PDF 下载 | 报错并提示升级 Node；其余功能不受影响 |

`package.json` 的 `engines.node` 声明为 `>=20`。

## peerDependencies 为什么写 `*`

这个插件与宿主的耦合点是**服务契约**（方法名与参数形状），不是版本号。
写死范围会在「其实能用」的组合上产生误报，而真正的失败模式是「某个服务没了」——
那种情况由**能力探测**发现，比版本号比较准确得多。所以：

- `peerDependencies` 一律 `*`，只表达「这些包由宿主提供」，不表达版本约束；
- 版本区间只用于生成一条提示性警告；
- 唯一的硬失败点是 `schemastery` 无法解析（导入期），此时症状非常明确：`Cannot find package '@deepseek-ai/schemastery'`。

## 升级 DSH 时的自查

```sh
npm run compat
```

这个脚本会定位本机的 DSH 安装，然后逐项核对：

1. DSH 版本号是否在声明区间内；
2. `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-tools` 能否解析，`defineTool` 是否是函数；
3. 客户端模块加载器契约（`__ModuleLoader__`）是否还在；
4. 我们注册的两个插槽名是否仍被客户端 UI 包声明；
5. `ctx.tools.register` / `ctx.webServer.register` 的名称是否仍出现在宿主工具与服务包里。

输出 `PASS` / `WARN` / `FAIL` 三档；只有 `FAIL` 会让脚本以非零码退出。
装好插件后，运行时的权威答案始终是 **`GET /paperdesk/api/health`**，它报的是当前进程里真实探测到的能力。

## 数据格式兼容

文库索引 `state/index.json` 带 `version` 字段与迁移表（`lib/core/store.js` 的 `MIGRATIONS`）：

- **读旧版本**：逐级迁移，缺失字段补默认值，旧记录不会被丢弃；
- **读到更高版本**（例如你降级了插件）：**拒绝读取**并给出提示，而不是按自己认识的字段写回去把新字段削掉；
- **文件损坏**：按空库启动，并把原文件备份为 `index.corrupt-<时间>.json`，不会静默丢数据。

`notes/<id>.md` 是给人看的镜像，任何时候都可以由索引重新生成；它坏了不影响任何功能。
