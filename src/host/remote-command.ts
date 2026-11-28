/**
 * `/remote` 命令 + `open_remote_access` 工具：**不开 WebUI 也能开远程访问、取配对码**。
 *
 * ## 为什么需要它
 *
 * 2.15.0 起 dsh-Go 的「接入」面板能看到状态，但远程访问的开关与配对码一直只在 WebUI 的
 * 「手机设置 → 远程访问」里（见 dsh-go-panel.ts 头注释：dsh-Go 的身份是内核客户端，
 * 与设备表没有映射，面板里放写操作等于绕过管理面鉴权）。`/tunnel` 也帮不上忙 ——
 * 它的候选地址取自 `remote.status().host`，远程没开时那是回环，`lan` / `wan` 筛完是空表。
 *
 * 于是「人不在电脑边」这件事在第一步就断了。这条命令补上第一步：
 *
 * - `/remote`（默认 all）/ `/remote lan` / `/remote wan`：**没开就先开**（绑定已配置的
 *   监听地址），开完把 `operation.pairingCode` 与 `pairingUrls` 原样回给用户；已经开着
 *   就直接签发一枚同范围的码。
 * - `/remote off`：关掉远程访问（回到回环）。
 *
 * ## 为什么写操作放在命令/工具里，而不是 dsh-Go 面板里
 *
 * 命令与工具跑在**用户自己的会话**里：能在这里发话的人，本来就能让智能体在这台机器上
 * 执行命令 —— 「开个端口」不越过任何他已经拥有的能力。dsh-Go 的 `/dsh-go/v1/invoke`
 * 则没有回环判据（`runtime/bridge/dsh-go-bridge/lib/native/routes.js` 只校验注册令牌与
 * 限流），任何能连到内核端口的客户端都能触发。所以面板那侧只做两件事：把二维码画出来、
 * 把「去对话里发 /remote」这句话写清楚（按钮只返回 `command` 效果，由 App 在**当前对话**
 * 执行命令，仍旧落在会话身份上）。
 *
 * ## 为什么不在这里开隧道
 *
 * `tun` / `all` 在 `/tunnel` 里的语义包含公网隧道；本命令**不启动 cloudflared**
 * （一台 cloudflared 下载不下来的机器照样要能开家用访问，见 issue #1）。所以这里只接受
 * `lan` / `wan` / `all`，`tun` 明确提示改用 `/tunnel` —— 静默把 `tun` 当成 `all` 会让
 * 用户以为「隧道也开了」。
 */

import { DEFAULT_DEVICE_SCOPES } from '../shared/contracts.ts'
import {
  CANDIDATE_SCOPE_LABEL,
  DEFAULT_PORT,
  candidateUrlsFor,
  parseCandidateScope,
  type CandidateScope,
} from './config-text.ts'
import { type RemoteOperationView, type RouterOptions } from './router.ts'

/** 命令名（与工具 `open_remote_access` 同一件事的两个入口）。 */
export const REMOTE_COMMAND_NAME = 'remote'

/** 本命令接受的地址范围：不含 `tun`（隧道由 `/tunnel` 负责，见文件头）。 */
export const REMOTE_SCOPES: readonly CandidateScope[] = ['lan', 'wan', 'all']

/** 命令描述（出现在 IM 的 `/help` 里，也是参数的唯一发现入口）。 */
export const REMOTE_COMMAND_DESCRIPTION =
  '开启或关闭远程访问并签发一次性配对码（可选 lan / wan / all，或 off）'

/** 参数非法时原样回这句；**不消耗**一次开监听。 */
const REMOTE_COMMAND_USAGE =
  '用法：/remote [lan|wan|all]（默认 all）· /remote off\n' +
  'lan=局域网地址 · wan=外网+虚拟网+IPv6（均只开本机监听，不开隧道；要公网隧道用 /tunnel）· off=关闭远程访问'

/**
 * 客户端下载页（与 `src/client/app-qr.ts` 里二维码指向的地址**必须一致**，
 * `tests/remote-command.spec.ts` 会核对，防止两处各写一份后漂移）。
 */
export const CLIENT_DOWNLOADS = [
  { client: 'dsh-Chat', label: 'GitHub', url: 'https://github.com/westanke/dsh-Chat/releases' },
  { client: 'dsh-Chat', label: 'Gitee', url: 'https://gitee.com/westanke/dsh-Chat/releases' },
] as const

