/**
 * `/tunnel` —— 从即时通讯（微信 / 飞书 / 钉钉 / 企业微信 …）里远程开隧道并取回配置文本。
 *
 * ## 为什么需要它
 *
 * 用户常见的困境是「人已经出门，才发现电脑上的 Cloudflare 隧道没开，配置文本也没发给自己」。
 * 此时公网入口不存在，WebUI 与 App 都够不着这台机器 —— 唯一的反向通道是 IM 机器人的
 * **长连接**（手机/IM 云 → 本机主动连出去，不需要任何入站端口）。
 *
 * 本模块只做一件事：注册一条 `/tunnel` 命令，把「开隧道 + 一次性配对码」的结果
 * 直接作为聊天消息回给发送者。**不做停止、不做改配置、不读任何文件** —— 攻击面刻意压到
 * 「最多被人开一次隧道」，而隧道本身不授予任何数据面权限（数据面仍要设备令牌）。
 *
 * ## 门禁在哪里（重要）
 *
 * 本命令**自己不做身份校验**，它依赖 IM 插件在派发命令之前执行的访问策略：
 * `@xmanrui/dsh-im` 的每个机器人都有 `canExecuteCommands` / `defaultCanExecuteCommands`，
 * 非白名单发送者的 `/xxx` 根本到不了这里（`lib/index.js` 的 access policy 判定）。因此
 * 部署侧的必要条件是：**机器人保持 allowlist 模式，且只把自己加进白名单**。
 * 这条约束写在 README「远程开隧道」一节与 SECURITY.md 里，别只在代码注释里说。
 *
 * ## 为什么直接调宿主 API 而不是走 HTTP 自调用
 *
 * 「已开隧道」这一状态下，`/manage` 管理面被判据 0 整体关门（`auth.ts` 的
 * `TUNNEL_MODE_ADMIN_DISABLED`），`/manage/config/text` 必然 403 —— 走 HTTP 就取不到
 * 配置文本。命令在插件进程内执行，与路由共用同一个隧道管理器与同一套建配置逻辑，
 * 天然绕开这个自锁，且不需要为它额外豁免任何端点。
 *
 * @module dsh-remote-bridge/im-command
 */

/** 命令名（不带斜杠）。 */
export const TUNNEL_COMMAND_NAME = 'tunnel'

/** 命令描述：会出现在 IM 的 `/help` 里。 */
export const TUNNEL_COMMAND_DESCRIPTION = '开启 Cloudflare 隧道并返回地址与一次性配对码'

/**
 * 一次成功的开隧道结果。
 *
 * ## 为什么是「配对码」而不是 `DSH1:` 长文本（issue #28）
 *
 * 这里曾经回一行 400+ 字符的 `DSH1:` 配置文本。2026-11-22 真机实测：这段文本经
 * 微信转发/复制后会**掉字符**——用户拿到的那份里 `token` 只有 42 位，而桥签发的
 * 一律 43 位（`randomBytes(32).toString('base64url')`），于是 App 拿着一枚「库里
 * 不存在」的令牌去连，桥只能回 `TOKEN_INVALID`。同一台电脑上「WebUI → 生成配对码」
 * 却一次就通，差别就在文本长度。
 *
 * 所以 IM 侧改回**短配对码**：10 字符量级，复制不会坏；权限仍在配对那一刻由
 * `scopes` 决定，语义与以前的「预建设备」完全一致。长文本仍保留在 WebUI 的
 * 「生成配置文本」里——那条路径是整段复制，没有 IM 转发的损耗。
 */
export interface TunnelCommandResult {
  /** 隧道公网地址（`https://<random>.trycloudflare.com`）。 */
  /**
   * 候选地址表，**隧道在前**（与配置文本同口径，见 `composeCandidates`）：
   * `[0]` 是公网隧道地址，其后是局域网 / 虚拟网。老客户端只认第一条也能连。
   */
  urls: string[]
  /** 一次性配对码（10 位十六进制字母数字，10 分钟内有效、只能用一次）。 */
  pairingCode: string
  /** 配对码过期时刻（毫秒时间戳），用于在回复里写清有效期。 */
  expiresAt: number
}

/** 命令的宿主侧依赖：只有一个函数，测试里换成假实现即可。 */
export interface TunnelCommandDeps {
  /**
   * 打开隧道并产出配置文本。
   *
   * 实现方负责：确保 cloudflared 存在 → startQuick → 等随机域名 → 建配置文本。
   * 隧道**已在运行**时实现方可以直接复用当前地址（不重复 spawn）。
   */
  openTunnel(): Promise<TunnelCommandResult>
  /** 可选日志；不传则静默。 */
  logger?: { info(message: string): void; warn(error: Error): void }
}

