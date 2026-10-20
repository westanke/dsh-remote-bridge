import {mkdir, mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 「DSH 工作区」与用户自己加的同目录根**并存**。
 *
 * 用户明确要：内置那条不可删除，但**他原来加的那条保持可删**。这两条指向同一个
 * 目录，所以 `roots.real_path` 上的 UNIQUE 约束必须去掉 —— 不去掉根本插不进第二条。
 *
 * SQLite 去约束只能**重建表**（没有 `ALTER TABLE … DROP CONSTRAINT`），所以这一步
 * 有真实的数据风险，必须单独钉住：
 * - 重建过程中不能丢行（devices / device_roots 的外键都指向 roots.id）；
 * - 重建后 UNIQUE 真的没了，否则下一条同路径的登记仍然插不进去；
 * - 手工加的根仍然可删（这次的起因就是它被误当成内置的）。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

async function scratch(prefix: string): Promise<string> {
  const container = path.join(process.cwd(), '.local-backup', 'test-tmp')
  await mkdir(container, { recursive: true })
  const base = await mkdtemp(path.join(container, `${prefix}-`))
  cleanup.dir(base)
  return base
}

describe('the built-in root coexists with a hand-added root for the same path', () => {
  it('adds a separate undeletable entry while the original stays deletable', async () => {
    const base = await scratch('builtin-coexist')
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      // 用户先手动加了这个目录 —— 现实里就是这样（本机那条是 10-08 加的）。
      const mine = await database.addRoot(workspace, 'workspace')
      expect(mine.builtin).toBeUndefined()

      // 内置登记撞上同一路径：不能复用（会把用户那条变成不可删），要另起一条。
      const builtin = await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      expect(builtin?.id).not.toBe(mine.id)
      expect(builtin?.builtin).toBe(true)
      expect(database.listRoots()).toHaveLength(2)

      // 用户那条照常可删 —— 这是用户明确要的。
      expect(() => database.removeRoot(mine.id)).not.toThrow()
      // 内置那条拦得住。
      expect(() => database.removeRoot(builtin!.id)).toThrowError(/cannot be removed/i)
      expect(database.listRoots()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('does not accumulate entries across restarts', async () => {
    const base = await scratch('builtin-coexist-idem')
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      await database.addRoot(workspace, 'workspace')
      const first = await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      for (let i = 0; i < 3; i += 1) await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      // 去重靠的是「已存在 builtin=1 的同路径就返回」，不是靠 UNIQUE（它已经被去掉了）。
      const builtins = database.listRoots().filter(root => root.builtin === true)
      expect(builtins).toHaveLength(1)
      expect(builtins[0]?.id).toBe(first?.id)
    } finally {
      database.close()
    }
  })

  it('keeps every row and the foreign keys alive across the schema rebuild', async () => {
    const base = await scratch('builtin-migrate-keep')
    const workspace = path.join(base, 'workspace')
    const other = path.join(base, 'other')
    await mkdir(workspace)
    await mkdir(other)
    const state = path.join(base, 'state')
    const database = cleanup.db(new WorkspaceDatabase(state))
    const kept = await database.addRoot(workspace, 'workspace')
    const otherRoot = await database.addRoot(other, 'other')
    const pairing = database.createPairing([kept.id, otherRoot.id], ['files.read'])
    const exchanged = database.exchangePairing(pairing.code, '手机')
    database.close()

    // 重建发生在 reopen 里：老库带着 UNIQUE 且没有 builtin 列，靠 migrate() 升级。
    const reopened = cleanup.db(new WorkspaceDatabase(state))
    try {
      expect(reopened.listRoots().map(root => root.id).sort())
        .toEqual([kept.id, otherRoot.id].sort())
      // device_roots 是外键：重建表最容易在这里丢东西，必须验。
      expect(reopened.authenticate(exchanged.token)?.rootIds.sort())
        .toEqual([kept.id, otherRoot.id].sort())
    } finally {
      reopened.close()
    }
  })
})