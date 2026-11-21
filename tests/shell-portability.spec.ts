/**
 * shell 脚本的跨平台可移植性：`$VAR` 后面紧跟非 ASCII 字符会被 bash 3.2 当成变量名的一部分。
 *
 * 事故（2026-11-21，GitHub Actions）：`core (macos-latest, *)` 与
 * `profile-install (macos-latest, *)` 从 2026-11-15 起每轮都红，ubuntu / windows 全绿；
 * 失败断言只有两行，来自 `tests/release-tag-push.spec.ts`：
 *
 * ```text
 * scripts/push-all.sh: line 68: BRANCH（: unbound variable
 *   expected 1 to be +0
 * ```
 *
 * 根因是 `say "推送分支 $BRANCH（${#PAIRS[@]} 个远端…）"` —— `$BRANCH` 后面紧贴全角括号。
 * bash 5（ubuntu/本机）在变量名边界上把非 ASCII 字节当定界符，能正常展开；
 * macOS runner 自带的 **bash 3.2** 把多字节字符算进了变量名，于是找的是
 * `BRANCH（…` 这个不存在的变量 —— 在 `set -u` 下直接 `unbound variable` 退出。
 * `profile-install` 的失败不是另一个缺陷：它的第 7 步是 `pnpm pack`，而 `prepack`
 * 会跑整条门禁，同一个用例把打包也带红了。
 *
 * 修法是所有 `$VAR` 在非 ASCII 前一律写成 `${VAR}`。本文件钉住这条，防止复发：
 * 静态扫 `scripts/**\/*.sh`，只要又出现裸 `$VAR` 紧跟非 ASCII 就红，
 * 并给出文件、行号与改法。静态断言就够 —— 这条规则与运行时无关，
 * 而真跑 bash 3.2 需要 macOS 或容器，CI 的 Linux 作业里做不到。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 必须走 `fileURLToPath`，不能用 `new URL(...).pathname`：后者在 Windows 上给出
// `/D:/a/repo/repo/scripts/`，拼出来的绝对路径是 `D:\D:\a\…`（2026-11-21 CI 实锤，
// core (windows-latest) 三个用例全 ENOENT）。
const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url))
const WORKFLOWS = fileURLToPath(new URL('../.github/workflows/', import.meta.url))

function shellScripts(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...shellScripts(full))
    else if (entry.endsWith('.sh')) out.push(full)
  }
  return out
}

/** `$VAR` 后面紧跟一个非 ASCII 字符 —— bash 3.2 会把它吃进变量名。 */
const BARE_VAR_BEFORE_MULTIBYTE = /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/

describe('shell scripts stay bash 3.2 portable', () => {
  it('workflow 里的 run: 段落同样不许出现裸 $VAR 紧贴非 ASCII', () => {
    // 作业换 runner（或默认 shell 变成 macOS 的 bash 3.2）时，同一行会立刻炸；
    // mirror-sync.yml 的 `echo "…（源：$SRC_LABEL）"` 就是这么被找出来的。
    const violations: string[] = []
    for (const entry of readdirSync(WORKFLOWS)) {
      if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue
      const file = join(WORKFLOWS, entry)
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const match = BARE_VAR_BEFORE_MULTIBYTE.exec(line)
          if (match === null) return
          violations.push(
            `.github/workflows/${entry}:${index + 1}  ${match[0]} 紧跟非 ASCII —— 改成 \${${match[0].slice(1)}}`,
          )
        })
    }
    expect(violations).toEqual([])
  })

  it('never puts a bare $VAR directly before a non-ASCII character', () => {
    const violations: string[] = []
    for (const file of shellScripts(SCRIPTS)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        const match = BARE_VAR_BEFORE_MULTIBYTE.exec(line)
        if (match !== null) {
          const relative = file.slice(SCRIPTS.length)
          violations.push(
            `scripts/${relative}:${index + 1}  ${match[0]} 紧跟非 ASCII —— 改成 \${${match[0].slice(1)}}`,
          )
        }
      })
    }
    expect(violations).toEqual([])
  })

  it('conditional 数组不许用裸 "${a[@]}" 展开（bash 3.2 + set -u 会 unbound variable）', () => {
    // `[ ... ] && arr=(--flag)` 造出的数组在条件不成立时**是空的**；bash 3.2 把空数组的
    // `"${arr[@]}"` 当未定义变量，`set -u` 下直接退出（2026-11-21 macOS runner 实锤：
    // push-all.sh 的 force_args）。要么在 if/else 里分开写，要么用 `${arr[@]+"${arr[@]}"}`。
    const CONDITIONAL_ARRAY = /^\s*\[.*\]\s*&&\s*([A-Za-z_][A-Za-z0-9_]*)=\(/gm
    const violations: string[] = []
    for (const file of shellScripts(SCRIPTS)) {
      const text = readFileSync(file, 'utf8')
      const relative = file.slice(SCRIPTS.length)
      for (const match of text.matchAll(CONDITIONAL_ARRAY)) {
        const name = match[1] as string
        const bare = new RegExp(`"\\\$\\{${name}\\[@\\]\\}"`)
        const guarded = new RegExp(`"\\\$\\{${name}\\[@\\]\\+`)
        text.split('\n').forEach((line, index) => {
          if (!bare.test(line) || guarded.test(line)) return
          violations.push(`scripts/${relative}:${index + 1}  "${name}[@]" 的裸展开 —— ${name} 可能为空`)
        })
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the release scripts that CI exercises free of the pattern', () => {
    // 这两支脚本会被 `tests/release-tag-push.spec.ts` 真跑，也是 macOS 上最先撞到的那两个。
    for (const name of ['push-all.sh', 'release.sh']) {
      const text = readFileSync(join(SCRIPTS, name), 'utf8')
      expect(text).not.toMatch(BARE_VAR_BEFORE_MULTIBYTE)
    }
  })
})
