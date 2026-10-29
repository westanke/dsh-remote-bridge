import path from 'node:path'
import { stat } from 'node:fs/promises'
import { AuthService } from './host/auth.ts'
import { CloudflaredTunnelManager } from './host/cloudflared.ts'
import { DshChatAdapter } from './host/chat-adapter.ts'
import { WorkspaceDatabase } from './host/database.ts'
import { createDsh02ApiProxy, readHandoffImageFile, type Dsh02HostServices } from './host/dsh-0.2-bridge.ts'
import { WorkspaceEventBus } from './host/event-bus.ts'
import { FileService } from './host/file-service.ts'
import { probeHostServices, type HostServiceReport } from './host/host-service-probe.ts'
import {
  registerTunnelCommand,
  registerTunnelTool,
  type TunnelCommandRegistry,
  type TunnelToolRegistry,
} from './host/im-command.ts'
import { runStartupRetention } from './host/retention.ts'
import { JobAdapter } from './host/job-adapter.ts'
import { createImageRouteHandler, IMAGE_ROUTE, readHandoffSubdir } from './host/image-handoff.ts'
import { DEFAULT_REMOTE_HOST, normalizeListenerHost, normalizeListenerPort } from './host/listener-config.ts'
import { ApiRouter } from './host/router.ts'
import { attachEmbeddedRoutes, RemoteApiServer } from './host/server.ts'
import { DshSettingsAdapter } from './host/settings-adapter.ts'
import { createHostRemoteServices } from './host/ws-host-services.ts'
import type { ScheduleCreatePort } from './host/bff-rest.ts'
import { PLUGIN_VERSION } from './shared/version.ts'

/**
 * 插件身份。
 *
 * 2.0.4 起由 `dsh-workspace` 改名为 `dsh-remote-bridge`：插件实际承担的是
 * 「把 DSH 内核的私有 remote 协议翻译成版本化 REST，供手机端远程访问这台机器」，
 * 外加一个设置中心（根目录 / 远程访问 / 设备 / 回收站 / 审计）。原先的
 * 「workspace」只是其中一页，名字比内容宽。
 *
 * **以下一处刻意不改**，它是已发布客户端依赖的对外契约，改了等于破坏兼容：
 * - REST 前缀 `/dsh-workspace-api`（`src/host/server.ts`）
 *
 * 已发布的 App 把它写死了，改名只动「装的时候叫什么、bundle 叫什么」。
 *
 * 另外两项**已随 2.2.0 删除独立页一并退役**，不再是契约：独立页路径 `/dsh-workspace`
 * （页面已删）、浏览器存储键 `dsh-workspace-device-token`（只被那个页面读写过，现已无人使用）。
 * 另有一项契约不在此处：状态目录 `dshHomePath('dsh-workspace')`（在 `cordis.patch.yml`），
 * 换目录等于清空用户的授权根与回收站。
 */
export const name = 'dsh-remote-bridge'

/**
 * Host services this plugin needs, for DSH 0.2.x.
 *
 * DSH ≤ 0.1.1 published the client-shaped `apiProxy` facade from
 * `@deepseek-ai/dsh-host-apiproxy`. DSH 0.1.2-alpha.3 replaced that package with
 * `@deepseek-ai/dsh-api-gateway` (service `typertGateway`), which publishes no
 * `apiProxy` — the controllers instead register directly as host services.
 * Injecting those keeps the plugin loadable on 0.2.x, and
 * `./host/dsh-0.2-bridge.ts` rebuilds the old facade on top of them so the
 * chat/settings adapters keep their original contract.
 */
export const inject = [
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
  // ⚠️ inject 只能放「两个支持版本上都存在的服务」（硬依赖，缺一个整个插件不激活）。
  // 可选服务（permissionPresets / jobController / fileUploads / attachments）不在这里，
  // 由 optionalService 经 ctx.reflect.get(name, false) 运行时读取 —— 见
  // dsh-0.2-bridge.ts 的 optionalService 注释与 docs:check 的 inject 对齐门禁。
]

