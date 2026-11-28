import { randomInt } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DeviceScope } from '../../shared/contracts.ts'
import { ApiError } from '../errors.ts'
import type { AuditSink } from './audit.ts'
import type { RootLookup } from './devices.ts'
import { assertScopes } from './devices.ts'
import { hashSecret } from './secrets.ts'

export interface PairingRow {
  code_hash: string
  scopes_json: string
  roots_json: string
  expires_at: number
  used_at: number | null
}

/** 配对码统一形态：只留字母数字再转大写（手机手输时容易混入空格/连字符）。 */
export function normalizePairingCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/**
 * 生成一枚**纯数字**配对码：10 位、中间一个连字符（`12345-67890`）。
 *
 * ## 为什么从十六进制改成纯数字（issue #3）
 *
 * 用户在真机上念码、输码，`A1B2C-3D4E5` 里 `0/O`、`1/I` 这类形近字符全靠猜；
 * 数字键盘比字母键盘少一层切换。码是**给人念的**，形状就该服从这件事。
 *
 * ## 熵够不够（结论：够，且与限流一起看才够）
 *
 * 10 位数字 = 10^10 ≈ 2^33.2，比原来的 10 位十六进制（16^10 = 2^40）低 6.8 bit。
 * 单独看像退化，但兑换端 `/api/v1/pairings/exchange` 的约束是叠加的：
 *
 * - `AuthService.pairingAttemptsByPeer` 每对端 **10 次 / 10 分钟**（隧道侧所有公网
 *   请求在 cloudflared 后面共用 `127.0.0.1` 这一桶，即公网整体 10 次 / 10 分钟）；
 * - 配对码 **10 分钟过期**且**一次有效**（`used_at`），每个码只活一个窗口；
 * - 猜中还得正好落在那 10 分钟内、且这个码尚未被真主人兑换。
 *
 * 按上限估：单个对端一天最多 1440 次，命中一个 10^10 空间的概率可忽略；要把它压到
 * 「一天内可试」需要上千万个独立对端，而公网侧根本拿不到独立桶。故不升位数：
 * 位数一多，用户就又回到「要对着屏幕抄」的处境。
 *
 * 用 `randomInt` 而不是 `randomBytes % 10`：后者对 256 取模有偏（十个数字概率不等）。
 */
function createPairingCode(): string {
  const digits = randomInt(0, 10_000_000_000).toString().padStart(10, '0')
  return `${digits.slice(0, 5)}-${digits.slice(5)}`
}

/**
 * `pairings` 表族：配对码的生成与查询。
 *
 * 兑换（`exchangePairing`）是**跨表族事务**（pairings + devices + device_roots +
 * audit 四张表一个事务），所以它留在 `WorkspaceDatabase`（组合根）里；本表族只
 * 提供 `lookup` / `markUsed` 两个事务内原语，供组合根拼装。单独属于 pairings
 * 一张表的 `createPairing` 留在这里。
 */
export class PairingsTable {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditSink,
    private readonly roots: RootLookup,
  ) {}

  /**
   * 生成一枚配对码。
   *
   * @param options.requestId - 发起这次请求的 HTTP requestId（审计可追溯）。
   */
  createPairing(
    rootIds: string[],
    scopes: DeviceScope[],
    ttlMs = 10 * 60_000,
    options: { requestId?: string } = {},
  ): { code: string; expiresAt: number } {
    assertScopes(scopes)
    for (const rootId of rootIds) {
      if (this.roots.get(rootId) === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', `Unknown root ${rootId}.`)
    }
    const code = createPairingCode()
    const expiresAt = Date.now() + ttlMs
    this.db.prepare('INSERT INTO pairings(code_hash,scopes_json,roots_json,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(hashSecret(normalizePairingCode(code)), JSON.stringify(scopes), JSON.stringify(rootIds), expiresAt, Date.now())
    this.audit('admin', 'loopback-admin', 'pairing.create', undefined, undefined, { rootIds, scopes, expiresAt }, options.requestId)
    return { code, expiresAt }
  }

  /** 按原始配对码查行（内部做 normalize + hash）。事务内原语，供 `exchangePairing` 用。 */
  lookup(code: string): PairingRow | undefined {
    return this.db.prepare(
      'SELECT code_hash,scopes_json,roots_json,expires_at,used_at FROM pairings WHERE code_hash = ?',
    ).get(hashSecret(normalizePairingCode(code))) as PairingRow | undefined
  }

  /** 标记配对码已用。事务内原语 —— 只改列，不校验、不审计。 */
  markUsed(codeHash: string, now: number): void {
    this.db.prepare('UPDATE pairings SET used_at = ? WHERE code_hash = ?').run(now, codeHash)
  }
}
