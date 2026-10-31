/**
 * 模型目录补容：目录条目不带 `contextWindow`/`maxTokens`，按需走
 * `llm.resolveModelInfo` 补齐（带 TTL 缓存，不缓存失败）。
 * （原 `dsh-0.2-bridge.ts` 内的容量区，#2 拆分时原样搬出。）
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


// ── model capacity enrichment ─────────────────────────────────────────────

/**
 * 容量元数据的缓存寿命。
 *
 * 与内核 `dsh-llm` 的 `DEFAULT_MODELS_MAX_AGE_MS = 600000` 对齐：那边是模型
 * **列表**的新鲜度，这边是**单个模型容量**的新鲜度，同一批配置变动（改
 * baseURL、换 API key、升级内核）会同时让两者失效，跟齐一个数量级最不容易
 * 出现「列表变了容量没变」的错配。
 */
const MODEL_CAPACITY_TTL_MS = 600_000

/** 缓存条目上限；只是防内存无界，正常部署里 provider×model 远小于这个数。 */
const MODEL_CAPACITY_CACHE_LIMIT = 512

export interface ModelCapacity {
  /** 上下文容量（请求 + 响应合计 token）。内核不知道时不填。 */
  contextWindow?: number
  /** adapter 的每请求默认输出上限。内核不知道时不填。 */
  maxTokens?: number
}

export const modelCapacityCache = new Map<string, { at: number; capacity: ModelCapacity }>()

/**
 * 把一个模型条目的容量字段补齐。
 *
 * **为什么不能直接从 `modelCatalog()` 拿**：0.2.x 的 `ModelCatalogModel` 只有
 * `{ id, name, description?, reasoning? }` —— 目录里没有 `contextWindow` /
 * `maxTokens` / `inputModalities`。这三个只在 `LlmResolvedModelInfo` 里，得走
 * `llm.resolveModelInfo(provider, model)`。目录条目自带容量是 1.x 的旧形状。
 *
 * 失败一律退回「不填」：模型选择器少显示一行容量，比整张目录报错好得多。
 * 注意**不缓存失败**——一次瞬时 RPC 抖动不该让某个模型十分钟没有容量。
 */
export async function modelCapacityOf(
  host: Dsh02HostServices,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<ModelCapacity> {
  const key = `${provider}\u0000${model}`
  const cached = modelCapacityCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < MODEL_CAPACITY_TTL_MS) {
    return cached.capacity
  }
  let capacity: ModelCapacity = {}
  try {
    const info = await host.llm.resolveModelInfo(provider, model, signal)
    const contextWindow = info?.context?.contextWindow
    const maxTokens = info?.defaultMaxTokens
    capacity = {
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
      ...(typeof maxTokens === 'number' && maxTokens > 0 ? { maxTokens } : {}),
    }
  } catch {
    // 元数据是锦上添花：查询失败就当作内核没声明，不要冒泡。
    return {}
  }
  if (modelCapacityCache.size >= MODEL_CAPACITY_CACHE_LIMIT) {
    const oldest = modelCapacityCache.keys().next()
    if (oldest.done !== true) modelCapacityCache.delete(oldest.value)
  }
  modelCapacityCache.set(key, { at: Date.now(), capacity })
  return capacity
}

/**
 * 给一张 provider group 列表补容量字段。
 *
 * 并发查而不是串行：目录动辄几十个模型，串行 RPC 会把模型选择器拖成几秒空白。
 * 单个模型失败不影响其他模型（`modelCapacityOf` 内部吞掉）。
 *
 * 对**形状**宽容：`groups` 是 `unknown`（内核给什么形状就是什么形状，我们只
 * 投影自己认识的字段），认不出来的条目原样透传，保证向前兼容。
 */
export async function enrichModelGroups<T>(
  host: Dsh02HostServices,
  groups: readonly T[],
  signal?: AbortSignal,
): Promise<T[]> {
  return Promise.all(groups.map(async group => {
    if (typeof group !== 'object' || group === null) return group
    const view = group as { id?: unknown; models?: unknown }
    const providerId = typeof view.id === 'string' ? view.id : undefined
    if (providerId === undefined || !Array.isArray(view.models)) return group
    const models = await Promise.all((view.models as readonly unknown[]).map(async model => {
      if (typeof model !== 'object' || model === null) return model
      const entry = model as { id?: unknown; contextWindow?: unknown; maxTokens?: unknown }
      const modelId = typeof entry.id === 'string' ? entry.id : undefined
      if (modelId === undefined) return model
      // 内核（或未来的内核）自己给了就别覆盖：那是更权威的来源。
      const capacity = await modelCapacityOf(host, providerId, modelId, signal)
      const filled: ModelCapacity = {
        ...(entry.contextWindow === undefined && capacity.contextWindow !== undefined
          ? { contextWindow: capacity.contextWindow }
          : {}),
        ...(entry.maxTokens === undefined && capacity.maxTokens !== undefined
          ? { maxTokens: capacity.maxTokens }
          : {}),
      }
      if (filled.contextWindow === undefined && filled.maxTokens === undefined) return model
      return { ...model, ...filled }
    }))
    return { ...group, models } as T
  }))
}
