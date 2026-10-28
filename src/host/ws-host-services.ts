/**
 * 可选内核远程服务网关（`typertGateway` + `connection`）的惰性封装。
 *
 * mobile-gateway 的定时任务（schedule）与官方语音（speech）都不是本插件自己实现的能力，
 * 而是把 WS 帧**原样代理**给内核通过 Typert Remote 发布的服务：
 * - `typertGateway.invoke({ namespace, method, args, peer, signal })`
 * - `typertGateway.stream({ namespace, method, args, peer, signal })`
 *
 * 两个服务都是**可选**的：0.2.1-rc.2 起才提供，老内核没有。因此：
 * - 不能进 `inject`（硬依赖缺一个整个插件不激活）；在 apply 期用 `ctx.reflect.get(name,false)` 取。
 * - peer 用 `connection.createPeer({ principal:{kind:'owner'}, interactions:'none' })`，
 *   插件以宿主 owner 身份代发，全部生命周期只创建一个并复用，停用时 dispose。
 * - 任一依赖缺失，{@link HostRemoteServices.available} 为 false，WS 层回结构化 unavailable。
 */

/** Typert 网关的最小结构类型（只声明用到的成员）。 */
export interface TypertGatewayLike {
  invoke(request: {
    namespace: string
    method: string
    args?: Record<string, unknown>
    peer?: unknown
    signal?: AbortSignal
  }): Promise<unknown>
  stream(request: {
    namespace: string
    method: string
    args?: Record<string, unknown>
    peer?: unknown
    signal?: AbortSignal
  }): Promise<AsyncIterable<unknown>>
}

/** 内核 connection 服务（createPeer）。 */
export interface ConnectionServiceLike {
  createPeer(options: { principal: { kind: 'owner' }; interactions: 'none' }): {
    signal: AbortSignal
    dispose(): Promise<void> | void
  }
}

/** 供 WS 域处理器调用的远程服务句柄。 */
export interface HostRemoteHandle {
  invoke(namespace: string, method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  stream(namespace: string, method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<AsyncIterable<unknown>>
}

/**
 * 在插件 apply 期从 cordis reflect 上取可选服务，构造一个可空的远程服务集。
 *
 * 注意：必须在 apply 期间调用（注入属性只在该窗口可读）；返回的对象把 gateway/peer
 * 存成快照，供之后的 WS 请求回调安全使用。
 */
export function createHostRemoteServices(reflect: {
  get?: (name: string, strict?: boolean) => unknown
} | undefined): { services: HostRemoteHandle | undefined; dispose: () => Promise<void> } {
  const gateway = readService<TypertGatewayLike>(reflect, 'typertGateway')
  const connection = readService<ConnectionServiceLike>(reflect, 'connection')

  if (
    gateway === undefined
    || typeof gateway.invoke !== 'function'
    || typeof gateway.stream !== 'function'
    || connection === undefined
    || typeof connection.createPeer !== 'function'
  ) {
    return { services: undefined, dispose: async () => {} }
  }

  // 一个 owner peer 贯穿全部代理调用，与 mobile-gateway 的单 peer 模型一致。
  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })

  const services: HostRemoteHandle = {
    invoke: (namespace, method, args, signal) =>
      gateway.invoke({ namespace, method, ...(args === undefined ? {} : { args }), peer, ...(signal === undefined ? {} : { signal }) }),
    stream: (namespace, method, args, signal) =>
      gateway.stream({ namespace, method, ...(args === undefined ? {} : { args }), peer, ...(signal === undefined ? {} : { signal }) }),
  }

  return {
    services,
    dispose: async () => {
      try {
        await peer.dispose()
      } catch {
        // 关停期 peer 释放失败不影响插件卸载。
      }
    },
  }
}

function readService<T>(reflect: { get?: (name: string, strict?: boolean) => unknown } | undefined, name: string): T | undefined {
  if (reflect?.get === undefined) return undefined
  const found = reflect.get(name, false)
  return found === undefined || found === null ? undefined : (found as T)
}
