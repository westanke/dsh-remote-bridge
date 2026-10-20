import {mkdir, mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 拿**这台机器真实**的 DSH 工作区数据跑一遍登记流程。
 *
 * 为什么要引真实文件而不是造个假路径：这套逻辑整条依赖「注册表返回的第一个工作区
 * 就是用户当前的工作目录」这个前提。前提要是错了，单元测试照样全绿，真机上就是
 * 设��里冒出一条指向别处的根 —— 而根目录配错的后果是手机能看见不该看见的东西。
 *
 * 读的是 `~/.dsh/storages/workspace.json`（DSH 的权威持久化），写进**临时副本库**，
 * 绝不碰 `~/.dsh/dsh-workspace/` 里的生产库。
 */

const REGISTRY = path.join(process.env.HOME ?? '/root', '.dsh', 'storages', 'workspace.json')

/**
 * 这套测试**按设计**读本机真实数据（理由见文件头注释：整套登记逻辑依赖
 * 「注册表返回的第一个工作区就是用户当前的工作目录」这个前提，造假路径测不到它）。
 *
 * 但 CI runner 上没有 `~/.dsh/storages/workspace.json` —— 这不是失败，是**环境没有**
 * 可供测的真实数据。红着会让 CI 永远失败，久而久之就没人看 CI 了（这正是
 * 「flaky/永远红 的门禁比没有门禁更坏」）。
 *
 * 所以：文件不存在就**跳过**并说清原因；存在就真跑。
 */
const hasRealRegistry = existsSync(REGISTRY)

interface RegistryFile {
  global?: { workspaceIds?: string[] }
  tables?: { workspaces?: Record<string, { path: string; title: string }> }
}

function readRealWorkspaces(): { path: string; title: string }[] {
  const file = JSON.parse(readFileSync(REGISTRY, 'utf8')) as RegistryFile
  const ids = file.global?.workspaceIds ?? []
  const table = file.tables?.workspaces ?? {}
  return ids.flatMap(id => (table[id] === undefined ? [] : [table[id]!]))
}

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe.skipIf(!hasRealRegistry)('the real DSH workspace on this machine', () => {
  it('registers the first workspace as the default authorized root', async () => {
    const workspaces = readRealWorkspaces()
    expect(workspaces.length).toBeGreaterThan(0)

    const container = path.join(process.cwd(), '.local-backup', 'test-tmp')
    await mkdir(container, { recursive: true })
    const base = await mkdtemp(path.join(container, 'real-'))
    cleanup.dir(base)

    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      // 与 `registerBuiltinWorkspaceRoot` 完全一致的两个前置判据。
      const workspace = workspaces[0]!
      const info = await import('node:fs/promises').then(fs => fs.stat(workspace.path))
      expect(info.isDirectory(), `工作区路径应真实存在：${workspace.path}`).toBe(true)

      const root = await database.ensureBuiltinRoot(workspace.path, workspace.title || 'DSH 工作区')
      expect(root?.builtin).toBe(true)
      expect(root?.realPath).toBe(workspace.path)
      // 标签沿用 DSH 给工作区起的名字，界面上看得出它是哪个。
      expect(root?.label).toBe(workspace.title)

      // 再跑一次模拟插件重启：不得插出第二条。
      await database.ensureBuiltinRoot(workspace.path, workspace.title || 'DSH 工作区')
      expect(database.listRoots()).toHaveLength(1)
    } finally {
      database.close()
    }
  })
})