import { describe, expect, it } from 'vitest'
import { probeHostServices, INJECTED_SERVICE_NAMES, OPTIONAL_SERVICE_NAMES } from '../src/host/host-service-probe.ts'

/**
 * 造一个「cordis 注入属性」语义的 host 替身。
 *
 * **为什么必须模拟抛错、不能简单留空字段**：cordis 的注入属性是惰性访问器，
 * 读一个没人提供的服务会抛 `cannot get property "x" without inject`。
 * 如果替身只是「没有这个字段」，读出来是 `undefined` —— 那测的是
 * 「字段不存在」而不是「服务没注入」，两者在真实内核里都会走到探针的 catch 分支，
 * 但**成因不同**，而探针的 available/resolvable 两个标记正是为了区分它们。
 *
 * 这正是记忆里那条教训的同类：桩比现实宽容，就会把 bug 放过去。
 */
/**
 * 造一个「cordis 注入属性」语义的 host 替身。
 *
 * **两件事都要模拟**，缺一就是桩比现实宽容或严苛：
 * 1. inject 里的名字：直接读返回服务对象；不在 inject 里的名字抛
 *    `cannot get property "x" without inject`（这是 Context proxy 对
 *    未声明属性的拦截行为）；
 * 2. `ctx.reflect` **总是可访问**（它是 mixin 到 Context 的服务，不走注入拦截），
 *    `reflect.get(name, false)` 对已提供的服务返回值、未提供的返回 undefined
 *    —— 这是探针读**可选服务**的通道。
 *
 * 旧桩只模拟了 1：`reflect` 本身也被当普通属性抛错，于是可选区的探测
 * 全部落进 catch，测试与实现脱节（真实内核上 reflect 一直都在）。
 */
function makeHost(available: readonly string[]): object {
  const present = new Set(available)
  const reflect = {
    get(name: string, _strict?: boolean): unknown {
      return present.has(name) ? { probe: name } : undefined
    },
  }
  return new Proxy({ reflect } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === 'reflect') return reflect
      if (present.has(prop)) return { probe: prop }
      throw new Error(`cannot get property "${prop}" without inject`)
    },
    has(_target, prop: string) {
      return prop === 'reflect' || present.has(prop)
    },
  })
}

describe('host service probe', () => {
  it('全部注入成功时，报告每个服务都可用', () => {
    const all = [...INJECTED_SERVICE_NAMES, ...OPTIONAL_SERVICE_NAMES]
    const report = probeHostServices(makeHost(all), '2.4.2')

    expect(report.pluginVersion).toBe('2.4.2')
    expect(report.summary.injectedTotal).toBe(INJECTED_SERVICE_NAMES.length)
    expect(report.summary.injectedAvailable).toBe(INJECTED_SERVICE_NAMES.length)
    expect(report.summary.injectedMissing).toEqual([])
    for (const service of report.injected) {
      expect(service.available).toBe(true)
      expect(service.resolvable).toBe(true)
      expect(service.error).toBeUndefined()
    }
  })

  it('某个服务没注入时，进 missing 清单并带上内核的错误信息', () => {
    const present = INJECTED_SERVICE_NAMES.filter(name => name !== 'commands')
    const report = probeHostServices(makeHost(present), '2.4.2')

    const missing = report.injected.find(service => service.name === 'commands')
    expect(missing?.available).toBe(false)
    expect(missing?.error).toContain('cannot get property "commands" without inject')
    expect(report.summary.injectedMissing).toContain('commands')
    // 缺一个不该让别的服务也变红。
    expect(report.summary.injectedAvailable).toBe(INJECTED_SERVICE_NAMES.length - 1)
  })

  it('解析出 null/undefined 时算 available 但不算 resolvable', () => {
    // 真实内核里这对应「服务注册了但值是空的」。available 与 resolvable 分开正是为了这个。
    const host = { sessionController: null } as Record<string, unknown>
    const report = probeHostServices(host, '2.4.2')

    const probe = report.injected.find(service => service.name === 'sessionController')
    expect(probe?.available).toBe(true)
    expect(probe?.resolvable).toBe(false)
    expect(probe?.error).toBe('resolved to null/undefined')
  })

  it('内核没提供的可选服务，available=true 但 resolvable=false', () => {
    // 可选区走 reflect.get：它**不抛错**（这是它与 inject 区的本质区别）——
    // 内核没提供就返回 undefined，探针把它记成「available 但不可解析」，
    // 意思是「这条通道本身是好的，这台内核只是没挂这个服务」。
    const report = probeHostServices(makeHost([...INJECTED_SERVICE_NAMES]), '2.4.2')

    expect(report.summary.observedAvailable).toEqual([])
    const wd = report.observed.find(service => service.name === 'workingDirectory')
    expect(wd?.available).toBe(true)
    expect(wd?.resolvable).toBe(false)
  })

  it('内核提供的可选服务被逐一报出（0.2.1 的能力信号）', () => {
    const report = probeHostServices(
      makeHost([...INJECTED_SERVICE_NAMES, ...OPTIONAL_SERVICE_NAMES]),
      '2.4.2',
    )

    expect(report.summary.observedAvailable).toEqual([...OPTIONAL_SERVICE_NAMES])
    const observed = report.observed.find(service => service.name === 'workingDirectory')
    expect(observed?.available).toBe(true)
    expect(observed?.resolvable).toBe(true)
  })

  it('探针清单与 src/index.ts 的 inject 声明一致（防止两边漂移）', async () => {
    // 这条盯着一个真实风险：在 index.ts 的 inject 数组里加了服务名，
    // 却忘了加进探针清单 —— 于是那个服务到底注没注进来，探针答不了。
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const source = await readFile(
      path.join(import.meta.dirname, '..', 'src', 'index.ts'),
      'utf8',
    )
    for (const name of INJECTED_SERVICE_NAMES) {
      expect(source).toContain(`'${name}'`)
    }
  })
})
