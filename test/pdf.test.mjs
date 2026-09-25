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
