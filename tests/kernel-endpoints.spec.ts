import { existsSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createKernelEndpointCatalog,
  describeKernelEndpoint,
  kernelCapabilityFlags,
  kernelEndpointIndex,
  readKernelEndpoints,
  readTypertRegistry,
  type KernelDescriptorLike,
  type KernelEndpoint,
  type TypertRegistryLike,
} from '../src/host/bridge/kernel-endpoints.ts'

/** 造一个最小描述符，只写这一条用例关心的字段。 */
function descriptor(overrides: Partial<KernelDescriptorLike> = {}): KernelDescriptorLike {
  return { namespace: 'session', method: 'list', parameters: [], ...overrides }
}

function parameter(overrides: Partial<KernelDescriptorLike['parameters'][number]> = {}): KernelDescriptorLike['parameters'][number] {
  return { name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict' }, ...overrides }
}

function registryOf(listed: readonly KernelDescriptorLike[] | (() => readonly KernelDescriptorLike[])): TypertRegistryLike {
  return {
    local: {
      list: typeof listed === 'function' ? listed : () => listed,
      get: () => undefined,
      hasSeen: () => false,
    },
  }
}

function endpointOf(endpoints: readonly KernelEndpoint[], name: string): KernelEndpoint {
  const found = endpoints.find(endpoint => endpoint.endpoint === name)
  if (found === undefined) throw new Error(`missing endpoint ${name}`)
  return found
}

describe('describeKernelEndpoint', () => {
  it('reads the wire keys straight off the descriptor', () => {
    const endpoint = describeKernelEndpoint(descriptor({
      namespace: 'settings',
      method: 'mutate',
      parameters: [
        parameter({ name: 'ns', wire: 'ns' }),
        parameter({ name: 'ops', wire: 'ops' }),
        parameter({ name: 'expectedRevision', wire: 'expectedRevision', acceptsUndefined: true }),
      ],
    }))
    expect(endpoint.endpoint).toBe('settings/mutate')
    expect(endpoint.namespace).toBe('settings')
    expect(endpoint.method).toBe('mutate')
    expect(endpoint.wires).toEqual(['ns', 'ops', 'expectedRevision'])
    expect(endpoint.stream).toBe(false)
    expect(endpoint.cancellation).toBe(false)
    expect(endpoint.uplink).toBe(false)
  })

  it('appends the context identity key to the wire set', () => {
    // context 调用多一个「身份键」，内核把它并进 expected（assertExactArguments）。
    // 漏掉它换源后每次调用都会报 `missing "agentId"` —— 所以这里是硬断言。
    const endpoint = describeKernelEndpoint(descriptor({
      namespace: 'agentPresets',
      method: 'select',
      invocation: { kind: 'context', context: 'agent', wire: 'agentId' },
      parameters: [parameter({ name: 'agentPreset', wire: 'agentPreset' })],
    }))
    expect(endpoint.wires).toEqual(['agentPreset', 'agentId'])
    expect(endpoint.contextWire).toBe('agentId')
  })

  it('marks only the parameters the kernel itself would let go missing', () => {
    const endpoint = describeKernelEndpoint(descriptor({
      parameters: [
        // 显式声明可为 undefined —— 可省。
        parameter({ name: 'a', wire: 'a', acceptsUndefined: true }),
        // SRC 弱描述（codec.mode === 'src-json'）—— 内核看不见哪些必填，所以也可省。
        parameter({ name: 'b', wire: 'b', codec: { mode: 'src-json' } }),
        // 普通必填。
        parameter({ name: 'c', wire: 'c' }),
        // lookup 标识符永不省略，哪怕它自己声明了 acceptsUndefined。
        parameter({ name: 'd', wire: 'd', source: 'lookup', acceptsUndefined: true }),
      ],
    }))
    expect(endpoint.parameters.map(item => [item.wire, item.optional])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', false],
    ])
  })

  it('keeps a JSON schema when the codec projects one and drops it when projection throws', () => {
    const projected = describeKernelEndpoint(descriptor({
      parameters: [parameter({ codec: { mode: 'strict', jsonSchema: { type: 'object' } } })],
    }))
    expect(projected.parameters[0]?.jsonSchema).toEqual({ type: 'object' })

    // 惰性投影失败不该让整张目录塌掉：那个参数只是少一条 schema。
    const throwing = parameter()
    Object.defineProperty(throwing.codec as object, 'jsonSchema', {
      get() { throw new Error('projection failed') },
    })
    const degraded = describeKernelEndpoint(descriptor({ parameters: [throwing, parameter({ wire: 'other' })] }))
    expect(degraded.parameters[0]?.jsonSchema).toBeUndefined()
    expect(degraded.wires).toEqual(['request', 'other'])
  })

  it('carries stream / cancellation / description flags', () => {
    const endpoint = describeKernelEndpoint(descriptor({
      method: 'follow',
      mode: 'stream',
      cancellation: { parameter: 'signal' },
      uplink: { codec: {} },
      description: 'Follow one session.',
    }))
    expect(endpoint.stream).toBe(true)
    expect(endpoint.cancellation).toBe(true)
    expect(endpoint.uplink).toBe(true)
    expect(endpoint.description).toBe('Follow one session.')
  })
})