export interface Config {
  dataDir?: string
  port?: number
  remoteHost?: string
  maxUploadBytes?: number
  /**
   * 额外允许手机端写入的设置命名空间（默认空）。
   *
   * 精确 ns（`ui-chat`）或通配前缀（`llm-*`）。与内置策略叠加：`ui-*` 与以
   * `locale` 结尾的命名空间本来就可写；其余默认只读，因为改模型/权限等于把
   * 遥控器交出去（理由见 docs/project/SECURITY.md）。
   */
  settingsWriteNamespaces?: readonly string[]
  /**
   * 允许供应商 `baseURL` 指向的私网 / 回环 host 白名单（默认空 = 一律拒绝）。
   *
   * 默认拒绝的理由：手机端改 `baseURL` 就等于把模型请求（含 `Authorization:
   * Bearer <真实 key>`）引到任意地址，这是 SEC-H11 的窃取路径。默认拒绝把
   * 「谁能连内网」变成部署方的显式决定。
   *
   * 要连本地 LLM（ollama / LM Studio 之类）时填这里，推荐带端口：
   * `["127.0.0.1:11434", "localhost:1234"]`。带端口的条目只放行该端口，裸
   * host 条目放行该主机的任意端口（面更大）。规则见 `src/host/provider-url-policy.ts`。
   */
  allowPrivateProviderHosts?: readonly string[]
}

interface HostContext extends Dsh02HostServices {
  webServer: Parameters<typeof attachEmbeddedRoutes>[0]
  agents: NonNullable<ConstructorParameters<typeof DshChatAdapter>[2]>['agents']
  commands: NonNullable<ConstructorParameters<typeof DshChatAdapter>[2]>['commands']
  logger: { info(message: string): void; warn(error: Error): void }
  effect(register: () => (() => void | Promise<void>), label?: string): void
}

