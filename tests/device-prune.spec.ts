import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * 一键清理「N 天未使用设备」。
 *
 * 用户的原话是「已配对设置 加一个 一键清理多少天未使用设备」，所以口径定在
 * **最后使用时间**：`last_seen_at`（每次令牌认证成功刷新），从没认证过的退回
 * `created_at` —— 否则「配好就再没开过」的那类设备永远清不掉，而它们恰恰是最该被清的。
 *
 * 这四条断言钉的是「语义边界」而不是实现细节：
 * - 老设备被清、新设备保留（否则一键清理等于「清空所有设备」）；
 * - 从没认证过但创建很久的设备也要能被清（COALESCE 那一半）；
 * - 天数被夹在 1..3650（传 0 / 负数不能变成清库）；
 * - 清理留一条汇总审计（谁在什么时候清了几个，事后能查）。
 */

const cleanup = new TestCleanup()
afterEach(async () => { await cleanup.dispose() })

const DAY = 24 * 60 * 60 * 1000

async function openDatabase(): Promise<{ database: WorkspaceDatabase; base: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dsh-prune-'))
  cleanup.dir(base)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  return { database, base }
}

/** 造一台已配对的设备，返回它的 id。 */
function pairDevice(database: WorkspaceDatabase, name: string): string {
  const pairing = database.createPairing([], ['chat.read'])
  const exchanged = database.exchangePairing(pairing.code, name)
  return exchanged.device.id
}

describe('prune inactive devices', () => {
  it('removes devices unused for longer than the window and keeps the recent one', async () => {
    const { database } = await openDatabase()
    try {
      const stale = pairDevice(database, 'old-phone')
      const fresh = pairDevice(database, 'current-phone')
      database.backdateDeviceForTest(stale, { lastSeenAt: Date.now() - 40 * DAY })

      expect(database.pruneInactiveDevices(30)).toBe(1)
      expect(database.listDevices().map(device => device.id)).toEqual([fresh])
      expect(database.listDevices().map(device => device.name)).toEqual(['current-phone'])
    } finally {
      database.close()
    }
  })

  it('also prunes devices that never authenticated, by their creation time', async () => {
    const { database } = await openDatabase()
    try {
      const never = pairDevice(database, 'never-used')
      const recent = pairDevice(database, 'recent')
      // 从没认证过 = last_seen_at 仍是 NULL，只能靠 created_at 判断。
      database.backdateDeviceForTest(never, { createdAt: Date.now() - 90 * DAY })

      expect(database.pruneInactiveDevices(30)).toBe(1)
      expect(database.listDevices().map(device => device.id)).toEqual([recent])
    } finally {
      database.close()
    }
  })

  it('clamps the window so a zero or negative value cannot empty the table', async () => {
    const { database } = await openDatabase()
    try {
      const device = pairDevice(database, 'live-phone')
      database.backdateDeviceForTest(device, { lastSeenAt: Date.now() - 2 * DAY })

      // 0 / 负数被夹到 1 天：2 天前用过的设备仍然会被清掉，但「刚刚用过」的不会。
      expect(database.pruneInactiveDevices(0)).toBe(1)
      expect(database.listDevices()).toHaveLength(0)

      const another = pairDevice(database, 'brand-new')
      expect(database.pruneInactiveDevices(-5)).toBe(0)
      expect(database.listDevices().map(item => item.id)).toEqual([another])
    } finally {
      database.close()
    }
  })

  it('writes one summary audit row per prune run, and none when nothing matched', async () => {
    const { database } = await openDatabase()
    try {
      const stale = pairDevice(database, 'stale')
      database.backdateDeviceForTest(stale, { lastSeenAt: Date.now() - 10 * DAY })
      database.pruneInactiveDevices(7)

      const actions = database.listAudit(50).map(row => row.action)
      expect(actions).toContain('device.prune')

      const before = database.listAudit(50).length
      database.pruneInactiveDevices(7) // 没有可清的了
      expect(database.listAudit(50).length).toBe(before)
    } finally {
      database.close()
    }
  })
})
