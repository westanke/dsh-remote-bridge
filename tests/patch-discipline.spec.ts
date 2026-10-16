import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `@patch` 补丁四要素的机检（`AGENTS.md` §3.3）。
 *
 * 宪法里写着「`test` 指向的测试**必须存在** —— 这条可机检」，而姊妹仓 `dsh-companion`
 * 早就用 `ArchitectureGuardTest` 兑现了它，本仓一直没有。这条测试补上的正是这处**不对称**：
 * 一份承诺了「可机检」的纪律，如果没有检查，实际约束力就等于零。
 *
 * ## 判据
 *
 * 每个 `// @patch` 块必须：
 * 1. 五要素齐全且非空（`id` / `for` / `why` / `until` / `test`）；
 * 2. `test` 里至少提到一个 `tests/*.spec.ts` 路径，且**文件真实存在**；
 * 3. `test` 里写出的**用例名**必须真的在那个文件里（否则「有测试盯着」是句空话）。
 *
 * 外加**下限断言**（至少扫到 1 个块）：解析规则一旦失效（比如注释风格变了），
 * 「零问题」与「零解析」会长得一模一样 —— 这条断言把两者分开。
 */
const PATCH_FIELDS = ['id', 'for', 'why', 'until', 'test'] as const

/** 从 `test` 字段里认出「英文用例名」：≥ 20 字符、以字母开头、含空格，不含中文与路径分隔符。 */
const TEST_NAME_LIKE = /[A-Za-z][A-Za-z0-9 ,:'’-]{19,}/g
const SPEC_FILE_REF = /tests\/[\w.-]+\.spec\.ts/g

interface PatchBlock {
  file: string
  line: number
  fields: Map<string, string>
}

const root = path.resolve(import.meta.dirname, '..')

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

/** 扫一个文件里的全部 `@patch` 块，字段值含 `//` 续行。 */
function parsePatchBlocks(file: string, text: string): PatchBlock[] {
  const lines = text.split('\n')
  const blocks: PatchBlock[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!(lines[index] ?? '').trimStart().startsWith('// @patch')) continue
    const fields = new Map<string, string>()
    let cursor = index + 1
    while (cursor < lines.length && (lines[cursor] ?? '').trim().startsWith('//')) {
      const match = /^\/\/\s*(id|for|why|until|test):\s*(.*)$/.exec((lines[cursor] ?? '').trim())
      if (match?.[1] !== undefined) {
        const name = match[1]
        let value = match[2] ?? ''
        // 续行：紧跟的 `//` 注释（且不是下一个字段）都算这段值的一部分。
        let next = cursor + 1
        while (next < lines.length) {
          const line = (lines[next] ?? '').trim()
          if (!line.startsWith('//')) break
          if (/^\/\/\s*(id|for|why|until|test):/.test(line)) break
          value += ` ${line.replace(/^\/\/\s?/, '')}`
          next += 1
        }
        cursor = next - 1
        fields.set(name, value.trim())
      }
      cursor += 1
    }
    blocks.push({ file: path.relative(root, file), line: index + 1, fields })
    index = cursor
  }
  return blocks
}

describe('@patch 补丁四要素', () => {
  it('每个 @patch 块五要素齐全，且 test 指向的用例真实存在', async () => {
    const files = await sourceFiles(path.join(root, 'src'))
    const blocks: PatchBlock[] = []
    for (const file of files) blocks.push(...parsePatchBlocks(file, await readFile(file, 'utf8')))

    // 下限断言：解析规则失效时「零问题」与「零解析」长得一样，先把它俩分开。
    expect(blocks.length, 'src 下一个 @patch 块都没扫到（注释风格变了？或补丁被删光了？）').toBeGreaterThan(0)

    const problems: string[] = []
    for (const block of blocks) {
      const at = `${block.file}:${block.line}`
      for (const field of PATCH_FIELDS) {
        if (!block.fields.get(field)) problems.push(`${at} 缺 \`${field}\` 或值为空`)
      }

      const testRef = block.fields.get('test')
      if (testRef === undefined) continue
      const refs = [...testRef.matchAll(SPEC_FILE_REF)].map(match => match[0])
      if (refs.length === 0) {
        problems.push(`${at} 的 \`test\` 里没有 \`tests/*.spec.ts\` 路径：${testRef}`)
        continue
      }
      for (const ref of new Set(refs)) {
        const full = path.join(root, ref)
        if (!existsSync(full)) {
          problems.push(`${at} 的 \`test\` 指向的测试文件不存在：${ref}`)
          continue
        }
        const content = await readFile(full, 'utf8')
        for (const name of [...testRef.matchAll(TEST_NAME_LIKE)].map(match => match[0].trim())) {
          if (!content.includes(name)) {
            problems.push(`${at} 的 \`test\` 写了用例名「${name}」，但 ${ref} 里找不到它`)
          }
        }
      }
    }

    expect(problems, `补丁四要素不合格（${problems.length} 处）：\n${problems.join('\n')}`).toEqual([])
  })
})