/** 一次 `/remote` 的结果；`off` 时 `pairingCode` 为 null。 */
export interface RemoteCommandResult {
  /** 执行完之后远程访问是不是开着的。 */
  enabled: boolean
  /** 候选地址（`#` 左边那段），关掉时为空数组。 */
  urls: string[]
  /** 一次性配对码；只有「开」才有。 */
  pairingCode: string | null
  /** 配对码过期时刻（毫秒时间戳）。 */
  expiresAt: number | null
  /** 实际监听地址与端口（回执里写清楚，用户才知道自己绑到了哪儿）。 */
  host: string
  port: number
  /** 这次用的地址范围。 */
  scope: CandidateScope
}

/** 命令与工具共用的宿主侧依赖；测试里换成假实现即可。 */
export interface RemoteCommandDeps {
  openRemote(scope: CandidateScope): Promise<RemoteCommandResult>
  closeRemote(): Promise<RemoteCommandResult>
  logger?: { info(message: string): void; warn(error: Error): void }
}

/** 命令处理器的返回值（内核 `CommandResult` 的结构子集）。 */
export type RemoteCommandOutcome =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/** 内核 `CommandInvocation` 的结构子集。 */
export interface RemoteCommandInvocation {
  readonly rawInput: string
}

/** 配对码有效期（分钟），仅用于拼人话。 */
function pairingMinutes(expiresAt: number): number {
  const remaining = Math.round((expiresAt - Date.now()) / 60_000)
  return remaining > 0 ? remaining : 10
}

/** 下载入口那一句（命令回执与工具输出共用；聊天里放不了图，只能给链接）。 */
export function formatDownloads(): string {
  const links = CLIENT_DOWNLOADS.map(item => `${item.label} ${item.url}`).join(' · ')
  return `客户端下载（二维码在 dsh-Go 的「接入」面板）：${links}`
}

/**
 * 把结果拼成聊天消息。
 *
 * 第一行仍是「地址#配对码」的短码（与 `/tunnel` 同形状：一行粘进 App 的导入框）。
 * 第二行写范围、监听位置、有效期与下载入口 —— 用户不在电脑边时，这四项就是全部上下文。
 */
export function formatRemoteReply(result: RemoteCommandResult): string {
  if (!result.enabled || result.pairingCode === null) {
    return `远程访问已关闭：现在只有这台机器自己连得上（监听 ${result.host}:${result.port}）。`
  }
  const range = result.scope === 'all' ? '' : `本范围：${CANDIDATE_SCOPE_LABEL[result.scope]}；`
  const expiresIn = result.expiresAt === null ? '' : `${pairingMinutes(result.expiresAt)} 分钟内有效、只能用一次；`
  return [
    `${result.urls.join(',')}#${result.pairingCode}`,
    `（${range}远程访问已开启，监听 ${result.host}:${result.port}；${expiresIn}一行粘进 App 的导入框即可）\n${formatDownloads()}`,
  ].join('\n')
}

/** 创建 `/remote` 的命令定义（不注册，纯数据，便于单测）。 */
export function createRemoteCommand(deps: RemoteCommandDeps): {
  name: string
  description: string
  input: { hint: string }
  handler: (invocation: RemoteCommandInvocation) => Promise<RemoteCommandOutcome>
} {
  /** 同一时刻只允许一次变更（IM 重发、双端同时发都可能撞上 `LISTENER_CHANGE_PENDING`）。 */
  let inFlight = false

  return {
    name: REMOTE_COMMAND_NAME,
    description: REMOTE_COMMAND_DESCRIPTION,
    input: { hint: `[${REMOTE_SCOPES.join('|')}|off]` },
    async handler(invocation) {
      const raw = invocation.rawInput.trim()
      const lowered = raw.toLowerCase()
      const wantOff = lowered === 'off' || lowered === 'close' || lowered === 'stop'
      const scope = wantOff ? 'all' : (raw === '' ? 'all' : parseCandidateScope(raw))
      if (scope === null) return { kind: 'error', text: REMOTE_COMMAND_USAGE }
      // `tun` 明确拒绝：本命令不开隧道（静默当成 all 会让用户以为隧道也开了）。
      if (!wantOff && !REMOTE_SCOPES.includes(scope)) {
        return { kind: 'error', text: `「${CANDIDATE_SCOPE_LABEL[scope]}」要开公网隧道，请用 /tunnel；${REMOTE_COMMAND_USAGE}` }
      }
      if (inFlight) return { kind: 'error', text: '上一次远程访问变更还没结束，请稍等几秒再发一次。' }
      inFlight = true
      try {
        const result = wantOff ? await deps.closeRemote() : await deps.openRemote(scope)
        deps.logger?.info(
          `[dsh-remote-bridge] /remote ${wantOff ? 'off' : scope} → ${result.enabled ? 'on' : 'off'} ${result.host}:${result.port}`,
        )
        return { kind: 'success', text: formatRemoteReply(result) }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        // 命令返回值会原样进聊天记录：只回可读原因，不拼堆栈。
        deps.logger?.warn(cause instanceof Error ? cause : new Error(message))
        return { kind: 'error', text: `远程访问变更失败：${message}` }
      } finally {
        inFlight = false
      }
    },
  }
}

