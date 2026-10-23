import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { TestCleanup } from './test-cleanup.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

/** 建一个带一条授权根、一台已配对设备的库。 */
async function setup(options: { deviceName?: string; nameSource?: 'default' | 'declared' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-identity-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  const stateDir = path.join(base, 'state')
  const database = cleanup.db(new WorkspaceDatabase(stateDir))
  const root = await database.addRoot(project, 'Project')
  const pairing = database.createPairing([root.id], ['files.read'])
  const exchanged = database.exchangePairing(pairing.code, options.deviceName ?? 'Mobile device', {
    ...(options.nameSource === undefined ? {} : { nameSource: options.nameSource }),
  })
  return { base, stateDir, database, root, exchanged }
}

/**
 * 设备身份的落库与自动改名。
 *
 * 动机（用户 2026-10-23）：鸿蒙手机被登记成「Android 设备」，而且**没有任何
 * API 能修**。所以这里既验「探测到的身份会被记下来」，也验「用户改过的名字
 * 不会被机器再盖掉」—— 后者是这套机制里唯一有争议的取舍，必须有断言钉住。
 */
describe('device identity', () => {
  it('records the detected platform and model', async () => {
    const { database, exchanged } = await setup()
    database.recordDeviceIdentity(exchanged.device.id, { platform: 'harmonyos', model: 'ICL-AL10' })
    const device = database.getActiveDevice(exchanged.device.id)
    expect(device?.platform).toBe('harmonyos')
    expect(device?.model).toBe('ICL-AL10')
  })

  it('renames a placeholder name on first detection', async () => {
    const { database, exchanged } = await setup({ nameSource: 'default' })
    expect(exchanged.device.name).toBe('Mobile device')
    database.recordDeviceIdentity(exchanged.device.id, {
      platform: 'harmonyos',
      model: 'ICL-AL10',
      suggestedName: 'HarmonyOS · ICL-AL10',
    })
    const device = database.getActiveDevice(exchanged.device.id)
    expect(device?.name).toBe('HarmonyOS · ICL-AL10')
    expect(device?.nameSource).toBe('detected')
  })

  it('keeps updating a name it generated itself', async () => {
    const { database, exchanged } = await setup({ nameSource: 'default' })
    database.recordDeviceIdentity(exchanged.device.id, {
      platform: 'android',
      suggestedName: 'Android',
    })
    database.recordDeviceIdentity(exchanged.device.id, {
      platform: 'android',
      model: 'Pixel 9',
      suggestedName: 'Android · Pixel 9',
    })
    expect(database.getActiveDevice(exchanged.device.id)?.name).toBe('Android · Pixel 9')
  })

  it('never overwrites a name a human set', async () => {
    // 这是这套机制里唯一有争议的取舍：用户起的名比机器猜的准，而且他能改一次
    // 就能改第二次 —— 但机器每次连接都覆盖就再也留不住了。
    const { database, exchanged } = await setup({ deviceName: '我的手机', nameSource: 'declared' })
    database.recordDeviceIdentity(exchanged.device.id, {
      platform: 'harmonyos',
      model: 'ICL-AL10',
      suggestedName: 'HarmonyOS · ICL-AL10',
    })
    const device = database.getActiveDevice(exchanged.device.id)
    expect(device?.name).toBe('我的手机')
    // 但身份本身照常记录 —— 不改名不等于不记事实。
    expect(device?.platform).toBe('harmonyos')
  })

  it('treats a legacy row without nameSource as declared', async () => {
    // 老库这三列是 NULL。那些名字多半是硬编码占位名，但也可能有人直接改过库 ——
    // 保守起见不动名字，只补身份两列。
    const { database, exchanged } = await setup({ deviceName: 'Android 设备' })
    database.recordDeviceIdentity(exchanged.device.id, {
      platform: 'harmonyos',
      suggestedName: 'HarmonyOS',
    })
    const device = database.getActiveDevice(exchanged.device.id)
    expect(device?.name).toBe('Android 设备')
    expect(device?.platform).toBe('harmonyos')
  })

  it('reports whether anything changed so callers can skip the revision bump', async () => {
    const { database, exchanged } = await setup({ nameSource: 'declared' })
    expect(database.recordDeviceIdentity(exchanged.device.id, { platform: 'android' })).toBe(true)
    // 同样的身份再来一次：不写库，也不递增设备版本号（否则每个请求都会触发
    // 全体客户端重拉设备表）。
    expect(database.recordDeviceIdentity(exchanged.device.id, { platform: 'android' })).toBe(false)
  })

  it('ignores an unknown device', async () => {
    const { database } = await setup()
    expect(database.recordDeviceIdentity('nope', { platform: 'android' })).toBe(false)
  })

  it('renames manually and marks the name as declared', async () => {
    const { database, exchanged } = await setup({ nameSource: 'default' })
    const renamed = database.renameDevice(exchanged.device.id, '  客厅的平板  ')
    expect(renamed.name).toBe('客厅的平板')
    expect(renamed.nameSource).toBe('declared')
    // 之后自动探测再也改不动它。
    database.recordDeviceIdentity(exchanged.device.id, { platform: 'android', suggestedName: 'Android' })
    expect(database.getActiveDevice(exchanged.device.id)?.name).toBe('客厅的平板')
  })

  it('rejects an empty rename', async () => {
    const { database, exchanged } = await setup()
    expect(() => database.renameDevice(exchanged.device.id, '   ')).toThrowError(/must not be empty/i)
  })

  it('rejects renaming an unknown or revoked device', async () => {
    const { database, exchanged } = await setup()
    expect(() => database.renameDevice('nope', 'x')).toThrowError(/does not exist/i)
    database.revokeDevice(exchanged.device.id)
    expect(() => database.renameDevice(exchanged.device.id, 'x')).toThrowError(/does not exist/i)
  })

  it('truncates an over-long rename instead of failing', async () => {
    const { database, exchanged } = await setup()
    expect(database.renameDevice(exchanged.device.id, 'x'.repeat(200)).name.length).toBe(120)
  })

  it('exposes identity on the device list', async () => {
    const { database, exchanged } = await setup()
    database.recordDeviceIdentity(exchanged.device.id, { platform: 'harmonyos', model: 'ICL-AL10' })
    const listed = database.listDevices().find(item => item.id === exchanged.device.id)
    expect(listed?.platform).toBe('harmonyos')
    expect(listed?.model).toBe('ICL-AL10')
  })
})

describe('device identity migration', () => {
  it('adds the three columns to an existing database and is idempotent', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-migrate-'))
    cleanup.dir(base)
    const stateDir = path.join(base, 'state')
    // 先用**旧表结构**建库：模拟一台升级前就装好的机器。
    await mkdir(stateDir, { recursive: true })
    const legacy = new DatabaseSync(path.join(stateDir, 'workspace.sqlite'))
    legacy.exec(`
      CREATE TABLE devices(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
      );
    `)
    legacy.exec("INSERT INTO devices(id,name,token_hash,scopes_json,created_at) VALUES('old','Android 设备','h','[\"files.read\"]',1)")
    legacy.close()

    // 打开即迁移。跑两次验幂等（插件每次启动都会经过 migrate 一次）。
    const first = new WorkspaceDatabase(stateDir)
    first.close()
    const second = new WorkspaceDatabase(stateDir)
    try {
      const columns = (second as unknown as { db: DatabaseSync }).db
        .prepare('PRAGMA table_info(devices)').all() as { name: string }[]
      const names = columns.map(entry => entry.name)
      expect(names).toContain('platform')
      expect(names).toContain('model')
      expect(names).toContain('name_source')
      // 老行的三列都是 NULL，语义是「从没探测过」。
      const listed = second.listDevices().find(item => item.id === 'old')
      expect(listed?.name).toBe('Android 设备')
      expect(listed?.platform).toBeUndefined()
      expect(listed?.nameSource).toBeUndefined()
    } finally {
      second.close()
    }
  })
})
