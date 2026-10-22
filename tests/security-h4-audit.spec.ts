import { mkdtemp, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestCleanup } from './test-cleanup.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'

/**
 * 【可追溯性缺陷｜中危】管理面四个写操作的审计**缺 requestId**（2.5.2 修复）。
 *
 * ## 被锁死的性质
 *
 * 审计的目的不只是「记下发生了什么」，还要能回答「**哪一次请求**干的」。
 * 2.5.1 及之前，四条最敏感的管理写操作在调用 `audit()` 时**没传第 7 个参数**：
 *
 * | 操作 | 实现位置 | 审计动作 |
 * |---|---|---|
 * | 登记授权根 | `database.addRoot` | `root.add` |
 * | 发配对码 | `database.createPairing` | `pairing.create` |
 * | 改设备权限 | `database.updateDevice` | `device.update` |
 * | 撤销设备 | `database.revokeDevice` | `device.revoke` |
 *
 * 对比：`router.ts` 里 `image.subdir` / `trash.purge` / `cloudflare.*` 都传了 requestId。
 * 于是事后取证时，这四条**无法与某次 HTTP 请求对应**，只能靠时间戳猜 ——
 * 而它们恰好是「谁能读我的文件」「谁的设备还在」这类问题的答案。
 *
 * ## 事务语义（FUNC-5）
 *
 * `revokeDevice` / `updateDevice` 是「先写审计、再改业务」两步。两步之间若进程退出，
 * 会留下「审计说撤了，但设备还在」（或反之）的不一致。修复把它们放进**同一个
 * `BEGIN IMMEDIATE` 事务**：审计与业务**同生共死**。
 *
 * 为什么选「审计失败 → 业务回滚」（而不是「审计失败只 warn」）：审计是**权限变更的
 * 必要条件**，不是附属品。没有审计记录的「撤销成功」是**不可审计的成功** ——
 * 安全上比「撤销失败」更糟（用户以为设备断了，其实还通着）。宁可让用户重试一次。
 *
 * ## devicesRevision（perf-reader 的 PERF-1 契约）
 *
 * 进程内单调计数，四处变更 +1：`exchangePairing` / `updateDevice` / `revokeDevice` /
 * `purgeRevokedDevices`。语义 =「任何改变『设备是否存在 / scope / rootIds』的写都 +1」。
 * `server.ts` 用它做**特性探测**：缺了就退回逐事件查库，不会更差。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

async function openDatabase(prefix: string): Promise<{ database: WorkspaceDatabase; base: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.dir(base)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  return { database, base }
}

async function withRoot(database: WorkspaceDatabase, base: string) {
  const project = path.join(base, 'project')
  await mkdir(project)
  return database.addRoot(project, 'Project')
}

function auditWith(database: WorkspaceDatabase, action: string): Record<string, unknown> | undefined {
  return database.listAudit(1000).find(item => item.action === action)
}

describe('审计带上 requestId（可追溯到具体一次请求）', () => {
  it('records root.add with the caller-supplied requestId', async () => {
    const { database, base } = await openDatabase('daw-audit-rid-')
    const project = path.join(base, 'project')
    await mkdir(project)
    await database.addRoot(project, 'Project', { requestId: 'req-root-add' })
    expect(auditWith(database, 'root.add')?.requestId).toBe('req-root-add')
  })

  it('records pairing.create with the caller-supplied requestId', async () => {
    const { database, base } = await openDatabase('daw-audit-rid-pair-')
    const root = await withRoot(database, base)
    database.createPairing([root.id], ['files.read'], 600_000, { requestId: 'req-pair-create' })
    expect(auditWith(database, 'pairing.create')?.requestId).toBe('req-pair-create')
  })

  it('records device.update with the caller-supplied requestId', async () => {
    const { database, base } = await openDatabase('daw-audit-rid-dev-')
    const root = await withRoot(database, base)
    const paired = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')
    database.updateDevice(paired.device.id, ['files.read', 'files.write'], [root.id], { requestId: 'req-dev-update' })
    expect(auditWith(database, 'device.update')?.requestId).toBe('req-dev-update')
  })

  it('records device.revoke with the caller-supplied requestId', async () => {
    const { database, base } = await openDatabase('daw-audit-rid-rev-')
    const root = await withRoot(database, base)
    const paired = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')
    database.revokeDevice(paired.device.id, { requestId: 'req-dev-revoke' })
    expect(auditWith(database, 'device.revoke')?.requestId).toBe('req-dev-revoke')
  })

  it('keeps requestId optional so internal callers (startup, builtin root) still work', async () => {
    const { database, base } = await openDatabase('daw-audit-rid-null-')
    const root = await withRoot(database, base)
    // 不传 requestId 的老调用方式必须继续工作（插件启动期没有 HTTP 请求）。
    // 审计行仍然写入，只是 request_id 为 null。
    const pairing = database.createPairing([root.id], ['files.read'])
    expect(pairing.code).toHaveLength(11)
    expect(auditWith(database, 'pairing.create')?.requestId ?? null).toBeNull()
  })
})

describe('FUNC-5：审计与业务在同一事务里（同生共死）', () => {
  it('rolls the business change back when the audit insert fails', async () => {
    const { database, base } = await openDatabase('daw-audit-tx-')
    const root = await withRoot(database, base)
    const paired = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')

    // 让审计写入失败，模拟「审计表不可写」（磁盘满 / 库锁 / schema 漂移）。
    // 用 spyOn 而不是真的破坏库：要的是「审计失败」这一个条件，别的都不变。
    const spy = vi.spyOn(database, 'audit').mockImplementation(() => {
      throw new Error('simulated audit failure')
    })
    try {
      expect(() => database.revokeDevice(paired.device.id, { requestId: 'req-x' })).toThrow()
    } finally {
      spy.mockRestore()
    }

    // 关键断言：业务**没有被提交** —— 设备仍然活着。
    // 否则就会出现「审计说撤了，设备其实还通着」这种不可审计的成功。
    expect(database.getActiveDevice(paired.device.id)).toBeDefined()
    expect(database.isDeviceActive(paired.device.id)).toBe(true)
  })

  it('does not commit a device update when its audit row cannot be written', async () => {
    const { database, base } = await openDatabase('daw-audit-tx2-')
    const root = await withRoot(database, base)
    const paired = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')

    const spy = vi.spyOn(database, 'audit').mockImplementation(() => {
      throw new Error('simulated audit failure')
    })
    try {
      expect(() => database.updateDevice(paired.device.id, ['files.read', 'files.write'], [root.id])).toThrow()
    } finally {
      spy.mockRestore()
    }

    // 权限没被扩大：回滚后仍是原来那条 files.read。
    const device = database.getActiveDevice(paired.device.id)
    expect(device?.scopes).toEqual(['files.read'])
  })
})

describe('devicesRevision：进程内单调计数（PERF-1 契约）', () => {
  it('increments on every write that changes device existence, scopes, or roots', async () => {
    const { database, base } = await openDatabase('daw-dev-rev-')
    const root = await withRoot(database, base)
    const start = database.devicesRevision

    const paired = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')
    expect(database.devicesRevision).toBe(start + 1) // exchangePairing

    database.updateDevice(paired.device.id, ['files.read', 'files.write'], [root.id])
    expect(database.devicesRevision).toBe(start + 2) // updateDevice

    database.revokeDevice(paired.device.id)
    expect(database.devicesRevision).toBe(start + 3) // revokeDevice

    // purge 没有可清理的行时也会 +1 —— 它是「可能改变设备集合」的写，
    // 保守地递增比漏递增安全（多一次缓存失效，少一次陈旧授权）。
    database.purgeRevokedDevices()
    expect(database.devicesRevision).toBe(start + 4)
  })

  it('does not increment for root changes (they are not device state)', async () => {
    const { database, base } = await openDatabase('daw-dev-rev-root-')
    const before = database.devicesRevision
    const root = await withRoot(database, base)
    database.removeRoot(root.id)
    // 根变更会让「设备能看到哪些根」的实际可达集合变化，但**设备记录本身没变**。
    // 缓存失效的判据是 devices 表；根变更另有 `/roots` 的实时查询，不靠这个计数。
    expect(database.devicesRevision).toBe(before)
  })
})

describe('保留策略的 SQL（perf-reader 的 retention.ts 调用）', () => {
  it('prunes idempotency rows older than the cutoff and reports how many', async () => {
    const { database, base } = await openDatabase('daw-prune-idem-')
    const root = await withRoot(database, base)
    const paired = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')
    database.saveIdempotent(paired.device.id, 'old-key', 201, { ok: true })
    database.saveIdempotent(paired.device.id, 'new-key', 201, { ok: true })

    // cutoff 设为「现在」→ 两条都更旧，应被清掉 2 条。
    const removed = database.pruneIdempotency(Date.now() + 1)
    expect(removed).toBe(2)
    expect(database.readIdempotent(paired.device.id, 'old-key')).toBeUndefined()
  })

  it('prunes audit by time and then caps the total to keepMax', async () => {
    const { database, base } = await openDatabase('daw-prune-audit-')
    const root = await withRoot(database, base)
    for (let index = 0; index < 5; index += 1) {
      database.audit('device', 'd1', `test.action.${index}`, undefined, undefined, {})
    }
    // 先按时间删：cutoff 放在最早那条之后 —— 但 audit 的时间戳同毫秒，无法区分。
    // 所以这里只验「兜底 cap」这一半：keepMax=2 时总数必须降到 2。
    const removed = database.pruneAudit(0, 2)
    expect(removed).toBeGreaterThanOrEqual(3)
    expect(database.listAudit(1000).length).toBeLessThanOrEqual(2)
  })

  it('never prunes below keepMax even when the time cutoff would remove everything', async () => {
    const { database, base } = await openDatabase('daw-prune-audit2-')
    rootRef(base)
    for (let index = 0; index < 3; index += 1) {
      database.audit('device', 'd1', `keep.action.${index}`, undefined, undefined, {})
    }
    // cutoff = 未来 → 所有行都「过期」。但 keepMax 是**下限保护**：
    // 保留最近 keepMax 条，避免一次错误的 cutoff 把审计清空。
    const removed = database.pruneAudit(Date.now() + 60_000, 2)
    expect(removed).toBe(1)
    expect(database.listAudit(1000)).toHaveLength(2)
  })
})

/** 只为让上一条用例读起来完整（它不需要 root）。 */
function rootRef(_base: string): void { /* no-op */ }
