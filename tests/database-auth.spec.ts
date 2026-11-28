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
 * 配对码的**格式**是跨仓契约（issue #32 / issue #3）。
 *
 * 2.18.0 之前由 `randomBytes(5)` 生成 ⇒ 40-bit、10 位十六进制（`A1B2C-D3E4F`）；
 * issue #3 起改成 **10 位纯数字**（`12345-67890`，10^10）。改的理由是码要给人
 * 念着输：`0/O`、`1/I` 这类形近字符在真机上全靠猜，数字键盘还少一层切换。
 * 熵低 6.8 bit，但兑换端每对端限 10 次 / 10 分钟 + 10 分钟过期 + 一次有效，
 * 叠加起来仍不可暴力（推导见 `pairings.ts` 的 `createPairingCode`）。
 * 兑换时 `normalizePairingCode` 会去连字符并转大写，所以手输 `1234567890`、
 * `1234 567 890`、带空格都等价 —— 客户端按任一形态输入都该能换到。
 */
describe('pairing code format', () => {
  it('is 10 digits with one dash in the middle', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-pc-fmt-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    const pairing = database.createPairing([root.id], ['files.read'])
    expect(pairing.code).toMatch(/^[0-9]{5}-[0-9]{5}$/)
    expect(pairing.code.replace('-', '')).toHaveLength(10)
    // 前导零也得是 10 位：`randomInt(0, 1e10).toString()` 会掉前导零，
    // 掉一位就少一个数量级的空间，而形状上仍然是「看着像码」的数字串。
    expect(pairing.code.match(/^\d{10}$/)).toBeNull()
  })

  it('keeps leading zeros so the space stays 10^10', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-pc-zero-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    // 200 枚码里出现前导零的概率约 1 - (0.9)^200 ≈ 100%：只要生成器没丢零，
    // 至少会有一枚以 0 开头；反之丢零的实现永远生成不出 0 开头的码。
    const codes = Array.from({ length: 200 }, () => database.createPairing([root.id], ['files.read']).code)
    expect(codes.every(code => /^[0-9]{5}-[0-9]{5}$/.test(code))).toBe(true)
    expect(codes.some(code => code.startsWith('0'))).toBe(true)
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
