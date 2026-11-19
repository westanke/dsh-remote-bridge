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
 * **完全一致**，缺一项就红。没有内核的机器上该段整段 skip（CI 不受影响），
 * 所以它只在开发机上生效 —— 这不是完美门禁，但它让「改了内核参数名、忘了改这张表」
 * 在开发机上立刻炸，而不是等到手机上某个功能静默失效。
 *
 * 生产路径不受本文件影响：`src/index.ts` 拿得到 `typertGateway` 时传的就是真网关。
 */

import type { Dsh02HostServices } from './kernel-services.ts'
import { createKernelEndpointCatalog, type KernelEndpointCatalog, type KernelDescriptorLike } from './kernel-endpoints.ts'
import { KernelArgumentsError, KernelEndpointUnknownError, type KernelCaller } from './kernel-invoke.ts'
import { userQuestionsOf, type FileUploadsLike } from './kernel-services.ts'
import type { KernelGateway } from './proxy-options.ts'

/** 一个永不中止的信号：给「能接受 undefined、但接口声明要求必填 signal」的方法用。 */
const IDLE_SIGNAL = new AbortController().signal

/** wire 键 → 值的参数集（与真实网关 `args` 同形）。 */
type Wire = Readonly<Record<string, unknown>>

/** 表里的一条：端点名 + 描述符 + 实现（实现拿到的就是 wire 参数集）。 */
interface LocalEndpoint {
  readonly descriptor: KernelDescriptorLike
  /** 流式方法的实现返回 `AsyncIterable`；unary 返回结果值。 */
  readonly run: (host: Dsh02HostServices, args: Wire, signal: AbortSignal | undefined) => unknown
}

const request = (wire = 'request'): KernelDescriptorLike['parameters'][number] => ({
  name: wire,
  wire,
  source: 'json',
})

/** 单参端点的快捷取法：`args[wire]` 交给宿主方法（类型由各方法自己声明）。 */
const one = (args: Wire, wire = 'request'): never => args[wire] as never

/**
 * 进程内传输的端点表。
 *
 * 顺序无关紧要（目录会按 endpoint 字典序排），但**按批次分组**：
 * 3a = 会话读侧 + `workspace.list`；3b = workspace 写侧 + settings + credentials。
 * 后续批次（3c/3d）直接往下追加。
 */
const LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  // ===== 阶段 3a：会话读侧 9 条 + workspace.list =====
  {
    descriptor: {
      namespace: 'session',
      method: 'list',
      parameters: [request('_request')],
      cancellation: { parameter: 'signal' },
    },
    run: (host, args, signal) => host.sessionController.list(one(args, '_request'), signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: { namespace: 'session', method: 'create', parameters: [request()] },
    run: (host, args) => host.sessionController.create(one(args)),
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
    run: (host, args, signal) => host.sessionController.follow(one(args), signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: {
      namespace: 'session',
      method: 'page',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, args, signal) => host.sessionController.page(one(args), signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: {
      namespace: 'session',
      method: 'projections',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, args, signal) => host.sessionController.projections(one(args), signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: {
      namespace: 'session',
      method: 'wait',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, args, signal) => host.sessionController.wait(one(args), signal ?? IDLE_SIGNAL),
  },
  {
    descriptor: { namespace: 'session', method: 'selectModel', parameters: [request()] },
    run: (host, args) => host.sessionController.selectModel(one(args)),
  },
  {
    descriptor: { namespace: 'session', method: 'rename', parameters: [request()] },
    run: (host, args) => host.sessionController.rename(one(args)),
  },
  {
    descriptor: { namespace: 'session', method: 'fork', parameters: [request()] },
    run: (host, args) => host.sessionController.fork(one(args)),
  },
  {
    descriptor: { namespace: 'session', method: 'cancel', parameters: [request()] },
    run: (host, args) => host.sessionController.cancel(one(args)),
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
    run: (host, _args, signal) => localWorkspaceFollow(host, signal),
  },

  // ===== 阶段 3b：workspace 写侧 4 条 + settings 2 条 + credentials 3 条 =====
  {
    descriptor: { namespace: 'workspace', method: 'create', parameters: [request()] },
    run: (host, args) => host.workspaceController.create(one(args)),
  },
  {
    descriptor: { namespace: 'workspace', method: 'rename', parameters: [request()] },
    run: (host, args) => host.workspaceController.rename(one(args)),
  },
  {
    descriptor: { namespace: 'workspace', method: 'delete', parameters: [request()] },
    run: (host, args) => host.workspaceController.delete(one(args)),
  },
  {
    descriptor: { namespace: 'workspace', method: 'archiveSession', parameters: [request()] },
    run: (host, args) => host.workspaceController.archiveSession(one(args)),
  },
  {
    // 无参端点：`args` 必须是空对象（真网关同样会拒多余键）。
    descriptor: { namespace: 'settings', method: 'describe', parameters: [] },
    run: host => host.settingsController.describe(),
  },
  {
    // **三个顶层参**：这是阶段 2「wire 键自动取」的第一次实战。
    descriptor: {
      namespace: 'settings',
      method: 'mutate',
      parameters: [request('ns'), request('ops'), request('expectedRevision')],
    },
    run: (host, args) => host.settingsController.mutate(
      args.ns as never,
      args.ops as never,
      args.expectedRevision as never,
    ),
  },
  {
    // 顶层数组参。
    descriptor: { namespace: 'credentials', method: 'describe', parameters: [request('refs')] },
    run: (host, args) => host.credentialsController.describe(args.refs as never),
  },
  {
    // 两个顶层参。
    descriptor: {
      namespace: 'credentials',
      method: 'set',
      parameters: [request('ref'), request('value')],
    },
    run: (host, args) => host.credentialsController.set(args.ref as never, args.value as never),
  },
  {
    descriptor: { namespace: 'credentials', method: 'unset', parameters: [request('ref')] },
    run: (host, args) => host.credentialsController.unset(args.ref as never),
  },

  // ===== 阶段 3c：llm 3 条 + agentPresets 2 条 + permissionPresets 1 条 =====
  {
    descriptor: { namespace: 'llm', method: 'listConfigurableProviders', parameters: [] },
    run: host => host.llm.listConfigurableProviders(),
  },
  {
    descriptor: { namespace: 'llm', method: 'listProviders', parameters: [] },
    run: host => host.llm.listProviders(),
  },
  {
    descriptor: { namespace: 'session', method: 'modelCatalog', parameters: [] },
    run: host => host.sessionController.modelCatalog(),
  },
  {
    // 两个顶层参 + 声明 cancellation（真描述符如此，`signal` 接在参数后面）。
    descriptor: {
      namespace: 'llm',
      method: 'discoverModels',
      parameters: [request('settingsNs'), request('request')],
      cancellation: { parameter: 'signal' },
    },
    run: (host, args, signal) => host.llm.discoverModels(
      args.settingsNs as never,
      args.request,
      signal ?? IDLE_SIGNAL,
    ),
  },
  {
    // 内核的 `@Remote('list')` 就是 `remoteExportList()`，返回 `{ presets }`。
    // 测试替身可能只实现了 `list()`，退回去包成同一形状。
    descriptor: { namespace: 'agentPresets', method: 'list', parameters: [] },
    run: async host => {
      const remote = (host.agentPresets as { remoteExportList?: () => Promise<unknown> }).remoteExportList
      if (typeof remote === 'function') return await remote.call(host.agentPresets)
      return { presets: [...await host.agentPresets.list()] }
    },
  },
  {
    // scope = agent：wire 键 `agentId` 装的是**会话 id**，lookup 再解析成 Agent
    // （内核 `dsh-api-session-controller/src/agent.ts:129` 的 `lookups.configure('agent', sessionId => resolveAgent(sessionId))`）。
    descriptor: {
      namespace: 'agentPresets',
      method: 'select',
      parameters: [request('agentId'), request('agentPreset')],
    },
    run: async (host, args) => host.agentPresets.select(
      await resolveLocalAgent(host, args.agentId),
      args.agentPreset as never,
    ),
  },
  {
    // 无参端点；服务缺席时抛 `gateway/service-unavailable`，让调用点走降级清单。
    descriptor: { namespace: 'permissionPresets', method: 'catalog', parameters: [] },
    run: async host => {
      const service = readLocalService<{ catalog?: () => Promise<unknown> }>(host, 'permissionPresets')
      if (service === null || typeof service.catalog !== 'function') {
        throw Object.assign(new Error('permissionPresets service is unavailable'), { code: 'gateway/service-unavailable' })
      }
      return await service.catalog()
    },
  },

  // ===== 阶段 3d：附件 + prompt + models 内建 + userQuestions =====
  {
    // scope = agent，两个顶层参 + cancellation。
    descriptor: {
      namespace: 'fileUploads',
      method: 'upload',
      parameters: [request('agentId'), request()],
      cancellation: { parameter: 'signal' },
    },
    run: async (host, args, signal) => {
      // 用 readLocalService：直接读属性在「服务缺席」时会抛
      // `cannot get property "fileUploads" without inject`，那是实现细节，
      // 不该冒充业务错误（既有用例钉的是 FILE_UPLOADS_UNAVAILABLE）。
      const service = readLocalService<FileUploadsLike>(host, 'fileUploads')
      if (service === null || typeof service.upload !== 'function') {
        throw new Error('FILE_UPLOADS_UNAVAILABLE: this DSH build provides no ctx.fileUploads service, so file attachments cannot be sent')
      }
      return await service.upload(
        await resolveLocalAgent(host, args.agentId),
        one(args),
        signal ?? IDLE_SIGNAL,
      )
    },
  },
  {
    descriptor: { namespace: 'session', method: 'attachment', parameters: [request()] },
    run: (host, args) => host.sessionController.attachment(one(args)),
  },
  {
    // prompt 的 `locale` 摘除、`requestId` 铸造、图片交接全在门面；这里只转发。
    descriptor: {
      namespace: 'session',
      method: 'prompt',
      parameters: [request()],
      cancellation: { parameter: 'signal' },
    },
    run: (host, args, signal) => host.sessionController.prompt(one(args), signal ?? IDLE_SIGNAL),
  },
  {
    // scope = agent（`agentId` 是会话 id）+ 三个顶层参。返回值是 boolean：
    // `false` 表示「这条 callId 不在内核的 continued 里」，调用点据此转去问挂起表。
    descriptor: {
      namespace: 'userQuestions',
      method: 'answer',
      parameters: [request('agentId'), request('callId'), request('answer')],
    },
    run: async (host, args) => {
      const agent = await resolveLocalAgent(host, args.agentId)
      const service = userQuestionsOf(agent)
      if (service === null || typeof service.answer !== 'function') {
        throw Object.assign(new Error('userQuestions service is unavailable'), { code: 'gateway/service-unavailable' })
      }
      return await service.answer(agent, args.callId as never, args.answer as never)
    },
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

/**
 * 宽容读一个可选宿主服务。
 *
 * 与门面里的 `optionalService` 同一个理由：cordis 上「读一个没被提供的注入属性」
 * 是**抛异常**（`cannot get property "x" without inject`），不是返回 undefined。
 * 少一条服务不该把端点打崩，所以这里两种缺席形态都收敛成 `null`。
 */
function readLocalService<T>(host: Dsh02HostServices, name: string): T | null {
  try {
    const value = (host as unknown as Record<string, unknown>)[name]
    return value === null || value === undefined ? null : value as T
  } catch {
    return null
  }
}

/**
 * 会话 id → 内核 Agent（`resolveAgent` 的包装对象要拆开，见 `host-reads.ts` 的解释）。
 * 端点语义是「lookup 解析身份」，进程内直连就在这里做同一件事。
 */
async function resolveLocalAgent(host: Dsh02HostServices, sessionId: unknown): Promise<unknown> {
  const resolved = await host.sessionController.resolveAgent(sessionId as never) as unknown
  const wrapped = resolved !== null && typeof resolved === 'object'
    && ('agent' in resolved || 'error' in resolved)
  if (!wrapped) return resolved
  const failure = (resolved as { error?: unknown }).error
  if (failure !== undefined && failure !== null) throw failure
  return (resolved as { agent?: unknown }).agent
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
  // 真网关会在 `assertExactArguments` 里拒多余键；进程内直连没有那一步，
  // 所以在这里做同一条判定 —— 否则「多传一个键」在单测里会静默通过，
  // 上线才被内核拒收，正是这次改造想消灭的那类差异。
  const assertWires = (endpoint: string, args: Wire): void => {
    const descriptor = catalog.byName.get(endpoint)
    const wires = descriptor?.wires ?? []
    for (const key of Reflect.ownKeys(args)) {
      if (!wires.includes(String(key))) throw new KernelArgumentsError(endpoint, `unexpected "${String(key)}"`)
    }
  }

  const caller: KernelCaller = {
    async invoke(namespace, method, args = {}, signal) {
      const endpoint = `${namespace}/${method}`
      assertWires(endpoint, args)
      // 取消照传：宿主方法的 AbortSignal 与内核 `cancellation` 参数语义一致。
      return await resolve(namespace, method)(host, args, signal)
    },
    async stream(namespace, method, args = {}, signal) {
      const endpoint = `${namespace}/${method}`
      assertWires(endpoint, args)
      const result = resolve(namespace, method)(host, args, signal)
      if (result === null || typeof result !== 'object') {
        throw new KernelEndpointUnknownError(`${endpoint} (local transport expected a stream)`)
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
