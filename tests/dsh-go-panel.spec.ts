import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  accessData,
  accessView,
  attachDshGoPanel,
  copyText,
  PANEL_ID,
  readState,
  STRIP_ID,
  stripData,
  words,
  type AccessSource,
  type DshGoService,
} from '../src/host/dsh-go-panel.ts'
import type { DeviceView } from '../src/shared/contracts.ts'

/**
 * dsh-Go 原生界面的测试。
 *
 * 守三件事：
 *
 * 1. **协议预算**：视图 ≤ 32 KiB / 120 节点、状态条文字 ≤ 24 字、复制文本 ≤ 8000 字、
 *    清单 ≤ 16 KiB 且长度上限（panel 标题 16、面板 ≤ 4、strip ≤ 1）。这些数字是 App 的硬上限，
 *    超了不是「显示得丑」，是被截断或整块丢弃。
 * 2. **只读**：面板与状态条里出现的效果只有 copy/toast —— 放写操作等于让任意 dsh-Go 客户端
 *    绕过管理面鉴权改本插件的安全状态（理由写在 src/host/dsh-go-panel.ts 头注释）。
 * 3. **注册失败不外溢**：没有注入器、桥接拒绝注册、回调内部抛错，都只能 warn，
 *    不能让 apply 抛错（那会拆掉整个 fiber，见 PITFALLS「apply 尾部抛错会留下半死桥」）。
 */

const device = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: 'dev-1',
  name: 'Pixel 9',
  scopes: ['chat.read', 'chat.write'],
  rootIds: [],
  createdAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_060_000,
  platform: 'android',
  model: 'Pixel 9',
  ...over,
} as DeviceView)

function source(over: Partial<{ remoteEnabled: boolean; tunnelRunning: boolean; tunnelUrl: string | null; roots: number; devices: DeviceView[] }> = {}): AccessSource {
  const state = {
    remoteEnabled: true,
    tunnelRunning: false,
    tunnelUrl: null as string | null,
    roots: 1,
    devices: [device()],
    ...over,
  }
  return {
    status: () => ({ host: '0.0.0.0', port: 3090, remoteEnabled: state.remoteEnabled }),
    tunnel: () => ({ running: state.tunnelRunning, url: state.tunnelUrl }),
    roots: () => state.roots,
    devices: () => state.devices,
  }
}

/** 固定的「现在」，让相对时间可断言（设备清单最多 8 行，台数的断言也按这个上限写）。 */
const NOW = 1_700_000_100_000

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

function countNodes(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce<number>((sum, item) => sum + countNodes(item), 0)
  const record = node as Record<string, unknown>
  let total = 1
  if (typeof record['type'] === 'string') {
    for (const [key, value] of Object.entries(record)) {
      if (key === 'type') continue
      total += countNodes(value)
    }
    return total
  }
  for (const value of Object.values(record)) total += countNodes(value)
  return total
}

/** 视图里出现的一切 action 名（点按时要能被 def.actions 接住）。 */
function actionIds(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) actionIds(item, found)
    return found
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'action' && typeof value === 'string') found.push(value)
    else actionIds(value, found)
  }
  return found
}