/** 命令注册表的最小结构契约（内核 `CommandRuntime` 的结构子集）。 */
export interface RemoteCommandRegistry {
  register(definition: {
    name: string
    description: string
    input?: { hint: string; attachments?: boolean }
    handler: (invocation: RemoteCommandInvocation) => Promise<RemoteCommandOutcome>
  }): () => void
}

/** 注册 `/remote` 并返回注销函数。注册是全局层：任何会话都能用。 */
export function registerRemoteCommand(
  registry: RemoteCommandRegistry,
  deps: RemoteCommandDeps,
): () => void {
  return registry.register(createRemoteCommand(deps))
}

/** 工具名（模型可见）。 */
export const REMOTE_TOOL_NAME = 'open_remote_access'

/**
 * 模型可见描述。
 *
 * IM 插件的斜杠命令表是封闭的（未知命令会当普通消息交给智能体），所以 IM 侧真正
 * 可用的入口是这条工具 —— 与 `/tunnel` 的处境完全相同（见 im-command.ts 头注释）。
 * 描述里显式写「不要跑 shell 命令去改数据库」，否则模型倾向自己拼 sqlite3。
 */
export const REMOTE_TOOL_DESCRIPTION =
  'Turn remote access for this DSH host on (binding the configured listener address) and return a ' +
  'one-time pairing code with the candidate addresses, or turn it off. Use it when the user asks to ' +
  'enable remote access, to get a pairing code, or says they are away from the computer and the ' +
  'WebUI is out of reach. ' +
  'Pass `scope` to trim the returned addresses: "lan" = LAN addresses only, ' +
  '"wan" = public IPv4 + virtual network + IPv6, "all" = every local address (default). ' +
  'It never starts a tunnel (ask for /tunnel or open_tunnel_config for that) and never touches files. ' +
  'When you reply, give the `<addresses>#<pairingCode>` line as the very first line — no code ' +
  'fences, no re-wrapping — then at most two short sentences, because the user pastes that line ' +
  'into the app.'

/** 工具的返回结构。 */
export interface RemoteToolOutput {
  /** 变更之后远程访问是否开着。 */
  enabled: boolean
  /** 逗号分隔的候选地址；关掉时是空串。 */
  addresses: string
  /** 配对码；关掉时是空串（schema 不接受 null）。 */
  pairingCode: string
  /** 过期时刻（毫秒时间戳）；关掉时是 0。 */
  expiresAt: number
  /** 一句人话（监听位置 / 已关闭），供模型复述。 */
  summary: string
  /** 客户端下载页，一条一行。 */
  downloads: string
}

/** 内核 tool 注册表的结构子集。 */
export interface RemoteToolRegistry {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render: (args: Record<string, never>, value: RemoteToolOutput) => Array<{ type: string; text: string }>
    }
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<RemoteToolOutput>
  }): () => void
}

