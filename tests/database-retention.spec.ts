import { DatabaseSync } from 'node:sqlite'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUDIT_KEEP_MAX,
  AUDIT_TTL_MS,
  IDEMPOTENCY_PRUNE_EVERY,
  IDEMPOTENCY_TTL_MS,
  createIdempotencyPruner,
  resolveRetentionPort,
  runStartupRetention,
} from '../src/host/retention.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * 数据保留策略（PERF-3）。
 *
 * `audit` 与 `idempotency` 此前**只增不删**（`src/` 下 `DELETE FROM audit` /
 * `DELETE FROM idempotency` / `VACUUM` 零命中）。这是本仓唯一一条「随时间必然恶化」
 * 的债：跑三个月之后库变大、`listAudit` 变慢，而刚装上时完全看不出来。
 *
 * 这里钉住四件事：
 * 1. **过期删、未过期留**（阈值语义不能写反，也不能「全表清空」）；
 * 2. **`trash` 不受影响**（清理是外科手术，不是清库）；
 * 3. **幂等去重语义不变**（清理掉旧的记录，不该影响同 key 的新写入与读取）；
 * 4. **端口缺席时静默降级**（只 warn，不抛、不拦启动）。
 *
 * 测试用**真实的 `node:sqlite`** 建两张同形表，而不是内存桩：
 * 桩只能证明「我调了你」，证明不了「SQL 真的按时间删」。保留策略最容易错的地方
 * 恰恰是 SQL 边界（`<` vs `<=`、时间单位、列名）。
 */

const cleanup = new TestCleanup()
/** 这个 spec 自己的库句柄：`TestCleanup` 只认 `WorkspaceDatabase`，这里用的是裸 `DatabaseSync`。 */
const openFixtures: RetentionFixture[] = []

afterEach(async () => {
  for (const fixtureInstance of openFixtures.splice(0)) {
    try {
      fixtureInstance.close()
    } catch {
      // 已关闭：忽略。
    }
  }
  await cleanup.dispose()
})

/**
 * 一个**只实现保留端口**的库替身：两张表 + 两个 prune 方法。
 *
 * 为什么不用真的 `WorkspaceDatabase`：`pruneIdempotency` / `pruneAudit` 归
 * `database.ts`（另一条手术台），此刻还没落地。这个替身让**策略**可以先被验证，
 * 等端口真的上了，只要 SQL 与这里一致就成立。
 */