describe('readState', () => {
  it('远程访问关着时不给接入地址，只报监听地址', () => {
    const state = readState(source({ remoteEnabled: false }))
    expect(state.remoteEnabled).toBe(false)
    expect(state.endpoints).toEqual([])
    expect(state.host).toBe('0.0.0.0')
    expect(state.port).toBe(3090)
  })

  it('远程访问开着时接入地址是数组（有多少网卡给多少个）', () => {
    const state = readState(source())
    expect(Array.isArray(state.endpoints)).toBe(true)
    for (const endpoint of state.endpoints) expect(endpoint).toMatch(/^https?:\/\//)
  })

  it('设备只留显示用的字段，令牌与权限位不进面板', () => {
    const state = readState(source())
    expect(Object.keys(state.devices[0] ?? {}).sort()).toEqual(['id', 'lastSeenAt', 'model', 'name', 'platform'])
  })

  it('设备清单有行数上限（手机一屏），超出部分不画', () => {
    const many = Array.from({ length: 40 }, (_, index) => device({ id: `dev-${index}`, name: `设备 ${index}` }))
    expect(readState(source({ devices: many })).devices).toHaveLength(8)
  })

  it('设备缺字段时不会塞一个 undefined 进去（exactOptionalPropertyTypes）', () => {
    // 直接写字面量而不是 `device({ platform: undefined })`：`exactOptionalPropertyTypes` 下
    // 「把可选属性显式赋 undefined」本身就不合法，用它来测「不塞 undefined」是矛盾的。
    const bare: DeviceView = {
      id: 'dev-1',
      name: 'Pixel 9',
      scopes: ['chat.read', 'chat.write'],
      rootIds: [],
      createdAt: 1_700_000_000_000,
    }
    const state = readState(source({ devices: [bare] }))
    expect(state.devices[0]).toEqual({ id: 'dev-1', name: 'Pixel 9' })
  })
})

describe('stripData', () => {
  it('开着时报状态与台数，且不超过 24 字', () => {
    const data = stripData(readState(source({ devices: [device(), device({ id: 'dev-2' })] })), 'zh')
    expect(data.text).toBe('远程已开 · 2 台')
    expect(Array.from(data.text).length).toBeLessThanOrEqual(24)
    expect(data.tone).toBe('good')
  })

  it('没有配对设备时只说「远程已开」，不报 0 台', () => {
    expect(stripData(readState(source({ devices: [] })), 'zh').text).toBe('远程已开')
  })

  it('关着时说「仅本机」', () => {
    const data = stripData(readState(source({ remoteEnabled: false })), 'zh')
    expect(data.text).toBe('仅本机')
    expect(data.tone).toBe('muted')
  })

  it('英文不超过 24 字符', () => {
    const data = stripData(readState(source({ devices: Array.from({ length: 12 }, (_, index) => device({ id: `d${index}` })) })), 'en')
    expect(data.text.length).toBeLessThanOrEqual(24)
    expect(data.text).toBe('Remote on · 8')
  })
})

describe('accessData', () => {
  it('开着：状态带设备数、地址取第一个局域网、隧道报未开启', () => {
    const data = accessData(readState(source()), 'zh')
    expect(data['statusTone']).toBe('good')
    expect(data['statusText']).toContain('已授权 1 台设备')
    expect(data['port']).toBe('3090')
    expect(data['deviceCount']).toBe('1 台')
    expect(data['rootCount']).toBe('1 个')
    expect(data['listen']).toBe('0.0.0.0:3090')
    expect(String(data['endpoint'])).toMatch(/^(https?:\/\/|http:\/\/127\.0\.0\.1:3090$)/)
    expect(data['tunnel']).toBe('未开启')
  })

  it('关着：状态说清「为什么现在没开」，并提示根目录也没配', () => {
    const data = accessData(readState(source({ remoteEnabled: false, roots: 0 })), 'zh')
    expect(data['statusTone']).toBe('info')
    expect(String(data['statusText'])).toContain('还没有授权根目录')
    expect(data['endpoint']).toBe('http://127.0.0.1:3090')
  })

  it('隧道开着时显示地址而不是「已开启」', () => {
    const data = accessData(readState(source({ tunnelRunning: true, tunnelUrl: 'https://x.trycloudflare.com' })), 'zh')
    expect(data['tunnel']).toBe('https://x.trycloudflare.com')
  })

  it('设备行带平台/型号与相对时间；从没连过写「从未」', () => {
    const fresh = accessData(readState(source({ devices: [device()] }), NOW), 'zh')
    expect((fresh['devices'] as Array<{ subtitle: string }>)[0]?.subtitle).toBe('android · Pixel 9 · 刚刚')

    const idle = accessData(readState(source({ devices: [device({ lastSeenAt: 0 })] }), NOW), 'zh')
    expect((idle['devices'] as Array<{ subtitle: string }>)[0]?.subtitle).toBe('android · Pixel 9 · 从未')

    const aged = accessData(readState(source({ devices: [device({ lastSeenAt: NOW - 3 * 24 * 3_600_000 })] }), NOW), 'zh')
    expect((aged['devices'] as Array<{ subtitle: string }>)[0]?.subtitle).toBe('android · Pixel 9 · 3 天前')
  })

  it('数据包在 32 KiB 以内（数据上限）', () => {
    const many = Array.from({ length: 8 }, (_, index) => device({ id: `d${index}`, name: 'x'.repeat(200) }))
    expect(byteLength(accessData(readState(source({ devices: many })), 'zh'))).toBeLessThan(32 * 1024)
  })

  it('英文文案走 en', () => {
    const data = accessData(readState(source(), NOW), 'en')
    expect(data['deviceCount']).toBe('1')
    expect(data['rootCount']).toBe('1')
    expect((data['devices'] as Array<{ subtitle: string }>)[0]?.subtitle).toBe('android · Pixel 9 · Just now')
  })
})

describe('accessView', () => {
  it('视图在预算内：≤ 32 KiB、≤ 120 节点', () => {
    const view = accessView('zh')
    expect(byteLength(view)).toBeLessThan(32 * 1024)
    expect(countNodes(view)).toBeLessThanOrEqual(120)
  })

  it('标题不超过 16 字（panelTitle 上限）', () => {
    expect(Array.from(words('zh').title).length).toBeLessThanOrEqual(16)
    expect(Array.from(words('en').title).length).toBeLessThanOrEqual(16)
  })

  it('所有数值走绑定，不把读数写死进视图', () => {
    const rendered = JSON.stringify(accessView('zh'))
    // 端口/台数/地址/隧道全部要以 {$:"data.*"} 出现，否则数值刷新只能靠整棵树重发。
    for (const key of ['statusTone', 'statusText', 'port', 'deviceCount', 'rootCount', 'listen', 'endpoint', 'tunnel', 'devices']) {
      expect(rendered).toContain(`"$":"data.${key}"`)
    }
  })

  it('唯一的动作是 copy，与 panel 定义里的 actions 对得上', () => {
    expect(actionIds(accessView('zh'))).toEqual(['copy'])
  })

  it('中文与英文视图结构一致（只有文字不同）', () => {
    const strip = (node: unknown): unknown => {
      if (node === null || typeof node !== 'object') return typeof node === 'string' ? '*' : node
      if (Array.isArray(node)) return node.map(strip)
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        // 文字、动作标签随语言变；keyValue 的「名」是文字对，值可以是绑定。
        out[key] = key === 'text' || key === 'title' || key === 'label' ? '*' : strip(value)
      }
      return out
    }
    expect(strip(accessView('en'))).toEqual(strip(accessView('zh')))
  })
})

