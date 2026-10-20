import { describe, expect, it } from 'vitest'
import { probeHostServices, INJECTED_SERVICE_NAMES, OBSERVED_ONLY_SERVICE_NAMES } from '../src/host/host-service-probe.ts'

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
function makeHost(available: readonly string[]): object {
  const present = new Set(available)
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (present.has(prop)) return { probe: prop }
      throw new Error(`cannot get property "${prop}" without inject`)
    },
    has(_target, prop: string) {
      return present.has(prop)
    },
  })
}

describe('host service probe', () => {
  it('全部注入成功时，报告每个服务都可用', () => {
    const all = [...INJECTED_SERVICE_NAMES, ...OBSERVED_ONLY_SERVICE_NAMES]
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
    const present = INJECTED_SERVICE_NAMES.filter(name => name !== 'permissionPresets')
    const report = probeHostServices(makeHost(present), '2.4.2')

    const missing = report.injected.find(service => service.name === 'permissionPresets')
    expect(missing?.available).toBe(false)
    expect(missing?.error).toContain('cannot get property "permissionPresets" without inject')
    expect(report.summary.injectedMissing).toContain('permissionPresets')
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

  it('观测区只报 0.2.1 已确认存在于 web profile 的服务', () => {
    const report = probeHostServices(makeHost([...INJECTED_SERVICE_NAMES]), '2.4.2')

    expect(OBSERVED_ONLY_SERVICE_NAMES).toContain('workingDirectory')
    // 桩里没给 workingDirectory，所以它应当出现在未可用集合之外。
    expect(report.summary.observedAvailable).not.toContain('workingDirectory')
  })

  it('workingDirectory 可用时被单独报出来（这是 0.2.1 的能力信号）', () => {
    const report = probeHostServices(
      makeHost([...INJECTED_SERVICE_NAMES, 'workingDirectory']),
      '2.4.2',
    )

    expect(report.summary.observedAvailable).toEqual(['workingDirectory'])
    const observed = report.observed.find(service => service.name === 'workingDirectory')
    expect(observed?.available).toBe(true)
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
