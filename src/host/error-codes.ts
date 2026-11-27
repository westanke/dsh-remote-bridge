/**
 * mobile WS `error` 帧的错误码语义表（issue #IKXGYS，2026-11-23 起）。
 *
 * 为什么集中成表而不是散在各发送点：`code` 此前是自由字符串，客户端无从区分
 * 「这个错可以重试」与「死了别再试」。参考 ds-harness-remote 的做法
 * （packages/protocol/src/index.ts 的 errorCodes 分组 + 每码 `retryable` 位），
 * 把桥实际会出现在 error 帧里的码分成六组，每组给一个明确的 `retryable` 判定。
 *
 * `transport` 组专指连接/传输层限制：`FRAME_TOO_LARGE` 是连接级错误（超限帧
 * 未解码，回显不了原帧的 `requestId`），客户端按连接级错误处理。
 *
 * 契约（docs/API.md 与 docs/api/asyncapi.yaml 同步成文）：
 * - `retryable: true`  ⇒ 同一请求原样重试**可能**成功（上游/内部暂时性故障）；
 * - `retryable: false` ⇒ 原样重试不会成功（客户端 bug / 授权缺失 / 资源状态已定）；
 * - 帧上**未带** `retryable` ⇒ 未知错误码，客户端一律按 `false` 处理（保守方向）。
 *
 * `details` 与本表无关：它由发送点自填（如 `RATE_LIMITED` 的 `retryAfterMs`），
 * 禁止携带绝对路径（SECURITY.md「不回显上游细节」）。
 */

/** 错误码分组：帧上不出现，用于文档与测试对账（与 API.md 的分组表一一对应）。 */
export type ErrorFrameGroup =
  | 'usage'
  | 'auth'
  | 'state'
  | 'transport'
  | 'upstream'
  | 'internal'

/**
 * code → 分组。只收录桥现在真的会放进 error 帧的码（`grep "code: '" src/host` 全集
 * + REST ApiError 透传码）；加新错误码时同批登记这里、API.md 分组表与 asyncapi。
 */
const ERROR_FRAME_TABLE: Record<string, { group: ErrorFrameGroup; retryable: boolean }> = {
  // usage：客户端用法错 —— 原样重发同一个帧永远不会成功。
  UNKNOWN_TYPE: { group: 'usage', retryable: false },
  MISSING_TYPE: { group: 'usage', retryable: false },
  INVALID_FRAME: { group: 'usage', retryable: false },
  MISSING_PARAMS: { group: 'usage', retryable: false },
  BAD_REQUEST: { group: 'usage', retryable: false },
  REQUEST_INVALID: { group: 'usage', retryable: false },
  JSON_INVALID: { group: 'usage', retryable: false },
  // NOT_IMPLEMENTED 是能力缺失：换客户端也没用，原样重试更没用。
  NOT_IMPLEMENTED: { group: 'usage', retryable: false },
  PATH_OUTSIDE_ROOTS: { group: 'usage', retryable: false },

  // auth：凭据/授权缺失 —— 重试无意义，要走重新配对或授权。
  AUTH_REQUIRED: { group: 'auth', retryable: false },
  FORBIDDEN_SCOPE: { group: 'auth', retryable: false },
  SCOPE_REQUIRED: { group: 'auth', retryable: false },
  ACCOUNT_SIGNED_OUT: { group: 'auth', retryable: false },
  TUNNEL_MODE_ADMIN_DISABLED: { group: 'auth', retryable: false },

  // state：资源状态已定 —— 结果确定，重试只会拿到同一个答案。
  NOT_FOUND: { group: 'state', retryable: false },
  ROUTE_NOT_FOUND: { group: 'state', retryable: false },
  SESSION_NOT_FOUND: { group: 'state', retryable: false },
  CONFLICT: { group: 'state', retryable: false },
  PAYLOAD_TOO_LARGE: { group: 'state', retryable: false },

  // transport：单帧超过连接上限 —— 压缩/拆分后重连重发可能成功。
  FRAME_TOO_LARGE: { group: 'transport', retryable: true },

  // upstream：桥背后的内核/上游暂时性故障 —— 原样重试可能成功。
  UPSTREAM_UNAVAILABLE: { group: 'upstream', retryable: true },
  SCHEDULE_FAILED: { group: 'upstream', retryable: true },
  TIMEOUT: { group: 'upstream', retryable: true },
  RATE_LIMITED: { group: 'upstream', retryable: true },

  // internal：桥自身错误 —— 重试可能成功也可能复发，但「别再试」是更糟的建议。
  INTERNAL_ERROR: { group: 'internal', retryable: true },
}

/** 已知码返回分组；未知码返回 undefined（不编造语义）。 */
export function errorFrameGroup(code: string): ErrorFrameGroup | undefined {
  return ERROR_FRAME_TABLE[code]?.group
}

/**
 * 已知码返回明确的 retryable；未知码返回 undefined —— 发送点**不写字段**，
 * 客户端按契约默认 false。这样将来新增错误码不需要客户端升级就能安全收敛。
 */
export function errorFrameRetryable(code: string): boolean | undefined {
  return ERROR_FRAME_TABLE[code]?.retryable
}
