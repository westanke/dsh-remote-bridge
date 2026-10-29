import { describe, expect, it } from 'vitest'
import {
  BRIDGE_CAPABILITIES,
  availableCapabilities,
  connectionReadyData,
} from '../src/host/capabilities.ts'

/**
 * 能力位的**运行时过滤**（FUNC-1）。
 *
 * ## 修的是什么
 *
 * `connection.ready` 此前**永远**宣告全部能力位，包括三个 `job-*-v1`。
 * 而 `jobController` 是可选宿主服务：0.2.0-rc.2 上没有它，`index.ts` 干脆
 * 不挂 jobs 端点（路由 404）。于是客户端按能力位探测后去打一个**必然 404**
 * 的端点 —— 这恰好是这份清单本身想消灭的那种「静默少一个功能」
 * （见 `capabilities.ts` 文件头：能力位存在的意义就是让客户端区分
 * 「服务端不支持」与「本来就没有」）。
 *
 * ## 这里钉住的三件事
 *
 * 1. `jobs: false` 时三个 job 位**不在**列表；
 * 2. 其余位**一个不少**（过滤不能变成「顺手删别的」）；
 * 3. 缺省（不传参）时保持全量 —— 老调用点、测试替身的行为一字不变。
 */

describe('capability filtering at connection time', () => {
  it('omits the three job capabilities when the job controller is absent', () => {
    const caps = availableCapabilities({ jobs: false })
    expect(caps).not.toContain('job-list-v1')
    expect(caps).not.toContain('job-output-v1')
    expect(caps).not.toContain('job-kill-v1')
    // 三个都该没了，且只有这三个没了 —— 差集必须精确等于 3。
    expect(BRIDGE_CAPABILITIES.length - caps.length).toBe(3)
  })

  it('keeps every other capability intact when jobs are unavailable', () => {
    const caps = availableCapabilities({ jobs: false })
    const expected = BRIDGE_CAPABILITIES.filter(capability => !capability.startsWith('job-'))
    expect(caps).toEqual(expected)
    // 尤其是这两条客户端硬依赖的位：缺了它们，App 会对**所有用户**
    // 误报「插件过旧、审批与问答卡片不会出现」。
    expect(caps).toContain('approvals-v1')
    expect(caps).toContain('questions-v1')
    expect(caps).toContain('session-archive-list-v1')
  })

  /**
   * 新三位的运行时过滤：`schedule` 与宿主 `ctx.schedule` 同生死（没有它，
   * 列表与新建都只会 503）；`speech` 只在网关整体缺失时剔除（内核没装语音包时
   * 目录仍回 200 `available:false`，客户端要能区分「支持但没配」与「不支持」）。
   */
  it('drops only the schedule capability when the host schedule service is absent', () => {
    const caps = availableCapabilities({ schedule: false })
    expect(caps).not.toContain('chat-schedules-v1')
    // 差集精确等于 1：不能顺手删掉语音或分块上传。
    expect(BRIDGE_CAPABILITIES.length - caps.length).toBe(1)
    expect(caps).toContain('speech-transcription-v1')
    expect(caps).toContain('attachment-chunked-upload-v1')
  })

  it('drops only the speech capability when the kernel gateway is absent', () => {
    const caps = availableCapabilities({ speech: false })
    expect(caps).not.toContain('speech-transcription-v1')
    expect(BRIDGE_CAPABILITIES.length - caps.length).toBe(1)
    expect(caps).toContain('attachment-chunked-upload-v1')
    expect(caps).toContain('chat-schedules-v1')
  })

  it('declares all capabilities when jobs are available', () => {
    expect(availableCapabilities({ jobs: true })).toEqual([...BRIDGE_CAPABILITIES])
  })

  it('defaults to the full list so old call sites keep their behaviour', () => {
    // 缺省必须保守地全给：`connectionReadyData()` 不带参的调用点（含既有测试）
    // 拿到的仍是完整清单 —— 否则这个改动会悄悄改掉所有既有期望。
    expect(connectionReadyData().capabilities).toEqual([...BRIDGE_CAPABILITIES])
    expect(connectionReadyData({}).capabilities).toEqual([...BRIDGE_CAPABILITIES])
    // 不传键（而不是显式传 undefined —— `exactOptionalPropertyTypes` 下那是另一种类型）
    // 也按「没声明」处理，与既有调用点一致。
    expect(availableCapabilities({})).toEqual([...BRIDGE_CAPABILITIES])
  })

  it('hands out a fresh array each time so callers cannot mutate the constant', () => {
    const first = connectionReadyData({ jobs: true })
    first.capabilities.push('bogus-v1')
    expect(BRIDGE_CAPABILITIES).not.toContain('bogus-v1')
    expect(connectionReadyData({ jobs: true }).capabilities).not.toContain('bogus-v1')
  })

  it('reports the plugin version alongside the filtered list', () => {
    const data = connectionReadyData({ jobs: false })
    expect(typeof data.bridgeVersion).toBe('string')
    expect(data.bridgeVersion).not.toBe('')
    expect(data.capabilities).not.toContain('job-list-v1')
  })
})
