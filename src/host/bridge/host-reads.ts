/**
 * 宿主读取助手：会话 id 规整、归档会话列表与 Agent 解析（原工厂内联的
 * `agentFor`/`agentForQuestions`，拆分时包装成显式参数的函数，行为不变）。
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
import type { Dsh02HostServices, WorkspaceRegistryLike } from './kernel-services.ts'
import { isAgentUnavailable } from './rpc.ts'


/**
 * Best-effort projection of an Agent identity to its session id.
 *
 * 内核侧有两个真相来源，顺序不能反：
 * - `Agent.id` **就是** `SessionId`（`dsh-agent/lib/types/types.d.ts:11-14` 的
 *   `readonly id: SessionId`，运行时由 `dsh-agent-loop/lib/index.js:773` 的
 *   `this.id = id` 赋值）。这是直给的那个，必须第一个查；
 * - `agent.session` 是 `dsh-session` 的 **class** `Session`，它**没有** `id` 属性 ——
 *   session id 挂在 `header.id`（`SessionHeader.id`）。只查 `session.id` 永远落空。
 *
 * 这两条都曾经被漏掉，代价极大：审批与提问两个 waterfall 监听都以
 * 「`sessionId === undefined` → 原样交给下游」收场，于是**电脑端一切正常、手机端
 * 一张卡都没有** —— 而且失败是静默的，两侧日志都不会说一句话。
 */
export function sessionIdOfAgent(agent: unknown): string | undefined {
  if (!agent || typeof agent !== 'object') return undefined
  const candidate = agent as {
    sessionId?: unknown
    id?: unknown
    session?: { id?: unknown; header?: { id?: unknown } }
  }
  if (typeof candidate.sessionId === 'string') return candidate.sessionId
  if (typeof candidate.id === 'string') return candidate.id
  const session = candidate.session
  if (session && typeof session === 'object') {
    if (typeof session.id === 'string') return session.id
    if (session.header && typeof session.header.id === 'string') return session.header.id
  }
  return undefined
}

/** Best-effort projection of a session view to its session id. */
export function sessionIdOf(summary: unknown): string | undefined {
  if (!summary || typeof summary !== 'object') return undefined
  const id = (summary as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id : undefined
}


/**
 * 读注册表级归档集合，读不到就返回空数组。
 *
 * 让 `workspace.list` 把内核的归档状态透传给上层（chat-adapter 靠它把已归档会话
 * 从列表里滤掉）。getter 缺失（老内核、测试替身）时退化成空集合：过滤失效，
 * 但列表本身照常可读 —— 比抛错更接近旧的可用行为。
 *
 * @param registry - 内核工作区注册表（`ctx.workspaceRegistry`）。
 * @returns 归档的会话 id；字段缺失或不是字符串数组时为空数组。
 */
export function readArchivedSessionIds(registry: WorkspaceRegistryLike): string[] {
  const value = registry.archivedSessionIds
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

// ── agent resolution ──────────────────────────────────────────────────
/**
 * 解出会话背后的 Agent（原 `createDsh02ApiProxy` 内联，拆分时原样搬出；
 * `host` 由闭包改为参数，行为不变）。
 */
export function createAgentResolver(host: Dsh02HostServices): {
  agentFor(sessionId: string): Promise<unknown>
  agentForQuestions(sessionId: string): Promise<unknown | null>
} {

  /**
   * Ask the host for the Agent backing a session before agent-scoped calls.
   *
   * 🔴 `sessionController.resolveAgent()` 返回的是**包装对象**，不是 Agent 本体：
   * `{ agent }` 成功、`{ error }` 失败（内核
   * `dsh-api-session-controller/lib/index.js:365-368` 的 `liveAgent()` 与 `:221-246`
   * 的 `resolve()` 都是这个形状）。早先这里直接把包装对象当 Agent 返回，调用方读
   * `agent.session.header` 就变成读 `undefined.header`，真机上表现为
   * `DSH_TYPEERROR: Cannot read properties of undefined (reading 'header')` ——
   * 上传附件、选 agent preset 全挂在这里，而报错信息完全指不到真正的原因。
   */
  async function agentFor(sessionId: string): Promise<unknown> {
    const resolved = (await host.sessionController.resolveAgent(sessionId)) as
      | { agent?: unknown; error?: unknown }
      | null
      | undefined
    // 兼容：万一某个内核版本直接返回 Agent 本体（没有 agent/error 两个键），照旧用它。
    const wrapped = resolved !== null && typeof resolved === 'object'
      && ('agent' in resolved || 'error' in resolved)
    const failure = wrapped ? (resolved as { error?: unknown }).error : undefined
    if (failure !== undefined && failure !== null) {
      // 内核已经给了稳定的 code（如 session/not-found），原样往上抛，
      // 不要一律压成 agent-unavailable —— 那会让「会话不存在」看起来像「会话没在跑」。
      throw failure
    }
    const agent = wrapped ? (resolved as { agent?: unknown }).agent : resolved
    if (agent === undefined || agent === null) {
      throw Object.assign(new Error(`no live Agent for session ${sessionId}`), { code: 'session/agent-unavailable' })
    }
    return agent
  }

  /**
   * `agentFor` 的宽松版：把「这个会话没有 live agent」当成**正常情况**（返回 null）。
   *
   * 为什么 list 需要它：手机端会对每个会话各拉一次问题列表，而冷会话（没在跑）没有
   * agent 是常态。把常态报成错误，客户端只会看到一片红。
   * 只放过 `session/agent-unavailable` 这一个 code，其它异常照旧往上抛。
   */
  async function agentForQuestions(sessionId: string): Promise<unknown | null> {
    try {
      return await agentFor(sessionId)
    } catch (error) {
      if (isAgentUnavailable(error)) return null
      throw error
    }
  }
  return { agentFor, agentForQuestions }
}

