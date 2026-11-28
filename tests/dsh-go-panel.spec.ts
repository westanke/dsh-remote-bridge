import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  accessData,
  accessView,
  EMPTY_PAIRING_STATE,
  attachDshGoPanel,
  copyText,
  PANEL_ID,
  QR_ASSETS,
  readState,
  STRIP_ID,
  stripData,
  words,
  type AccessSource,
  type DshGoService,
  type PanelPairing,
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
 * 2. **面板不写状态**：面板自己不调 `remote.enable()` / `createPairing()`，也不出现
 *    copy/toast 之外的「本地副作用」—— dsh-Go 的连接身份是内核客户端，没有回环判据，
 *    放写操作等于让任意 dsh-Go 客户端绕过管理面鉴权（理由写在 src/host/dsh-go-panel.ts 头注释）。
 *    issue #4 起多了一个 `enable` 按钮，但它只回一条 `command` 效果（让 App 在**当前对话**里
 *    执行 `/remote`），真正的写操作落在用户自己的会话身份上 —— 与手打命令等价，不是后门。
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

const OPEN_RESULT = {
  enabled: true,
  urls: ['http://192.168.1.9:3090'],
  pairingCode: '12345-67890',
  expiresAt: Date.now() + 10 * 60_000,
  host: '192.168.1.9',
  port: 3090,
  scope: 'all' as const,
}

