import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 在**生产库的真实副本**上演练「清理历史标记式撤销设备」。
 *
 * 这是一次性动作，但只在真机上做才有意义：本机库里堆了 32 条已撤销设备，全是历史测试
 * 探针和早已弃用的旧手机。单测用的是自己造的临时库，删不掉「外键链」「审计留痕」这些
 * 只有真实数据才会暴露的问题。
 *
 * 只读副本，绝不动生产库。
 */

const SOURCE = path.join(process.env.HOME ?? '/root', '.dsh', 'dsh-workspace', 'workspace.sqlite')

/**
 * 这套演练**按设计**跑在生产库的真实副本上（理由见文件头注释：表重建有真实外键风险，
 * 单测用的是我们自己造的临时库，结构与真实那份不同）。
 *
 * CI runner 上没有 `~/.dsh/dsh-workspace/workspace.sqlite` —— 那不是失败，是**环境没有**
 * 可供演练的真实库。红着会让 CI 永远失败，久而久之就没人看 CI 了
 * （永远红 的门禁比没有门禁更坏：它教会人忽略红灯）。
 *
 * 所以：生产库不在就**跳过**并说清原因；在就真跑一遍。
 */
const hasRealDatabase = existsSync(SOURCE)
const DRILL_DIR = path.join(process.cwd(), '.local-backup', 'purge-drill')

function copyProduction(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${SOURCE}${suffix}`
    if (existsSync(from)) copyFileSync(from, path.join(targetDir, `workspace.sqlite${suffix}`))
  }
}

describe.skipIf(!hasRealDatabase)('purging revoked devices on a copy of the real production database', () => {
  it('deletes every stale row and leaves the audit trail and active devices intact', () => {
    const dir = path.join(DRILL_DIR, 'purge')
    rmSync(dir, { recursive: true, force: true })
    copyProduction(dir)

    const raw = new DatabaseSync(path.join(dir, 'workspace.sqlite'))
    const grantsBefore = raw.prepare('SELECT COUNT(*) c FROM device_roots').get() as { c: number }
    const auditsBefore = raw.prepare('SELECT COUNT(*) c FROM audit').get() as { c: number }
    raw.close()

    // 真实库里那 32 条已经在上次重启时清掉了（这正是这条演练要验的效果生效过）。
    // 为了让演练**仍然有东西可测**，在副本里自己造一批历史脏数据：模拟「撤销改成删除
    // 之前」那种只打标记的旧设备。用裸 SQLite 造，避免走生产代码路径。
    //
    // 早先这里断言「真实库里必须还有脏数据」，结果清理一跑成功它就开始红 ——
    // 那是**前提被自己的成果推翻了**，不是回归。测「清理是否有效」不该依赖「脏数据还在」。
    const seed = new DatabaseSync(path.join(dir, 'workspace.sqlite'))
    const seeded = 3
    for (let i = 0; i < seeded; i += 1) {
      seed.prepare('INSERT INTO devices(id,name,token_hash,scopes_json,created_at,revoked_at) VALUES(?,?,?,?,?,?)')
        .run(`stale-${i}`, `旧设备 ${i}`, `hash-${i}`, JSON.stringify(['chat.read']), Date.now(), Date.now())
    }
    seed.close()

    const database = new WorkspaceDatabase(dir)
    try {
      // 只数**本测试插入的那批**。真实库里可能已经有活跃设备（重启后重新配对过），
      // 早先这里断言「一台都没有」，于是每次用户真去配一次设备它就红一次 ——
      // 那是把「用户的正常使用」误判成回归。
      const activeBefore = database.listDevices()
      expect(activeBefore.some(device => device.id.startsWith('stale-'))).toBe(false)

      const purged = database.purgeRevokedDevices()
      expect(purged).toBe(seeded)
      expect(database.purgeRevokedDevices()).toBe(0) // 幂等

      const after = new DatabaseSync(path.join(dir, 'workspace.sqlite'))
      try {
        // 插入的那批没了；真实库里原有的活跃设备一根汗毛都没掉。
        expect((after.prepare("SELECT COUNT(*) c FROM devices WHERE id LIKE 'stale-%'").get() as { c: number }).c).toBe(0)
        expect((after.prepare('SELECT COUNT(*) c FROM devices').get() as { c: number }).c).toBe(activeBefore.length)
        // 授权行跟着 CASCADE 走了。
        expect((after.prepare('SELECT COUNT(*) c FROM device_roots').get() as { c: number }).c)
          .toBeLessThanOrEqual(grantsBefore.c)
        // 审计一条不少 —— 删的是设备，不是「谁撤了谁」这段历史。
        expect((after.prepare('SELECT COUNT(*) c FROM audit').get() as { c: number }).c)
          .toBeGreaterThan(auditsBefore.c)
        // 本次清理留下了汇总审计。
        // 注意：真实副本里可能**已经有**一条 `device.purge` —— 因为上次重启时清理真的
        // 跑过。所以断言「至少一条」而不是「恰一条」，否则这个测试会在清理成功之后变红。
        expect((after.prepare("SELECT COUNT(*) c FROM audit WHERE action = 'device.purge'").get() as { c: number }).c)
          .toBeGreaterThanOrEqual(1)
      } finally {
        after.close()
      }
    } finally {
      database.close()
    }
  })
})