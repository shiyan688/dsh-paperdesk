/**
 * 兼容层的单测。
 *
 * 这一层是「跨 DSH 版本可用」这个承诺的落点，所以它必须比业务代码更严：
 * 版本比较的边界、预发布版本序、能力探测在残缺 context 下的行为，都要钉死。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  PLUGIN_VERSION,
  REQUIRED_NODE_MAJOR,
  SUPPORTED_DSH_RANGE,
  capabilityReport,
  compareVersions,
  describeRange,
  inSupportedRange,
  parseVersion,
  probeCapabilities,
} from '../lib/core/compat.js'

test('parseVersion 认常见写法，拒绝垃圾输入', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: '', raw: '1.2.3' })
  assert.equal(parseVersion('v0.1.5-rc.2').pre, 'rc.2')
  assert.deepEqual(parseVersion('1.2'), { major: 1, minor: 2, patch: 0, pre: '', raw: '1.2' })
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
})

test('compareVersions：数值比较、预发布小于正式版', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '不能按字符串比')
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  // 无法解析的一侧视为最小，而不是抛错
  assert.equal(compareVersions('garbage', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', 'garbage'), 1)
  assert.equal(compareVersions('garbage', 'nonsense'), 0)
})

test('inSupportedRange / describeRange', () => {
  assert.equal(inSupportedRange('0.1.5-rc.2'), true)
  assert.equal(inSupportedRange('0.1.0'), true)
  assert.equal(inSupportedRange('0.0.9'), false)
  assert.equal(inSupportedRange('0.2.0'), false, '上界是开区间')
  assert.equal(inSupportedRange('unknown'), false)
  assert.equal(describeRange(), `>=${SUPPORTED_DSH_RANGE.min} <${SUPPORTED_DSH_RANGE.maxExclusive}`)
})

test('probeCapabilities：残缺 ctx 不抛错，只报 false', () => {
  const empty = probeCapabilities(undefined, { fetchImpl: () => {} })
  assert.deepEqual(
    { tools: empty.tools, webServer: empty.webServer, settings: empty.settings, fetch: empty.fetch },
    { tools: false, webServer: false, settings: false, fetch: true },
  )

  const hostile = probeCapabilities({ get() { throw new Error('boom') } }, { fetchImpl: null })
  assert.equal(hostile.tools, false)
  assert.equal(hostile.fetch, false)

  const full = probeCapabilities({
    get: (key) => ({
      tools: { register: () => {} },
      webServer: { register: () => {} },
      settings: { register: () => {} },
    })[key],
  }, { fetchImpl: () => {}, extractor: 'python' })
  assert.equal(full.tools, true)
  assert.equal(full.webServer, true)
  assert.equal(full.settings, true)
  assert.equal(full.extractor, 'python')

  // 服务存在但方法不对，仍算不可用
  const wrongShape = probeCapabilities({ get: () => ({}) }, { fetchImpl: () => {} })
  assert.equal(wrongShape.tools, false)
})

test('capabilityReport：缺工具注册表是错误，缺抽取器只是警告', () => {
  const base = { tools: true, webServer: true, settings: false, fetch: true, extractor: 'python', nodeMajor: 22 }

  const ok = capabilityReport({ dshVersion: '0.1.5-rc.2', capabilities: base, wantTools: true, wantApi: true })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.warnings, [])
  assert.equal(ok.pluginVersion, PLUGIN_VERSION)

  const noTools = capabilityReport({ capabilities: { ...base, tools: false }, wantTools: true })
  assert.equal(noTools.ok, false)
  assert.match(noTools.errors[0], /ctx\.tools/)

  const noApi = capabilityReport({ capabilities: { ...base, webServer: false }, wantApi: true })
  assert.equal(noApi.ok, false)
  assert.match(noApi.errors[0], /ctx\.webServer/)

  const noExtractor = capabilityReport({ capabilities: { ...base, extractor: 'none' }, extractorHint: '装 pdftotext' })
  assert.equal(noExtractor.ok, true, '没有抽取器不影响题录与检索，不该判为致命')
  assert.match(noExtractor.warnings[0], /pdftotext/)
})

test('capabilityReport：版本不在区间内只警告，不阻止运行', () => {
  const report = capabilityReport({
    dshVersion: '9.9.9',
    capabilities: { tools: true, webServer: true, settings: false, fetch: true, extractor: 'python', nodeMajor: 22 },
  })
  assert.equal(report.ok, true)
  assert.equal(report.warnings.length, 1)
  assert.match(report.warnings[0], /9\.9\.9/)
  assert.match(report.warnings[0], /health/)
})

test('capabilityReport：老 Node 没有 fetch 时给出可执行的建议', () => {
  const report = capabilityReport({
    capabilities: { tools: true, webServer: true, settings: false, fetch: false, extractor: 'none', nodeMajor: 18 },
  })
  assert.equal(report.ok, false)
  assert.match(report.errors.join('\n'), new RegExp(`Node >= ${REQUIRED_NODE_MAJOR}`))
})
