import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import {
  DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES,
  DEFAULT_FILE_DOWNLOAD_MAX_BYTES,
  DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS,
  DEFAULT_FILE_UPLOAD_CHUNK_BYTES,
  DEFAULT_FILE_UPLOAD_MAX_BYTES,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  INTERACTION_PROTOCOL_REVISION,
  PROTOCOL_AUTH_PREFIX,
  PROTOCOL_PAIR_PREFIX,
  WS_PATH,
  WS_PROTOCOL,
} from '../src/host/ws-protocol.ts'

/**
 * `/ws/mobile` 的**契约钉桩**测试。
 *
 * ## 这个文件要防的是什么
 *
 * `tests/mobile-gateway-ws.spec.ts` 验证的是「服务端行为对不对」——它起真服务器、
 * 发帧、看回帧，跑一遍要几秒。它证明不了另一件事：**对外契约文档有没有跟上代码**。
 * 那件事的失败模式是静默的：代码加了帧、asyncapi 没加，客户端 SDK 就不认识这个帧，
 * 表现成「服务端不发数据」；反过来 asyncapi 多写了一个代码里没有的帧，客户端就会
 * 发出一个必然收到 `UNKNOWN_TYPE` 的请求，看起来像客户端 bug。
 *
 * 所以这里只做**纯静态对账**（读文件、比集合），不连网、不起服务器，毫秒级。
 * 行为层面的保证仍然留给 `mobile-gateway-ws.spec.ts`，两者是分工不是重复。
 *
 * ## 与 `scripts/check-project-docs.ts` 的关系
 *
 * docs:check 里也有同一组断言。**故意重复**：
 * - docs:check 是发布门禁，跑在 `npm run check` 的第三段，只有 CI/发版时拦住人；
 * - 这里是 `npm test` 的一部分，改代码时先撞上它，反馈更早。
 * 两处的白名单必须同步（都指向 TECH-DEBT 的 DEBT-005），谁清账都要一起删。
 */

const asyncapiText = readFileSync(new URL('../docs/api/asyncapi.yaml', import.meta.url), 'utf8')
const protocolSource = readFileSync(new URL('../src/host/ws-protocol.ts', import.meta.url), 'utf8')

/**
 * asyncapi 里一个 schema 节点的**测试用**形状。
 *
 * 不引 asyncapi 的类型定义（本仓没有那个依赖，且契约文档是数据不是代码），
 * 这里只声明断言真正会读的字段，其余靠 `unknown` 兜住 —— 目的是让 TS 能检查
 * `?.` 链，而不是把 YAML 建模成完整类型系统。
 */
type SchemaNode = {
  const?: unknown
  required?: string[]
  enum?: unknown
  items?: SchemaNode
  properties?: Record<string, SchemaNode>
}

type AsyncApiDoc = {
  info?: { version?: string }
  channels?: Record<string, { address?: string } | undefined>
  operations?: Record<string, { action?: string } | undefined>
  components?: {
    messages?: Record<string, { payload?: { $ref?: string } } | undefined>
    schemas?: Record<string, SchemaNode | undefined>
  }
}

const asyncapi = ((): AsyncApiDoc => {
  const document = parseDocument(asyncapiText)
  // YAML 解析失败必须当场炸：静默得到一个空对象会让下面每条断言都变成
  // 「undefined !== 期望值」的噪声，看不出真正原因是语法错。
  expect(document.errors.map(error => error.message)).toEqual([])
  return document.toJS() as AsyncApiDoc
})()

/**
 * 从 `export type X = 'a' | 'b' | ...` 里抽成员。
 *
 * 用文本正则而不是 TS 类型反射：`ws-protocol.ts` 里的联合类型是**运行时不存在**的
 * 纯类型，没有任何方式在运行期读到它。文本解析是唯一途径，因此配了「解析出多少个」
 * 的下限断言 —— 解析失效时必须报红，而不是退化成「两个空集合相等」。
 */
function unionMembers(typeName: string, endMarker: string): string[] {
  const start = protocolSource.indexOf(`export type ${typeName} =`)
  expect(start, `ws-protocol.ts 里找不到 export type ${typeName}`).toBeGreaterThanOrEqual(0)
  const rest = protocolSource.slice(start)
  const end = rest.indexOf(endMarker)
  const block = end === -1 ? rest : rest.slice(0, end)
  return [...block.matchAll(/'([a-z0-9-]+)'/g)].map(match => match[1] as string)
}