/** 创建工具定义（不注册，便于单测）。 */
export function createRemoteTool(deps: RemoteCommandDeps): Parameters<RemoteToolRegistry['register']>[0] {
  return {
    name: REMOTE_TOOL_NAME,
    description: REMOTE_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: [...REMOTE_SCOPES],
          description:
            'Address range for the returned candidates: lan = LAN only, ' +
            'wan = public IPv4 + virtual network + IPv6, all = every local address (default). ' +
            'Tunnels are a separate entry point (open_tunnel_config); never asked for here.',
        },
        action: {
          type: 'string',
          enum: ['enable', 'disable'],
          description: 'enable (default) turns remote access on and issues a code; disable turns it off.',
        },
      },
    },
    output: {
      // 内核 schema 子集的两条硬规则见 im-command.ts 里同一段注释（issue #22）：
      // `required` 只能挂在 `type: 'object'` 节点上，且必须是属性名数组。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          addresses: { type: 'string' },
          pairingCode: { type: 'string' },
          expiresAt: { type: 'number' },
          summary: { type: 'string' },
          downloads: { type: 'string' },
        },
        required: ['enabled', 'addresses', 'pairingCode', 'expiresAt', 'summary', 'downloads'],
      },
      // 凭据放第一块（issue IKX5N7 的同一个教训）：模型会复述它先看到的那段。
      render: (_args, value) => value.enabled
        ? [
          { type: 'text', text: `${value.addresses}#${value.pairingCode}` },
          {
            type: 'text',
            text:
              `${value.summary} The code expires at ${new Date(value.expiresAt).toISOString()} and works once. ` +
              'Reply with the first block verbatim as the very first line, keep extra explanation to at most ' +
              `two short sentences, and mention the QR codes live in the dsh-Go “Access” panel.\n${value.downloads}`,
          },
        ]
        : [{ type: 'text', text: value.summary }, { type: 'text', text: value.downloads }],
    },
    async execute(args) {
      const input = args as { scope?: unknown; action?: unknown }
      const action = input.action === 'disable' ? 'disable' : 'enable'
      const rawScope = input.scope
      const scope = rawScope === undefined || rawScope === null
        ? 'all'
        : parseCandidateScope(rawScope)
      if (scope === null || !REMOTE_SCOPES.includes(scope)) {
        throw new Error(`scope 只能是 ${REMOTE_SCOPES.join(' / ')}（隧道请用 open_tunnel_config）。`)
      }
      const result = action === 'disable' ? await deps.closeRemote() : await deps.openRemote(scope)
      deps.logger?.info(
        `[dsh-remote-bridge] ${REMOTE_TOOL_NAME} ${action}${action === 'enable' ? ` ${scope}` : ''} → ${result.enabled ? 'on' : 'off'}`,
      )
      return {
        enabled: result.enabled,
        addresses: result.urls.join(','),
        pairingCode: result.pairingCode ?? '',
        expiresAt: result.expiresAt ?? 0,
        summary: result.enabled
          ? `Remote access is on, listening on ${result.host}:${result.port}.`
          : `Remote access is off; only this machine can connect (listening on ${result.host}:${result.port}).`,
        downloads: CLIENT_DOWNLOADS.map(item => `${item.client} ${item.label}: ${item.url}`).join('\n'),
      }
    },
  }
}

/** 注册工具并返回注销函数。注册是全局层：任何会话（含 IM 会话）都能调用。 */
export function registerRemoteTool(
  registry: RemoteToolRegistry,
  deps: RemoteCommandDeps,
): () => void {
  return registry.register(createRemoteTool(deps))
}

// ------------------------------------------------------------------ 宿主半侧

/** 等一次监听变更落地的最长时间：重绑是本机操作，正常几十毫秒。 */
const OPERATION_TIMEOUT_MS = 8_000

/** 轮询间隔：与 WebUI 的 `poll()` 同一量级，够快也不打满 CPU。 */
const OPERATION_POLL_MS = 100

/**
 * 等 `enable` / `disable` 的 operation 收敛。
 *
 * `RemoteApiServer` 的变更是异步的（75 ms 定时器 → rebind → 写库），而命令要**当场**
 * 回配对码。所以这里轮询 `status(operationId)`，而不是让用户「等几秒再发一次」。
 * 超时也照实说：不抛一个只有作者看得懂的内部错误。
 */
async function waitOperation(
  remote: RouterOptions['remote'],
  id: string,
): Promise<RemoteOperationView> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  for (;;) {
    const view = remote.status(id).operation
    if (view !== undefined && view.state !== 'pending') return view
    if (Date.now() >= deadline) {
      throw new Error('监听变更超过 8 秒还没结束；再发一次 /remote 可以复用当前状态。')
    }
    await new Promise(resolve => setTimeout(resolve, OPERATION_POLL_MS))
  }
}