function source(
  over: Partial<{
    remoteEnabled: boolean
    tunnelRunning: boolean
    tunnelUrl: string | null
    roots: number
    devices: DeviceView[]
    openRemote: AccessSource['openRemote']
  }> = {},
): AccessSource & { enableCalls: string[] } {
  const state = {
    remoteEnabled: true,
    tunnelRunning: false,
    tunnelUrl: null as string | null,
    roots: 1,
    devices: [device()],
    ...over,
  }
  const enableCalls: string[] = []
  return {
    enableCalls,
    status: () => ({ host: '0.0.0.0', port: 3090, remoteEnabled: state.remoteEnabled }),
    tunnel: () => ({ running: state.tunnelRunning, url: state.tunnelUrl }),
    roots: () => state.roots,
    devices: () => state.devices,
    openRemote: async (scope) => {
      enableCalls.push(scope)
      if (state.openRemote !== undefined) return state.openRemote(scope)
      return OPEN_RESULT
    },
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

  it('两个动作：enable（有会话回 command）、copy 是本地复制', () => {
    expect(actionIds(accessView('zh'))).toEqual(['enable', 'copy'])
  })

  it('配对码一节按 data 绑定：码与地址都在视图里，靠推送刷新（issue #7）', () => {
    const rendered = JSON.stringify(accessView('zh'))
    expect(rendered).toContain('"$":"data.pairingCode"')
    expect(rendered).toContain('"$":"data.pairingUrls"')
    // 只有一种视图形态：按钮不再随 scope 变文案。
    expect(JSON.stringify(accessView('zh'))).toContain('开启并取码')
  })

  it('还没有码时数据也给一句话，不给空串（空绑定会画破折号）', () => {
    const empty = accessData(readState(source()), 'zh', EMPTY_PAIRING_STATE)
    expect(empty['pairingCode']).toBe('还没有配对码 —— 点上面的按钮')
    expect(empty['pairingUrls']).toBe('')
  })

  it('有码时把码、剩余分钟与地址一起写进数据', () => {
    const pairing: PanelPairing = { code: '12345-67890', urls: ['http://192.168.1.9:3090'], expiresAt: Date.now() + 8 * 60_000 }
    const data = accessData(readState(source()), 'zh', { pairing, failure: null })
    expect(data['pairingCode']).toContain('12345-67890')
    expect(data['pairingCode']).toContain('分钟')
    expect(data['pairingUrls']).toBe('http://192.168.1.9:3090')
  })

  it('开启失败时数据里是可读原因，不出现码', () => {
    const data = accessData(readState(source()), 'zh', { pairing: null, failure: '隧道功能未启用。' })
    expect(data['pairingCode']).toBe('开启失败：隧道功能未启用。')
    expect(data['pairingUrls']).toBe('')
  })

  it('二维码是 asset: 引用，指向清单 assets 目录里真实存在的文件', () => {
    const images: Array<{ src: string; caption?: string; aspect?: number }> = []
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      const record = node as Record<string, unknown>
      if (record['type'] === 'image') images.push(record as never)
      for (const value of Object.values(record)) walk(value)
    }
    walk(accessView('zh'))
    expect(images).toHaveLength(QR_ASSETS.length)
    for (const [index, image] of images.entries()) {
      expect(image.src).toBe(QR_ASSETS[index]?.src)
      expect(image.src.startsWith('asset:')).toBe(true)
      expect(image.aspect).toBe(1)
      // 说明文字只放短标签：整串下载页地址在 320dp 的窄屏上会折成两行。
      expect(image.caption).toBe(QR_ASSETS[index]?.caption)
      const file = path.join(import.meta.dirname, '..', 'assets', image.src.slice('asset:'.length))
      expect(readFileSync(file).length).toBeGreaterThan(0)
    }
  })

  it('二维码在面板最底部、两张并排（v2 row + columns equal）', () => {
    type Node = Record<string, unknown>
    const view = accessView('zh') as Node & { v?: number; children: Node[] }
    // v2 才能让这一行平分：v1 的 row 对 image 按 160dp 最小宽算列数，320dp 的窄屏
    // 会算成 1 列，两张码又堆回上下两张。
    expect(view.v).toBe(2)
    const last = view.children.at(-1) as Node & { type: string; style?: Node; children: Node[] }
    expect(last.type).toBe('row')
    expect(last.style).toEqual({ columns: 'equal', gap: 'S', align: 'center' })
    expect(last.children.map(child => child['src'])).toEqual(QR_ASSETS.map(asset => asset.src))
    // 动作按钮在二维码之前：二维码不是每次都要用的动作，不该挡在按钮前面。
    const actionIndex = view.children.findIndex(child => child['type'] === 'actions')
    expect(actionIndex).toBeGreaterThan(-1)
    expect(actionIndex).toBeLessThan(view.children.indexOf(last))
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
    // 没有 scope（「全部功能」入口）→ 视图是「复制版」，不是默认的会话版。
    expect(definition?.view(undefined, { locale: 'zh' })).toEqual(accessView('zh'))
    const effects = definition?.actions['copy']?.(undefined, { locale: 'zh' }) as Array<{ type: string; text: string }>
    expect(effects.map(effect => effect.type)).toEqual(['copy', 'toast'])
    expect(effects[0]?.text).toContain('dsh-remote-bridge 接入信息')
    expect(Array.from(effects[1]?.text ?? '').length).toBeLessThanOrEqual(40)
  })

  it('enable 在对话里打开时只把「执行 /remote」交回会话，面板自己不改状态', async () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx } = host(captured)
    const values = source()
    attachDshGoPanel(ctx, values)
    const effects = await captured.panels.get(PANEL_ID)?.actions['enable']?.({ sessionId: 's-1' }, { locale: 'zh' })
    // 协议 §5 的效果白名单里，command 是「在当前对话执行斜杠命令」。
    expect(effects).toEqual([{ type: 'command', name: 'remote', args: 'all' }])
    // 交回会话时面板自己一次都不动状态。
    expect(values.enableCalls).toEqual([])
  })

  it('enable 在没有会话时由面板自己开（走 openRemote，与 /remote 同一份实现，issue #7）', async () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx } = host(captured)
    const values = source()
    attachDshGoPanel(ctx, values)
    const effects = await captured.panels.get(PANEL_ID)?.actions['enable']?.(undefined, { locale: 'zh' }) as Array<{ type: string; text: string }>
    expect(values.enableCalls).toEqual(['all'])
    expect(effects).toEqual([{ type: 'toast', text: '已开启远程访问，配对码就在面板上' }])
  })

  it('开完之后数据里就有码：App 不用再点一次（issue #7）', async () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx } = host(captured)
    attachDshGoPanel(ctx, source())
    const definition = captured.panels.get(PANEL_ID)
    await definition?.actions['enable']?.(undefined, { locale: 'zh' })
    const payloads: Array<Record<string, unknown>> = []
    definition?.data?.(undefined, payload => payloads.push(payload as never), { locale: 'zh' })
    expect(String(payloads[0]?.['pairingCode'])).toContain('12345-67890')
  })

  it('开失败时回可读原因，数据里也没有码（issue #7）', async () => {
    const captured: Captured = { panels: new Map(), strips: new Map() }
    const { ctx } = host(captured)
    attachDshGoPanel(ctx, source({
      openRemote: async () => {
        throw new Error('隧道功能未启用。')
      },
    }))
    const definition = captured.panels.get(PANEL_ID)
    const effects = await definition?.actions['enable']?.(undefined, { locale: 'zh' }) as Array<{ type: string; text: string }>
    expect(effects).toEqual([{ type: 'toast', text: '开启失败：隧道功能未启用。' }])
    const payloads: Array<Record<string, unknown>> = []
    definition?.data?.(undefined, payload => payloads.push(payload as never), { locale: 'zh' })
    expect(String(payloads[0]?.['pairingCode'])).toContain('开启失败')
  })

  it('开得慢就先把「正在开」回给 App，别撞 3 秒预算（issue #7）', async () => {
    vi.useFakeTimers()
    try {
      const captured: Captured = { panels: new Map(), strips: new Map() }
      const { ctx } = host(captured)
      let release: () => void = () => {}
      attachDshGoPanel(ctx, source({
        openRemote: () => new Promise<typeof OPEN_RESULT>(resolve => {
          release = () => resolve(OPEN_RESULT)
        }),
      }))
      const running = captured.panels.get(PANEL_ID)?.actions['enable']?.(undefined, { locale: 'zh' }) as Promise<Array<{ text: string }>>
      await vi.advanceTimersByTimeAsync(2_100)
      expect((await running)[0]?.text).toBe('正在开远程访问；完成后配对码会自己出现在面板上')
      release()
    } finally {
      vi.useRealTimers()
    }
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
        openRemote: async () => OPEN_RESULT,
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
    assets?: string
    contributes: {
      panels: Array<{ id: string; title: Record<string, string>; icon: string; placement: string[] }>
      'composer.strip': Array<{ id: string; icon: string; panel: string }>
    }
  }

  it('存在且协议版本是 1', () => {
    // 不钉死具体版本：这条用例守的是「清单在、协议 v1」，版本号由 package.json 自己说了算
    // （钉死过一次 —— 2.17.5→2.18.0 发版时它先红）。
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
    expect(manifest?.v).toBe(1)
  })

  it('清单序列化不超过 16 KiB', () => {
    expect(Buffer.byteLength(JSON.stringify(manifest), 'utf8')).toBeLessThanOrEqual(16 * 1024)
  })

  it('声明 assets 目录（面板里的二维码靠它取图）', () => {
    expect(manifest.assets).toBe('./assets')
    for (const asset of QR_ASSETS) {
      const file = path.join(import.meta.dirname, '..', 'assets', asset.src.slice('asset:'.length))
      expect(readFileSync(file).length).toBeGreaterThan(0)
    }
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
