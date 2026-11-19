import { existsSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  describeKernelEndpoint,
  kernelEndpointIndex,
  readKernelEndpoints,
  type KernelDescriptorLike,
} from '../src/host/bridge/kernel-endpoints.ts'
import { KernelArgumentsError, KernelEndpointUnknownError } from '../src/host/bridge/kernel-invoke.ts'
import { createLocalKernelGateway, localEndpointDescriptors } from '../src/host/bridge/kernel-local.ts'
import type { Dsh02HostServices } from '../src/host/bridge/kernel-services.ts'

/** 只带本地传输用得上的那几个方法；其余字段这些用例不碰。 */
function fakeHost(overrides: Partial<Record<string, unknown>> = {}): Dsh02HostServices {
  return {
    sessionController: {
      list: vi.fn(async () => ({ items: [] })),
      create: vi.fn(async (payload: unknown) => ({ payload })),
      follow: vi.fn(() => (async function* () { yield { type: 'snapshot', session: { sessionId: 's-1' } } })()),
      page: vi.fn(async () => ({ entries: [] })),
      projections: vi.fn(async () => ({})),
      wait: vi.fn(async () => ({ items: [] })),
      selectModel: vi.fn(async (payload: unknown) => payload),
      rename: vi.fn(async (payload: unknown) => payload),
      fork: vi.fn(async (payload: unknown) => payload),
      cancel: vi.fn(async (payload: unknown) => payload),
    },
    workspaceController: {},
    workspaceRegistry: { list: vi.fn(() => []) },
    ...overrides,
  } as unknown as Dsh02HostServices
}

describe('local kernel transport (in-process)', () => {
  it('unpacks the single wire key and forwards it verbatim', async () => {
    const host = fakeHost()
    const gateway = createLocalKernelGateway(host)
    const payload = { sessionId: 's-1', title: 'renamed' }

    await gateway.caller.invoke('session', 'rename', { request: payload })

    expect(host.sessionController.rename).toHaveBeenCalledWith(payload)
    expect(host.sessionController.rename).toHaveBeenCalledTimes(1)
  })

  it('refuses a wire key the descriptor does not declare', async () => {
    const gateway = createLocalKernelGateway(fakeHost())
    // 真网关在 `assertExactArguments` 里就拒了；进程内传输必须做同一条判定，
    // 否则「多传一个键」在单测里静默通过、上线才被内核拒收。
    await expect(gateway.caller.invoke('session', 'rename', {
      request: { sessionId: 's-1' },
      extra: true,
    })).rejects.toBeInstanceOf(KernelArgumentsError)
  })

  it('spreads several top-level wire keys across the host method arguments', async () => {
    const settings = { mutate: vi.fn(async () => ({ revision: 2 })), describe: vi.fn(async () => ({})) }
    const credentials = { set: vi.fn(async () => undefined), unset: vi.fn(async () => undefined) }
    const host = fakeHost({ settingsController: settings, credentialsController: credentials })
    const gateway = createLocalKernelGateway(host)

    await gateway.caller.invoke('settings', 'mutate', { ns: 'ui', ops: [{ op: 'set' }], expectedRevision: 1 })
    await gateway.caller.invoke('credentials', 'set', { ref: 'anthropic', value: 'sk-1' })

    expect(settings.mutate).toHaveBeenCalledWith('ui', [{ op: 'set' }], 1)
    expect(credentials.set).toHaveBeenCalledWith('anthropic', 'sk-1')
  })

  it('raises the unknown-endpoint error instead of guessing a method', async () => {
    const gateway = createLocalKernelGateway(fakeHost())
    await expect(gateway.caller.invoke('session', 'definitelyNotAMethod')).rejects.toBeInstanceOf(KernelEndpointUnknownError)
  })

  it('returns the async iterable for a stream method', async () => {
    const gateway = createLocalKernelGateway(fakeHost())
    const stream = await gateway.caller.stream('session', 'follow', { request: { address: { kind: 'session', sessionId: 's-1' } } })

    const frames: unknown[] = []
    for await (const frame of stream) frames.push(frame)
    expect(frames).toEqual([{ type: 'snapshot', session: { sessionId: 's-1' } }])
  })

  it('builds a workspace baseline when the host has no follow()', async () => {
    const host = fakeHost({
      workspaceRegistry: {
        list: () => [{ id: 'w-1', path: '/p', title: 'P', sessionIds: ['s-1'], createdAt: 'c', updatedAt: 'u' }],
        archivedSessionIds: ['s-9'],
        pinnedSessionIds: ['s-1'],
      },
    })
    const gateway = createLocalKernelGateway(host)

    const stream = await gateway.caller.stream('workspace', 'follow')
    const first = await stream[Symbol.asyncIterator]().next()

    expect(first.value).toEqual({
      type: 'baseline',
      value: {
        items: [{ workspaceId: 'w-1', path: '/p', title: 'P', sessionIds: ['s-1'], createdAt: 'c', updatedAt: 'u' }],
        archivedSessionIds: ['s-9'],
        pinnedSessionIds: ['s-1'],
      },
    })
  })

  it('exposes the local table through the same catalog shape as the kernel one', () => {
    const gateway = createLocalKernelGateway(fakeHost())
    const names = gateway.catalog.endpoints.map(endpoint => endpoint.endpoint)

    // 目录按 endpoint 字典序排列，所以期望值也按字典序写（否则顺序差异会伪装成内容差异）。
    expect(names).toEqual([
      'agentPresets/list', // 3c
      'agentPresets/select',
      'credentials/describe', // 3b
      'credentials/set',
      'credentials/unset',
      'fileUploads/upload', // 3d
      'llm/discoverModels', // 3c
      'llm/listConfigurableProviders',
      'llm/listProviders',
      'permissionPresets/catalog', // 3c
      'session/attachment', // 3d
      'session/cancel', // 3a
      'session/create',
      'session/follow',
      'session/fork',
      'session/list',
      'session/modelCatalog', // 3c
      'session/page', // 3a
      'session/projections',
      'session/prompt', // 3d
      'session/rename', // 3a
      'session/selectModel',
      'session/wait',
      'settings/describe', // 3b
      'settings/mutate',
      'userQuestions/answer', // 3d
      'workspace/archiveSession', // 3b
      'workspace/create',
      'workspace/delete',
      'workspace/follow', // 3a
      'workspace/rename', // 3b
    ])
    // 目录条目与表里的描述符逐条同源：换源点拿到的 wire 键就是这里声明的。
    for (const descriptor of localEndpointDescriptors()) {
      const endpoint = gateway.catalog.byName.get(`${descriptor.namespace}/${descriptor.method}`)
      expect(endpoint).toEqual(describeKernelEndpoint(descriptor))
    }
  })
})

