import {mkdtemp, mkdir,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { normalizePairingCode } from '../src/host/db/pairings.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

/**
 * 配对码的**格式**是跨仓契约（issue #32）。
 *
 * 码由 `randomBytes(5)` 生成 ⇒ 40-bit、**10 位十六进制**，中间一个连字符
 * （`A1B2C-D3E4F`）。这个形状自 v1.0.0 起没变过，但文档与注释曾先后写成
 * 「6 位 hex」「8 位」三种说法，照文档实现的客户端会把码截短或按 Base64URL 解码。
 * 兑换时 `normalizePairingCode` 会去连字符并转大写，所以手输 `a1b2cd3e4f`、
 * `A1B2C-D3E4F`、带空格都等价 —— 客户端按任一形态输入都该能换到。
 */
describe('pairing code format', () => {
  it('is 10 hex characters with one dash in the middle', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-pc-fmt-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    const pairing = database.createPairing([root.id], ['files.read'])
    expect(pairing.code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/)
    expect(pairing.code.replace('-', '')).toHaveLength(10)
  })

  it('redeems the same pairing however the user typed it', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-pc-norm-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    const pairing = database.createPairing([root.id], ['files.read'])
    const bare = pairing.code.replace('-', '')
    expect(normalizePairingCode(bare)).toBe(normalizePairingCode(pairing.code))
    // 手输形态：小写、无连字符、带空格。
    expect(normalizePairingCode(` ${bare.toLowerCase()} `)).toBe(normalizePairingCode(pairing.code))
    const exchanged = database.exchangePairing(bare.toLowerCase(), 'Phone')
    expect(exchanged.device.id).toBeTruthy()
  })
})

describe('device pairing database', () => {
  it('returns a token once and revokes it immediately', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-db-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const root = await database.addRoot(project, 'Project')
      const pairing = database.createPairing([root.id], ['files.read', 'chat.read'])
      const exchanged = database.exchangePairing(pairing.code, 'Phone')
      const authenticated = database.authenticate(exchanged.token)
      expect(authenticated?.rootIds).toEqual([root.id])
      expect(authenticated?.scopes).toEqual(['files.read', 'chat.read'])
      expect(() => database.exchangePairing(pairing.code, 'Second phone')).toThrowError(/invalid, expired, or already used/i)
      database.revokeDevice(exchanged.device.id)
      expect(database.authenticate(exchanged.token)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('does not grant roots added after pairing', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-db-root-'))
    cleanup.dir(base)
    const first = path.join(base, 'first')
    const second = path.join(base, 'second')
    await mkdir(first)
    await mkdir(second)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    try {
      const firstRoot = await database.addRoot(first)
      const pairing = database.createPairing([firstRoot.id], ['files.read'])
      const exchanged = database.exchangePairing(pairing.code, 'Phone')
      await database.addRoot(second)
      expect(database.authenticate(exchanged.token)?.rootIds).toEqual([firstRoot.id])
    } finally {
      database.close()
    }
  })
})
