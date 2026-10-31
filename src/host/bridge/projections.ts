/**
 * 会话投影读取：`projectionsOf`（从 follow 快照自带的基线里取）与
 * `readSessionProjections`（单独一次 RPC 兜底）。
 * （原 `dsh-0.2-bridge.ts` 内的投影区，#2 拆分时原样搬出。）
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from '../chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from '../image-handoff.ts'
import { recordFrameHubDropped, recordRpc } from '../metrics.ts'
import { wireRelative } from '../path-policy.ts'
import type { SettingsApiProxy } from '../settings-adapter.ts'
import type { Dsh02HostServices } from './kernel-services.ts'
import { timeoutSignal, SESSION_DIR_LOOKUP_TIMEOUT_MS } from './rpc.ts'


/**
 * 从 follow 的 snapshot 帧里取投影基线。
 *
 * 0.2.1 起 `SessionFollowFrame` 的 snapshot 分支自带
 * `projections: SessionProjectionBaseline`，所以正常情况下**不需要**再打一次
 * `sessionController.projections()`。这个函数就是那个判断：有就用，没有返回 undefined
 * 让调用方回落。
 *
 * 为什么用结构探测而不是类型收窄：本插件刻意不 import `@deepseek-ai/*`，
 * `snapshot` 在这里是结构类型，看不到内核的判别联合。按形状判断是唯一办法，
 * 也与本文件其余部分的风格一致。
 */
export function projectionsOf(
  snapshot: unknown,
): { asOfSeq?: number; values: Record<string, unknown> } | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const projections = (snapshot as { projections?: unknown }).projections
  if (projections === null || typeof projections !== 'object') return undefined
  const values = (projections as { values?: unknown }).values
  if (values === null || typeof values !== 'object') return undefined
  const asOfSeq = (projections as { asOfSeq?: unknown }).asOfSeq
  return {
    ...(typeof asOfSeq === 'number' ? { asOfSeq } : {}),
    values: values as Record<string, unknown>,
  }
}

/**
 * 读会话的**投影基线**（`permissions` / `modelSelection` / `title` …）。
 *
 * @patch
 * id: history-projections-passthrough
 * for: 内核 `sessionController.follow()` 的 snapshot 与 `page()` 都**不返回 projections**
 *      （0.2.0 的类型上就是 `{ cursor, records, hasMore }`），而客户端要靠
 *      `projections.values.permissions` 才能显示会话的当前权限档位。
 *      内核那边确实注册了这条投影（`dsh-permission-presets` 里
 *      `ctx.sessionProjections.register({ key: 'permissions', … })`），
 *      只是它**不在 history 通道上** —— 必须单独问一次 `sessionController.projections()`。
 * why: 没有正规写法：history 端点拿不到投影，只能补一次调用。
 *      不补的后果是 Android 客户端的权限档位 Pill 与 ⋯ 菜单权限项**从不渲染**
 *      —— v2.2.44 真机验收实测到了这个，而当时 `PARITY.md` 还把它标成 `done`。
 * until: 内核把 projections 并进 follow/page 的返回。
 *       **0.2.1 已达成**：snapshot 分支现在自带 `projections`，history 首屏走
 *       `projectionsOf(snapshot)`，不再打这次 RPC。本函数降级为**老内核回落路径**，
 *       保留到最低支持版本升过 0.2.1 之后再删。
 * test: tests/history-projections.spec.ts
 */
export async function readSessionProjections(
  host: Dsh02HostServices,
  sessionId: string,
  signal: AbortSignal,
): Promise<{ asOfSeq?: number; values: Record<string, unknown> } | undefined> {
  try {
    const baseline = await host.sessionController.projections({ sessionId }, signal)
    if (baseline === null || baseline === undefined) return undefined
    const values = baseline.values
    if (values === undefined || values === null || typeof values !== 'object') return undefined
    return {
      ...(typeof baseline.asOfSeq === 'number' ? { asOfSeq: baseline.asOfSeq } : {}),
      values: values as Record<string, unknown>,
    }
  } catch {
    // 投影取不到**绝不能**把整份历史打掉：历史是主功能，档位是附加信息。
    // 取不到就是「这次没有投影」，客户端会据此走降级路径（只显示得出来的那部分）。
    return undefined
  }
}
