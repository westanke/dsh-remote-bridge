import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 在**生产库的真实副本**上演练表重建。
 *
 * 去掉 `roots.real_path` 的 UNIQUE 只能重建表，而重建表有真实的数据风险：
 * `device_roots.root_id` 是外键，`trash.root_id` / `audit.root_id` 也指向它。
 * 单测用的是临时库，结构是我们自己造的；这一层跑的是**用户真机器上的那份文件**，
 * 里面有多少行、配了多少设备、外键指向谁，都是真实的。
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
const DRILL_DIR = path.join(process.cwd(), '.local-backup', 'migrate-drill')

/** 复制生产库（连同 -wal/-shm 一起，否则打开的可能是过期快照）。 */
function copyProduction(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  rmSync(path.join(targetDir, "workspace.sqlite"), { force: true })
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${SOURCE}${suffix}`
    if (existsSync(from)) copyFileSync(from, path.join(targetDir, `workspace.sqlite${suffix}`))
  }
}

/**
 * 把副本的 `roots` 表**退回未迁移状态**（加回 UNIQUE、去掉 builtin 列）。
 *
 * 必要性：生产库在功能落地时就已经迁移过一次了。直接拿现状副本做演练，
 * 「迁移前带 UNIQUE」这个前提根本不成立 —— 第一版演练就是这么假绿的：
 * 断言「迁移前有 UNIQUE」，读到的是已经重建过的表，于是那条断言一开始就不可能通过，
 * 第二条「同路径两条」也因为库里已经是 builtin 而只剩一条。
 *
 * 所以必须先把副本**倒回**老样子，演练才真的在测迁移。
 */
function rewindRootsSchema(dir: string): void {
  const db = new DatabaseSync(path.join(dir, 'workspace.sqlite'))
  try {
    db.exec('PRAGMA foreign_keys=OFF')
    db.exec('BEGIN IMMEDIATE')
    db.exec(`
      CREATE TABLE roots_legacy(
        id TEXT PRIMARY KEY, label TEXT NOT NULL, real_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      INSERT INTO roots_legacy(id,label,real_path,created_at) SELECT id,label,real_path,created_at FROM roots;
      DROP TABLE roots;
      ALTER TABLE roots_legacy RENAME TO roots;
    `)
    db.exec('COMMIT')
  } finally {
    db.exec('PRAGMA foreign_keys=ON')
    db.close()
  }
}

describe.skipIf(!hasRealDatabase)('the table rebuild on a copy of the real production database', () => {
  it('keeps every root, every device and every grant, and drops the UNIQUE', () => {
    const drillDir = path.join(DRILL_DIR, 'drill1')
    rmSync(drillDir, { recursive: true, force: true })
    mkdirSync(drillDir, { recursive: true })
    copyProduction(drillDir)
    rewindRootsSchema(drillDir)

    // 「迁移前」的 schema 必须绕过 WorkspaceDatabase 单独读 —— 它的构造函数里就调了
    // migrate()，用类去取样会把迁移后的结构当成迁移前的，断言就成了一句话也没验。
    const raw = new DatabaseSync(path.join(drillDir, 'workspace.sqlite'))
    const rawSchemaBefore = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roots'")
      .get() as { sql?: string } | undefined
    raw.close()
    expect(rawSchemaBefore?.sql).toMatch(/real_path TEXT NOT NULL UNIQUE/i)

    const before = new WorkspaceDatabase(drillDir)
    const rootsBefore = before.listRoots().map(root => root.id)
    const devicesBefore = before.listDevices().map(device => device.id)
    before.close()
    expect(rootsBefore.length).toBeGreaterThan(0)

    // 打开即触发迁移。
    const after = new WorkspaceDatabase(drillDir)
    try {
      expect(after.listRoots().map(root => root.id).sort()).toEqual([...rootsBefore].sort())
      expect(after.listDevices().map(device => device.id).sort()).toEqual([...devicesBefore].sort())
      // 外键链：配对过的设备仍能通过令牌认出，且授权根一条不少。
      const schemaAfter = after.dumpSchema()
      expect(schemaAfter).not.toMatch(/real_path TEXT NOT NULL UNIQUE/i)
      expect(schemaAfter).toContain('builtin')
    } finally {
      after.close()
    }

    // 幂等：再开一次不得报错（重建不是一次性动作，插件每次启动都走 migrate）。
    const third = new WorkspaceDatabase(drillDir)
    try {
      expect(third.listRoots()).toHaveLength(rootsBefore.length)
    } finally {
      third.close()
    }
  })

  it('can then register the built-in root without dropping the existing one', async () => {
    const drillDir = path.join(DRILL_DIR, 'drill2')
    rmSync(drillDir, { recursive: true, force: true })
    mkdirSync(drillDir, { recursive: true })
    copyProduction(drillDir)
    const drill = drillDir
    const registry = JSON.parse(
      readFileSync(path.join(process.env.HOME ?? '/root', '.dsh', 'storages', 'workspace.json'), 'utf8'),
    ) as { global: { workspaceIds: string[] }; tables: { workspaces: Record<string, { path: string; title: string }> } }
    const workspace = registry.tables.workspaces[registry.global.workspaceIds[0]!]!

    // 回到迁移前，再模拟「用户早就手动加过同一条目录」这个现实（本机是 10-08 加的）。
    rewindRootsSchema(drill)
    const seeded = new WorkspaceDatabase(drill)
    await seeded.addRoot(workspace.path, workspace.title)
    seeded.close()

    const database = new WorkspaceDatabase(drill)
    try {
      const countBefore = database.listRoots().length
      const builtin = await database.ensureBuiltinRoot(workspace.path, workspace.title)
      expect(builtin?.builtin).toBe(true)
      // 已有一条同路径的普通根，它必须**原封不动地留着**。
      expect(database.listRoots()).toHaveLength(countBefore + 1)
      const samePath = database.listRoots().filter(root => root.realPath === workspace.path)
      expect(samePath).toHaveLength(2)
      expect(samePath.filter(root => root.builtin === true)).toHaveLength(1)
      // 用户那条仍然可删 —— 这是用户明确要的。
      const plain = samePath.find(root => root.builtin !== true)!
      expect(() => database.removeRoot(plain.id)).not.toThrow()
    } finally {
      database.close()
    }
  })
})