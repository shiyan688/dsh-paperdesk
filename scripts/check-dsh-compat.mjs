#!/usr/bin/env node
/**
 * dsh-paperdesk — 宿主兼容性自查。
 *
 * 这个脚本回答一个具体问题：**我当前这台机器上的 DSH，满足这个插件依赖的服务与接口吗？**
 *
 * 它做的是静态核对（版本号、包能否解析、契约字符串是否还在），不是运行时探测 ——
 * 运行时的权威答案永远是插件自己报的 `GET /paperdesk/api/health`。
 * 两者互补：这个脚本能在**装之前**发现问题，health 报的是装好之后进程里的真实情况。
 *
 * 用法：
 *   node scripts/check-dsh-compat.mjs            # 自动定位 DSH
 *   DSH_HOME=/path/to/.dsh node scripts/...      # 指定 DSH 根目录
 *
 * 退出码：0 = 没有 FAIL（可以有 WARN）；1 = 有 FAIL。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { SUPPORTED_DSH_RANGE, TESTED_DSH_VERSION, compareVersions, describeRange } from '../lib/core/compat.js'

const require = createRequire(import.meta.url)

const results = []
const record = (level, title, detail) => results.push({ level, title, detail })
const pass = (title, detail = '') => record('PASS', title, detail)
const warn = (title, detail = '') => record('WARN', title, detail)
const fail = (title, detail = '') => record('FAIL', title, detail)

/** 读一个文件，读不到返回 null。 */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 路径是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 在一个目录里递归找包含某段文字的 .js 文件（有界，避免扫爆）。
 * @param {string} dir
 * @param {string} needle
 * @param {{ maxFiles?: number, maxBytes?: number }} [limits]
 * @returns {Promise<string[]>} 命中的文件路径
 */
async function grepDir(dir, needle, limits = {}) {
  const maxFiles = limits.maxFiles ?? 4000
  const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024
  const hits = []
  let visited = 0
  const queue = [dir]
  while (queue.length > 0 && visited < maxFiles) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (visited >= maxFiles) break
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        queue.push(path)
      } else if (entry.isFile() && /\.(js|mjs|cjs|ts|d\.ts)$/.test(entry.name)) {
        visited += 1
        try {
          const info = await stat(path)
          if (info.size > maxBytes) continue
          const text = await readFile(path, 'utf8')
          if (text.includes(needle)) hits.push(path)
        } catch {
          // 读不了就跳过
        }
      }
    }
  }
  return hits
}

