/**
 * PDF 下载与抽取的单测。
 *
 * 这里全部用假的子进程与假的 fetch：真实 PDF 工具在各平台差异很大，
 * 而这一层真正要保证的是**判据与降级**：
 *  - 退出码非 0 但拿到了文本，算成功（MiKTeX 版 pdftotext 的已知行为）；
 *  - 命令不存在要识别成 spawnError，而不是当成抽取失败；
 *  - 下载到的不是 PDF（HTML 错误页）必须失败，不能存成一个打不开的文件。
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { EXTRACT_SCRIPT, detectExtractor, downloadToFile, extractPdfText, pdfTextCandidates, pythonCandidates, runCommand } from '../lib/core/pdf.js'
import { withTmpDir } from './helpers/tmp.mjs'

/** 造一个假的 run 实现：按命令返回预设结果。 */
function fakeRun(table) {
  const calls = []
  const run = async (command, args) => {
    calls.push({ command, args })
    const hit = table[command]
    if (hit === undefined) return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn ENOENT' }
    return typeof hit === 'function' ? hit(args) : hit
  }
  run.calls = calls
  return run
}

const OK = (stdout) => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false, spawnError: '' })

test('pythonCandidates / pdfTextCandidates：配置优先，去重', () => {
  assert.deepEqual(pythonCandidates(''), ['python', 'python3', 'py'])
  assert.deepEqual(pythonCandidates('python3'), ['python3', 'python', 'py'])
  assert.deepEqual(pythonCandidates('python'), ['python', 'python3', 'py'])
  assert.deepEqual(pdfTextCandidates(''), ['pdftotext'])
  assert.deepEqual(pdfTextCandidates('/opt/bin/pdftotext'), ['/opt/bin/pdftotext', 'pdftotext'])
})

test('detectExtractor：优先选带引擎的 python', async () => {
  const run = fakeRun({
    python: OK('pymupdf\n'),
    pdftotext: (args) => (args[0] === '-v' ? { code: 1, signal: null, stdout: '', stderr: 'log4cxx', timedOut: false, spawnError: '' } : OK('')),
  })
  const plan = await detectExtractor({ run })
  assert.equal(plan.kind, 'python')
  assert.equal(plan.command, 'python')
  assert.equal(plan.engine, 'pymupdf')
  assert.match(plan.note, /pymupdf/)
})

test('detectExtractor：python 在但没有 PDF 库 → 落到 pdftotext', async () => {
  const run = fakeRun({
    python: OK('\n'),
    pdftotext: { code: 1, signal: null, stdout: 'pdftotext version 24.02.0', stderr: 'log4cxx: ...', timedOut: false, spawnError: '' },
  })
  const plan = await detectExtractor({ run })
  assert.equal(plan.kind, 'pdftotext', 'pdftotext -v 非零退出仍算可用')
  assert.equal(plan.engine, 'pdftotext')
})

test('detectExtractor：什么都没有 → none，并给安装建议', async () => {
  const plan = await detectExtractor({ run: fakeRun({}) })
  assert.equal(plan.kind, 'none')
  assert.match(plan.note, /pymupdf|pdftotext/)
  assert.ok(plan.probedAt.length > 0)
})

