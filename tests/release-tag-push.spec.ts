/**
 * 发版脚本的 tag 推送回归（issue #25）。
 *
 * 事故（2026-11-19 发 v2.12.1 时撞上）：`scripts/release.sh` 第 4 步调用
 * `bash scripts/push-all.sh` 时**没带 `PUSH_TAGS=1`**，而 push-all.sh 的默认是
 * `PUSH_TAGS=0` —— 于是「双推」只推了分支，**tag 没到远端**。第 5 步的 Release
 * 用 `tag_name=$TAG` 建，两站的 Release 接口**不校验远端有没有这个 tag**，
 * 所以 Release 照样建好、npm 照样发上去，等第 7 步回读才发现「tag 缺失」——
 * 那时 npm 已经发布，不可回滚。
 *
 * 更要命的是注释：`release.sh` 那段注释曾写着「tag 的推法与 push-all.sh 的
 * 默认一致：只推指向 HEAD 的 tag」，而 push-all.sh 的默认恰恰是**根本不推 tag**。
 * 两处注释互相矛盾 —— 这正是缺陷能活下来的原因。
 *
 * 本文件钉三件事：
 *
 * 1. **被调方行为**（真实跑 `scripts/push-all.sh`）：默认不推 tag，带 `PUSH_TAGS=1`
 *    才推指向 HEAD 的 tag。远端用**本地 bare 仓库**冒充（零网络、零凭据）。
 * 2. **调用方**：release.sh 对 push-all.sh 的调用**显式带 `PUSH_TAGS=1`**，
 *    且不依赖外部环境变量 —— 直接钉住这次修的那一行。
 * 3. **注释与行为不再相反**：release.sh 里不再出现「与 push-all.sh 的默认一致」
 *    这类措辞（防止文档再次说反，注释说反过一次就够了）。
 *
 * 为什么要跑真脚本而不做静态文本断言：push-all.sh 的 tag 段是「逐个推、
 * 失败不阻塞分支」，退出码与「tag 是否推上去」**不是一回事** —— 只有真跑一遍
 * 拿远端 refs 才能说清。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const PUSH_ALL = path.join(REPO_ROOT, 'scripts', 'push-all.sh')
const RELEASE = path.join(REPO_ROOT, 'scripts', 'release.sh')

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 造一个「远端 + 本地工作仓」：
 * - `gitee` / `atomgit` 是两个本地 bare 仓库（当主站/备站），零网络零凭据；
 * - 工作仓里 `main` 分支有两个提交，HEAD 上打一个 annotated tag `v9.9.9`。
 *
 * 返回跑 push-all.sh 所需的路径与查远端 refs 的办法。
 */
function makeFixture(): {
  work: string
  remotes: { gitee: string; atomgit: string }
  remoteHasTag: (remote: string, tag: string) => boolean
  remoteHasBranch: (remote: string, branch: string) => boolean
} {
  const base = mkdtempSync(path.join(tmpdir(), 'release-tag-push-'))
  created.push(base)

  const gitee = path.join(base, 'gitee.git')
  const atomgit = path.join(base, 'atomgit.git')
  const work = path.join(base, 'work')

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  for (const remote of [gitee, atomgit]) {
    git(base, 'init', '--bare', '--quiet', remote)
  }

  git(base, 'init', '--quiet', work)
  git(work, 'config', 'user.email', 'test@example.invalid')
  git(work, 'config', 'user.name', 'release-tag-push test')
  git(work, 'config', 'commit.gpgsign', 'false')
  // 用 -b main 让初始分支就叫 main，与 push-all.sh 的 BRANCH 默认值一致。
  git(work, 'checkout', '--quiet', '-b', 'main')
  writeFileSync(path.join(work, 'README.md'), '# fixture\n')
  git(work, 'add', 'README.md')
  git(work, 'commit', '--quiet', '-m', 'first')
  writeFileSync(path.join(work, 'README.md'), '# fixture v2\n')
  git(work, 'commit', '--quiet', '-am', 'second')
  git(work, 'tag', '-a', 'v9.9.9', '-m', 'fixture tag')

  git(work, 'remote', 'add', 'gitee', gitee)
  git(work, 'remote', 'add', 'atomgit', atomgit)

  const lsRemote = (remote: string, pattern: string): string => {
    try {
      return git(work, 'ls-remote', '--tags', remote, pattern)
    } catch {
      return ''
    }
  }
  const lsRemoteBranch = (remote: string, branch: string): string => {
    try {
      return git(work, 'ls-remote', '--heads', remote, `refs/heads/${branch}`)
    } catch {
      return ''
    }
  }

  return {
    work,
    remotes: { gitee, atomgit },
    remoteHasTag: (remote, tag) => lsRemote(remote, `refs/tags/${tag}`).trim().length > 0,
    remoteHasBranch: (remote, branch) => lsRemoteBranch(remote, branch).trim().length > 0,
  }
}