describe('readKernelEndpoints', () => {
  it('returns an empty catalog instead of throwing when the registry is absent', () => {
    // 极老内核上没有 typert 服务；apply 期抛出去等于让插件装不上。
    expect(readKernelEndpoints(undefined)).toEqual([])
    expect(readKernelEndpoints({} as TypertRegistryLike)).toEqual([])
    // local 上没有 list 也不该炸。
    expect(readKernelEndpoints({ local: {} } as unknown as TypertRegistryLike)).toEqual([])
  })

  it('swallows a failing list()', () => {
    const registry = registryOf(() => { throw new Error('typert not ready') })
    expect(readKernelEndpoints(registry)).toEqual([])
  })

  it('sorts by endpoint and keeps one entry per endpoint name', () => {
    const endpoints = readKernelEndpoints(registryOf([
      descriptor({ namespace: 'workspace', method: 'follow' }),
      descriptor({ namespace: 'session', method: 'list' }),
      // 同名端点后出现的覆盖先出现的（登记表不允许重复键，这里只是防御）。
      descriptor({ namespace: 'session', method: 'list', parameters: [parameter()] }),
    ]))
    expect(endpoints.map(endpoint => endpoint.endpoint)).toEqual(['session/list', 'workspace/follow'])
    expect(endpointOf(endpoints, 'session/list').wires).toEqual(['request'])
  })

  it('skips entries that are not shaped like descriptors', () => {
    const endpoints = readKernelEndpoints(registryOf([
      // @ts-expect-error —— 运行时可能拿到残缺项（跨版本），跳过而不是抛。
      { namespace: 'bad' },
      // @ts-expect-error —— parameters 不是数组同理。
      { namespace: 'bad2', method: 'x', parameters: 'nope' },
      descriptor({ namespace: 'session', method: 'create' }),
    ]))
    expect(endpoints.map(endpoint => endpoint.endpoint)).toEqual(['session/create'])
  })

  it('indexes the catalog by endpoint name', () => {
    const catalog = createKernelEndpointCatalog(registryOf([
      descriptor({ namespace: 'session', method: 'list' }),
      descriptor({ namespace: 'llm', method: 'discoverModels' }),
    ]))
    expect(catalog.endpoints).toHaveLength(2)
    expect([...catalog.byName.keys()]).toEqual(['llm/discoverModels', 'session/list'])
    expect(kernelEndpointIndex([]).size).toBe(0)
  })
})

describe('kernelCapabilityFlags', () => {
  it('never declares the catalog bit for an empty catalog', () => {
    // 探测不到内核（或登记表为空）⇒ 两枚位都不给。
    expect(kernelCapabilityFlags(createKernelEndpointCatalog(undefined))).toEqual({ kernelCatalog: false, kernelCall: false })
    expect(kernelCapabilityFlags(createKernelEndpointCatalog(registryOf([])))).toEqual({ kernelCatalog: false, kernelCall: false })
  })

  it('declares the catalog bit for a non-empty catalog and still withholds the call surface', () => {
    // 「给位 ⇒ 目录非空」的另一半；调用面要等端点白名单（阶段 5）。
    const flags = kernelCapabilityFlags(createKernelEndpointCatalog(registryOf([descriptor()])))
    expect(flags).toEqual({ kernelCatalog: true, kernelCall: false })
  })
})

describe('readTypertRegistry', () => {
  it('returns undefined for kernels without the typert service', () => {
    expect(readTypertRegistry(undefined)).toBeUndefined()
    expect(readTypertRegistry({})).toBeUndefined()
    expect(readTypertRegistry({ get: () => undefined })).toBeUndefined()
    expect(readTypertRegistry({ get: () => ({}) })).toBeUndefined()
    expect(readTypertRegistry({ get: () => ({ local: {} }) })).toBeUndefined()
  })

  it('accepts a registry whose local surface has list()', () => {
    const registry = { local: { list: () => [], get: () => undefined, hasSeen: () => false } }
    expect(readTypertRegistry({ get: name => (name === 'typert' ? registry : undefined) })).toBe(registry)
  })

  it('asks reflect for the optional service instead of injecting it', () => {
    const asked: string[] = []
    readTypertRegistry({
      get: (name, strict) => {
        asked.push(`${name}:${String(strict)}`)
        return undefined
      },
    })
    // 第二个参数必须是 false：inject 是硬依赖，缺服务时插件不能整个挂掉。
    expect(asked).toEqual(['typert:false'])
  })
})

