/**
 * 测试用的临时目录。
 *
 * 刻意**不用** `os.tmpdir()`：本仓库的测试要能在受限沙箱里跑（比如 DSH 自己的
 * workspace-write 策略下，系统临时目录常常不可写）。所以临时目录开在仓库内的
 * `.test-tmp/` 下，并在用例结束时删掉；该目录已进 .gitignore。
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = join(here, '..', '..', '.test-tmp')

/**
 * 建一个临时目录（父目录不存在时先建出来 —— mkdtemp 要求父目录已存在）。
 * @param {string} [label]
 * @returns {Promise<string>}
 */
export async function makeTmpDir(label = 'case') {
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, `${label}-`))
}

/**
 * 跑一段逻辑并保证临时目录被清理。
 * @template T
 * @param {(dir: string) => Promise<T>} fn
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export async function withTmpDir(fn, label) {
  const dir = await makeTmpDir(label)
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
