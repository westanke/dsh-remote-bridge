/**
 * 宿主服务注入面探针。
 *
 * 为什么需要它：本插件刻意不 import 任何 `@deepseek-ai/*`（见
 * docs/project/COMPATIBILITY.md），全部宿主服务按结构类型 + Host 注入消费。
 * 好处是跨内核版本零漂移，**代价是「服务到底注进来了没有」只能靠猜** ——
 * cordis 的注入属性是惰性访问器，读一个没人提供的服务会抛
 * `cannot get property "x" without inject`，而这个错误只在真的去读的那一刻出现。
 *
 * 于是历史上反复出现同一类事故：某功能静默不工作，两侧日志都不说一句话，
 * 排错者先从客户端查起，查到服务端才发现服务压根没注入。
 * 2.0.0 的 `attachments`、2.0.2 的 `fileUploads` 都是这么炸的（见
 * dsh-0.2-bridge.ts 里那段长注释）。
 *
 * 这个探针把「猜」变成「问」：在 apply 期间（注入属性还可读时）逐个试读一次，
 * 记录每个服务的**可解析性**，之后任何时候都能回答「0.2.x 上到底有哪些服务可用」。
 * 它不改变任何行为 —— 纯粹是观测。
 *
 * 使用方式：`GET /dsh-workspace-api/api/v1/debug/host-services`
 * （需要设备 token 或 loopback admin，与其它 REST 端点同一套鉴权）。
 */

/** 插件 `src/index.ts` 里 inject 声明的全部服务名。 */
export const INJECTED_SERVICE_NAMES = [
  'sessionController',
  'workspaceController',
  'workspaceRegistry',
  'settingsController',
  'credentialsController',
  'agentPresets',
  'permissionPresets',
  'llm',
  'webServer',
  'agents',
  'commands',
  'fileUploads',
  'attachments',
] as const

export type InjectedServiceName = (typeof INJECTED_SERVICE_NAMES)[number]

/** 0.2.1 新增、插件尚未 inject 但已确认存在于 web profile 的服务。 */
export const OBSERVED_ONLY_SERVICE_NAMES = [
  /**
   * `@deepseek-ai/dsh-working-directory` 的 cordis 服务。
   *
   * 已在真实 web profile 组合里确认存在（`dsh --profile web --dump-config`
   * 的 `- id: working-directory` 行，未 disabled），且它的三个依赖
   * （`fs` / `sessionProjections` / `systemPrompt`）都在 web profile 落地。
   * 列在这里是为了让探针顺手回答「要接的时候它在不在」。
   */
  'workingDirectory',
] as const

export type ObservedServiceName = (typeof OBSERVED_ONLY_SERVICE_NAMES)[number]

export interface ServiceProbe {
  name: string
  /** 服务是否可解析。`false` = cordis 认为没有插件提供它。 */
  available: boolean
  /** 解析失败时的错误信息（成功时为 undefined）。 */
  error?: string
  /** 解析到的值是否像一个可用的服务对象（非 null/非 undefined）。 */
  resolvable: boolean
}

export interface HostServiceReport {
  /** 探针执行时的内核运行时版本，供比对「哪个版本注入面是这样」。 */
  pluginVersion: string
  injected: ServiceProbe[]
  observed: ServiceProbe[]
  /** 注入面摘要：注入了几个、缺几个。缺的那几个就是「功能可能静默不工作」的清单。 */
  summary: {
    injectedTotal: number
    injectedAvailable: number
    injectedMissing: readonly string[]
    observedAvailable: readonly string[]
  }
}

/**
 * 在注入属性**仍可读**的时机（即 `apply` 执行期间）逐个试读服务。
 *
 * 为什么必须在 apply 期间读、不能留到 HTTP 回调里：cordis 的注入属性是
 * 有生命周期的惰性访问器，`apply` 一结束就读不到了（会抛
 * `cannot get property "attachments" without inject`）。这正是
 * dsh-0.2-bridge.ts 里 `optionalService` 那段注释记的教训 ——
 * 2.0.1 把读取留到回调里，结果整个插件激活失败。
 *
 * @param host - `ctx` 本身（不是取到的服务对象）。
 * @returns 每个服务的可解析性报告。
 */
export function probeHostServices(host: object, pluginVersion: string): HostServiceReport {
  const probeOne = (name: string): ServiceProbe => {
    let available = false
    let resolvable = false
    let error: string | undefined
    try {
      const value = (host as Record<string, unknown>)[name]
      available = true
      resolvable = value !== null && value !== undefined
      if (!resolvable) error = 'resolved to null/undefined'
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    return { name, available, resolvable, ...(error === undefined ? {} : { error }) }
  }

  const injected = INJECTED_SERVICE_NAMES.map(probeOne)
  const observed = OBSERVED_ONLY_SERVICE_NAMES.map(probeOne)

  return {
    pluginVersion,
    injected,
    observed,
    summary: {
      injectedTotal: injected.length,
      injectedAvailable: injected.filter(service => service.available).length,
      injectedMissing: injected.filter(service => !service.available).map(service => service.name),
      observedAvailable: observed.filter(service => service.available).map(service => service.name),
    },
  }
}