class RetentionFixture {
  readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit(
        id TEXT PRIMARY KEY, time INTEGER NOT NULL, request_id TEXT, actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL, action TEXT NOT NULL, root_id TEXT, relative_path TEXT, details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency(
        device_id TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL,
        response_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(device_id,key)
      );
      CREATE TABLE IF NOT EXISTS trash(
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        payload_path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
        digest TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL
      );
    `)
  }

  pruneIdempotency(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(cutoffMs)
    return Number(result.changes)
  }

  pruneAudit(cutoffMs: number, keepMax: number): number {
    const byTime = Number(this.db.prepare('DELETE FROM audit WHERE time < ?').run(cutoffMs).changes)
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n)
    if (total <= keepMax) return byTime
    const overflow = total - keepMax
    // 删最旧的那批：`ORDER BY time ASC LIMIT ?`（SQLite 的 DELETE 支持 LIMIT 需编译选项，
    // 所以用子查询选 id —— 这是可移植写法）。
    const removed = Number(this.db.prepare(
      'DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY time ASC LIMIT ?)',
    ).run(overflow).changes)
    return byTime + removed
  }

  insertAudit(id: string, time: number): void {
    this.db.prepare(
      'INSERT INTO audit(id,time,request_id,actor_type,actor_id,action,root_id,relative_path,details_json) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, time, null, 'device', 'd1', 'file.write', null, null, '{}')
  }

  insertIdempotent(device: string, key: string, createdAt: number): void {
    this.db.prepare(
      'INSERT INTO idempotency(device_id,key,status,response_json,created_at) VALUES(?,?,?,?,?)',
    ).run(device, key, 202, '{"message":{"accepted":true}}', createdAt)
  }

  insertTrash(id: string, createdAt: number): void {
    this.db.prepare(
      'INSERT INTO trash(id,root_id,relative_path,payload_path,kind,size,digest,created_at,status) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, 'root-1', 'a.txt', '/tmp/payload', 'file', 1, 'deadbeef', createdAt, 'trashed')
  }

  counts(): { audit: number; idempotency: number; trash: number } {
    const one = (sql: string): number => Number((this.db.prepare(sql).get() as { n: number }).n)
    return {
      audit: one('SELECT COUNT(*) AS n FROM audit'),
      idempotency: one('SELECT COUNT(*) AS n FROM idempotency'),
      trash: one('SELECT COUNT(*) AS n FROM trash'),
    }
  }

  close(): void {
    this.db.close()
  }
}

function recordingLogger(): { info: (message: string) => void; warn: (error: Error) => void; infos: string[]; warns: string[] } {
  const infos: string[] = []
  const warns: string[] = []
  return {
    infos,
    warns,
    info: (message: string) => { infos.push(message) },
    warn: (error: Error) => { warns.push(error.message) },
  }
}

async function fixture(): Promise<RetentionFixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-retention-'))
  cleanup.dir(base)
  const instance = new RetentionFixture(path.join(base, 'retention.sqlite'))
  openFixtures.push(instance)
  return instance
}

describe('retention port detection', () => {
  it('returns null when the database exposes no prune methods', () => {
    expect(resolveRetentionPort({})).toBeNull()
    expect(resolveRetentionPort({ pruneIdempotency: () => 0 })).toBeNull()
  })

  it('returns the port once both methods exist', () => {
    const port = resolveRetentionPort({ pruneIdempotency: () => 0, pruneAudit: () => 0 })
    expect(port).not.toBeNull()
  })
})

describe('startup retention', () => {
  it('deletes only rows older than the TTL and keeps recent ones', async () => {
    const store = await fixture()
    const now = 1_000_000_000_000
    // 幂等：一条过期、一条刚写的。
    store.insertIdempotent('device-1', 'old', now - IDEMPOTENCY_TTL_MS - 1)
    store.insertIdempotent('device-1', 'fresh', now - 1_000)
    // 审计：一条过期、一条刚写的。
    store.insertAudit('audit-old', now - AUDIT_TTL_MS - 1)
    store.insertAudit('audit-fresh', now - 1_000)

    const logger = recordingLogger()
    const outcome = runStartupRetention(store, logger, now)

    expect(outcome.ran).toBe(true)
    expect(outcome.idempotencyDeleted).toBe(1)
    expect(outcome.auditDeleted).toBe(1)
    expect(store.counts()).toEqual({ audit: 1, idempotency: 1, trash: 0 })
    // 留下的必须是「新」那条，而不是随机留一条。
    const idempotencyKeys = store.db.prepare('SELECT key FROM idempotency').all() as { key: string }[]
    expect(idempotencyKeys.map(row => row.key)).toEqual(['fresh'])
    const auditIds = store.db.prepare('SELECT id FROM audit').all() as { id: string }[]
    expect(auditIds.map(row => row.id)).toEqual(['audit-fresh'])
    expect(logger.infos.join(' ')).toContain('retention removed')
  })

  it('never touches the trash table', async () => {
    const store = await fixture()
    const now = 1_000_000_000_000
    // trash 里有**远早于任何 TTL** 的记录：清理不该顺手把它收了 ——
    // 回收站是用户数据，它的生命周期由用户自己决定（恢复/彻底删除）。
    store.insertTrash('trash-old', now - 365 * 24 * 60 * 60_000)
    runStartupRetention(store, recordingLogger(), now)
    expect(store.counts().trash).toBe(1)
  })

  it('caps the audit table at AUDIT_KEEP_MAX even inside the TTL window', async () => {
    const store = await fixture()
    const now = 1_000_000_000_000
    // 全部都在 TTL 之内（不按时间删），但总数超标 → 必须按「删最旧」兜住。
    // 用 keepMax 的实际值太慢，这里临时插 12 条并把阈值当作 12 之下验证语义：
    // 直接调端口（`pruneAudit`）而不是 `runStartupRetention`，因为常量不可注入。
    for (let index = 0; index < 12; index += 1) store.insertAudit(`a-${index}`, now - index * 1_000)
    store.pruneAudit(now - AUDIT_TTL_MS, 5)
    expect(store.counts().audit).toBe(5)
    const remaining = store.db.prepare('SELECT id FROM audit ORDER BY time DESC').all() as { id: string }[]
    // 留下的必须是**最新的 5 条**（a-0 .. a-4），不是最旧的。
    expect(remaining.map(row => row.id)).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'a-4'])
    expect(AUDIT_KEEP_MAX).toBeGreaterThan(5)
  })

  it('degrades to a warning when the port is missing, never throwing', () => {
    const logger = recordingLogger()
    const outcome = runStartupRetention({}, logger, 1_000)
    expect(outcome).toEqual({ ran: false, idempotencyDeleted: 0, auditDeleted: 0 })
    expect(logger.warns.join(' ')).toContain('retention skipped')
  })

  it('swallows a failing prune and reports zero rather than breaking startup', async () => {
    const store = await fixture()
    const logger = recordingLogger()
    const broken = {
      pruneIdempotency: () => { throw new Error('disk is on fire') },
      pruneAudit: () => { throw new Error('disk is still on fire') },
    }
    const outcome = runStartupRetention(broken, logger, 1_000)
    expect(outcome.ran).toBe(true)
    expect(outcome.idempotencyDeleted).toBe(0)
    expect(outcome.auditDeleted).toBe(0)
    expect(logger.warns.some(message => message.includes('pruning idempotency failed'))).toBe(true)
    expect(logger.warns.some(message => message.includes('pruning audit failed'))).toBe(true)
    // 真实库没被碰。
    expect(store.counts().audit).toBe(0)
  })
})

describe('periodic idempotency pruning', () => {
  it('prunes once every configured number of writes, and only expired rows', async () => {
    const store = await fixture()
    const now = 1_000_000_000_000
    const prune = createIdempotencyPruner(store, recordingLogger())

    store.insertIdempotent('device-1', 'old', now - IDEMPOTENCY_TTL_MS - 1)
    // 前 N-1 次不该清理（清理很便宜，但没必要每次写都跑一条 DELETE）。
    for (let index = 0; index < IDEMPOTENCY_PRUNE_EVERY - 1; index += 1) {
      expect(prune(now)).toBe(0)
    }
    expect(store.counts().idempotency).toBe(1)

    // 第 N 次触发清理 → 过期那条被删。
    expect(prune(now)).toBe(1)
    expect(store.counts().idempotency).toBe(0)
  })

  it('keeps unexpired idempotency rows so replay still works', async () => {
    const store = await fixture()
    const now = 1_000_000_000_000
    const prune = createIdempotencyPruner(store, recordingLogger())
    // 幂等重放的语义是「同一个 key 再问一次，拿回当初那份响应」。
    // 只要还在 24 h 内，清理就不该把它删掉。
    store.insertIdempotent('device-1', 'replay-me', now - 60_000)
    for (let index = 0; index < IDEMPOTENCY_PRUNE_EVERY; index += 1) prune(now)
    const rows = store.db.prepare('SELECT key, status, response_json FROM idempotency').all() as
      { key: string; status: number; response_json: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('replay-me')
    // **响应体保持原样**（没有被裁成 {sessionId}）—— 见 retention.ts 里那条否决。
    expect(rows[0]?.response_json).toBe('{"message":{"accepted":true}}')
  })

  it('does nothing when the port is absent', () => {
    const prune = createIdempotencyPruner({}, recordingLogger())
    for (let index = 0; index < IDEMPOTENCY_PRUNE_EVERY; index += 1) {
      expect(prune(1_000)).toBe(0)
    }
  })

  it('does not throw when the prune itself fails', () => {
    const prune = createIdempotencyPruner(
      { pruneIdempotency: () => { throw new Error('locked') }, pruneAudit: () => 0 },
      recordingLogger(),
    )
    // 清理失败绝不能让「保存幂等记录」跟着失败（那会把一次成功的请求变 500）。
    expect(() => {
      for (let index = 0; index < IDEMPOTENCY_PRUNE_EVERY; index += 1) prune(1_000)
    }).not.toThrow()
  })
})