describe('copyText', () => {
  it('多行列出监听/地址/隧道/设备，且不超 8000 字', () => {
    const text = copyText(readState(source({ tunnelRunning: true, tunnelUrl: 'https://x.trycloudflare.com' })), 'zh')
    expect(text.split('\n')[0]).toBe('dsh-remote-bridge 接入信息')
    expect(text).toContain('监听: 0.0.0.0:3090')
    expect(text).toContain('https://x.trycloudflare.com')
    expect(text).toContain('- Pixel 9')
    expect(text.length).toBeLessThanOrEqual(8000)
  })

  it('设备很多时也不超 8000 字', () => {
    const many = Array.from({ length: 8 }, (_, index) => device({ id: `d${index}`, name: '很长的设备名'.repeat(20) }))
    expect(copyText(readState(source({ devices: many })), 'zh').length).toBeLessThanOrEqual(8000)
  })
})

describe('attachDshGoPanel', () => {
  interface Captured {
    panels: Map<string, { view: (scope: unknown, caps?: { locale?: string }) => unknown; data: (scope: unknown, emit: (d: Record<string, unknown>) => void, caps?: { locale?: string }) => (() => void) | undefined; actions: Record<string, (scope: unknown, event?: { locale?: string }) => unknown> }>
    strips: Map<string, (scope: unknown, emit: (d: Record<string, unknown>) => void, caps?: { locale?: string }) => (() => void) | undefined>
  }

  function host(captured: Captured, options: { inject?: boolean; throwOnPanel?: boolean } = {}) {
    const service: DshGoService = {
      panel: (id, definition) => {
        if (options.throwOnPanel === true) throw new Error('bridge said no')
        captured.panels.set(id, definition)
      },
      strip: (id, data) => { captured.strips.set(id, data) },
    }
    const warn = vi.fn()
    const ctx = options.inject === false
      ? {}
      : {
          inject: (dependencies: readonly string[], register: (scope: { dshGo: DshGoService }) => void) => {
            expect(dependencies).toEqual(['dshGo'])
            register({ dshGo: service })
          },
        }
    return { ctx, warn }
  }

  it('注册面板与状态条，id 与清单常量一致', () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx } = host(captured)
    attachDshGoPanel(ctx, source())
    expect([...captured.panels.keys()]).toEqual([PANEL_ID])
    expect([...captured.strips.keys()]).toEqual([STRIP_ID])
  })

  it('视图与动作直接可用：copy 回 copy + toast', () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx } = host(captured)
    attachDshGoPanel(ctx, source())
    const definition = captured.panels.get(PANEL_ID)
    expect(definition).toBeDefined()
    expect(definition?.view(undefined, { locale: 'zh' })).toEqual(accessView('zh'))
    const effects = definition?.actions['copy']?.(undefined, { locale: 'zh' }) as Array<{ type: string; text: string }>
    expect(effects.map(effect => effect.type)).toEqual(['copy', 'toast'])
    expect(effects[0]?.text).toContain('dsh-remote-bridge 接入信息')
    expect(Array.from(effects[1]?.text ?? '').length).toBeLessThanOrEqual(40)
  })

  it('数据只在值变化时发：同一状态第二次不 emit', () => {
    vi.useFakeTimers()
    try {
      const captured: Captured = { panels: new Map(), strips: new Map() }
      const { ctx } = host(captured)
      attachDshGoPanel(ctx, source())
      const emit = vi.fn()
      const stop = captured.panels.get(PANEL_ID)?.data(undefined, emit, { locale: 'zh' })
      expect(emit).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(30_000)
      expect(emit).toHaveBeenCalledTimes(1)
      stop?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('清理后不再轮询', () => {
    vi.useFakeTimers()
    try {
      const captured: Captured = { panels: new Map(), strips: new Map() }
      const { ctx } = host(captured)
      attachDshGoPanel(ctx, source())
      const emit = vi.fn()
      const stop = captured.strips.get(STRIP_ID)?.(undefined, emit, { locale: 'zh' })
      expect(emit).toHaveBeenCalledTimes(1)
      stop?.()
      vi.advanceTimersByTime(60_000)
      expect(emit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('状态变了才发新数据', () => {
    vi.useFakeTimers()
    try {
      let devices: DeviceView[] = [device()]
      const src: AccessSource = {
        status: () => ({ host: '0.0.0.0', port: 3090, remoteEnabled: true }),
        tunnel: () => ({ running: false, url: null }),
        roots: () => 1,
        devices: () => devices,
      }
      const captured: Captured = { panels: new Map(), strips: new Map() }
      const { ctx } = host(captured)
      attachDshGoPanel(ctx, src)
      const emit = vi.fn()
      const stop = captured.strips.get(STRIP_ID)?.(undefined, emit, { locale: 'zh' })
      devices = []
      vi.advanceTimersByTime(10_000)
      expect(emit).toHaveBeenCalledTimes(2)
      expect((emit.mock.calls[1]?.[0] as { text: string }).text).toBe('远程已开')
      stop?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('宿主没有注入器时什么都不做，也不抛错', () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx } = host(captured, { inject: false })
    expect(() => attachDshGoPanel(ctx, source())).not.toThrow()
    expect(captured.panels.size).toBe(0)
  })

  it('桥接拒绝注册时只 warn，绝不上抛', () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx, warn } = host(captured, { throwOnPanel: true })
    expect(() => attachDshGoPanel(ctx, source(), { warn })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0]?.message)).toContain('panel registration failed')
    expect(captured.strips.size).toBe(0)
  })
})

describe('package.json 的 dshGo 清单', () => {
  const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    version: string
    dshGo?: Record<string, unknown>
  }
  const manifest = pkg.dshGo as {
    v: number
    title: Record<string, string>
    icon: string
    contributes: {
      panels: Array<{ id: string; title: Record<string, string>; icon: string; placement: string[] }>
      'composer.strip': Array<{ id: string; icon: string; panel: string }>
    }
  }

  it('存在且协议版本是 1', () => {
    expect(pkg.version).toBe('2.17.5')
    expect(manifest?.v).toBe(1)
  })

  it('清单序列化不超过 16 KiB', () => {
    expect(Buffer.byteLength(JSON.stringify(manifest), 'utf8')).toBeLessThanOrEqual(16 * 1024)
  })

  it('id / icon / 标题长度都合格', () => {
    const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
    const iconPattern = /^[a-z][a-z0-9-]{0,31}$/
    expect(manifest.icon).toMatch(iconPattern)
    for (const panel of manifest.contributes.panels) {
      expect(panel.id).toMatch(idPattern)
      expect(panel.icon).toMatch(iconPattern)
      expect(Object.values(panel.title).every(text => Array.from(text).length <= 16)).toBe(true)
    }
    for (const strip of manifest.contributes['composer.strip']) {
      expect(strip.id).toMatch(idPattern)
      expect(strip.icon).toMatch(iconPattern)
    }
    expect(Array.from(Object.values(manifest.title).map(text => text.length)).every(length => length <= 24)).toBe(true)
  })

  it('预算内：面板 ≤ 4、状态条 ≤ 1，且 id 全局唯一', () => {
    expect(manifest.contributes.panels.length).toBeLessThanOrEqual(4)
    expect(manifest.contributes['composer.strip'].length).toBeLessThanOrEqual(1)
    const ids = [
      ...manifest.contributes.panels.map(panel => panel.id),
      ...manifest.contributes['composer.strip'].map(strip => strip.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('状态条点了打开自己的面板，且面板/状态条 id 与代码常量一致', () => {
    const strip = manifest.contributes['composer.strip'][0]
    expect(strip?.id).toBe(STRIP_ID)
    expect(strip?.panel).toBe(PANEL_ID)
    expect(manifest.contributes.panels[0]?.id).toBe(PANEL_ID)
  })

  it('placement 只用协议允许的取值', () => {
    const allowed = new Set(['session.tab', 'features', 'chat.panel', 'plugin'])
    for (const panel of manifest.contributes.panels) {
      expect(panel.placement.length).toBeGreaterThan(0)
      for (const placement of panel.placement) expect(allowed.has(placement)).toBe(true)
    }
  })
})
