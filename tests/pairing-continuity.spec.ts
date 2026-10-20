import {mkdir, mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 「插件每次启动自动登记一次」会不会逼用户重新配对？
 *
 * 这是用户直接提出的担心，所以钉成测试而不是口头保证。要证明的是两件事，**分开的**：
 *
 * 1. **既有设备不会失效** —— 令牌还在 `devices` 里，`device_roots` 没被动过，
 *    `authenticate` 照样认。这是「会不会被要求重新扫码」的直接答案。
 * 2. **新登记的根默认不给已配对设备授权** —— 这不是 bug，是 `device_roots` 的语义：
 *    授权是配对那一刻的**快照**。但它是用户可能撞上的事实，必须写进文档和提示，
 *    不能让人自己发现「手机里看不到那个目录」。
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

describe('the built-in root never invalidates existing pairings', () => {
  it('keeps an already paired device authenticated across plugin restarts', async () => {
    const base = await scratch('pairing-survives')
    const workspace = path.join(base, 'workspace')
    const shared = path.join(base, 'shared')
    await mkdir(workspace)
    await mkdir(shared)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      // 手机先配对一次，授权的是当时存在的那个根。
      const existing = await database.addRoot(shared, 'Shared')
      const pairing = database.createPairing([existing.id], ['files.read', 'chat.read'])
      const exchanged = database.exchangePairing(pairing.code, '我的手机')
      const token = exchanged.token

      // 插件重启：自动登记工作区（全新的一条根）。
      await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      // 再重启两次，证明是幂等的，不是「第一次侥幸没坏」。
      await database.ensureBuiltinRoot(workspace, 'DSH 工作区')
      await database.ensureBuiltinRoot(workspace, 'DSH 工作区')

      // 核心断言：令牌照样有效 —— 用户不需要重新扫码。
      const still = database.authenticate(token)
      expect(still).toBeDefined()
      expect(still?.id).toBe(exchanged.device.id)
      expect(still?.name).toBe('我的手机')
      // 原有授权一条没少。
      expect(still?.rootIds).toEqual([existing.id])
      // 老根依然可删。
      expect(() => database.removeRoot(existing.id)).not.toThrow()
    } finally {
      database.close()
    }
  })

  it('does not silently grant the new root to already paired devices', async () => {
    const base = await scratch('pairing-snapshot')
    const workspace = path.join(base, 'workspace')
    const shared = path.join(base, 'shared')
    await mkdir(workspace)
    await mkdir(shared)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const existing = await database.addRoot(shared, 'Shared')
      const pairing = database.createPairing([existing.id], ['files.read'])
      const exchanged = database.exchangePairing(pairing.code, '我的手机')
      await database.ensureBuiltinRoot(workspace, 'DSH 工作区')

      const builtin = database.listRoots().find(root => root.builtin === true)
      expect(builtin).toBeDefined()

      // `device_roots` 是配对那一刻的快照，所以新根**不会**自动授权给老设备。
      // 这是安全侧的默认（不给就等于不给），但用户必须知道，否则会以为功能坏了。
      const authenticated = database.authenticate(exchanged.token)
      expect(authenticated?.rootIds).toEqual([existing.id])
      expect(authenticated?.rootIds).not.toContain(builtin!.id)
    } finally {
      database.close()
    }
  })
})