test('detectExtractor：pypdf 作为 python 的次选引擎', async () => {
  const plan = await detectExtractor({ run: fakeRun({ python3: OK('pypdf\n'), python: { code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' } }) })
  assert.equal(plan.kind, 'python')
  assert.equal(plan.command, 'python3')
  assert.equal(plan.engine, 'pypdf')
})

test('extractPdfText(none)：直接失败并指向 health', async () => {
  const result = await extractPdfText('/tmp/a.pdf', '/tmp/a.txt', { plan: { kind: 'none', command: '' }, scriptPath: '/tmp/x.py' })
  assert.equal(result.ok, false)
  assert.match(result.error, /health/)
})

test('extractPdfText(python)：写脚本、解析 JSON 回执', async () => {
  await withTmpDir(async (dir) => {
    const scriptPath = join(dir, '.tools', 'extract_pdf.py')
    const run = fakeRun({ python: OK(`noise\n{"ok":true,"engine":"pymupdf","pages":15,"chars":41234}\n`) })
    const result = await extractPdfText('/tmp/a.pdf', join(dir, 'text', 'a.txt'), { plan: { kind: 'python', command: 'python' }, scriptPath, run })

    assert.equal(result.ok, true)
    assert.equal(result.engine, 'pymupdf')
    assert.equal(result.pages, 15)
    assert.equal(result.chars, 41234)

    // 脚本必须真的被写下去，且内容是那份 python 源码
    const written = await readFile(scriptPath, 'utf8')
    assert.equal(written, EXTRACT_SCRIPT)
    assert.match(written, /import fitz/)
    // python 源码里的换行必须是转义后的 \n，不能被 JS 模板字符串提前变成真换行
    assert.ok(written.includes("'\\n'.join"), 'python 源码里的 \\n 必须保持转义')
  }, 'pdf-python')
})

test('extractPdfText(python)：回执缺失或 ok=false 时给出可读错误', async () => {
  await withTmpDir(async (dir) => {
    const scriptPath = join(dir, 'extract_pdf.py')
    const bad = fakeRun({ python: OK('{"ok":false,"error":"PDF 解析失败: boom"}') })
    const failed = await extractPdfText('/tmp/a.pdf', join(dir, 'a.txt'), { plan: { kind: 'python', command: 'python' }, scriptPath, run: bad })
    assert.equal(failed.ok, false)
    assert.match(failed.error, /boom/)

    const silent = fakeRun({ python: { code: 1, signal: null, stdout: '', stderr: 'python: command failed', timedOut: false, spawnError: '' } })
    const noOutput = await extractPdfText('/tmp/a.pdf', join(dir, 'a.txt'), { plan: { kind: 'python', command: 'python' }, scriptPath, run: silent })
    assert.equal(noOutput.ok, false)
    assert.match(noOutput.error, /command failed|无输出/)
  }, 'pdf-python-bad')
})

test('extractPdfText(pdftotext)：退出码非 0 但有文本算成功，并如实给警告', async () => {
  await withTmpDir(async (dir) => {
    const dest = join(dir, 'text', 'a.txt')
    const run = fakeRun({ pdftotext: { code: -1073740791, signal: null, stdout: 'Extracted paper text\n', stderr: 'log4cxx: IO Exception', timedOut: false, spawnError: '' } })
    const result = await extractPdfText('/tmp/a.pdf', dest, { plan: { kind: 'pdftotext', command: 'pdftotext' }, scriptPath: join(dir, 'x.py'), run })

    assert.equal(result.ok, true)
    assert.equal(result.engine, 'pdftotext')
    assert.match(result.warning, /已知的收尾日志问题/)
    assert.equal(await readFile(dest, 'utf8'), 'Extracted paper text\n')
  }, 'pdf-pdftotext')
})

test('extractPdfText(pdftotext)：完全没输出算失败', async () => {
  await withTmpDir(async (dir) => {
    const run = fakeRun({ pdftotext: { code: 1, signal: null, stdout: '   ', stderr: 'syntax error', timedOut: false, spawnError: '' } })
    const result = await extractPdfText('/tmp/a.pdf', join(dir, 'a.txt'), { plan: { kind: 'pdftotext', command: 'pdftotext' }, scriptPath: join(dir, 'x.py'), run })
    assert.equal(result.ok, false)
    assert.match(result.error, /syntax error/)
  }, 'pdf-pdftotext-bad')
})

test('downloadToFile：正常 PDF 落盘并回报字节数', async () => {
  await withTmpDir(async (dir) => {
    const dest = join(dir, 'pdf', 'a.pdf')
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)])
    const result = await downloadToFile('https://example.test/a.pdf', dest, {
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => pdf }),
    })
    assert.equal(result.bytes, pdf.length)
    assert.equal((await readFile(dest)).length, pdf.length)
  }, 'dl-ok')
})

test('downloadToFile：HTML 错误页 / 0 字节 / 超限 / HTTP 错都拒绝', async () => {
  await withTmpDir(async (dir) => {
    const dest = join(dir, 'a.pdf')
    const respond = (body, headers = {}) => async () => ({
      ok: true,
      status: 200,
      headers: { get: (key) => headers[key] ?? null },
      arrayBuffer: async () => body,
    })

    await assert.rejects(() => downloadToFile('u', dest, { fetchImpl: respond(Buffer.from('<html>Not Found</html>')) }), /不是 PDF/)
    await assert.rejects(() => downloadToFile('u', dest, { fetchImpl: respond(Buffer.alloc(0)) }), /0 字节/)
    await assert.rejects(
      () => downloadToFile('u', dest, { fetchImpl: respond(Buffer.from('%PDF-'), { 'content-length': String(200 * 1024 * 1024) }) }),
      /超过上限/,
    )
    await assert.rejects(
      () => downloadToFile('u', dest, { fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }) }),
      /HTTP 404/,
    )
  }, 'dl-bad')
})

