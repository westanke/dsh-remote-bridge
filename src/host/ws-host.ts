/**
 * 主机信息快照 WS 处理器（/ws/mobile）。
 *
 * 对齐 mobile-gateway v0.11.1 的 `host` 帧：返回 bridge 版本、宿主主目录、附着会话数、
 * 默认模型精简版。上游还有 dshVersion/historyFormatVersion/canOpenPath 三个内核字段，
 * 本桥没有对应内核 RPC，按可用信息尽力给出（canOpenPath 恒 false，不暴露宿主绝对工作目录）。
 *
 * 安全：`cwd` 只给 `os.homedir()` 级别的主目录（与上游一致），不回显任何授权根/会话绝对路径。
 */
import { homedir } from 'node:os'
import type { Principal } from '../shared/contracts.ts'
import { PLUGIN_VERSION } from '../shared/version.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { ClientFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

interface CatalogLike {
  groups?: unknown
  failures?: unknown
}

/** 主机信息处理器。 */
export class HostHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
    private readonly catalog?: () => Promise<CatalogLike>,
  ) {}

  /** 处理 host 帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (frame.type !== 'host') return false
    try {
      // 附着会话数 = 该设备可见的非归档会话数；默认模型从全局目录取首个组的首个模型（尽力）。
      const [sessions, catalog] = await Promise.all([
        this.chat.listSessions(principal, { archived: false }).catch(() => []),
        this.catalog === undefined ? Promise.resolve(undefined) : this.catalog().catch(() => undefined),
      ])
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const firstGroup = (groups[0] ?? {}) as { id?: unknown; models?: unknown }
      const firstModels = Array.isArray(firstGroup.models) ? firstGroup.models : []
      // 全局目录的模型条目可能是 {id,name} 对象，也可能直接是模型 id 字符串（测试/精简目录）。
      const firstModelEntry = firstModels[0]
      const firstModelId = typeof firstModelEntry === 'string' ? firstModelEntry : (firstModelEntry as { id?: unknown } | undefined)?.id
      this.sendFrame({
        kind: 'host',
        data: {
          version: 'remote-bridge',
          dshVersion: PLUGIN_VERSION,
          cwd: homedir(),
          attachedSessions: sessions.length,
          // 本桥没有 canOpenWorkspacePath 内核通道：保守给 false，客户端据此隐藏「在此打开」入口。
          canOpenPath: false,
          ...(typeof firstGroup.id !== 'string' || typeof firstModelId !== 'string'
            ? {}
            : { defaultProvider: firstGroup.id, defaultModel: firstModelId }),
        },
      })
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: 'Failed to describe host.' } })
      }
    }
    return true
  }
}
