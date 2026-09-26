/**
 * 浏览器半区的单测：模块加载器契约、slot 注册、组件树渲染、API 调用形状。
 *
 * 这些测试的价值在于**在没有浏览器的情况下**抓住组件代码的硬错误
 * （拼错的变量、渲染期抛异常、错误的 slot 名/id、打错的 API 路径）。
 * 它们不能替代真机验证：协调、样式、真实交互仍要在 DSH 界面里点一遍
 * （README 的「验证清单」列了这一步）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createMiniReact, find, findAll, textOf } from './helpers/mini-react.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/**
 * 在假的 `window.__ModuleLoader__` 里加载浏览器半区。
 * @returns {Promise<{ entry: any, plugin: any, requireCalls: string[] }>}
 */
async function loadClient() {
  const captured = []
  // 假 window 要够真：面板会挂 keydown 监听（Esc 关闭），缺方法会直接抛错
  const eventListeners = []
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => captured.push(entry) },
    addEventListener: (type, handler) => eventListeners.push({ type, handler }),
    removeEventListener: () => {},
  }
  const requireCalls = []
  // 加查询串绕开 ESM 模块缓存，让每个用例拿到干净的模块实例（共享状态随之复位）
  await import(`${pathToFileURL(clientPath).href}?case=${Math.random()}`)
  assert.equal(captured.length, 1, '客户端模块必须自己调用一次 __ModuleLoader__.load')

  const mini = createMiniReact()
  const require = (name) => {
    requireCalls.push(name)
    if (name === 'react') return mini.React
    throw new Error(`客户端半区不应该 require(${name})`)
  }
  const entry = captured[0]
  const plugin = entry.factory(require)
  return { entry, plugin, requireCalls, mini, eventListeners }
}