const clientUnion = unionMembers('ClientFrameType', '/** 服务端')
const serverUnion = unionMembers('ServerFrameKind', '// ─')

/** 取一个 schema 节点，缺失时直接报红并给出可读的位置。 */
function schemaNode(name: string): SchemaNode {
  const value = asyncapi.components?.schemas?.[name]
  expect(value, `asyncapi 缺少 components.schemas.${name}`).toBeDefined()
  return value as SchemaNode
}

function enumOf(schema: string, property: string): string[] {
  const property_ = schemaNode(schema).properties?.[property]
  expect(property_, `${schema}.properties.${property} 缺失`).toBeDefined()
  expect(Array.isArray(property_?.enum), `${schema}.properties.${property}.enum 不是数组`).toBe(true)
  return property_?.enum as string[]
}

const clientEnum = enumOf('MobileClientFrame', 'type')
const serverEnum = enumOf('MobileServerFrame', 'kind')

/**
 * 契约里允许出现、但 `ws-protocol.ts` 联合类型尚未收录的帧。
 *
 * 这些是**已核实的实现细节帧**（handler 真的处理/发送它们），登记在
 * `docs/project/TECH-DEBT.md` 的 DEBT-005 名下。白名单只许变短：
 * 谁把联合类型补齐，就必须同步删掉这里的对应项（下面有断言盯着）。
 */
const CLIENT_ONLY_IN_CONTRACT = ['fork', 'workspace-create', 'file-list', 'directory-create', 'directories']
const SERVER_ONLY_IN_CONTRACT = [
  'paired', 'fork', 'workspace-create',
  'host', 'models', 'default-model', 'providers', 'permission', 'permission-options',
  'agent-presets', 'session-stats', 'context-usage',
]

describe('/ws/mobile 帧词汇表与 asyncapi 契约一致', () => {
  it('从 ws-protocol.ts 解析出的联合类型规模符合预期（防止解析静默失效）', () => {
    // 下限而不是等值：新增帧是正常的，不该逼着每次加帧都来改测试数字。
    expect(clientUnion.length).toBeGreaterThanOrEqual(60)
    expect(serverUnion.length).toBeGreaterThanOrEqual(60)
    expect(new Set(clientUnion).size).toBe(clientUnion.length)
    expect(new Set(serverUnion).size).toBe(serverUnion.length)
  })

  it('契约里出现了所有代码声明的客户端帧类型', () => {
    const documented = new Set(clientEnum)
    const missing = clientUnion.filter(type => !documented.has(type))
    expect(missing, `asyncapi 缺少客户端帧：${missing.join(', ')}`).toEqual([])
  })

  it('契约里出现了所有代码声明的服务端帧 kind', () => {
    const documented = new Set(serverEnum)
    const missing = serverUnion.filter(kind => !documented.has(kind))
    expect(missing, `asyncapi 缺少服务端帧：${missing.join(', ')}`).toEqual([])
  })

  it('契约没有比实现更宽（多出来的只能是 DEBT-005 白名单）', () => {
    const declaredClient = new Set(clientUnion)
    const declaredServer = new Set(serverUnion)
    expect(clientEnum.filter(type => !declaredClient.has(type) && !CLIENT_ONLY_IN_CONTRACT.includes(type))).toEqual([])
    expect(serverEnum.filter(kind => !declaredServer.has(kind) && !SERVER_ONLY_IN_CONTRACT.includes(kind))).toEqual([])
  })

  it('DEBT-005 白名单只许变短：已进联合类型的名字必须从白名单删掉', () => {
    const declaredClient = new Set(clientUnion)
    const declaredServer = new Set(serverUnion)
    expect(CLIENT_ONLY_IN_CONTRACT.filter(type => declaredClient.has(type))).toEqual([])
    expect(SERVER_ONLY_IN_CONTRACT.filter(kind => declaredServer.has(kind))).toEqual([])
  })

  it('契约 enum 本身没有重复项', () => {
    // 重复项不会让任何 diff 报红，但会让「哪些帧存在」这件事变得含混。
    expect(new Set(clientEnum).size).toBe(clientEnum.length)
    expect(new Set(serverEnum).size).toBe(serverEnum.length)
  })
})