export async function apply(ctx: HostContext, config: Config = {}): Promise<void> {
  const dataDir = path.resolve(config.dataDir ?? path.join(process.cwd(), '.dsh-workspace'))
  const port = normalizeListenerPort(config.port ?? 3090, true)
  const remoteHost = normalizeListenerHost(config.remoteHost ?? DEFAULT_REMOTE_HOST)
  const maxUploadBytes = config.maxUploadBytes ?? 20 * 1024 * 1024
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new Error('dsh-remote-bridge: maxUploadBytes must be positive')

  const database = new WorkspaceDatabase(dataDir)
  // 清掉历史遗留的「标记式」撤销设备。
  //
  // 撤销现在是直接删行，但在这之前每次撤销只打 `revoked_at` 标记，于是库越用越臃肿
  // —— 本机实测堆到 32 条，全是历史测试探针和早已弃用的旧手机，界面上就是一长串灰字。
  // 用户要求「已撤销的不显示，也自动从数据库中删除」，这里是后一半的落地。
  //
  // 幂等，放在启动时最省事：不必关心历史数据长什么样。
  try {
    const purged = database.purgeRevokedDevices()
    if (purged > 0) ctx.logger.info(`dsh-remote-bridge: purged ${purged} revoked device(s)`)
  } catch (error) {
    // 清理失败不该拦住插件启动 —— 它只是清理历史数据，不影响新功能。
    ctx.logger.warn(new Error(`dsh-remote-bridge: could not purge revoked devices: ${String(error)}`))
  }

  // 数据保留：把 `audit` / `idempotency` 两张**只增不删**的表收到阈值以内。
  //
  // 为什么放在启动时：它要处理的是「上次运行攒下来的量」，那批数据可能远超一次
  // 请求能承受的规模，混进请求路径只会让某一次请求莫名变慢。策略与理由见
  // `retention.ts` 的文件头（含「为什么不裁幂等记录的响应体」那条否决）。
  //
  // 端口缺席时它只记一条 warn 就返回 —— 清理任务缺席不该让插件起不来。
  runStartupRetention(database, ctx.logger)

  // 把 DSH 自己的工作区登记成一条授权根（不可删除，但可正常访问）。
  //
  // 为什么在启动时自动登记、而不是让用户手填：用户要的就是「默认指向当前 DSH 的
  // 工作目录」，而工作区路径**每个用户、每台机器都不一样**（DSH 用的是系统文档目录
  // 派生的 `<Documents>/deepseek-harness/default-workspace`）。手填等于让用户去猜一个
  // 他本来就不该知道的路径。`ensureBuiltinRoot` 幂等，所以每次启动无脑调一次即可。
  //
  // 拿不到工作区、或那个目录已经不存在，就什么都不做 —— 留一条指向虚空的授权根只会
  // 让手机浏览一路报错，比不显示更糟。
  await registerBuiltinWorkspaceRoot(ctx, database)
  const events = new WorkspaceEventBus()
  // Cloudflare 隧道管理器：进程状态全部收敛在这一个实例里，router 只当 HTTP 门面。
  // 二进制不随插件发布，需按需下载（见 cloudflared.ts），位置在 `dataDir/cloudflared-bin`。
  //
  // 它**必须先于 AuthService 创建**：管理面鉴权的判据 0 是「隧道在跑就整体关门」，
  // 而那条判据读的是这个实例的实时状态。所有请求都发生在 `remote.start()` 之后，
  // 那时实例一定已就绪；auth 里存的是闭包而不是快照，所以隧道后来启停也能跟上。
  const tunnels = new CloudflaredTunnelManager()
  const auth = new AuthService(database, { tunnelActive: () => tunnels.tunnelActive })
  const files = new FileService(database, event => events.emit(event))
  // Rebuild the pre-0.2 `apiProxy` facade over the 0.2.x host services so both
  // adapters keep the contract they were written against.
  //
  // 图片交接的首选落点是**会话工作目录**的 `.dsh-images/`（由 handoffRoots
  // 解析出会话 cwd），符合「产物放工作目录、别塞进 DSH 私有目录」；
  // 解析不出工作目录（冷会话 / cwd 不在任何授权根下）时，才退回
  // `<dataDir>/image-handoff` 这个 DSH 目录兜底 —— 无论如何不能让发消息失败。
  //
  // 三处都传**函数**而不是快照（2.2.5 起）：
  // - `handoffRoots`：设置页刚加完授权根，那张图就该落进新根；
  // - `handoffSubdir`：识图路径改完立即生效（设置面板写数据库，这里现读）；
  // - `imageHandoffDir`：兜底目录是常量，直接给值。
  const imageHandoffDir = path.join(dataDir, 'image-handoff')
  const handoffRootsOf = () => database.listRoots().map(root => ({ id: root.id, realPath: root.realPath }))
  const apiProxy = createDsh02ApiProxy(ctx, {
    handoffRoots: handoffRootsOf,
    imageHandoffDir,
    handoffSubdir: () => readHandoffSubdir(database),
  })
  const chat = new DshChatAdapter(apiProxy, database, { agents: ctx.agents, commands: ctx.commands })
  const settings = new DshSettingsAdapter(apiProxy, {
    writeNamespaces: config.settingsWriteNamespaces ?? [],
    allowPrivateProviderHosts: config.allowPrivateProviderHosts ?? [],
  })
  // 宿主服务注入面探针：在 apply 期间（cordis 注入属性仍可读）采集一份快照。
  //
  // 为什么必须在这里采、不能留到 HTTP 回调里：注入属性是有生命周期的惰性访问器，
  // apply 一结束再读会抛 `cannot get property "x" without inject`。2.0.1 正是
  // 把 attachments 的读取留到回调里，导致整个插件激活失败（见 host-service-probe.ts 头注释）。
  //
  // 采集失败不该拦住插件启动 —— 它只是观测。启动期把探针打成日志，
  // 这样即使没人去请求那个端点，「注入了几个服务」也会出现在 DSH 日志里。
  let hostServiceReport: HostServiceReport | undefined
  try {
    hostServiceReport = probeHostServices(ctx, PLUGIN_VERSION)
    const { injectedAvailable, injectedTotal, injectedMissing } = hostServiceReport.summary
    const detail = injectedMissing.length === 0 ? '' : `，缺失：${injectedMissing.join(', ')}`
    ctx.logger.info(`dsh-remote-bridge: host services ${injectedAvailable}/${injectedTotal} 可注入${detail}`)
    if (hostServiceReport.summary.observedAvailable.length > 0) {
      ctx.logger.info(`dsh-remote-bridge: 观测到可用但未 inject 的服务：${hostServiceReport.summary.observedAvailable.join(', ')}`)
    }
  } catch (error) {
    ctx.logger.warn(new Error(`dsh-remote-bridge: host service probe failed: ${String(error)}`))
  }
  let router!: ApiRouter
  // jobController 是**可选服务**（不在 inject 里 —— inject 是硬依赖，而它只在
  // 0.2.1 的 web profile 上存在；0.2.0-rc.2 上缺失时把插件整个挂掉是 CI 实锤过的回归）。
  // 用 reflect.get(name, false) 读：不需要 inject 声明，缺失时返回 undefined。
  // 缺失时干脆不挂 jobs —— 客户端会收到 404，而不是一个永远空的清单。
  const reflect = (ctx as { reflect?: { get?: (name: string, strict?: boolean) => unknown } }).reflect
  const jobControllerAvailable =
    reflect?.get !== undefined && reflect.get('jobController', false) !== undefined
  if (!jobControllerAvailable) {
    ctx.logger.warn(new Error('dsh-remote-bridge: jobController not provided by this kernel, background-job endpoints disabled'))
  }
  // 定时任务 / 官方语音走内核 typertGateway Remote（DSH 0.2.1-rc.2+ 才有）。
  // 同样是可选服务：reflect.get 取不到就不启用，WS 帧回结构化 unavailable 引导 REST。
  // 提到 RemoteApiServer 之前构造，是因为能力位要在构造时就能如实声明（见下）。
  const hostRemote = createHostRemoteServices(reflect)
  // 定时任务的**新建**没有远程方法：`dsh-schedule` 只注册了
  // catalog / changed / delete / history / list / update（见 `bff-schedule.ts` 文件头），
  // `create` 只在宿主 cordis 服务 `ctx.schedule` 上。同样是可选服务 ——
  // 取不到时 REST 的 POST 回 503 `schedule/create-unavailable`，而不是假的 201。
  const schedule = reflect?.get === undefined
    ? undefined
    : reflect.get('schedule', false) as ScheduleCreatePort | undefined
  const capabilities = {
    jobs: jobControllerAvailable,
    // `chat-schedules-v1` 与宿主 `ctx.schedule` 同生死：没有它，列表与新建都只会回 503。
    schedule: schedule !== undefined,
    // `speech-transcription-v1` 只在网关整体缺失时剔除 —— 内核没装语音包时
    // `GET …/catalog` 仍回 200 `{available:false,reason}`，客户端要能区分
    // 「支持但本机没配」与「不支持」。理由写在 `capabilities.ts`。
    speech: hostRemote.services !== undefined,
  }
  const remote = new RemoteApiServer({
    port,
    remoteHost,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
    // 能力位必须与**这台进程真的能提供什么**一致：`jobController` 缺席时
    // 三个 jobs 端点根本没挂（路由 404），此时仍然向客户端宣告 `job-list-v1`
    // 等于让它去打一个必然失败的端点 —— 而这正是能力位要消灭的那种
    // 「静默少一个功能」。过滤规则与理由见 `capabilities.ts` 的
    // `CAPABILITY_REQUIREMENTS`。
    capabilities,
  })
  // /ws/mobile 的全局模型目录 / providers / 文件浏览需要 settings 与 files 适配器，
  // 它们在此刻才构造完成（晚于 RemoteApiServer），通过 setter 注入避免构造顺序环。
  remote.attachMobileHostServices({ settings, files })
  remote.attachMobileRemoteServices(hostRemote.services)
  router = new ApiRouter({
    database,
    auth,
    files,
    chat,
    settings,
    remote,
    tunnels,
    cloudflaredBinDir: path.join(dataDir, 'cloudflared-bin'),
    maxUploadBytes,
    imageFallbackDir: imageHandoffDir,
    ...(hostRemote.services === undefined ? {} : { hostRemote: hostRemote.services }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(hostServiceReport === undefined ? {} : { hostServiceReport }),
    ...(jobControllerAvailable && reflect?.get
      ? { jobs: new JobAdapter({ jobController: reflect.get('jobController', false) as never }) }
      : {}),
  })

  try {
    await remote.start()
  } catch (error) {
    database.close()
    throw error
  }
  // 只读图片路由：WebUI 的 `<img>` 用不了带鉴权的 REST（浏览器不给 `<img>` 加请求头），
  // 所以它在 `/plugin/dsh-remote-bridge/raw` 上按「回环 + 同源 + 裸文件名 + 字节自证」服务。
  // 取图实现直接复用交接读盘那一份，目录由宿主按会话推出 —— 客户端连目录都递不进来。
  const imageRoute = createImageRouteHandler({
    read: (sessionId, name) =>
      readHandoffImageFile(ctx, handoffRootsOf(), imageHandoffDir, readHandoffSubdir(database), sessionId, name),
  })
  const disposeEmbedded = attachEmbeddedRoutes(ctx.webServer, router, remote, [
    { kind: 'prefix', path: IMAGE_ROUTE, handler: imageRoute },
  ])
  // `/tunnel`：从 IM（微信/飞书/钉钉/企微…）里远程开隧道并取回配置文本。**只开不停**，
  // 门禁依赖 IM 插件自身的访问策略（allowlist + canExecuteCommands）—— 见 im-command.ts 头注释。
  // 注册失败只降级「没有 /tunnel」，绝不能让 apply 抛错 —— apply 抛错会让 cordis 拆掉整个
  // fiber：HTTP 服务器已经 bind、端口还占着，但 ctx 变成 inactive，于是每个需要内核服务的
  // 端点都返回 `cannot get required service "x" in inactive context`，客户端看起来像「全挂了」。
  // 2026-10-22 真机实测踩过这个坑（热替换产物 + 重启时序）。
  try {
    ctx.effect(
      () => registerTunnelCommand(ctx.commands as unknown as TunnelCommandRegistry, {
        openTunnel: () => router.openTunnelForCommand(),
        logger: {
          info: (message) => ctx.logger.info(message),
          warn: (error) => ctx.logger.warn(error),
        },
      }),
      'dsh-remote-bridge /tunnel command',
    )
  } catch (error) {
    ctx.logger.warn(new Error(`dsh-remote-bridge: /tunnel command registration failed (ignored): ${String(error)}`))
  }
  // 同一件事的第二个入口：**工具**。IM 插件的斜杠命令表是封闭的（只有内置 31 条 +
  // `/compact` `/clear` `/permission` 三条委派宿主，没有通用派发），所以 IM 里发 `/tunnel`
  // 到不了命令处理函数；用户用自然语言说「帮我开隧道」时，智能体调这个工具即可。
  // `tools` 不在 inject 里（硬依赖会让插件在其他构建上整个起不来），缺了就不注册。
  let toolsService: unknown
  try {
    toolsService = reflect?.get?.('tools', false)
  } catch {
    toolsService = undefined
  }
  if (toolsService !== undefined) {
    try {
      ctx.effect(
        () => registerTunnelTool(toolsService as unknown as TunnelToolRegistry, {
          openTunnel: () => router.openTunnelForCommand(),
          logger: {
            info: (message) => ctx.logger.info(message),
            warn: (error) => ctx.logger.warn(error),
          },
        }),
        'dsh-remote-bridge open_tunnel_config tool',
      )
    } catch (error) {
      ctx.logger.warn(new Error(`dsh-remote-bridge: open_tunnel_config registration failed (ignored): ${String(error)}`))
    }
  }
  ctx.effect(() => async () => {
    disposeEmbedded()
    await remote.stop()
    await router.dispose()
    await hostRemote.dispose()
    database.close()
  }, 'dsh-remote-bridge lifecycle')
  const status = remote.status()
  ctx.logger.info(`dsh-remote-bridge v${PLUGIN_VERSION}: ${status.host}:${status.port} (${status.remoteEnabled ? 'remote enabled' : 'loopback only'})`)
}

export default apply

/**
 * 登记「DSH 工作区」为内置授权根。
 *
 * 取 `ctx.workspaceRegistry.list()` 的**第一个**工作区（用户明确要「只显示第一个」），
 * 登记成一条 `builtin` 根。四个必须静默失败的情形 —— 插件启动不该因为一个「锦上添花的
 * 默认根」而整个起不来：
 *
 * - 没有工作区（用户从没建过）：什么都不做；
 * - 第一个工作区的路径已经不存在（用户把它删了）：什么都不做，否则留下一条指向虚空的
 *   授权根，手机浏览时一路报错，比不显示更糟；
 * - 注册表自己抛了：同上，记一条 warn 就走。
 *
 * 目录存在性用 `stat` 判，且必须是**目录**而不是文件 —— `canonicalRoot` 之后如果指向一个
 * 普通文件，后续列目录会一路报错。
 */
async function registerBuiltinWorkspaceRoot(ctx: HostContext, database: WorkspaceDatabase): Promise<void> {
  try {
    const registry = ctx.workspaceRegistry
    // cordis 的注入属性只在 apply 期间可读（见 dsh-0.2-bridge 里的说明），
    // 所以这里立刻取值，不把 registry 对象存起来再用。
    const workspace = registry.list()[0]
    if (workspace === undefined) return
    const target = workspace.path?.trim()
    if (target === undefined || target === '') return

    const info = await stat(target)
    if (!info.isDirectory()) return

    const root = await database.ensureBuiltinRoot(target, workspace.title?.trim() || 'DSH 工作区')
    if (root !== undefined) {
      ctx.logger.info(`dsh-remote-bridge: registered the DSH workspace as a built-in root: ${root.realPath}`)
    }
  } catch (error) {
    ctx.logger.warn(new Error(`dsh-remote-bridge: could not register the DSH workspace root: ${String(error)}`))
  }
}
