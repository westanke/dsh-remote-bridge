import type { ListenOptions } from 'node:net'
import { isIP } from 'node:net'
import { ApiError } from './errors.ts'

/**
 * 各平台的默认监听地址。
 *
 * - Linux / macOS：`0.0.0.0`。Linux 的 `server.listen(port, '0.0.0.0')` 在
 *   多数发行版上会自动映射到双栈 socket，IPv6 也能连进来。
 * - **Windows：`::`**。Windows 没有 Linux 那套自动双栈回退：绑 `0.0.0.0` 就是
 *   **纯 IPv4** socket，3 个公网 IPv6 一个也用不上。要双栈必须绑 `::` 并显式
 *   关掉 `IPV6_V6ONLY`（见 {@link listenOptionsFor}）。这是 AtomGit issue #1 的根因。
 */
export const DEFAULT_REMOTE_HOST = '0.0.0.0'

/** 平台感知的默认监听地址（不传 platform 时用本机平台，便于测试）。 */
export function defaultRemoteHost(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '::' : DEFAULT_REMOTE_HOST
}

export function normalizeListenerHost(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || isIP(value.trim()) === 0) {
    throw new ApiError(400, 'LISTENER_HOST_INVALID', 'host must be a numeric IPv4 or IPv6 address.')
  }
  return value.trim()
}

/**
 * 把「已保存 / 传入的监听地址」归一到本机真正该绑的值。
 *
 * 唯一改写规则：**Windows 上的 `0.0.0.0` 提升为 `::`**。
 *
 * 两个来源都会走进来：
 * - 历史版本把默认值 `0.0.0.0` 写进了 settings，升级后要迁移，否则老用户仍然只有
 *   IPv4 候选（issue #1 的 workaround 就是手改这一项）。
 * - 调用方显式传 `0.0.0.0` 时，用户的本意是「全部网卡」；Windows 上「全部网卡」包含
 *   IPv6 的唯一表达就是 `::`，所以改写成 `::` 才是语义等价。
 */
export function resolveListenerHost(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const host = normalizeListenerHost(value)
  return platform === 'win32' && host === DEFAULT_REMOTE_HOST ? '::' : host
}

export function normalizeListenerPort(value: unknown, allowZero = false): number {
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) > 65535) {
    throw new ApiError(400, 'LISTENER_PORT_INVALID', `port must be between ${allowZero ? 0 : 1} and 65535.`)
  }
  return value as number
}

export function loopbackFor(
  host: string,
  platform: NodeJS.Platform = process.platform,
): '127.0.0.1' | '::1' {
  // Windows 上回环监听**固定** `127.0.0.1`，即使配置的是 IPv6 地址：Windows 的
  // `::1` 是独立的一套栈，只绑它等于把 `http://127.0.0.1:PORT` 全断掉 —— 而本机
  // 的消费者（面板复制出来的地址、`curl 127.0.0.1`、测试）都走 IPv4 回环。
  // 远程启用时仍按配置绑（`::` 是双栈，IPv4 照样能连）。
  if (platform === 'win32') return '127.0.0.1'
  return isIP(host) === 6 ? '::1' : '127.0.0.1'
}

/**
 * 生成 `server.listen()` 的参数。
 *
 * 绑 `::` 时必须显式 `ipv6Only: false`：Windows 默认双栈，但 Linux 的默认值取决于
 * `net.ipv6.bindv6only`；不声明就可能出现「接入面板列了 IPv4 候选、实际却连不上」
 * 的假候选。显式写死让两个平台行为一致（issue #1）。
 */
export function listenOptionsFor(host: string, port: number): ListenOptions {
  return host === '::' ? { port, host, ipv6Only: false } : { port, host }
}
