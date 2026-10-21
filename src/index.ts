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
import { JobAdapter } from './host/job-adapter.ts'
import { createImageRouteHandler, IMAGE_ROUTE, readHandoffSubdir } from './host/image-handoff.ts'
import { DEFAULT_REMOTE_HOST, normalizeListenerHost, normalizeListenerPort } from './host/listener-config.ts'
import { ApiRouter } from './host/router.ts'
import { attachEmbeddedRoutes, RemoteApiServer } from './host/server.ts'
import { DshSettingsAdapter } from './host/settings-adapter.ts'
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
  const settings = new DshSettingsAdapter(apiProxy)
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
  const remote = new RemoteApiServer({
    port,
    remoteHost,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
  })
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
  ctx.effect(() => async () => {
    disposeEmbedded()
    await remote.stop()
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
