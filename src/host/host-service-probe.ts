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

/**
 * 插件 `cordis.patch.yml` 与 `src/index.ts` 里 inject 声明的全部服务名
 * （**两份清单必须一致**，docs:check 有对齐门禁）。
 *
 * ⚠️ 只能放「两个支持版本（0.2.0-rc.2 与 0.2.1-rc.2）上都存在的服务」——
 * cordis 的 inject 是硬依赖，缺一个整个插件不激活（2026-10-20 在 0.2.0-rc.2 的
 * smoke-profile-install 上实锤过）。可选服务一律走 OPTIONAL_SERVICE_NAMES。
 */
export const INJECTED_SERVICE_NAMES = [
  'sessionController',
  'workspaceController',
  'workspaceRegistry',
  'settingsController',
  'credentialsController',
  'agentPresets',
  'llm',
  'webServer',
  'agents',
  'commands',
] as const

export type InjectedServiceName = (typeof INJECTED_SERVICE_NAMES)[number]

/**
 * **可选服务**：不写进 inject（inject 是硬依赖），由插件经
 * `ctx.reflect.get(name, false)` 运行时读取 —— 读到就走该能力，读不到按能力位降级。
 *
 * 探针用同一条 `reflect.get` 读取它们：这样报告的是「内核**真的**提供了什么」，
 * 而不是「我们 inject 了什么」。两者的差就是「可选能力在这台内核上可用与否」。
 */
export const OPTIONAL_SERVICE_NAMES = [
  /**
   * `@deepseek-ai/dsh-permission-presets`（权限档位目录）。
   * 0.2.1-rc.2 的 web profile 上实测可用；0.2.0-rc.2 上未提供时
   * 权限档位目录走 `FALLBACK_PERMISSION_CATALOG` + BFF。
   */
  'permissionPresets',
  /**
   * `@deepseek-ai/dsh-api-job-controller`（后台任务）。
   * 0.2.1-rc.2 的 web profile 上实测可用；0.2.0-rc.2 上缺失时
   * jobs 三个端点返回 404（`jobs-adapter` 不挂载）。
   */
  'jobController',
  /**
   * `@deepseek-ai/dsh-client-file-upload`（文件上传）。
   * 缺失时图片/文件上传走内核的 loopback HTTP 路由降级。
   */
  'fileUploads',
  /**
   * `@deepseek-ai/dsh-attachment-local` 的附件存储。
   * 缺失时历史图片读取走内核 `sessionController.attachment()`。
   */
  'attachments',
  /**
   * `@deepseek-ai/dsh-working-directory`（0.2.1 新增的宿主服务）。
   * 其 `static inject` 里有 `fs`，而 web profile 没有 `dsh-fs` 这一行，
   * 所以它在两个版本上都激活不了 —— 列在这里是让探针如实报告「不可用」，
   * 会话工作目录改走投影只读路线。
   */
  'workingDirectory',
  /**
   * `@deepseek-ai/dsh-api-workspace-files`（工作区文件预览与变更监听）。
   * 同样因 `static inject` 里的 `fs` 在 web profile 上激活不了；
   * 文件变更监听（A1）因此未实现，留此存照。
   */
  'workspaceFiles',
] as const

export type OptionalServiceName = (typeof OPTIONAL_SERVICE_NAMES)[number]
/** 兼容旧名。 */
export const OBSERVED_ONLY_SERVICE_NAMES = OPTIONAL_SERVICE_NAMES
export type ObservedServiceName = OptionalServiceName

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
  // 可选服务走 reflect.get（strict=false）：不要求 inject 声明，也不要求
  // 提供方 fiber 已激活 —— 报告的是「内核真的提供了什么」。
  const reflect = (host as { reflect?: { get?: (name: string, strict?: boolean) => unknown } }).reflect
  const probeOptional = (name: string): ServiceProbe => {
    if (reflect === undefined || typeof reflect.get !== 'function') {
      return { name, available: false, resolvable: false, error: 'ctx.reflect.get unavailable on this cordis' }
    }
    try {
      const value = reflect.get(name, false)
      const resolvable = value !== null && value !== undefined
      return {
        name,
        available: true,
        resolvable,
        ...(resolvable ? {} : { error: 'not provided by this kernel/profile' }),
      }
    } catch (caught) {
      return {
        name,
        available: false,
        resolvable: false,
        error: caught instanceof Error ? caught.message : String(caught),
      }
    }
  }

  // inject 里的名字走属性读：在 inject 里但未激活会抛
  // `cannot get required service "x" in inactive context`（那说明依赖没齐，插件本来也活不了）。
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
  const observed = OPTIONAL_SERVICE_NAMES.map(probeOptional)

  return {
    pluginVersion,
    injected,
    observed,
    summary: {
      injectedTotal: injected.length,
      injectedAvailable: injected.filter(service => service.available).length,
      injectedMissing: injected.filter(service => !service.available).map(service => service.name),
      // 可选区按 **resolvable** 过滤，不是 available：reflect.get 的通道本身总是通的
      // （available 恒为 true），「这台内核真的提供了这个服务」由 resolvable 表达。
      // 按 available 过滤会把「没提供」也记成可用 —— 恰好丢掉探针最想回答的那个问题。
      observedAvailable: observed.filter(service => service.resolvable).map(service => service.name),
    },
  }
}
