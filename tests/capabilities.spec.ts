import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRIDGE_CAPABILITIES, connectionReadyData, HISTORY_FORMAT_VERSION } from '../src/host/capabilities.ts'
import { PLUGIN_VERSION } from '../src/shared/version.ts'

const openapi = readFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8')
const asyncapi = readFileSync(new URL('../docs/api/asyncapi.yaml', import.meta.url), 'utf8')

/**
 * 每个能力位的**依据**：它承诺的东西在契约文件里出现的字面量。
 *
 * 这张表是刻意手写的（不是从 openapi 自动推出来的）：
 * 自动推只能证明「路径存在」，证明不了「这条路径支撑的就是这个能力」。
 * 手写 + 双向断言（能力位少了/多了都红）才能把声明钉在契约上。
 */
const EVIDENCE: Record<string, { openapi?: string[]; asyncapi?: string[] }> = {
  'device-pairing-v1': { openapi: ['/pairings/exchange', '/devices/self'] },
  'file-browse-v1': { openapi: ['/roots/{rootId}/entries', '/roots/{rootId}/content'] },
  'file-write-v1': { openapi: ['/roots/{rootId}/entries', '/roots/{rootId}/content'] },
  'file-trash-v1': { openapi: ['/trash', '/trash/{trashId}/restore'] },
  'session-list-v1': { openapi: ['/chat/sessions'] },
  'session-rename-v1': { openapi: ['/chat/sessions/{sessionId}'] },
  'session-fork-v1': { openapi: ['/chat/sessions/{sessionId}/fork'] },
  'session-archive-v1': { openapi: ['/chat/sessions/{sessionId}/archive'] },
  // 依据是那个 query 参数本身（路径与 session-list-v1 共用，靠参数名区分能力）。
  'session-archive-list-v1': { openapi: ['name: archived'] },
  'history-v1': { openapi: ['/chat/sessions/{sessionId}/messages'] },
  'turn-cancel-v1': { openapi: ['/chat/runs/{id}/cancel'] },
  'session-config-v1': {
    openapi: ['/chat/sessions/{sessionId}/model', '/chat/sessions/{sessionId}/agent-preset'],
  },
  'commands-v1': { openapi: ['/chat/sessions/{sessionId}/commands'] },
  'agent-presets-v1': { openapi: ['/chat/agent-presets'] },
  'workspace-list-v1': { openapi: ['/chat/workspaces'] },
  'workspace-manage-v1': { openapi: ['/chat/workspaces/{workspaceId}'] },
  'provider-settings-v1': {
    openapi: ['/settings/providers', '/settings/providers/{providerId}/discover'],
  },
  'model-catalog-v1': { openapi: ['/settings/models'] },
  'plugin-inventory-v1': { openapi: ['/settings/plugins'] },
  'plugin-toggle-v1': { openapi: ['/settings/plugins'] },
  // 依据是这两条路径本身；`/settings/namespaces/{ns}` 与 `/settings/namespaces` 是两个独立
  // 能力动作（读全表 / 按 ns 写），但同属一个能力面，故合成一条位。
  'settings-namespaces-v1': {
    openapi: ['/settings/namespaces', '/settings/namespaces/{ns}'],
  },
  'approvals-v1': {
    openapi: [
      '/chat/sessions/{sessionId}/approvals',
      '/chat/sessions/{sessionId}/approvals/{approvalId}/decision',
    ],
  },
  'questions-v1': {
    openapi: [
      '/chat/sessions/{sessionId}/questions',
      '/chat/sessions/{sessionId}/questions/{callId}/answer',
    ],
  },
  'turn-failure-v1': { asyncapi: ['chat.turn.failed'] },
  'session-snapshot-v1': { asyncapi: ['chat.session.snapshot'] },
  // 这两条是**行为保证**，不新增路径/事件，因此没有契约字面量可指：
  // 它们的依据在源码（history-budget.ts / chat-adapter 的 replay 方法）与 API.md 的说明里。
  'history-byte-budget-v1': {},
  'interaction-replay-v1': {},
  // 后台任务：三条能力位分别指向自己的端点（list / output / kill 形态不同，
  // 合并成一条会让「只有 kill 可用」的中间态被误判成完整可用）。
  'job-list-v1': { openapi: ['/chat/sessions/{sessionId}/jobs'] },
  'job-output-v1': { openapi: ['/chat/sessions/{sessionId}/jobs/{jobId}/output'] },
  'job-kill-v1': { openapi: ['/chat/sessions/{sessionId}/jobs/{jobId}/kill'] },
}

describe('bridge capability declaration', () => {
  it('uses one naming scheme and no duplicates', () => {
    expect(new Set(BRIDGE_CAPABILITIES).size).toBe(BRIDGE_CAPABILITIES.length)
    for (const capability of BRIDGE_CAPABILITIES) {
      expect(capability, capability).toMatch(/^[a-z][a-z0-9-]*-v\d+$/)
    }
  })

  it('lets every declared capability point at a literal in the contract files', () => {
    for (const capability of BRIDGE_CAPABILITIES) {
      const evidence = EVIDENCE[capability]
      expect(evidence, `能力位 ${capability} 没有写依据`).toBeDefined()
      for (const literal of evidence?.openapi ?? []) {
        expect(openapi, `${capability} 声称的 ${literal} 不在 openapi.yaml 里`).toContain(literal)
      }
      for (const literal of evidence?.asyncapi ?? []) {
        expect(asyncapi, `${capability} 声称的 ${literal} 不在 asyncapi.yaml 里`).toContain(literal)
      }
    }
  })

  /**
   * 反向断言：依据表里**不许有孤儿**。
   *
   * 少了能力位却留着依据（或加了依据忘了加能力位）会让这张表慢慢变成摆设，
   * 而摆设比没有更糟 —— 它会让人以为「有测试在守」。
   */
  it('has no orphan evidence entries', () => {
    expect(Object.keys(EVIDENCE).sort()).toEqual([...BRIDGE_CAPABILITIES].sort())
  })

  it('reports the plugin version alongside the capabilities', () => {
    const data = connectionReadyData()
    expect(data.bridgeVersion).toBe(PLUGIN_VERSION)
    expect(data.capabilities).toEqual([...BRIDGE_CAPABILITIES])
  })

  /** 返回副本：调用方改它不能污染常量（否则一次手滑影响后续所有连接）。 */
  it('hands out a copy the caller cannot mutate', () => {
    connectionReadyData().capabilities.push('bogus-v1')
    expect(BRIDGE_CAPABILITIES).not.toContain('bogus-v1')
    expect(connectionReadyData().capabilities).not.toContain('bogus-v1')
  })

  /**
   * 跨仓契约钉子：姊妹仓 `dsh-companion` 的 `REQUIRED_CAPABILITIES` 里**写死了**这两个名字 ——
   * 清单里缺任意一个，客户端就会显示「插件过旧、审批与问答卡片不会出现」。
   * 也就是说：删掉它们不是内部重构，而是让客户端对**所有用户**误报。
   */
  it('keeps the two capabilities the Android app treats as required', () => {
    expect(BRIDGE_CAPABILITIES).toContain('approvals-v1')
    expect(BRIDGE_CAPABILITIES).toContain('questions-v1')
  })

  it('declares a positive integer history format version', () => {
    expect(Number.isSafeInteger(HISTORY_FORMAT_VERSION)).toBe(true)
    expect(HISTORY_FORMAT_VERSION).toBeGreaterThan(0)
  })
})