/** 定位 DSH 安装：DSH_HOME/profiles → 默认 ~/.dsh → require.resolve。 */
async function locateDsh() {
  const candidates = []
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  candidates.push(join(home, 'profiles', 'node_modules', '@deepseek-ai'))
  candidates.push(join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai'))

  try {
    const manifest = require.resolve('@deepseek-ai/dsh/package.json')
    candidates.push(dirname(dirname(manifest)))
  } catch {
    // 解析不到就走目录候选
  }

  for (const packagesDir of candidates) {
    const dshPkg = join(packagesDir, 'dsh', 'package.json')
    const text = await readText(dshPkg)
    if (text === null) continue
    try {
      const parsed = JSON.parse(text)
      return { packagesDir, version: String(parsed.version ?? 'unknown'), manifest: dshPkg }
    } catch {
      continue
    }
  }
  return null
}

/** 从一个包目录里解析 package.json。packagesDir 已经是 scope 目录，这里只取包名部分。 */
async function packageVersion(packagesDir, name) {
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const text = await readText(join(packagesDir, bare, 'package.json'))
  if (text === null) return null
  try {
    return String(JSON.parse(text).version ?? 'unknown')
  } catch {
    return null
  }
}

async function main() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  console.log('dsh-paperdesk 兼容性自查')
  console.log(`  声明支持区间 : ${describeRange(SUPPORTED_DSH_RANGE)}`)
  console.log(`  实测通过版本 : ${TESTED_DSH_VERSION}`)
  console.log(`  DSH_HOME     : ${dshHome}`)
  console.log('')

  const dsh = await locateDsh()
  if (dsh === null) {
    warn('未找到本机 DSH 安装', '跳过全部宿主核对；运行时报的 /paperdesk/api/health 才是权威答案')
  } else {
    console.log(`  已定位 DSH   : ${dsh.manifest}`)
    console.log('')

    // 1. 版本号
    const inRange = compareVersions(dsh.version, SUPPORTED_DSH_RANGE.min) >= 0
      && compareVersions(dsh.version, SUPPORTED_DSH_RANGE.maxExclusive) < 0
    if (inRange) pass(`DSH 版本 ${dsh.version} 在声明区间内`)
    else warn(`DSH 版本 ${dsh.version} 不在声明区间内`, '不阻止运行：能力探测会决定实际可用性')

    // 2. peer 依赖能否解析
    //    schemastery 是导入期硬依赖；dsh-tools 拿不到会退到内置编译器；cordis 由宿主提供，只作参考。
    const peerNotes = {
      '@deepseek-ai/schemastery': { hard: true, missing: '它是导入期硬依赖：缺了 lib/index.js 根本起不来' },
      '@deepseek-ai/dsh-tools': { hard: false, missing: '会退到内置编译器（/health 里会标注 schemaMode）' },
      '@deepseek-ai/cordis': { hard: false, missing: '由宿主提供，本插件不直接 import 它' },
    }
    for (const [name, note] of Object.entries(peerNotes)) {
      const version = await packageVersion(dsh.packagesDir, name)
      if (version === null) {
        if (note.hard) fail(`${name} 不存在`, note.missing)
        else warn(`${name} 不存在`, note.missing)
        continue
      }
      if (name === '@deepseek-ai/dsh-tools') {
        try {
          const module = await import('@deepseek-ai/dsh-tools')
          if (typeof module.defineTool === 'function') pass(`${name} ${version} 可解析，defineTool 可用`)
          else warn(`${name} ${version} 里没有 defineTool`, '会退到内置编译器')
        } catch (error) {
          warn(`${name} 无法 import`, String(error?.message ?? error))
        }
      } else {
        pass(`${name} ${version} 存在`)
      }
    }

    // 3. 客户端模块加载器契约
    const clientModules = join(dsh.packagesDir, 'dsh-client-modules')
    const loaderFiles = await grepDir(clientModules, '__ModuleLoader__', { maxFiles: 400 })
    if (loaderFiles.length > 0) pass('客户端模块加载器契约（__ModuleLoader__）仍在', `命中 ${loaderFiles.length} 个文件`)
    else warn('在 dsh-client-modules 里没找到 __ModuleLoader__', '浏览器半区可能换了加载方式，需要人工确认')

    // 4. 我们注册的两个插槽是否仍被声明
    for (const slot of ['sidebar.footer.action', 'shell.overlay']) {
      const hits = await grepDir(join(dsh.packagesDir, 'dsh-client-ui-sidebar'), slot, { maxFiles: 800 })
      const hits2 = hits.length > 0 ? hits : await grepDir(join(dsh.packagesDir, 'dsh-client-ui-layout'), slot, { maxFiles: 800 })
      if (hits2.length > 0) pass(`插槽 ${slot} 仍被客户端 UI 声明`)
      else warn(`没找到插槽 ${slot} 的声明`, '界面可能挂不上；这两个插槽缺失时插件不会报错，只是界面空白')
    }

    // 5. 宿主服务注册方法名
    const checks = [
      ['ctx.tools.register', join(dsh.packagesDir, 'dsh-tools'), 'register('],
      ['ctx.webServer.register', join(dsh.packagesDir, 'dsh-host-webserver'), 'register('],
    ]
    for (const [label, dir, needle] of checks) {
      if (!(await exists(dir))) {
        warn(`${label}：找不到对应包 ${dir}`, '跳过')
        continue
      }
      const hits = await grepDir(dir, needle, { maxFiles: 600 })
      if (hits.length > 0) pass(`${label} 的方法仍在导出中`)
      else warn(`${label}：没在源码里找到 ${needle}`, '可能是压缩/改名，建议装好后看 /paperdesk/api/health')
    }
  }

  // 6. profile 是否真的把插件登记成了 bundle 层。
  //    这是「装了但没反应」的唯一常见原因：`dsh plugin add` 按安装状态对账
  //    `dsh.profile.bundles`，依赖若解析不出 `dsh.bundle.patch`，就只当普通依赖装进去，
  //    插件永远不会被加载，而且没有任何报错。
  const profileFlag = process.argv.indexOf('--profile')
  const profileName = profileFlag >= 0
    ? process.argv[profileFlag + 1]
    : (process.argv[2] !== undefined && !process.argv[2].startsWith('--') ? process.argv[2] : undefined)

  if (profileName === undefined) {
    warn('未核对 profile 的 bundle 登记', '带上 --profile <名字> 可顺带核对「装了但静默不加载」这个失败模式')
  } else {
    const manifestPath = join(dshHome, 'profiles', profileName, 'package.json')
    const text = await readText(manifestPath)
    if (text === null) {
      fail(`找不到 profile「${profileName}」的 package.json`, manifestPath)
    } else {
      let manifest = null
      try {
        manifest = JSON.parse(text)
      } catch (error) {
        fail(`profile「${profileName}」的 package.json 解析失败`, String(error?.message ?? error))
      }
      if (manifest !== null) {
        const dependency = manifest.dependencies?.['dsh-paperdesk']
        const bundles = manifest.dsh?.profile?.bundles ?? []
        if (dependency === undefined) {
          fail(`profile「${profileName}」里没有 dsh-paperdesk 依赖`, `运行：dsh plugin --profile ${profileName} add dsh-paperdesk`)
        } else {
          pass(`profile「${profileName}」已登记依赖：${dependency}`)
        }
        if (bundles.includes('dsh-paperdesk')) {
          pass(`已在 dsh.profile.bundles 里（第 ${bundles.indexOf('dsh-paperdesk') + 1} 层，共 ${bundles.length} 层）`)
        } else {
          fail(
            'dsh-paperdesk 不在 dsh.profile.bundles 里 —— 插件不会被加载（静默失效，无报错）',
            `把 "dsh-paperdesk" 追加到 ${manifestPath} 的 dsh.profile.bundles 数组末尾`,
          )
        }
      }
    }
  }

  console.log('核对结果')
  for (const item of results) {
    const mark = item.level === 'PASS' ? '  ok  ' : item.level === 'WARN' ? ' warn ' : ' fail '
    console.log(`[${mark}] ${item.title}${item.detail === '' ? '' : `\n         ${item.detail}`}`)
  }
  const failures = results.filter((item) => item.level === 'FAIL')
  const warnings = results.filter((item) => item.level === 'WARN')
  console.log('')
  console.log(`合计：${results.length - failures.length - warnings.length} 通过 / ${warnings.length} 警告 / ${failures.length} 失败`)
  if (failures.length > 0) {
    console.log('')
    console.log('有硬失败项：插件很可能装不起来。请带着上面的输出提 issue。')
    process.exitCode = 1
    return
  }
  console.log('没有硬失败项。装好插件后请再确认一次 GET /paperdesk/api/health。')
  process.exitCode = 0
}

main().catch((error) => {
  console.error('自查脚本自身出错：', error)
  process.exitCode = 1
})
