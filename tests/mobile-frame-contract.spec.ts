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
 * 两处的白名单必须同步（阶段 1 之前都指向 TECH-DEBT 的 DEBT-005），谁清账都要一起删。
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
  type?: string | string[]
  description?: string
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
 * issue #26 阶段 1 已把两侧全部收编（客户端 75 / 服务端 67，与契约 enum 逐条零差异），
 * DEBT-005 随之关闭，白名单清空。**只许变短**的规矩留在断言里：谁再往契约里加代码
 * 没有的帧，就得先补联合类型，而不是往回加白名单。
 */
const CLIENT_ONLY_IN_CONTRACT: string[] = []
const SERVER_ONLY_IN_CONTRACT: string[] = []

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

  it('契约没有比实现更宽（多出来的只能是白名单，现已清空）', () => {
    const declaredClient = new Set(clientUnion)
    const declaredServer = new Set(serverUnion)
    expect(clientEnum.filter(type => !declaredClient.has(type) && !CLIENT_ONLY_IN_CONTRACT.includes(type))).toEqual([])
    expect(serverEnum.filter(kind => !declaredServer.has(kind) && !SERVER_ONLY_IN_CONTRACT.includes(kind))).toEqual([])
  })

  it('帧白名单只许变短：已进联合类型的名字必须从白名单删掉', () => {
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
    // maxFrameBytes 宣告生效上限（issue #IKXGYX），可省略（老服务端不发，客户端回退 1 MiB）。
    expect(hello.properties?.maxFrameBytes?.type).toBe('integer')
    expect(hello.required).not.toContain('maxFrameBytes')
    // 契约里写明「生效值」语义，而不是把 1 MiB 当硬契约。
    expect(hello.properties?.maxFrameBytes?.description ?? '').toContain('Effective inbound per-frame limit')
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

  it('error 帧声明可选 retryable/details，retryable 缺省语义成文（issue #IKXGYS）', () => {
    const errorSchema = schemaNode('MobileError')
    // 新字段必须标注 optional（不在 required 里）——旧客户端忽略新字段，零破坏是承诺。
    expect(errorSchema.properties?.retryable?.type).toBe('boolean')
    expect(errorSchema.properties?.details).toBeDefined()
    expect(errorSchema.required).not.toContain('retryable')
    expect(errorSchema.required).not.toContain('details')
    // 「缺字段 = 未知码 = 按 false」必须写进契约，客户端才知道保守方向。
    expect(asyncapiText).toMatch(/Absent means an\s*\n?\s*unknown code|absent means an unknown code/i)
    // 服务端语义表与文档相互指认：实现文件存在，且 API.md 分组表列了六个组。
    const errorCodesSource = readFileSync(new URL('../src/host/error-codes.ts', import.meta.url), 'utf8')
    expect(errorCodesSource).toContain("export function errorFrameRetryable")
    const apiDoc = readFileSync(new URL('../docs/project/API.md', import.meta.url), 'utf8')
    for (const group of ['usage', 'auth', 'state', 'transport', 'upstream', 'internal']) {
      expect(apiDoc).toContain(`| ${group}`)
    }
    // 抽查语义表内容与 API.md 分组表一致（防止两处文档各改各的）。
    expect(errorCodesSource).toContain("UPSTREAM_UNAVAILABLE: { group: 'upstream', retryable: true }")
    expect(errorCodesSource).toContain("INTERNAL_ERROR: { group: 'internal', retryable: true }")
    expect(errorCodesSource).toContain("UNKNOWN_TYPE: { group: 'usage', retryable: false }")
    // 帧超限是连接级错误：先 error 帧再 1009，按 transport 组登记（2026-11-27）。
    expect(errorCodesSource).toContain("FRAME_TOO_LARGE: { group: 'transport', retryable: true }")
    expect(apiDoc).toContain('| transport（传输层限制） | `true` | `FRAME_TOO_LARGE`')
  })

  it('history 帧的可选 compact 参数成文，且与实现/能力位互指（issue #IKXGYV）', () => {
    // 契约：参数语义写进客户端帧 description（data 没有 per-kind schema，字面量自指）。
    expect(asyncapiText).toContain('history-compact-v1')
    expect(asyncapiText).toMatch(/first 512 chars/i)
    // 实现：摘要投影存在、保留量常量在（文档抄的数字以源码为准）。
    const budget = readFileSync(new URL('../src/host/history-budget.ts', import.meta.url), 'utf8')
    expect(budget).toContain('export function compactHistoryEvents')
    expect(budget).toContain('HISTORY_COMPACT_KEEP_CHARS = 512')
    // 客户端帧类型：HistoryFrame 声明了 compact?: boolean。
    const protocol = readFileSync(new URL('../src/host/ws-protocol.ts', import.meta.url), 'utf8')
    const frame = protocol.match(/export interface HistoryFrame[\s\S]*?compact\?: boolean/)
    expect(frame, 'HistoryFrame 缺少 compact?: boolean').not.toBeNull()
    // 能力位与 API.md 表格互指。
    const capabilities = readFileSync(new URL('../src/host/capabilities.ts', import.meta.url), 'utf8')
    expect(capabilities).toContain("'history-compact-v1'")
    const apiDoc = readFileSync(new URL('../docs/project/API.md', import.meta.url), 'utf8')
    expect(apiDoc).toContain('history-compact-v1')
  })

  it('file-upload-status 双向进词表与契约，幂等语义成文（issue #IKXGYW）', () => {
    // 帧类型：客户端词表与服务端 kind 词表都含。
    expect(asyncapiText).toMatch(/-\s*file-upload-status\s*\n/)
    const protocol = readFileSync(new URL('../src/host/ws-protocol.ts', import.meta.url), 'utf8')
    expect(protocol).toMatch(/\| 'file-upload-status'/)
    expect(protocol).toMatch(/export interface FileUploadStatusFrame[\s\S]*?uploadId: string/)
    // 语义：设备级归属 + TTL 写进契约，否则客户端不会知道重连后还能查。
    expect(asyncapiText).toMatch(/scoped to the\s*\*\*device\*\*\s*\(not the connection\)/)
    expect(asyncapiText).toMatch(/UPLOAD_RESULT_TTL_MS/)
    const apiDoc = readFileSync(new URL('../docs/project/API.md', import.meta.url), 'utf8')
    expect(apiDoc).toContain('file-upload-status')
    const source = readFileSync(new URL('../src/host/ws-file-transfer.ts', import.meta.url), 'utf8')
    expect(source).toContain('UPLOAD_RESULT_TTL_MS')
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
    // 两条通道各有自己的一份常量：/api/v1/events 的在 server.ts，/ws/mobile 的在
    // ws-handler.ts。**四份都必须还是 512 / 32 / 30 s**，否则 asyncapi 的 const 就骗人了
    // —— 「文档承诺 32、实现没有上限」正是这条用例要拦的那类事。
    expect(protocolSource.length).toBeGreaterThan(0)
    const handlerSource = readFileSync(new URL('../src/host/ws-handler.ts', import.meta.url), 'utf8')
    const serverSource = readFileSync(new URL('../src/host/server.ts', import.meta.url), 'utf8')
    expect(handlerSource).toContain('const DEFAULT_MOBILE_QUEUE_LIMIT = 512')
    expect(handlerSource).toContain('const DEFAULT_MOBILE_MAX_CONNECTIONS = 32')
    expect(handlerSource).toContain('const DEFAULT_MOBILE_HEARTBEAT_INTERVAL_MS = 30_000')
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
