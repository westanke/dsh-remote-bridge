import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 测试用的临时库夹具。
 *
 * ## 为什么需要它
 *
 * `WorkspaceDatabase` 用 `PRAGMA journal_mode=WAL` 打开 sqlite，会留下
 * `workspace.sqlite` / `-wal` / `-shm` 三个文件，**且句柄不关就删不掉**。
 *
 * 在 Linux/macOS 上删一个仍被打开的文件是允许的（unlink 只是断链），
 * 所以测试里「造库 → 删临时目录」一直没暴露问题；**Windows 上直接 EBUSY**：
 *
 * ```
 * EBUSY: resource busy or locked, unlink 'C:\...\Temp\daw-image-xxx\state\workspace.sqlite'
 * ```
 *
 * 2026-10-20 CI 在 windows-latest 上实锤（macOS/Linux 全绿，Windows 全红）。
 *
 * ## 正确用法
 *
 * ```ts
 * const tmp = new TempDatabase()
 * afterEach(() => tmp.dispose())   // 先 close 再删
 * const db = tmp.open()             // 每次一个独立库
 * ```
 *
 * `dispose()` 是**幂等**的，且会吞掉删除失败 —— 清理失败不该把测试判红
 * （那会把「环境清理问题」误报成「功能坏了」）。
 */
export class TempDatabase {
  private readonly roots: string[] = []
  private readonly opened = new Set<WorkspaceDatabase>()

  /** 造一个新的临时库目录（调用方自己决定放什么进去）。 */
  async dir(prefix = 'daw-tmp-'): Promise<string> {
    const base = await mkdtemp(path.join(os.tmpdir(), prefix))
    this.roots.push(base)
    return base
  }

  /** 在临时目录里开一个库；close 由 [dispose] 统一负责。 */
  open(dir: string, name = 'state'): WorkspaceDatabase {
    const db = new WorkspaceDatabase(path.join(dir, name))
    this.opened.add(db)
    return db
  }

  /** 登记一个已存在的库（用于那些自己 new 的场景）。 */
  track(db: WorkspaceDatabase): WorkspaceDatabase {
    this.opened.add(db)
    return db
  }

  /** 关闭所有库并删除所有临时目录。可反复调用。 */
  async dispose(): Promise<void> {
    for (const db of this.opened) {
      try {
        db.close()
      } catch {
        // 已关闭或关不掉：不影响清理，继续删目录。
      }
    }
    this.opened.clear()
    for (const target of this.roots.splice(0)) {
      try {
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        // 清理失败不该让测试判红（那是环境问题，不是功能问题）。
      }
    }
  }
}
