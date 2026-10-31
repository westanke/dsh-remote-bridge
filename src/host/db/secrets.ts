import { createHash } from 'node:crypto'

/**
 * 令牌 / 配对码的摘要。
 *
 * 库里**只存哈希**：令牌原文一旦落库，「撤销」就只能等下一次写；而哈希让撤销
 * 变成一次 `DELETE` 就够。配对码同理（`normalizePairingCode` 之后哈希存库）。
 *
 * 单独一个文件而不是塞进 `database.ts`：`db/*` 各表族模块都要用它，而
 * `database.ts` 是它们的组合根 —— 放在组合根里会形成「表族 → 组合根」的环。
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