/** 命令处理器的返回值（内核 `CommandResult` 的结构子集）。 */
export type TunnelCommandOutcome =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/** 内核 `CommandInvocation` 的结构子集：只声明本命令真的会读的字段。 */
export interface TunnelCommandInvocation {
  readonly rawInput: string
}

/** 配对码有效期（分钟），仅用于拼人话；真值在 `result.expiresAt`。 */
function pairingMinutes(expiresAt: number): number {
  const remaining = Math.round((expiresAt - Date.now()) / 60_000)
  return remaining > 0 ? remaining : 10
}

/** 把结果拼成聊天消息。 */
export function formatTunnelReply(result: TunnelCommandResult): string {
  return [
    `${result.urls.join(',')}#${result.pairingCode}`,
    `（一行粘进 App 的导入框即可：它会拆成多条候选地址 + 配对码，连哪条自己探；每次 /tunnel 都重新签发，${pairingMinutes(result.expiresAt)} 分钟内有效、只能用一次）`,
  ].join('\n')
}

/**
 * 创建 `/tunnel` 的命令定义（不注册，纯数据，便于单测）。
 *
 * 参数只接受空串：本命令刻意**不接受**任何开关，避免出现「`/tunnel stop`」这种需要
 * 额外鉴权语义的入口。带参数一律回用法说明。
 */
export function createTunnelCommand(deps: TunnelCommandDeps): {
  name: string
  description: string
  input: { hint: string }
  handler: (invocation: TunnelCommandInvocation) => Promise<TunnelCommandOutcome>
} {
  /** 同一时刻只允许一次开隧道（IM 侧重发、双端同时发都可能撞上）。 */
  let inFlight = false

  return {
    name: TUNNEL_COMMAND_NAME,
    description: TUNNEL_COMMAND_DESCRIPTION,
    input: { hint: '（无需参数）' },
    async handler(invocation) {
      if (invocation.rawInput.trim().length > 0) {
        return { kind: 'error', text: '用法：/tunnel（不需要参数）' }
      }
      if (inFlight) {
        return { kind: 'error', text: '上一次开隧道还没结束，请稍等几秒再发一次。' }
      }
      inFlight = true
      try {
        const result = await deps.openTunnel()
        deps.logger?.info(`[dsh-remote-bridge] /tunnel 已开启隧道 ${result.urls[0] ?? '(no url)'}`)
        return { kind: 'success', text: formatTunnelReply(result) }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        // 命令返回值会原样进聊天记录，所以这里**只回可读原因**，不拼接堆栈。
        deps.logger?.warn(cause instanceof Error ? cause : new Error(message))
        return { kind: 'error', text: `开隧道失败：${message}` }
      } finally {
        inFlight = false
      }
    },
  }
}

/** 命令注册表的最小结构契约（内核 `CommandRuntime` 的结构子集）。 */
export interface TunnelCommandRegistry {
  register(definition: {
    name: string
    description: string
    input?: { hint: string; attachments?: boolean }
    handler: (invocation: TunnelCommandInvocation) => Promise<TunnelCommandOutcome>
  }): () => void
}

/**
 * 注册 `/tunnel` 并返回注销函数。
 *
 * 注册是**全局层**（不是 agent 子层），所以任何 IM 会话、任何工作区里都能用 ——
 * 这正是本命令的用途：开机时人不在电脑边。是否允许某个人执行，由 IM 插件的
 * 访问策略决定（见模块头注释）。
 */
export function registerTunnelCommand(
  registry: TunnelCommandRegistry,
  deps: TunnelCommandDeps,
): () => void {
  return registry.register(createTunnelCommand(deps))
}

/**
 * ## 为什么除命令之外还要一个工具
 *
 * `@xmanrui/dsh-im` 5.4.0 的斜杠命令表是**封闭的**：内置 31 条，另外只把
 * `/compact` `/clear` `/permission` 三条委派给宿主（`lib/index.js` 里
 * `executeCommand("/compact")` 等固定字面量），**没有**「未知命令转交宿主命令表」的通用派发，
 * 也从不调用 `commands.list`。所以在 IM 里发 `/tunnel` 到不了上面那个命令处理函数 ——
 * 它会当成一句普通消息交给智能体。
 *
 * 于是 IM 侧真正可用的入口是**工具**：用户用自然语言说一句（「帮我开隧道，把配置发我」），
 * 智能体调用本工具，结果直接回到聊天里。命令与工具共用同一个 `openTunnel()`，
 * 语义完全一致；两者的差别只是「谁来触发」。
 */

/** 工具名（模型可见）。 */
export const TUNNEL_TOOL_NAME = 'open_tunnel_config'