/**
 * 与真实内核的对照。
 *
 * 这段**只在装了 DSH 的机器上跑**（CI 上没有内核，`skipIf` 让它整体跳过）。
 * 它守的是「目录不是自说自话」：抽样端点的 wire 键是**写死**的期望值（来自
 * 2026-11-19 的 0.2.2-rc.4），内核哪天改键，这里先红，而不是等手机上收到一句
 * `args fields do not match the descriptor`。
 */
const KERNEL_PACKAGES = '/home/wangke/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

function kernelDescriptorFiles(): string[] {
  if (!existsSync(KERNEL_PACKAGES)) return []
  return readdirSync(KERNEL_PACKAGES)
    .map(name => `${KERNEL_PACKAGES}/${name}/lib/typert.host.js`)
    .filter(file => existsSync(file))
}

const SAMPLE_WIRES: Record<string, { wires: string[], stream: boolean, cancellation: boolean }> = {
  'session/list': { wires: ['_request'], stream: false, cancellation: true },
  'session/create': { wires: ['request'], stream: false, cancellation: false },
  'session/page': { wires: ['request'], stream: false, cancellation: true },
  'session/follow': { wires: ['request'], stream: true, cancellation: true },
  'session/cancel': { wires: ['request'], stream: false, cancellation: false },
  'session/modelCatalog': { wires: [], stream: false, cancellation: false },
  'session/attachment': { wires: ['request'], stream: false, cancellation: false },
  'settings/mutate': { wires: ['ns', 'ops', 'expectedRevision'], stream: false, cancellation: false },
  'credentials/describe': { wires: ['refs'], stream: false, cancellation: false },
  'llm/discoverModels': { wires: ['settingsNs', 'request'], stream: false, cancellation: true },
  'workspace/follow': { wires: [], stream: true, cancellation: true },
  'userQuestions/answer': { wires: ['agentId', 'callId', 'answer'], stream: false, cancellation: false },
  'fileUploads/upload': { wires: ['agentId', 'request'], stream: false, cancellation: true },
  'agentPresets/select': { wires: ['agentId', 'agentPreset'], stream: false, cancellation: false },
  'permissionPresets/catalog': { wires: [], stream: false, cancellation: false },
  'goals/get': { wires: ['agentId'], stream: false, cancellation: false },
  'schedule/list': { wires: ['request'], stream: false, cancellation: false },
  'speech/transcribe': { wires: ['request'], stream: false, cancellation: true },
  'fileReferences/list': { wires: ['agentId', 'query'], stream: false, cancellation: true },
  'subagents/prompt': { wires: ['request'], stream: false, cancellation: true },
}

describe.skipIf(kernelDescriptorFiles().length === 0)('kernel catalog against the installed kernel', () => {
  it('keeps every sampled wire set identical to the generated descriptors', async () => {
    const descriptors: KernelDescriptorLike[] = []
    for (const file of kernelDescriptorFiles()) {
      const module = await import(pathToFileURL(file).href) as { TYPERT?: { invocations?: readonly KernelDescriptorLike[] } }
      descriptors.push(...module.TYPERT?.invocations ?? [])
    }
    expect(descriptors.length).toBeGreaterThan(200)

    const endpoints = readKernelEndpoints(registryOf(descriptors))
    const byName = kernelEndpointIndex(endpoints)
    for (const [name, expected] of Object.entries(SAMPLE_WIRES)) {
      const endpoint = byName.get(name)
      expect(endpoint, `端点 ${name} 不在目录里`).toBeDefined()
      expect(endpoint?.wires, `${name} 的 wire 键与生成描述符不一致`).toEqual(expected.wires)
      expect(endpoint?.stream, `${name} 的 stream 判定不一致`).toBe(expected.stream)
      expect(endpoint?.cancellation, `${name} 的 cancellation 判定不一致`).toBe(expected.cancellation)
    }
  })

  it('never drops or invents a wire key for any endpoint in the catalog', async () => {
    const descriptors: KernelDescriptorLike[] = []
    for (const file of kernelDescriptorFiles()) {
      const module = await import(pathToFileURL(file).href) as { TYPERT?: { invocations?: readonly KernelDescriptorLike[] } }
      descriptors.push(...module.TYPERT?.invocations ?? [])
    }
    const endpoints = readKernelEndpoints(registryOf(descriptors))
    // 目录条目数与描述符数一致（同 key 不允许重复），且逐条自证：目录里的每个 wire
    // 都能在描述符的参数表（或 context 身份键）里找到，反之亦然。
    expect(endpoints.length).toBe(descriptors.length)
    for (const endpoint of endpoints) {
      const source = descriptors.find(candidate => `${candidate.namespace}/${candidate.method}` === endpoint.endpoint)
      expect(source, endpoint.endpoint).toBeDefined()
      const declared = source?.parameters.map(item => item.wire) ?? []
      const contextWire = source?.invocation?.kind === 'context' ? source.invocation.wire : undefined
      expect(endpoint.wires, endpoint.endpoint).toEqual(contextWire === undefined ? declared : [...declared, contextWire])
    }
  })
})
