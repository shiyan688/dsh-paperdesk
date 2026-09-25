/**
 * 一个极小的 React 替身，只为在 Node 里把浏览器半区的组件树渲染一遍。
 *
 * 为什么不用真的 react + react-dom/server：
 *   - 这个仓库刻意零运行时依赖，测试也不该为了跑一次渲染就拖进一个渲染器；
 *   - 我们要抓的是**组件代码本身的错**（拼错的变量、hook 用错、undefined 解引用、
 *     渲染期抛异常），而不是 React 的协调算法。一个只会「调用函数组件 + 执行 hooks」
 *     的替身足够抓这些，而且行为完全可预测。
 *
 * 它**不**做：diff、key 复用、批处理、并发特性。所以它不能替代真实浏览器验证 ——
 * 真实渲染仍然需要在 DSH 里打开界面确认（README 的验证清单里写了这一步）。
 */

/**
 * 创建一个 React 替身。
 * @param {{ onEffect?: (fn: Function) => void }} [options]
 */
export function createMiniReact(options = {}) {
  /** 当前正在渲染的组件的 hook 槽位。 */
  let current = null
  /** 每次渲染派生的待执行 effect 队列。 */
  let pendingEffects = []

  function createElement(type, props, ...children) {
    const flat = children.length === 0 ? [] : children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    return { type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat } }
  }

  function useState(initial) {
    if (current === null) throw new Error('useState 只能在渲染期调用')
    const scope = current
    const index = scope.cursor
    scope.cursor += 1
    if (!(index in scope.slots)) scope.slots[index] = typeof initial === 'function' ? initial() : initial
    // 注意闭包捕获的是 scope 而不是外层可变的 current：setter 往往在渲染结束之后
    // 才被 onClick 调用，那时 current 已经被还原成 null 了。
    const setter = (next) => {
      scope.slots[index] = typeof next === 'function' ? next(scope.slots[index]) : next
    }
    return [scope.slots[index], setter]
  }

  function useEffect(effect, deps) {
    if (current === null) throw new Error('useEffect 只能在渲染期调用')
    const scope = current
    const index = scope.cursor
    scope.cursor += 1
    const previous = scope.effects[index]
    const changed = previous === undefined
      || deps === undefined
      || previous.deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((value, i) => !Object.is(value, previous.deps[i]))
    if (!changed) return
    const cleanup = effect()
    scope.effects[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
    pendingEffects.push(() => scope.effects[index]?.cleanup?.())
  }

  const React = { createElement, useState, useEffect }

  /**
   * 渲染一个元素（递归调用函数组件），返回它产出的元素树。
   *
   * 每个函数组件拿到**独立**的 hook 槽位：这个替身不做协调，也不需要跨渲染保存状态，
   * 共享槽位只会让嵌套组件的 hook 互相踩。
   *
   * effect 在渲染过程中**已经执行**（同步部分 + 启动异步部分）；返回值里的
   * `cleanups` 是卸载函数，只在你想模拟「组件卸载」时才调用 —— 调它会把组件里
   * 的 `alive = false` 之类标志置假，从而掐掉还没完成的异步工作。
   *
   * @param {any} element
   * @returns {{ tree: any, cleanups: Array<() => void> }}
   */
  function render(element) {
    pendingEffects = []

    function walk(node) {
      if (node === null || node === undefined || typeof node === 'boolean') return null
      if (typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map(walk)
      if (typeof node.type === 'function') {
        const previous = current
        current = { cursor: 0, slots: [], effects: {} }
        let produced
        try {
          produced = node.type({ ...(node.props ?? {}) })
        } finally {
          current = previous
        }
        return walk(produced)
      }
      // 宿主元素：把 children 也递归展开
      const children = node.props?.children
      return { ...node, props: { ...node.props, children: walk(children) } }
    }

    const tree = walk(element)
    return { tree, cleanups: pendingEffects }
  }

  return { React, render }
}

/**
 * 把渲染结果摊平成字符串，用于断言「界面上有没有这句话」。
 * @param {any} node
 * @returns {string}
 */
export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const children = node.props?.children
  const own = typeof node.type === 'string' ? '' : ''
  return `${own}${textOf(children)}`
}

/**
 * 深度优先找第一个满足条件的宿主元素。
 * @param {any} node
 * @param {(element: any) => boolean} predicate
 * @returns {any|null}
 */
export function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}

/**
 * 找出所有满足条件的宿主元素。
 * @param {any} node
 * @param {(element: any) => boolean} predicate
 * @param {any[]} [out]
 * @returns {any[]}
 */
export function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.props?.children, predicate, out)
  return out
}
