import {mkdir, mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 内置授权根（「DSH 工作区」那条）的行为。
 *
 * 用户要求：默认把当前 DSH 的工作目录显示成一个授权根，**不可删除、但可以正常访问**。
 * 这三件事各有各的失败方式，所以分开钉：
 * - 幂等：插件每次启动都调一次，重复登记会插出第二条；
 * - 不可删：只有界面不给按钮是不够的，服务端也必须拦（API 可能被别处调用）；
 * - 可访问：它是**普通的**一条根，手机端照常浏览，不另起一套特例。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

/**
 * 临时目录放在工作区下而不是 `os.tmpdir()` —— 用户明令禁用 /tmp。
 * 用例之间靠随机后缀隔离，不需要跨进程唯一。
 */
async function scratch(prefix: string): Promise<string> {
  const container = path.join(process.cwd(), '.local-backup', 'test-tmp')
  await mkdir(container, { recursive: true })
  const base = path.join(container, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(base, { recursive: true })
  cleanup.dir(base)
  return base
}

describe('built-in workspace root', () => {
  it('registers the workspace once, however many times it is asked', async () => {
    const base = await scratch('builtin-idempotent')
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const first = await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      expect(first?.builtin).toBe(true)

      // 插件每次启动都会调一次，重复调用必须完全无副作用。
      const second = await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      const third = await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      expect(second?.id).toBe(first?.id)
      expect(third?.id).toBe(first?.id)
      expect(database.listRoots()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('refuses to remove it, while ordinary roots still delete', async () => {
    const base = await scratch('builtin-protected')
    const workspace = path.join(base, 'workspace')
    const own = path.join(base, 'own')
    await mkdir(workspace)
    await mkdir(own)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const builtin = await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      const added = await database.addRoot(own, 'Mine')
      expect(added.builtin).toBeUndefined()

      // 服务端这一道闸是真正的防线：界面不给按钮不代表 API 不会被直接调。
      expect(() => database.removeRoot(builtin!.id)).toThrowError(/cannot be removed/i)
      expect(database.listRoots()).toHaveLength(2)

      // 普通根不受影响 —— 否则这条保护就变成了「谁都不敢删东西」。
      database.removeRoot(added.id)
      expect(database.listRoots().map(root => root.id)).toEqual([builtin!.id])
    } finally {
      database.close()
    }
  })

  it('stays an ordinary root: it pairs and authorizes like any other', async () => {
    const base = await scratch('builtin-usable')
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const builtin = await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      const pairing = database.createPairing([builtin!.id], ['files.read', 'chat.read'])
      const exchanged = database.exchangePairing(pairing.code, 'Phone')
      const authenticated = database.authenticate(exchanged.token)
      // 「不可删除」不等于「不可访问」——用户要的是默认就有、照常用。
      expect(authenticated?.rootIds).toEqual([builtin!.id])
      expect(authenticated?.scopes).toEqual(['files.read', 'chat.read'])
    } finally {
      database.close()
    }
  })

  it('never touches the record the user added by hand', async () => {
    const base = await scratch('builtin-respect-user')
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const mine = await database.addRoot(workspace, '我加的')
      await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      // 内置登记**不得就地改**用户那条：把它变成 builtin 就等于让「我自己加的根」
      // 突然不能删。正确做法是另起一条（见 builtin-coexist.spec.ts）。
      expect(database.getRoot(mine.id)?.builtin).toBeUndefined()
      expect(database.removeRoot(mine.id)).toBeUndefined()
      expect(database.getRoot(mine.id)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('lists the built-in root first so it reads as the default', async () => {
    const base = await scratch('builtin-first')
    const workspace = path.join(base, 'workspace')
    const other = path.join(base, 'other')
    await mkdir(workspace)
    await mkdir(other)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      await database.addRoot(other, '先加的')
      await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      // 「默认」要在第一条，否则用户得自己找哪条是默认。
      expect(database.listRoots()[0]?.builtin).toBe(true)
    } finally {
      database.close()
    }
  })
})

describe('roots migration', () => {
  it('adds the builtin column to a database created before it existed', async () => {
    const base = await scratch('builtin-migrate')
    const state = path.join(base, 'state')
    await mkdir(state, { recursive: true })
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace)

    // 手工造一张「旧版」表：没有 builtin 列，模拟已经装过的机器。
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(path.join(state, 'workspace.sqlite'))
    legacy.exec('CREATE TABLE roots(id TEXT PRIMARY KEY, label TEXT NOT NULL, real_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)')
    legacy.prepare('INSERT INTO roots(id,label,real_path,created_at) VALUES(?,?,?,?)')
      .run('legacy-1', '老的根', workspace, Date.now())
    legacy.close()

    const database = cleanup.db(new WorkspaceDatabase(state))
    // 老行必须读成「非内置」，不能因为列默认值而凭空变成不可删。
    expect(database.getRoot('legacy-1')?.builtin).toBeUndefined()
    database.close()

    // 迁移可重跑：插件每次启动都走一次 migrate，第二次不能再报 duplicate column。
    const reopened = cleanup.db(new WorkspaceDatabase(state))
    try {
      expect(reopened.listRoots()).toHaveLength(1)
      expect(reopened.getRoot('legacy-1')?.builtin).toBeUndefined()
    } finally {
      reopened.close()
    }
  })
})