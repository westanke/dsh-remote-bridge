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

export const name = 'dsh-workspace'

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
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new Error('dsh-workspace: maxUploadBytes must be positive')

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
  }, 'dsh-workspace lifecycle')
  const status = remote.status()
  ctx.logger.info(`dsh-workspace v${PLUGIN_VERSION}: ${status.host}:${status.port} (${status.remoteEnabled ? 'remote enabled' : 'loopback only'})`)
}

export default apply
