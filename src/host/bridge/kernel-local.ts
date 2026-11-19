/**
 * 进程内传输：把「内核端点」这套语义接到宿主服务对象上。
 *
 * ## 为什么需要第二条传输
 *
 * 换源（issue #26 阶段 3）以后，门面调的是**端点名**（`session/list`）而不是
 * `host.sessionController.list`。真正的传输是 `typertGateway`（owner peer，见
 * `ws-host-services.ts`）—— 但有两处拿不到它：
 *
 * 1. **单元测试**：测试用的是假宿主服务，没有内核，也没有 peer。让几十条既有用例
 *    全部改成「自己搭一个 fake gateway」既吵又容易把断言写歪。
 * 2. **宿主内直连**：`typertGateway` 是可选服务。它缺席时（老内核 / 裁剪过的
 *    profile）会话读取不该整片死掉 —— 这些宿主仍然有 `sessionController`。
 *
 * 于是把「端点名 → 宿主方法」收成**一张表**；参数键仍由描述符给（本文件的
 * `wires` 只是描述符的声明，调用点不碰），校验、错误归一、取消透传全部复用
 * `kernel-invoke.ts` 那一条路径。**两条传输，一套端点语义**。
 *
 * ## 这张表为什么会漂，以及怎么防
 *
 * `wires` 是手写的（进程内直连没有登记表可读）。防漂移的办法是拿真实内核的
 * 目录去比：`tests/kernel-local.spec.ts` 在本机装有内核时逐条断言
 * `LOCAL_ENDPOINTS` 的 wire 键/流式/cancellation 与 `typert.host.js` 的描述符
 * **完全一致**，缺一项就红。没有内核的机器上该用例整段 skip（CI 不受影响），
 * 所以它只在开发机上生效 —— 这不是完美门禁，但它让「改了内核参数名、忘了改这张表」
 * 在开发机上立刻炸，而不是等到手机上某个功能静默失效。
 *
 * 生产路径不受本文件影响：`src/index.ts` 拿得到 `typertGateway` 时传的就是真网关。
 */

import type { Dsh02HostServices } from './kernel-services.ts'
import { createKernelEndpointCatalog, type KernelEndpointCatalog, type KernelDescriptorLike } from './kernel-endpoints.ts'
import { KernelEndpointUnknownError, type KernelCaller } from './kernel-invoke.ts'
import type { KernelGateway } from './proxy-options.ts'

/** 一个永不中止的信号：给「能接受 undefined、但接口声明要求必填 signal」的方法用。 */
const IDLE_SIGNAL = new AbortController().signal

/** 表里的一条：端点名 + 描述符 + 实现（实现拿的永远是解包后的 payload）。 */
interface LocalEndpoint {
  readonly descriptor: KernelDescriptorLike
  /**
   * 流式方法的实现返回 `AsyncIterable`；unary 返回结果值。
   *
   * `payload` 声明成 `never` 是有意的：解包出来的是 `unknown`（描述符只说「有一个
   * JSON 参数」），而各宿主方法要的是各自的请求类型。在这里收成 `never`，让表里的
   * 实现直接按方法的参数类型写、不必每个都抄一遍 `as {...}`；真正做校验的是调用点
   * （`assertKernelArguments` 已经拒了多余/缺失的 wire 键）与内核方法自己。
   */
  readonly run: (host: Dsh02HostServices, payload: never, signal: AbortSignal | undefined) => unknown
}

const request = (wire = 'request'): KernelDescriptorLike['parameters'][number] => ({
  name: wire,
  wire,
  source: 'json',
})

/**
 * 阶段 3a 收进来的十条（会话读侧 9 条 + `workspace.list`）。
 *
 * 顺序无关紧要（目录会按 endpoint 字典序排），但**按批次分组**，
 * 下一批（3b/3c/3d）直接往下追加。
 */
const LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  {
    descriptor: {
      namespace: 'session',
      method: 'list',
      parameters: [request('_request')],
      cancellation: { parameter: 'signal' },
    },
    run: (host, payload, signal) => host.sessionController.list(payload, signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: { namespace: 'session', method: 'create', parameters: [request()] },
    run: (host, payload) => host.sessionController.create(payload),
  },
  {
    // 流式 + 声明 cancellation：与真实描述符一致（`mode:'stream'` + `signal` 参数）。
    descriptor: {
      namespace: 'session',
      method: 'follow',
      mode: 'stream',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, payload, signal) => host.sessionController.follow(payload, signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: {
      namespace: 'session',
      method: 'page',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, payload, signal) => host.sessionController.page(payload, signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: {
      namespace: 'session',
      method: 'projections',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, payload, signal) => host.sessionController.projections(payload, signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: {
      namespace: 'session',
      method: 'wait',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, payload, signal) => host.sessionController.wait(payload, signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: { namespace: 'session', method: 'selectModel', parameters: [request()] },
    run: (host, payload) => host.sessionController.selectModel(payload),
  },
  {
    descriptor: { namespace: 'session', method: 'rename', parameters: [request()] },
    run: (host, payload) => host.sessionController.rename(payload),
  },
  {
    descriptor: { namespace: 'session', method: 'fork', parameters: [request()] },
    run: (host, payload) => host.sessionController.fork(payload),
  },
  {
    descriptor: { namespace: 'session', method: 'cancel', parameters: [request()] },
    run: (host, payload) => host.sessionController.cancel(payload),
  },
  {
    // `workspace/follow` 无参数、流式、声明 cancellation。宿主对象的
    // `workspaceController` 在 0.2.x 上有 `follow`；没有时用注册表拼出等价 baseline
    // （只读场景：今天的 `workspace.list` 只取首帧）。
    descriptor: {
      namespace: 'workspace',
      method: 'follow',
      mode: 'stream',
      parameters: [],
      cancellation: { parameter: 'signal' },
    },
    run: (host, _payload, signal) => localWorkspaceFollow(host, signal),
  },
]

function localWorkspaceFollow(host: Dsh02HostServices, signal: AbortSignal | undefined): AsyncIterable<unknown> {
  async function* frames(): AsyncIterable<unknown> {
    const controller = host.workspaceController as unknown as {
      follow?: (signal?: AbortSignal) => AsyncIterable<unknown>
    }
    if (typeof controller.follow === 'function') {
      yield* controller.follow(signal)
      return
    }
    const registry = host.workspaceRegistry as unknown as {
      list(): readonly { id: string; path: string; title: string; sessionIds?: readonly string[]; createdAt: string; updatedAt: string }[]
      archivedSessionIds?: readonly string[]
      pinnedSessionIds?: readonly string[]
    }
    yield {
      type: 'baseline',
      value: {
        items: registry.list().map(row => ({
          workspaceId: row.id,
          path: row.path,
          title: row.title,
          sessionIds: [...(row.sessionIds ?? [])],
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        archivedSessionIds: [...(registry.archivedSessionIds ?? [])],
        pinnedSessionIds: [...(registry.pinnedSessionIds ?? [])],
      },
    }
  }
  return frames()
}

/** 端点名 → 表项（构建一次，复用）。 */
function indexOf(endpoints: readonly LocalEndpoint[]): ReadonlyMap<string, { run: LocalEndpoint['run'] }> {
  return new Map(endpoints.map(entry => [
    `${entry.descriptor.namespace}/${entry.descriptor.method}`,
    { run: entry.run },
  ]))
}

/** 把表伪装成 Typert 登记表，复用 `createKernelEndpointCatalog` 的规整逻辑。 */
function registryOf(endpoints: readonly LocalEndpoint[]): Parameters<typeof createKernelEndpointCatalog>[0] {
  const descriptors = endpoints.map(entry => entry.descriptor)
  return {
    local: {
      list: () => descriptors,
      get: endpoint => descriptors.find(descriptor => `${descriptor.namespace}/${descriptor.method}` === endpoint),
      hasSeen: endpoint => descriptors.some(descriptor => `${descriptor.namespace}/${descriptor.method}` === endpoint),
    },
  }
}

/** 进程内网关：端点语义不变，传输是直接调宿主服务。 */
export function createLocalKernelGateway(host: Dsh02HostServices): KernelGateway {
  const catalog: KernelEndpointCatalog = createKernelEndpointCatalog(registryOf(LOCAL_ENDPOINTS))
  const table = indexOf(LOCAL_ENDPOINTS)

  const resolve = (namespace: string, method: string): LocalEndpoint['run'] => {
    const found = table.get(`${namespace}/${method}`)
    if (found === undefined) throw new KernelEndpointUnknownError(`${namespace}/${method}`)
    return found.run
  }
  // 进程内直连没有 wire 编码：参数就是描述符里的那一个 payload。多参端点在
  // 这里无法表达（也没有需要），出现就是写错，直接抛 —— 别静默只取第一个。
  const payloadOf = (endpoint: string, args: Readonly<Record<string, unknown>>): unknown => {
    const keys = Reflect.ownKeys(args)
    if (keys.length === 0) return undefined
    if (keys.length > 1) throw new KernelEndpointUnknownError(`${endpoint} (local transport takes a single payload argument)`)
    return args[String(keys[0])]
  }

  const caller: KernelCaller = {
    async invoke(namespace, method, args = {}, signal) {
      const run = resolve(namespace, method)
      // 取消照传：宿主方法的 AbortSignal 与内核 `cancellation` 参数语义一致。
      return await run(host, payloadOf(`${namespace}/${method}`, args) as never, signal)
    },
    async stream(namespace, method, args = {}, signal) {
      const run = resolve(namespace, method)
      const result = run(host, payloadOf(`${namespace}/${method}`, args) as never, signal)
      if (result === null || typeof result !== 'object') {
        throw new KernelEndpointUnknownError(`${namespace}/${method} (local transport expected a stream)`)
      }
      return result as AsyncIterable<unknown>
    },
  }

  return { caller, catalog }
}

/** 测试与 `tests/kernel-local.spec.ts` 用的表视图（只读快照）。 */
export function localEndpointDescriptors(): readonly KernelDescriptorLike[] {
  return LOCAL_ENDPOINTS.map(entry => entry.descriptor)
}