/** 跑一次真实的 scripts/push-all.sh，返回退出码与合并输出。 */
function runPushAll(work: string, env: Record<string, string>): { code: number; output: string } {
  try {
    const output = execFileSync('bash', [PUSH_ALL], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    }
  }
}

describe('push-all.sh 的 tag 推送开关（issue #25）', () => {
  it('默认不推 tag：远端只有分支、没有 tag（被调方的默认行为不变）', () => {
    const fx = makeFixture()

    const { code } = runPushAll(fx.work, {})
    expect(code).toBe(0)

    // 分支推上去了 —— 这是默认行为的一部分。
    expect(fx.remoteHasBranch('gitee', 'main')).toBe(true)
    expect(fx.remoteHasBranch('atomgit', 'main')).toBe(true)
    // tag 没有 —— 这正是 issue #25 的病灶。
    expect(fx.remoteHasTag('gitee', 'v9.9.9')).toBe(false)
    expect(fx.remoteHasTag('atomgit', 'v9.9.9')).toBe(false)
  })

  it('带 PUSH_TAGS=1 时推「指向 HEAD 的 tag」：远端既有分支也有 tag', () => {
    const fx = makeFixture()

    const { code, output } = runPushAll(fx.work, { PUSH_TAGS: '1' })
    expect(code, output).toBe(0)

    expect(fx.remoteHasBranch('gitee', 'main')).toBe(true)
    expect(fx.remoteHasBranch('atomgit', 'main')).toBe(true)
    expect(fx.remoteHasTag('gitee', 'v9.9.9')).toBe(true)
    expect(fx.remoteHasTag('atomgit', 'v9.9.9')).toBe(true)
  })

  it('tag 推送是逐个推的：远端已有同名 tag 时不报错、不影响分支', () => {
    const fx = makeFixture()

    const first = runPushAll(fx.work, { PUSH_TAGS: '1' })
    expect(first.code, first.output).toBe(0)
    expect(fx.remoteHasTag('gitee', 'v9.9.9')).toBe(true)

    // 幂等重跑：远端已有同名 tag → 跳过（不是失败），分支照旧推。
    const second = runPushAll(fx.work, { PUSH_TAGS: '1' })
    expect(second.code, second.output).toBe(0)
    expect(second.output).toContain('已存在，跳过')
    expect(fx.remoteHasTag('gitee', 'v9.9.9')).toBe(true)
    expect(fx.remoteHasTag('atomgit', 'v9.9.9')).toBe(true)
  })
})

describe('release.sh 的 tag 推送义务（issue #25 的修复本体）', () => {
  it('release.sh 调用 push-all.sh 时显式带 PUSH_TAGS=1（不靠调用者记得配环境变量）', () => {
    const source = readFileSync(RELEASE, 'utf8')

    // 取第 4 步里真正调用 push-all.sh 的那一行（不是 dry-run 提示行）。
    const callLine = source
      .split('\n')
      .find((line) => /bash\s+scripts\/push-all\.sh/.test(line) && !/\[dry\]/.test(line))

    expect(callLine, 'release.sh 里找不到对 scripts/push-all.sh 的真实调用').toBeTruthy()
    expect(callLine).toMatch(/PUSH_TAGS=1\s+bash\s+scripts\/push-all\.sh/)
  })

  it('release.sh 不再声称 tag 推法「与 push-all.sh 的默认一致」（注释曾与行为相反）', () => {
    const source = readFileSync(RELEASE, 'utf8')

    expect(source).not.toContain('与 push-all.sh 的默认一致')
    // 反向确认：push-all.sh 自己的默认值仍然是「不推」—— 手工推送的默认不该变。
    const pushAll = readFileSync(PUSH_ALL, 'utf8')
    expect(pushAll).toMatch(/PUSH_TAGS="\$\{PUSH_TAGS:-0\}"/)
  })

  it('release.sh 在进入 Release 之前就检查两站 tag 已就位（tag 缺失必须早于 npm 发布暴露）', () => {
    const source = readFileSync(RELEASE, 'utf8')

    const tagGateAt = source.indexOf('tag $TAG 已就位')
    const releaseStepAt = source.indexOf('5) 两站 Release + 附件')
    const npmStepAt = source.indexOf('6) npm 发布')

    expect(tagGateAt, 'release.sh 里找不到 tag 就位检查').toBeGreaterThan(-1)
    expect(releaseStepAt, 'release.sh 里找不到第 5 步').toBeGreaterThan(-1)
    expect(npmStepAt, 'release.sh 里找不到第 6 步').toBeGreaterThan(-1)
    // 闸门必须在 Release 之前 —— Release 引用的是 tag_name，
    // 远端没有这个 tag 时 Release 接口照样会建成功。
    expect(tagGateAt).toBeLessThan(releaseStepAt)
    expect(tagGateAt).toBeLessThan(npmStepAt)
  })
})