/**
 * 与真实内核的漂移对照。
 *
 * 本地传输的 `wires` 是手写的（进程内直连没有登记表可读），所以这里拿安装了内核的
 * 机器上的生成描述符去比：只要内核改了参数名/流式标记/取消声明，这条就先红。
 * CI 上没有内核，整段 `skipIf` 跳过。
 */
const KERNEL_PACKAGES = '/home/wangke/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

function kernelDescriptorFiles(): string[] {
  if (!existsSync(KERNEL_PACKAGES)) return []
  return readdirSync(KERNEL_PACKAGES)
    .map(name => `${KERNEL_PACKAGES}/${name}/lib/typert.host.js`)
    .filter(file => existsSync(file))
}

describe.skipIf(kernelDescriptorFiles().length === 0)('local table against the installed kernel', () => {
  it('declares exactly the same wires / stream / cancellation as the generated descriptors', async () => {
    const descriptors: KernelDescriptorLike[] = []
    for (const file of kernelDescriptorFiles()) {
      const module = await import(pathToFileURL(file).href) as { TYPERT?: { invocations?: readonly KernelDescriptorLike[] } }
      descriptors.push(...module.TYPERT?.invocations ?? [])
    }
    const real = kernelEndpointIndex(readKernelEndpoints({
      local: {
        list: () => descriptors,
        get: endpoint => descriptors.find(candidate => `${candidate.namespace}/${candidate.method}` === endpoint),
        hasSeen: () => false,
      },
    }))

    for (const descriptor of localEndpointDescriptors()) {
      const name = `${descriptor.namespace}/${descriptor.method}`
      const endpoint = real.get(name)
      expect(endpoint, `端点 ${name} 不在真实目录里（本地传输表需要更新）`).toBeDefined()
      const local = describeKernelEndpoint(descriptor)
      expect(local.wires, `${name} 的 wire 键漂了`).toEqual(endpoint?.wires)
      expect(local.stream, `${name} 的 stream 判定漂了`).toBe(endpoint?.stream)
      expect(local.cancellation, `${name} 的 cancellation 判定漂了`).toBe(endpoint?.cancellation)
    }
  })
})