describe('/ws/mobile 通道与握手在 asyncapi 里有形状', () => {
  it('通道地址与路径常量一致', () => {
    expect(WS_PATH).toBe('/ws/mobile')
    expect(asyncapi.channels?.mobile?.address).toBe(WS_PATH)
  })

  it('send/receive 两个方向都有 operation', () => {
    const actions = Object.values(asyncapi.operations ?? {}).map(operation => operation?.action)
    expect(actions).toContain('send')
    expect(actions).toContain('receive')
    const mobileOperations = Object.entries(asyncapi.operations ?? {}).filter(([name]) => name.toLowerCase().includes('mobile'))
    expect(mobileOperations.length).toBeGreaterThanOrEqual(2)
  })

  it('client/server 两个方向的 message 都指向同名 schema', () => {
    expect(asyncapi.components?.messages?.MobileClientFrame?.payload?.$ref).toBe('#/components/schemas/MobileClientFrame')
    expect(asyncapi.components?.messages?.MobileServerFrame?.payload?.$ref).toBe('#/components/schemas/MobileServerFrame')
  })

  it('hello 的协议号、必填字段与 HelloData 的形状一致', () => {
    const hello = schemaNode('MobileHello')
    expect(hello.properties?.protocol?.const).toBe(3)
    expect(hello.properties?.authenticated?.const).toBe(true)
    // 缺了这三项客户端就没法判断「连上的是不是我要的那台机器」。
    expect(hello.required).toEqual(expect.arrayContaining(['protocol', 'capabilities', 'authenticated']))
    // device 必须可省略：回环管理员连接没有设备身份，服务端整段不发。
    expect(hello.required).not.toContain('device')
  })

  it('设备 scope 枚举覆盖 contracts.ts 的 DEVICE_SCOPES 全集', async () => {
    const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8')
    const declared = [...contracts.matchAll(/^ {2}'([a-z]+\.[a-z]+)',$/gm)].map(match => match[1] as string)
    expect(declared.length).toBeGreaterThanOrEqual(7)
    const device = schemaNode('MobileHello').properties?.device
    const scopes = (device?.properties?.scopes?.items?.enum as string[] | undefined) ?? []
    expect(scopes).toEqual(expect.arrayContaining(declared))
  })

  it('三个子协议前缀都写进了契约（改前缀就红）', () => {
    expect(WS_PROTOCOL).toBe('dsh-mobile-v1')
    expect(PROTOCOL_PAIR_PREFIX).toBe('dsh-pair.')
    expect(PROTOCOL_AUTH_PREFIX).toBe('dsh-auth.')
    for (const literal of [WS_PROTOCOL, PROTOCOL_PAIR_PREFIX, PROTOCOL_AUTH_PREFIX]) {
      expect(asyncapiText, `asyncapi 缺少子协议 ${literal}`).toContain(literal)
    }
    // 配对必需的设备头；少了它配对流程直接 4001，客户端会误判成 token 过期。
    expect(asyncapiText).toContain('X-DSH-Device-ID')
    expect(asyncapiText).toContain('X-DSH-Device-Name')
  })

  it('paired 帧带 token 与 device，且文档写明它早于 hello', () => {
    expect(schemaNode('MobilePaired').required).toEqual(expect.arrayContaining(['token', 'device']))
    expect(asyncapiText).toMatch(/paired/i)
    // 顺序是协议的一部分：客户端在配对流程里必须先存 token 再处理 hello。
    expect(asyncapiText).toMatch(/before[^\n]*hello|先[^\n]*hello/i)
  })

  it('error 帧的 code/message 必填，且区分 NOT_IMPLEMENTED 与 UNKNOWN_TYPE', () => {
    expect(schemaNode('MobileError').required).toEqual(expect.arrayContaining(['code', 'message']))
    // 这两种错误对客户端的含义完全不同：前者该回落到 REST，后者是客户端 bug。
    expect(asyncapiText).toContain('NOT_IMPLEMENTED')
    expect(asyncapiText).toContain('UNKNOWN_TYPE')
  })
})

