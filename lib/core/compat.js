/**
 * dsh-paperdesk — DSH 版本与能力兼容层。
 *
 * 目标：插件在新旧 DSH 上「能跑就跑，跑不了说清楚」，而不是抛一个看不懂的错。
 *
 * 三条策略：
 *  1. **软版本门**：本文件声明的区间只用来生成警告，永远不阻止插件启动 ——
 *     因为 DSH 的版本号与某个服务是否存在并不一一对应，硬门会把「其实能用」的组合拦掉。
 *     真正决定能不能用的是第 2 条的能力探测。
 *  2. **能力探测优先**：需要的服务/内置对象逐个 `typeof` 检查，缺哪个降级哪个，
 *     降级结果进 `capabilityReport()`，通过 /paperdesk/api/health 暴露给界面与用户。
 *  3. **只用最稳的接口面**：`ctx.tools.register` / `ctx.webServer.register` / `ctx.get`。
 *     不碰只在动态插件里存在的 `harness.*`，也不碰任何 `@deepseek-ai/dsh-*` 的内部符号。
 */

export const PLUGIN_VERSION = '0.1.0'

/** 本版本实际验证过的 DSH 版本（本机实测）。 */
export const TESTED_DSH_VERSION = '0.1.5-rc.2'

/** 声明支持区间：`[min, maxExclusive)`。 */
export const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.1.0', maxExclusive: '0.2.0' })

/** Node 主版本下限（依赖全局 fetch）。 */
export const REQUIRED_NODE_MAJOR = 20

/**
 * 解析版本号。支持 `1.2.3`、`1.2.3-rc.2`、`v1.2.3`、`1.2`。
 * @param {unknown} input
 * @returns {{ major: number, minor: number, patch: number, pre: string, raw: string }|null}
 */
export function parseVersion(input) {
  const raw = String(input ?? '').trim().replace(/^v/i, '')
  const match = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: match[4] ?? '',
    raw,
  }
}

/**
 * 比较两个版本号。预发布版本小于同号正式版（`1.0.0-rc.1 < 1.0.0`）。
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number} -1 / 0 / 1；无法解析的一方视为最小。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : 1
}

/**
 * 版本是否落在区间内。
 * @param {unknown} version
 * @param {{ min: string, maxExclusive: string }} [range]
 * @returns {boolean}
 */
export function inSupportedRange(version, range = SUPPORTED_DSH_RANGE) {
  const parsed = parseVersion(version)
  if (parsed === null) return false
  return compareVersions(parsed.raw, range.min) >= 0 && compareVersions(parsed.raw, range.maxExclusive) < 0
}

/**
 * 人类可读的区间描述。
 * @param {{ min: string, maxExclusive: string }} [range]
 * @returns {string}
 */
export function describeRange(range = SUPPORTED_DSH_RANGE) {
  return `>=${range.min} <${range.maxExclusive}`
}

/**
 * 从宿主 context 探测能力。
 *
 * 只做「有没有」判断，不调用任何可能抛错的方法 —— 探测本身绝不能成为故障源。
 *
 * @param {any} ctx
 * @param {{ fetchImpl?: unknown, nodeVersion?: string }} [env]
 * @returns {{
 *   tools: boolean, webServer: boolean, settings: boolean,
 *   fetch: boolean, extractor: string,
 *   nodeMajor: number,
 * }}
 */
export function probeCapabilities(ctx, env = {}) {
  const get = (key) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    } catch {
      return undefined
    }
  }
  const tools = get('tools')
  const webServer = get('webServer')
  const settings = get('settings')
  const fetchImpl = env.fetchImpl ?? globalThis.fetch
  const nodeMajor = Number.parseInt(String(env.nodeVersion ?? process.versions?.node ?? '0').split('.')[0], 10)

  return {
    tools: typeof tools?.register === 'function',
    webServer: typeof webServer?.register === 'function',
    settings: typeof settings?.register === 'function',
    fetch: typeof fetchImpl === 'function',
    extractor: String(env.extractor ?? 'none'),
    nodeMajor: Number.isFinite(nodeMajor) ? nodeMajor : 0,
  }
}

/**
 * 汇总一份兼容性报告。**这是给用户看的**，所以文字要说人话、给出下一步动作。
 *
 * @param {{
 *   dshVersion?: string, pluginVersion?: string, capabilities: ReturnType<typeof probeCapabilities>,
 *   wantTools?: boolean, wantApi?: boolean, extractorHint?: string,
 * }} input
 * @returns {{
 *   ok: boolean, dshVersion: string, range: string, pluginVersion: string,
 *   capabilities: ReturnType<typeof probeCapabilities>, errors: string[], warnings: string[],
 * }}
 */
export function capabilityReport(input) {
  const capabilities = input.capabilities
  const dshVersion = String(input.dshVersion ?? 'unknown')
  const errors = []
  const warnings = []

  if (input.wantTools === true && !capabilities.tools) {
    errors.push('ctx.tools 不可用：无法注册论文工具，请确认组合配置里包含工具注册表（dsh-base 已提供）。')
  }
  if (input.wantApi === true && !capabilities.webServer) {
    errors.push('ctx.webServer 不可用：界面拿不到数据，请确认 profile 里包含 web 应用层。')
  }
  if (!capabilities.fetch && capabilities.nodeMajor < REQUIRED_NODE_MAJOR) {
    errors.push(`Node ${capabilities.nodeMajor} 没有全局 fetch：请升级到 Node >= ${REQUIRED_NODE_MAJOR}。`)
  }
  if (capabilities.extractor === 'none') {
    warnings.push(`没有可用的 PDF 全文抽取器：题录与检索不受影响，但「抽取全文」会失败。${input.extractorHint ?? ''}`)
  }
  if (dshVersion !== 'unknown' && !inSupportedRange(dshVersion)) {
    warnings.push(
      `当前 DSH ${dshVersion} 不在本插件验证过的区间 ${describeRange()} 内（实测版本 ${TESTED_DSH_VERSION}）：`
      + '插件仍会按能力探测降级运行，遇到问题时请附上 /paperdesk/api/health 的输出提 issue。',
    )
  }

  return {
    ok: errors.length === 0,
    dshVersion,
    pluginVersion: String(input.pluginVersion ?? PLUGIN_VERSION),
    range: describeRange(),
    testedVersion: TESTED_DSH_VERSION,
    capabilities,
    errors,
    warnings,
  }
}
