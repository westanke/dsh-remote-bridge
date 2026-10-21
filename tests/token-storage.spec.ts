import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase, hashSecret } from '../src/host/database.ts'

/**
 * 令牌的生成强度、库内形态与审计洁净度。
 *
 * SECURITY.md 声称两条：「令牌由 256 位随机数生成，数据库只保存 SHA-256 摘要」
 * 与「审计不保存令牌」。此前**一条测试都没有**（`database-auth.spec.ts` 只验
 * 「令牌能换设备、能撤销」，不验长度、不验哈希、不验库里是不是明文）。
 *
 * 这里盯的是「会不会在某个不经意的重构里把明文写进库」。所以断言直接读
 * `workspace.sqlite` 的**原始字节**去找令牌 —— 比查某张表的某列更狠：
 * 不管是 devices.token_hash、idempotency、还是哪张新表，只要明文落过盘就会被抓到。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

async function openDatabase(prefix: string): Promise<{ database: WorkspaceDatabase; stateDir: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.dir(base)
  const stateDir = path.join(base, 'state')
  const database = cleanup.db(new WorkspaceDatabase(stateDir))
  return { database, stateDir }
}

describe('设备令牌的生成与存储', () => {
  it('generates a 256-bit token (32 random bytes, base64url) and stores only its SHA-256', async () => {
    const { database, stateDir } = await openDatabase('daw-token-')
    const project = path.join(stateDir, '..', 'project')
    await mkdir(project)
    const root = await database.addRoot(project, 'P')
    const pairing = database.createPairing([root.id], ['files.read'])
    const exchanged = database.exchangePairing(pairing.code, 'Phone')

    // 256 位 = 32 字节；base64url 无填充 => ceil(32/3)*4 - 4 = 43 个字符。
    const decoded = Buffer.from(exchanged.token, 'base64url')
    expect(decoded).toHaveLength(32)
    expect(exchanged.token).toHaveLength(43)
    expect(exchanged.token).toMatch(/^[A-Za-z0-9_-]+$/)

    // 库内只存摘要：SHA-256 十六进制是 64 个字符，且能由令牌算出来。
    const digest = hashSecret(exchanged.token)
    expect(digest).toHaveLength(64)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toBe(exchanged.token)

    // `WorkspaceDatabase` 打开时 WAL 还在旁路文件里，先 checkpoint 才能确保主文件读全。
    database.close()
    const raw = readFileSync(path.join(stateDir, 'workspace.sqlite'))
    expect(raw.includes(Buffer.from(exchanged.token, 'utf8'))).toBe(false)
    expect(raw.includes(Buffer.from(digest, 'utf8'))).toBe(true)
  })

  it('never returns the token hash to a client listing', async () => {
    const { database, stateDir } = await openDatabase('daw-token-list-')
    const project = path.join(stateDir, '..', 'project')
    await mkdir(project)
    const root = await database.addRoot(project, 'P')
    const exchanged = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')

    // `listDevices()` 的每一项都会原样进 `/manage/devices` 响应。
    const view = database.listDevices()[0] as unknown as Record<string, unknown>
    expect(Object.keys(view).sort()).toEqual(['createdAt', 'id', 'name', 'rootIds', 'scopes'])
    expect(JSON.stringify(view)).not.toContain(hashSecret(exchanged.token))
    expect(JSON.stringify(view)).not.toContain(exchanged.token)
  })

  it('keeps tokens and pairing codes out of the audit trail', async () => {
    const { database, stateDir } = await openDatabase('daw-token-audit-')
    const project = path.join(stateDir, '..', 'project')
    await mkdir(project)
    const root = await database.addRoot(project, 'P')
    const pairing = database.createPairing([root.id], ['files.read'])
    const exchanged = database.exchangePairing(pairing.code, 'Phone')
    database.revokeDevice(exchanged.device.id)

    const serialized = JSON.stringify(database.listAudit(1000))
    // 审计要看得见「发生了什么」，但绝不能让令牌本身可被复读。
    expect(serialized).not.toContain(exchanged.token)
    expect(serialized).not.toContain(hashSecret(exchanged.token))
    expect(serialized).not.toContain(pairing.code)
    // 反面证据：配对与撤销确实进了审计（否则上面的「不含」可能只是「审计是空的」）。
    expect(serialized).toContain('pairing.create')
    expect(serialized).toContain('pairing.exchange')
    expect(serialized).toContain('device.revoke')
  })

  it('stores only a hash of the pairing code too', async () => {
    const { database, stateDir } = await openDatabase('daw-pairing-hash-')
    const project = path.join(stateDir, '..', 'project')
    await mkdir(project)
    const root = await database.addRoot(project, 'P')
    const pairing = database.createPairing([root.id], ['files.read'])
    // 配对码也是秘密（能换来长期令牌），同样不能明文落盘。
    expect(pairing.code).toHaveLength(11) // 5 hex + '-' + 5 hex
    database.close()
    const raw = readFileSync(path.join(stateDir, 'workspace.sqlite'))
    expect(raw.includes(Buffer.from(pairing.code, 'utf8'))).toBe(false)
    expect(raw.includes(Buffer.from(pairing.code.replace('-', ''), 'utf8'))).toBe(false)
  })

  it('does not accept a token that is only the hash of a real one', async () => {
    const { database, stateDir } = await openDatabase('daw-token-hashlogin-')
    const project = path.join(stateDir, '..', 'project')
    await mkdir(project)
    const root = await database.addRoot(project, 'P')
    const exchanged = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')

    // 关键的反向断言：如果哪天有人把「比较摘要」写成「把摘要当令牌查」，
    // 那么知道库内容的人就能直接登录。摘要本身必须是无效凭据。
    expect(database.authenticate(hashSecret(exchanged.token))).toBeUndefined()
    expect(database.authenticate(exchanged.token)).toBeDefined()
  })
})
