import path from 'node:path'
import { AuthService } from './host/auth.ts'
import { DshChatAdapter } from './host/chat-adapter.ts'
import { WorkspaceDatabase } from './host/database.ts'
import { createDsh02ApiProxy, type Dsh02HostServices } from './host/dsh-0.2-bridge.ts'
import { WorkspaceEventBus } from './host/event-bus.ts'
import { FileService } from './host/file-service.ts'
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
 * **以下三处刻意不改**，它们是已发布客户端依赖的对外契约，改了等于破坏兼容：
 * - REST 前缀 `/dsh-workspace-api`（`src/host/server.ts`）
 * - 独立页路径 `/dsh-workspace`（同上）
 * - 浏览器存储键 `dsh-workspace-device-token`（`src/standalone/index.tsx`）
 *
 * 已发布的 App 把这些路径写死了，改名只动「装的时候叫什么、bundle 叫什么」。
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
  // 文件上传服务（ctx.fileUploads）：内核以 cordis 服务形式暴露。用它而不是内核那条
  // /api/session/uploadFileBinary HTTP 路由 —— 后者只绑 loopback，手机根本到不了。
  'fileUploads',
  // 附件存储（ctx.attachments）：会话历史里的图片以 attachmentId 引用存在，
  // 要显示它们就必须能按 id 取回字节。
  'attachments',
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
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const files = new FileService(database, event => events.emit(event))
  // Rebuild the pre-0.2 `apiProxy` facade over the 0.2.x host services so both
  // adapters keep the contract they were written against.
  const apiProxy = createDsh02ApiProxy(ctx)
  const chat = new DshChatAdapter(apiProxy, database, { agents: ctx.agents, commands: ctx.commands })
  const settings = new DshSettingsAdapter(apiProxy)
  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port,
    remoteHost,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
  })
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes })

  try {
    await remote.start()
  } catch (error) {
    database.close()
    throw error
  }
  const disposeEmbedded = attachEmbeddedRoutes(ctx.webServer, router, remote)
  ctx.effect(() => async () => {
    disposeEmbedded()
    await remote.stop()
    database.close()
  }, 'dsh-remote-bridge lifecycle')
  const status = remote.status()
  ctx.logger.info(`dsh-remote-bridge v${PLUGIN_VERSION}: ${status.host}:${status.port} (${status.remoteEnabled ? 'remote enabled' : 'loopback only'})`)
}

export default apply
