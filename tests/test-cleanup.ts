import { rm } from 'node:fs/promises'
import type { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 测试清理助手：让「先关库、再删目录」这件事**只有一个写法**。
 *
 * ## 为什么需要它
 *
 * `WorkspaceDatabase` 用 `PRAGMA journal_mode=WAL` 打开 sqlite，会留下
 * `workspace.sqlite` / `-wal` / `-shm` 三个文件，**句柄不关就删不掉**。
 * Linux/macOS 上删一个仍被打开的文件是允许的（unlink 只断链），所以问题在
 * Linux/macOS 上看不出来；**Windows 上直接 EBUSY**：
 *
 * ```
 * EBUSY: resource busy or locked, unlink 'C:\\...\\Temp\\daw-xxx\\state\\workspace.sqlite'
 * ```
 *
 * 2026-10-20 CI 在 windows-latest 上实锤（macOS/Linux 全绿、Windows 全红）。
 *
 * ## 用法
 *
 * ```ts
 * const cleanup = new TestCleanup()
 * afterEach(() => cleanup.dispose())
 *
 * const base = await cleanup.dir()          // 造临时目录
 * const db = cleanup.open(path.join(base, 'state'))  // 开库并登记
 * ```
 *
 * `dispose()` 幂等：先关所有登记过的库，再删所有登记过的目录；
 * 清理失败**不抛**（那是环境问题，不该把测试判红）。
 */
export class TestCleanup {
  private readonly dirs: string[] = []
  private readonly dbs: WorkspaceDatabase[] = []

  /** 登记一个（或几个）要删的目录。 */
  dir(...targets: string[]): string {
    for (const target of targets) this.dirs.push(target)
    return targets[0] as string
  }

  /** 登记一个开了的库（会在删目录之前被关闭）。 */
  db(target: WorkspaceDatabase): WorkspaceDatabase {
    this.dbs.push(target)
    return target
  }

  /** 关库 + 删目录。可反复调用。 */
  async dispose(): Promise<void> {
    for (const db of this.dbs.splice(0)) {
      try {
        db.close()
      } catch {
        // 已经关过：忽略。
      }
    }
    for (const target of this.dirs.splice(0)) {
      try {
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // 清理失败不该让测试判红（环境问题 ≠ 功能问题）。
      }
    }
  }
}