describe('/ws/mobile 的背压与传输参数与常量一致', () => {
  const limits = schemaNode('MobileConnectionLimits')

  it('MobileConnectionLimits 存在且有属性', () => {
    expect(Object.keys(limits.properties ?? {}).length).toBeGreaterThanOrEqual(8)
  })

  it('帧与缓冲上限等于 ws-protocol.ts 的默认值', () => {
    expect(limits.properties?.maxFrameBytes?.const).toBe(DEFAULT_MAX_FRAME_BYTES)
    expect(limits.properties?.maxWebSocketPayloadBytes?.const).toBe(DEFAULT_MAX_WS_PAYLOAD_BYTES)
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(1024 * 1024)
    expect(DEFAULT_MAX_WS_PAYLOAD_BYTES).toBe(144 * 1024 * 1024)
  })

  it('发送队列与连接上限等于实现里的常量', () => {
    // 队列上限在 ws-handler.ts 里是私有常量 SOCKET_QUEUE_LIMIT，server.ts 里另有一份
    // DEFAULT_SOCKET_QUEUE_LIMIT。两处都必须还是 512，否则 asyncapi 的 const 就骗人了。
    expect(protocolSource.length).toBeGreaterThan(0)
    const handlerSource = readFileSync(new URL('../src/host/ws-handler.ts', import.meta.url), 'utf8')
    const serverSource = readFileSync(new URL('../src/host/server.ts', import.meta.url), 'utf8')
    expect(handlerSource).toContain('const SOCKET_QUEUE_LIMIT = 512')
    expect(serverSource).toContain('const DEFAULT_SOCKET_QUEUE_LIMIT = 512')
    expect(limits.properties?.sendQueueFrames?.const).toBe(512)
    expect(serverSource).toContain('const DEFAULT_MAX_CONNECTIONS = 32')
    expect(limits.properties?.maxConnections?.const).toBe(32)
    expect(serverSource).toContain('const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000')
    expect(limits.properties?.heartbeatIntervalMs?.const).toBe(30_000)
  })

  it('下载/上传的分块与上限等于 ws-protocol.ts 的默认值', () => {
    expect(limits.properties?.fileDownload?.properties?.maxBytes?.const).toBe(DEFAULT_FILE_DOWNLOAD_MAX_BYTES)
    expect(limits.properties?.fileDownload?.properties?.chunkBytes?.const).toBe(DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES)
    expect(limits.properties?.fileDownload?.properties?.maxTransfers?.const).toBe(DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS)
    expect(limits.properties?.fileUpload?.properties?.maxBytes?.const).toBe(DEFAULT_FILE_UPLOAD_MAX_BYTES)
    expect(limits.properties?.fileUpload?.properties?.chunkBytes?.const).toBe(DEFAULT_FILE_UPLOAD_CHUNK_BYTES)
    // 上传块比下载块小一半是刻意的：上传是客户端持续产出的方向，块大了更容易撞背压。
    expect(DEFAULT_FILE_UPLOAD_CHUNK_BYTES * 2).toBe(DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES)
  })

  it('吊销 close code 与 HITL 协议修订号一致', () => {
    expect(limits.properties?.closeDeviceRevoked?.const).toBe(4001)
    expect(limits.properties?.interactionProtocolRevision?.const).toBe(INTERACTION_PROTOCOL_REVISION)
    expect(INTERACTION_PROTOCOL_REVISION).toBe('question-approval-v2')
  })
})

describe('/ws/mobile 契约保留了既有事件契约', () => {
  it('既有 events 通道没被改动', () => {
    // 这条不是形式主义：改 asyncapi 时最容易顺手「整理」既有通道，
    // 而 /api/v1/events 是已发布契约，动了就是破坏性变更。
    expect(asyncapi.channels?.events?.address).toBe('/api/v1/events')
  })

  it('能力位依赖的既有事件字面量还在', () => {
    // tests/capabilities.spec.ts 按字面量断言这些，删了会连带把能力位门禁打红。
    for (const literal of ['chat.message.delta', 'chat.approval.requested', 'ChatTurnFailed']) {
      expect(asyncapiText).toContain(literal)
    }
  })

  it('版本号仍是 package.json 的版本（改契约不许顺手改版本）', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(asyncapi.info?.version).toBe(packageJson.version)
  })
})