/** 空表要抛可读错误：回一行只有 `#码` 的残码，用户复制过去只会一直连不上。 */
function requireUrls(urls: string[], scope: CandidateScope): string[] {
  if (urls.length === 0) {
    throw new Error(
      `按「${CANDIDATE_SCOPE_LABEL[scope]}」筛完没有可用地址：这台机器此刻没有这一类地址，换个范围再发一次。`,
    )
  }
  return urls
}

/** 没有根目录时配对码批不出任何路径，先拦住并说清怎么办。 */
function rootIdsOrThrow(options: RouterOptions): string[] {
  const rootIds = options.database.listRoots().map(root => root.id)
  if (rootIds.length === 0) {
    throw new Error('还没有授权根目录：先在「根目录」里加一个（WebUI 或 App），否则配对码批不了任何路径。')
  }
  return rootIds
}

/**
 * `/remote` 的宿主侧实现：确保远程访问开着，然后给一枚该范围的配对码。
 *
 * 两个分支的口径不同，这是刻意的：
 * - **刚开**：码由 `performChange` 在建监听时一并签发（`operation.pairingCode`），
 *   地址用它算好的 `pairingUrls` —— 那是**实际**绑定后的 host/port，比我们再猜一次准。
 * - **早已开着**：这里新建一枚码，地址用 `candidateUrlsFor` 现算（同一条出口，
 *   见 config-text.ts 的说明）。
 */
export async function openRemoteForCommand(
  options: RouterOptions,
  scope: CandidateScope = 'all',
): Promise<RemoteCommandResult> {
  const requestId = `remote-command-${Date.now().toString(36)}`
  const rootIds = rootIdsOrThrow(options)
  const status = options.remote.status()

  if (!status.remoteEnabled) {
    const operation = await waitOperation(options.remote, options.remote.enable(
      rootIds,
      [...DEFAULT_DEVICE_SCOPES],
      scope,
    ).id)
    if (operation.state !== 'succeeded') {
      throw new Error(operation.message ?? `监听变更失败（${operation.code ?? operation.state}）。`)
    }
    if (operation.pairingCode === undefined || operation.pairingCode === null) {
      throw new Error('远程访问已开启，但没有拿到配对码；再发一次 /remote 可以直接签发一枚。')
    }
    const urls = requireUrls(operation.pairingUrls ?? [], scope)
    options.database.audit('admin', 'im-command', 'listener.enable', undefined, undefined, {
      scope,
      via: REMOTE_COMMAND_NAME,
    })
    return {
      enabled: true,
      urls,
      pairingCode: operation.pairingCode,
      expiresAt: operation.pairingExpiresAt ?? Date.now() + 10 * 60_000,
      host: status.host,
      port: status.port,
      scope,
    }
  }

  const port = Number.isInteger(status.port) && status.port > 0 ? status.port : DEFAULT_PORT
  const urls = requireUrls(candidateUrlsFor({
    port,
    listenerHost: status.host,
    tunnelUrl: null,
    scope,
  }), scope)
  const pairing = options.database.createPairing(rootIds, [...DEFAULT_DEVICE_SCOPES], undefined, { requestId })
  options.database.audit('admin', 'im-command', 'remote.pairing', undefined, undefined, {
    scope,
    via: REMOTE_COMMAND_NAME,
  })
  return {
    enabled: true,
    urls,
    pairingCode: pairing.code,
    expiresAt: pairing.expiresAt,
    host: status.host,
    port: status.port,
    scope,
  }
}

/** `/remote off` 的宿主侧实现：关掉远程访问，回执里写清关完监听在哪。 */
export async function closeRemoteForCommand(options: RouterOptions): Promise<RemoteCommandResult> {
  const operation = await waitOperation(options.remote, options.remote.disable().id)
  if (operation.state !== 'succeeded') {
    throw new Error(operation.message ?? `监听变更失败（${operation.code ?? operation.state}）。`)
  }
  const status = options.remote.status()
  options.database.audit('admin', 'im-command', 'listener.disable', undefined, undefined, {
    via: REMOTE_COMMAND_NAME,
  })
  return {
    enabled: false,
    urls: [],
    pairingCode: null,
    expiresAt: null,
    host: status.host,
    port: status.port,
    scope: 'all',
  }
}
