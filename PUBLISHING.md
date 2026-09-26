# 发布清单

这份清单只讲一件事：**把 dsh-paperdesk 发出去的具体步骤，以及每一步凭什么算通过。**
版本号策略与兼容面见 `COMPATIBILITY.md`，改动记录见 `CHANGELOG.md`。

---

## 0. 发布前必须由人确认的三件事

前两项我（或任何自动化）都不该替你决定：

| 项 | 位置 | 说明 |
| --- | --- | --- |
| **仓库地址** | `package.json` 的 `repository` / `homepage` / `bugs` | 当前填的是按你已有插件推断的 `github.com/shiyan688/dsh-paperdesk`。仓库名不同就改这三处 |
| **LICENSE 署名** | `LICENSE` 第 3 行 | 当前是 `Copyright (c) 2026 dsh-paperdesk contributors`。要署真名就改这一行 |
| **版本号** | `package.json` 的 `version` | 首次发布 `0.1.0` 即可；之后按语义化版本递增 |

---

## 1. 本地放行检查（全部应通过）

```sh
npm test              # 108 项：单元 + HTTP 全链路 + 客户端渲染 + 仓库静态守卫
npm run compat        # 本机 DSH 能力自查（9~11 项 PASS）
npm pack --dry-run --cache .npm-cache   # 看发布产物清单
```

`npm pack --dry-run` 的输出要逐条看过：**只应有 `lib/`、`scripts/check-dsh-compat.mjs`、
`cordis.patch.yml`、四份文档与 LICENSE**。曾经的教训是调试用脚本（`scripts/_*.mjs`、
`_*.ps1`）被 `files: ["scripts/"]` 一并带上 —— 静态守卫现在有一条专门盯这个。

产物侧写（0.1.0 实测）：`total files: 20`，`package size: 60.4 kB`，`unpacked size: 175.2 kB`。

---

## 2. 推到 GitHub

```sh
gh repo create shiyan688/dsh-paperdesk --public --source=. --remote=origin --push
```

> **推 CI 需要额外 scope。** 含 `.github/workflows/` 的提交会被 GitHub 拒收：
> `refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`。
> 本机 `gh` token 的 scope 是 `gist, read:org, repo`，所以要先补：
>
> ```sh
> gh auth refresh -s workflow
> ```
>
> 这一步是交互式的（浏览器确认），无法自动化。补完再推即可。

推送前确认工作区干净（`git status`）、且没有把 `.test-tmp/`、`.npm-cache/`、
`.dsh-paperdesk/`、`.git-credentials` 之类的本地产物带进去（都已在 `.gitignore` 里）。

---

## 3. 发布到 npm

> **本机 registry 是镜像，必须先看这一条。**
> 实测 `npm config get registry` 返回 `https://registry.npmmirror.com`（淘宝镜像）。
> 镜像是**只读**的：直接 `npm login` / `npm publish` 会打到镜像上 —— 要么认证失败，
> 要么发到一个别人 `npm install` 装不到的地方。所以每一步都要显式指向官方源；
> `package.json` 的 `publishConfig.registry` 已经写死官方源，`npm publish` 这一条已经安全。

```sh
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
npx --registry=https://registry.npmjs.org npm view dsh-paperdesk version   # 验证官方源能查到
```

`publishConfig.access` 已设为 `public`，包名 `dsh-paperdesk` 无 scope（实测该名字尚未被占用）。

---

## 4. 发布后验证（**不要跳过**）

在一台**干净环境**里按用户视角装一次，而不是在开发目录里自测：

```sh
dsh plugin --profile web add dsh-paperdesk
node node_modules/dsh-paperdesk/scripts/check-dsh-compat.mjs --profile web
# 重启 dsh web，然后 Ctrl+F5 强刷页面
```

验收标准（按证据强弱排列）：

1. 启动日志出现：`[paperdesk] 0.1.0 就绪 · 文库 <root> · 抽取器 <…> · 工具 7 个 · 界面接口 已挂载`
2. `GET http://127.0.0.1:<端口>/paperdesk/api/health` 返回 HTTP 200，且 `ok=true`、`tools.registered` 有 7 项
3. 浏览器控制台出现：`[dsh-paperdesk] 客户端半区已挂载：侧栏入口 + 工作台面板`
4. 侧栏底部出现 **📚 论文**，面板三个页签可用

第 3 条是 0.1.0 之前那次「装了但界面看不见」事故留下的检查点：**只有第 1、2 条通过时，
插件可能仅仅在宿主侧活着**。控制台那行没出现就说明浏览器半区没被激活。

---

## 5. 出问题怎么办

| 情况 | 处理 |
| --- | --- |
| 刚发布的版本有严重问题 | `npm deprecate dsh-paperdesk@0.1.0 "原因"`，然后尽快发修复版。**不要 `unpublish`** —— 已经装过的人会拿到不一致的锁文件 |
| 只是文档错 | 一样的流程：改文档 → 升 patch 版本 → 再发。npm 上的内容不可原地修改 |
| 兼容性区间要变 | 同时改 `lib/core/compat.js` 的 `SUPPORTED_DSH_RANGE` / `TESTED_DSH_VERSION` 与 `COMPATIBILITY.md`；静态守卫会盯着两处版本号不许漂移 |
| 索引结构要改 | `lib/core/store.js` 的 `INDEX_VERSION` +1 并补一条 `MIGRATIONS`；读到更高版本必须继续拒绝读取 |

---

## 6. 这个插件不该做的事

写在发布清单里，是因为发布之后最容易被人要求加功能：

- **不做去重合并** —— 预印本与会议版是两条记录，标签是用户的手段；
- **不碰 `ctx.fs` / `ctx.shell`** —— 文件用 `node:fs`、子进程用 `node:child_process`，
  否则会把宿主的沙箱策略变化引进来（见 `COMPATIBILITY.md` 的「不用」一节）；
- **不把用户文库变成云服务** —— 文库是磁盘上的纯文件，用户可以整个拷走。