/** 假的 slots 服务，记录注册。 */
function fakeSlots() {
  const registrations = []
  return {
    registrations,
    service: {
      inject(_key, callback) { callback() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
}

test('客户端模块声明了正确的 id，且只 require react', async () => {
  const { entry, requireCalls } = await loadClient()
  assert.equal(entry.id, 'dsh-paperdesk')
  assert.deepEqual(requireCalls, ['react'])
})

test('插件同时满足两种 factory 约定（返回值与 module.exports）', async () => {
  const { plugin } = await loadClient()
  assert.equal(plugin.name, 'dsh-paperdesk')
  assert.equal(typeof plugin.apply, 'function')
})

test('插件对象声明了 inject 含 slots（客户端服务门禁的硬要求）', async () => {
  const { plugin } = await loadClient()
  // 回归防线：不声明 inject 时，插件可能在 slots 就绪前 apply 完毕、静默不注册任何东西，
  // 且 Cordis 永远不会重新激活它 —— 症状就是「模块加载了但界面里什么都没有」。
  assert.ok(Array.isArray(plugin.inject), 'plugin.inject 必须是数组')
  assert.ok(plugin.inject.includes('slots'), `plugin.inject 必须包含 slots，实际 ${JSON.stringify(plugin.inject)}`)
})

test('apply 注册侧栏入口与浮层两个 slot，参数符合列表协议', async () => {
  const { plugin } = await loadClient()
  const slots = fakeSlots()
  plugin.apply({ get: (key) => (key === 'slots' ? slots.service : undefined) })

  assert.equal(slots.registrations.length, 2)
  const byName = Object.fromEntries(slots.registrations.map((item) => [item.options.name, item.options]))

  assert.equal(byName['sidebar.footer.action'].id, 'dsh-paperdesk')
  assert.equal(typeof byName['sidebar.footer.action'].order, 'number')
  assert.equal(byName['shell.overlay'].id, 'dsh-paperdesk')
  assert.equal(typeof byName['shell.overlay'].order, 'number')

  for (const item of slots.registrations) {
    assert.equal(typeof item.component, 'function', `${item.options.name} 的组件必须是函数`)
  }
})

test('slots 服务缺失时不抛错，但留下可查的错误日志（不许静默）', async () => {
  const { plugin } = await loadClient()
  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args.join(' '))
  try {
    assert.doesNotThrow(() => plugin.apply({ get: () => undefined }))
  } finally {
    console.error = original
  }
  assert.equal(logged.length, 1, '必须留下恰好一条错误日志')
  assert.match(logged[0], /slots/)
})

test('侧栏入口渲染出可点的按钮，点击后浮层才渲染面板', async () => {
  const { plugin, mini } = await loadClient()
  const slots = fakeSlots()
  plugin.apply({ get: (key) => (key === 'slots' ? slots.service : undefined) })
  const entryComponent = slots.registrations.find((item) => item.options.name === 'sidebar.footer.action').component
  const overlayComponent = slots.registrations.find((item) => item.options.name === 'shell.overlay').component

  // 关闭状态：浮层渲染 null
  const closed = mini.render(mini.React.createElement(overlayComponent, null))
  assert.equal(closed.tree, null)

  // 点一下侧栏按钮
  const button = find(mini.render(mini.React.createElement(entryComponent, null)).tree, (el) => el.type === 'button')
  assert.ok(button !== null, '侧栏入口必须渲染出一个 button')
  assert.match(textOf(button), /论文/)
  assert.match(String(button.props.title), /论文工作台/)
  button.props.onClick()

  // 打开状态：面板出现，并且带上三个标签页与关键按钮文案
  const opened = mini.render(mini.React.createElement(overlayComponent, null))
  const text = textOf(opened.tree)
  assert.match(text, /论文工作台/)
  assert.match(text, /arXiv 检索/)
  assert.match(text, /导入 PDF/)
  assert.match(text, /文库/)
  const tabs = findAll(opened.tree, (el) => el.type === 'button').map((el) => textOf(el))
  assert.ok(tabs.some((label) => label.includes('关闭')), '面板必须有可点的关闭按钮')
})

test('面板打开后按预期调用宿主 API（GET /state 与 GET /health）', async () => {
  const { plugin, mini } = await loadClient()
  const slots = fakeSlots()
  plugin.apply({ get: (key) => (key === 'slots' ? slots.service : undefined) })
  const entryComponent = slots.registrations.find((item) => item.options.name === 'sidebar.footer.action').component
  const overlayComponent = slots.registrations.find((item) => item.options.name === 'shell.overlay').component

  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    if (String(url).endsWith('/state')) {
      return { status: 200, json: async () => ({ ok: true, root: 'D:/lib', stats: { total: 1, unread: 1, reading: 0, read: 0, pdf: 0, text: 0, noted: 0 }, papers: [{ id: '1706.03762', title: 'Attention Is All You Need', status: 'unread', tags: [], authors: [], rating: 0 }] }) }
    }
    return { status: 200, json: async () => ({ ok: true, extractor: { note: 'python + pymupdf' }, warnings: [], errors: [], dshVersion: '0.1.5-rc.2' }) }
  }

  const button = find(mini.render(mini.React.createElement(entryComponent, null)).tree, (el) => el.type === 'button')
  button.props.onClick()
  const opened = mini.render(mini.React.createElement(overlayComponent, null))

  // effect 在渲染时已经跑起来了（挂载 effect 里发了两个请求），这里只需等异步链走完。
  // 千万不要调 opened.cleanups —— 那是卸载函数，会把组件里的 alive 标志置假。
  await new Promise((resolve) => setTimeout(resolve, 20))

  const urls = calls.map((c) => c.url)
  assert.ok(urls.includes('/paperdesk/api/health'), `应请求 health，实际：${urls.join(', ')}`)
  assert.ok(urls.includes('/paperdesk/api/state'), `应请求 state，实际：${urls.join(', ')}`)
  assert.ok(calls.every((c) => c.method === 'GET'))
  assert.ok(opened.tree !== null)
  assert.ok(opened.cleanups.length >= 1, '面板挂载应注册卸载清理（订阅、键盘监听等）')
  delete globalThis.fetch
})

test('浏览器半区不碰 node 内置模块（静态检查）', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.ok(!/require\(\s*['"]node:/.test(source), '客户端不得 require node: 内置模块')
  assert.ok(!/\bimport\b[^\n]*from\s*['"]node:/.test(source), '客户端不得 import node: 内置模块')
  assert.ok(!/\bprocess\./.test(source), '客户端不得使用 process')

  // 用行首锚定找**真正的注册调用**：文件头注释里也提到了这个名字，indexOf 会找错地方
  const registration = source.match(/^window\.__ModuleLoader__\.load\(/m)
  assert.ok(registration !== null, '客户端必须自我注册到模块加载器')
  const before = source.slice(0, registration.index)
  const executable = before.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim()
  assert.equal(executable, '', '注册调用之前不允许有可执行语句')
})