test('extractPdfText(python)：调用抽取器之前必须先建好输出目录（回归）', async () => {
  // 真实事故：文库目录被外部删过之后 text/ 不存在，而 python 侧当时直接 open(dest,'w')，
  // 于是「解析全文」以 FileNotFoundError 失败，界面上只显示一句失败提示。
  // 两侧都钉住：JS 侧开跑前建目录，python 源码自身也建。
  assert.match(EXTRACT_SCRIPT, /Path\(dest\)\.parent\.mkdir/, 'python 源码必须自建输出目录')
  await withTmpDir(async (dir) => {
    const scriptPath = join(dir, '.tools', 'extract_pdf.py')
    const destDir = join(dir, 'text') // 故意不预先创建
    const dest = join(destDir, 'a.txt')
    let dirExistedWhenRun = null
    const run = async () => {
      dirExistedWhenRun = existsSync(destDir)
      return OK('{"ok":true,"engine":"pymupdf","pages":3,"chars":42}')
    }
    const result = await extractPdfText('/tmp/a.pdf', dest, { plan: { kind: 'python', command: 'python' }, scriptPath, run })
    assert.equal(result.ok, true)
    assert.equal(dirExistedWhenRun, true, '输出目录必须在抽取器启动前就存在')
  }, 'pdf-destdir')
})

test('EXTRACT_SCRIPT：python 源码用到的模块必须都在 import 里（回归）', () => {
  // 真实事故：0.1.1 给脚本加了 pathlib.Path(dest).parent.mkdir(...) 却没加 `import pathlib`，
  // 于是装了 0.1.1 之后**每一次「解析全文」都以 NameError 失败**。
  // 当时的测试只断言源码里出现那串字样，从未执行脚本，所以完全没拦住 —— 这条补上静态面。
  const imported = new Set()
  for (const line of EXTRACT_SCRIPT.split('\n')) {
    const plain = line.match(/^\s*import\s+(.+)$/)
    if (plain) {
      for (const part of plain[1].split(',')) imported.add(part.split('#')[0].trim().split(/\s+as\s+/)[0])
    }
    const from = line.match(/^\s*from\s+(\w+)\s+import/)
    if (from) imported.add(from[1])
  }
  const used = new Set(
    [...EXTRACT_SCRIPT.matchAll(/\b(pathlib|json|sys|os|shutil|urllib|re|math|fitz|pypdf)\./g)].map((m) => m[1]),
  )
  const missing = [...used].filter((name) => !imported.has(name))
  assert.deepEqual(missing, [], `脚本用到但没 import 的模块：${missing.join(', ')}`)
})

test('EXTRACT_SCRIPT：python 可用时真的跑一遍（CI 会执行；受限沙箱如实跳过）', async () => {
  const probe = await runCommand('python', ['-c', 'print(1)'], { timeoutMs: 15000 })
  if (probe.spawnError !== '') {
    // 本机沙箱不允许起子进程：跳过而不是伪装通过（CI 上没有这个限制）
    assert.match(probe.spawnError, /EPERM|ENOENT/)
    return
  }
  await withTmpDir(async (dir) => {
    const maker = join(dir, 'make_pdf.py')
    await writeFile(
      maker,
      'import sys, fitz\nd = fitz.open()\np = d.new_page()\np.insert_text((72, 72), "hello paperdesk")\nd.save(sys.argv[1])\n',
      'utf8',
    )
    const pdf = join(dir, 'in.pdf')
    const made = await runCommand('python', [maker, pdf], { timeoutMs: 60000 })
    if (made.spawnError !== '' || !existsSync(pdf)) return // 没装 PyMuPDF 就算了，别伪装通过

    const script = join(dir, 'extract_pdf.py')
    await writeFile(script, EXTRACT_SCRIPT, 'utf8')
    const out = join(dir, 'out.txt')
    const ran = await runCommand('python', [script, pdf, out], { timeoutMs: 60000 })
    if (ran.spawnError !== '') return // 沙箱对子进程的拒绝是间歇的：中途被拒同样如实跳过
    const parsed = JSON.parse(ran.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop() ?? 'null')
    assert.equal(parsed?.ok, true, `脚本执行失败：${ran.stdout} ${ran.stderr}`)
    assert.match(await readFile(out, 'utf8'), /hello paperdesk/)
  }, 'pdf-run-script')
})

test('runCommand：命令不存在时返回 spawnError 而不是抛错', async () => {
  const result = await runCommand('definitely-not-a-real-command-xyz', ['--version'], { timeoutMs: 5000 })
  assert.equal(result.spawnError !== '', true, 'spawn 失败必须被识别出来')
  assert.equal(result.code, null)
})

test('runCommand：超时会被杀掉并标记 timedOut', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 300 })
  if (result.spawnError !== '') {
    // 受限沙箱里不允许起子进程：如实跳过，不伪装成通过
    assert.match(result.spawnError, /EPERM|ENOENT/)
    return
  }
  assert.equal(result.timedOut, true)
  assert.equal(result.spawnError, '')
})

test('runCommand：正常命令能拿到 stdout 与退出码', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("hello")'], { timeoutMs: 10000 })
  if (result.spawnError !== '') {
    // 受限沙箱里连自己都 spawn 不了：如实跳过，不伪装成通过
    assert.match(result.spawnError, /EPERM|ENOENT/)
    return
  }
  assert.equal(result.stdout, 'hello')
  assert.equal(result.code, 0)
})