/**
 * 模型可见描述。
 *
 * 写英文是惯例（工具描述面向模型，与仓内其他描述同语言），并显式写清
 * 「用户说开隧道/取配置时调用」，否则模型倾向于自己用 bash 拼一条 curl。
 *
 * 两条历史教训都留在里面：
 * - issue IKX5N7：客户端新对话里 `/tunnel` 会被当普通消息交给智能体，模型拿到凭据后
 *   习惯先写一大段说明，凭据排到很后面 → 要求把凭据放到回复最前面。
 * - issue #28：曾经回一行 400+ 字符的 `DSH1:` 文本，经 IM 转发会掉字符（令牌变成
 *   库里不存在的一枚），所以现在只回「地址 + 一次性配对码」两行短文本。
 */
export const TUNNEL_TOOL_DESCRIPTION =
  'Open the Cloudflare quick tunnel for this DSH host and return its candidate addresses plus a ' +
  'one-time pairing code that a phone app can use to pair. Use it whenever the user asks to ' +
  'start the tunnel, to get the connection info, or says they are away from the computer and ' +
  'need remote access. ' +
  'It never stops the tunnel and never touches files. ' +
  'When you reply, give the `<url>#<pairingCode>` line as the very first line — ' +
  'no code fences, no re-wrapping, no reformatting — and keep any explanation to at most ' +
  'two short sentences after it, because the user pastes that line into the app.'

/** 工具的返回结构（与 `TunnelCommandResult` 同源）。 */
export interface TunnelToolOutput {
  /** 逗号分隔的候选地址表（隧道在前）；与配对码用 `#` 拼成一行短码。 */
  addresses: string
  pairingCode: string
  expiresAt: number
}

/** 内核 tool 注册表的结构子集：只声明本工具真的会用到的字段。 */
export interface TunnelToolRegistry {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render: (args: Record<string, never>, value: TunnelToolOutput) => Array<{ type: string; text: string }>
    }
    execute: (args: Record<string, never>, exec: unknown) => Promise<TunnelToolOutput>
  }): () => void
}

/** 创建工具定义（不注册，便于单测）。 */
export function createTunnelTool(deps: TunnelCommandDeps): Parameters<TunnelToolRegistry['register']>[0] {
  return {
    name: TUNNEL_TOOL_NAME,
    description: TUNNEL_TOOL_DESCRIPTION,
    // 无参数：这条工具只有一个用途，给它加开关等于给自己加鉴权面。
    parameters: {},
    output: {
      // 内核的 `assertSupportedJsonSchema` 只接受一个很小的子集：
      // `type` / `oneOf` / `properties` / `required` / `additionalProperties` /
      // `items` / `enum` / `const` + 注解。两条硬规则（实测 `dsh-tools`
      // `lib/types/json-schema.js`）：
      // 1. `required` **只能**出现在 `type: 'object'` 的节点上 ——
      //    写在属性节点（`properties.url.required`）上直接被拒；
      // 2. 顶层 `required` 必须是**属性名字符串数组**，不能是 `true`。
      // 违反任一条 → `ToolsService.register` 抛错 → 插件侧注册失败，
      // 工具在模型可见列表里**静默消失**（只有一行 warn）。见 issue #22。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          addresses: { type: 'string' },
          pairingCode: { type: 'string' },
          expiresAt: { type: 'number' },
        },
        required: ['addresses', 'pairingCode', 'expiresAt'],
      },
      // 顺序有意为之（issue IKX5N7）：**凭据放第一块**。模型倾向于复述它先看到的
      // 那段，之前把「Tunnel is up at …」放前面时，回复往往是先一句寒暄再贴码；
      // 现在第一块就是可直接长按复制的一行短码「地址#配对码」，第二块才给有效期与
      // 「原样回这一行、别加解释」的提醒。
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.addresses}#${value.pairingCode}`,
        },
        {
          type: 'text',
          text:
            `The pairing code expires at ${new Date(value.expiresAt).toISOString()} and works once. ` +
            'Reply with that single line verbatim as the very first line of your answer, and keep ' +
            'any extra explanation to at most two short sentences: the user pastes it into the app.',
        },
      ],
    },
    async execute() {
      const result = await deps.openTunnel()
      deps.logger?.info(`[dsh-remote-bridge] ${TUNNEL_TOOL_NAME} 已开启隧道 ${result.urls[0] ?? '(no url)'}`)
      return {
        addresses: result.urls.join(','),
        pairingCode: result.pairingCode,
        expiresAt: result.expiresAt,
      }
    },
  }
}

/** 注册工具并返回注销函数。注册是全局层：任何会话（含 IM 会话）都能调用。 */
export function registerTunnelTool(
  registry: TunnelToolRegistry,
  deps: TunnelCommandDeps,
): () => void {
  return registry.register(createTunnelTool(deps))
}

