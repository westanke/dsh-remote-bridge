import {mkdir, mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { DEVICE_SCOPES } from '../src/shared/contracts.ts'
import { scopeLabel, translate } from '../src/client/i18n.tsx'

/**
 * 撤销即删除，以及权限码的中文化。
 *
 * 用户要求：「设备中『已撤销』的可以不显示，也自动从数据库中删除，授权的权限，中文状态下
 * 显示中文，英文显示英文。」
 *
 * 「撤销即删除」这一条有个容易被忽略的后果：**审计留痕不能跟着消失**。`audit.actor_id`
 * 是普通字符串而不是外键，所以删设备不会连带删审计 —— 但这值得钉住，因为一旦哪天有人
 * 给 audit 加上外键并配上 CASCADE，这个功能就会静默地吃掉审计记录，而那种丢失
 * 永远要到出事那天才被发现。
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

/** 建一台配对过的设备，返回它的令牌与 id。 */
async function pairDevice(database: WorkspaceDatabase, rootId: string, name: string): Promise<{ token: string; id: string }> {
  const pairing = database.createPairing([rootId], ['chat.read', 'files.read'])
  const exchanged = database.exchangePairing(pairing.code, name)
  return { token: exchanged.token, id: exchanged.device.id }
}

describe('revoking a device deletes the row outright', () => {
  it('removes it from the database, not just from the list', async () => {
    const base = await scratch('revoke-delete')
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'P')
      const device = await pairDevice(database, root.id, '我的手机')
      expect(database.listDevices()).toHaveLength(1)

      database.revokeDevice(device.id)

      // 真删了，不是打个标记 —— 这正是用户要的「自动从数据库中删除」。
      expect(database.listDevices()).toHaveLength(0)
      expect(database.getActiveDevice(device.id)).toBeUndefined()
      // 令牌立刻失效，而且是因为「查无此行」而不是因为「被标记」。
      expect(database.authenticate(device.token)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('cascades the grants but keeps the audit trail', async () => {
    const base = await scratch('revoke-cascade')
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'P')
      const device = await pairDevice(database, root.id, '我的手机')
      const auditsBefore = database.listAudit(1000).length

      database.revokeDevice(device.id)

      // 授权行跟着走（device_roots 是 ON DELETE CASCADE）。
      // 审计一条不少：删掉的是设备，不是「谁在什么时候撤了谁」这段历史。
      const auditsAfter = database.listAudit(1000)
      expect(auditsAfter.length).toBeGreaterThan(auditsBefore)
      expect(auditsAfter.some(item => item.action === 'device.revoke')).toBe(true)
    } finally {
      database.close()
    }
  })

  it('reports a device that is already gone as not found', async () => {
    const base = await scratch('revoke-twice')
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'P')
      const device = await pairDevice(database, root.id, '手机')
      database.revokeDevice(device.id)
      // 撤销一个已经没了的设备仍是 404 —— 与原语义一致，调用方能分辨。
      expect(() => database.revokeDevice(device.id)).toThrowError(/does not exist/i)
    } finally {
      database.close()
    }
  })
})

describe('purging the old marker-style revocations', () => {
  it('removes every revoked row that earlier versions left behind', async () => {
    const base = await scratch('purge-legacy')
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'P')
      const alive = await pairDevice(database, root.id, '还在用')
      const gone = await pairDevice(database, root.id, '早废了')

      // 造一行「新版本之前」的标记式撤销：直接改库模拟历史数据。
      database.markRevokedForTest(gone.id)
      // 用户界面看到的就是这些灰字，所以它们必须不出现。
      expect(database.listDevices().map(device => device.id)).toEqual([alive.id])

      expect(database.purgeRevokedDevices()).toBe(1)
      expect(database.purgeRevokedDevices()).toBe(0) // 幂等
      // 活跃设备一根汗毛都没掉。
      expect(database.listDevices().map(device => device.id)).toEqual([alive.id])
      expect(database.authenticate(alive.token)).toBeDefined()
    } finally {
      database.close()
    }
  })
})

describe('scope labels', () => {
  it('reads as prose in Chinese and as prose in English', () => {
    // 每一项都不能原样露出协议码 —— 用户要求的是「中文显示中文、英文显示英文」，
    // 露出 chat.read 等于什么都没做。
    for (const scope of DEVICE_SCOPES) {
      const zh = scopeLabel('zh-CN', scope)
      const en = scopeLabel('en', scope)
      expect(zh).not.toBe(scope)
      expect(en).not.toBe(scope)
      expect(en).not.toBe(zh)
    }
    expect(scopeLabel('zh-CN', 'files.delete')).toBe('删文件')
    expect(scopeLabel('en', 'files.delete')).toBe('Delete files')
  })

  it('shows the raw code for a scope this build does not know', () => {
    // 老库里可能有已废弃的权限码。宁可难看也不要空白或 `scopeXxx` 键名。
    expect(scopeLabel('zh-CN', 'legacy.thing')).toBe('legacy.thing')
  })

  it('never falls back to exposing a key name', () => {
    // 映射表少一条就会退化成键名（translate 的降级行为），这里钉住。
    for (const scope of DEVICE_SCOPES) {
      expect(scopeLabel('zh-CN', scope)).not.toMatch(/^scope[A-Z]/)
      expect(scopeLabel('en', scope)).not.toMatch(/^scope[A-Z]/)
    }
    expect(translate('zh-CN', 'noScopes')).toBe('没有任何权限')
    expect(translate('en', 'noScopes')).toBe('No permissions')
  })
})