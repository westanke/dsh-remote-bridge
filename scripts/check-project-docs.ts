import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'

const root = path.resolve(import.meta.dirname, '..')
const projectDir = path.join(root, 'docs', 'project')
const requiredDocs = [
  'README.md',
  'STATUS.md',
  'ROADMAP.md',
  'ARCHITECTURE.md',
  'API.md',
  'COMPATIBILITY.md',
  'SECURITY.md',
  'TESTING.md',
  'CHANGELOG-DEV.md',
  'RELEASE.md',
]
const validStatuses = new Set(['planned', 'in-progress', 'blocked', 'done'])

const failures: string[] = []
const contents = new Map<string, string>()
for (const name of requiredDocs) {
  try {
    contents.set(name, await readFile(path.join(projectDir, name), 'utf8'))
  } catch {
    failures.push(`missing docs/project/${name}`)
  }
}

const roadmap = contents.get('ROADMAP.md') ?? ''
const tasks = new Map<string, string>()
for (const match of roadmap.matchAll(/^\| ([A-Z]+-\d{3}) \| ([a-z-]+) \|/gm)) {
  tasks.set(match[1] as string, match[2] as string)
}
if (tasks.size === 0) failures.push('ROADMAP.md contains no stable task IDs')
for (const [id, status] of tasks) if (!validStatuses.has(status)) failures.push(`${id} has invalid status ${status}`)

const statusDoc = contents.get('STATUS.md') ?? ''
for (const match of statusDoc.matchAll(/`([A-Z]+-\d{3})`/g)) {
  if (!tasks.has(match[1] as string)) failures.push(`STATUS.md references unknown task ${match[1]}`)
}

const decisionsDir = path.join(projectDir, 'decisions')
const decisionFiles = (await readdir(decisionsDir)).filter(name => /^ADR-\d{4}-.+\.md$/.test(name))
const index = contents.get('README.md') ?? ''
for (const file of decisionFiles) {
  const number = file.slice(0, 8)
  if (!index.includes(number)) failures.push(`${file} is missing from the ADR index`)
  const body = await readFile(path.join(decisionsDir, file), 'utf8')
  // `proposed` 也是 ADR 的标准状态（2026-10-17 加：ADR-0009 是首个「待拍板」的决策 ——
  // 它的结论正是「先别改代码，等一个实验」。要求它必须是 accepted 会逼人把
  // 「还没定」写成「已定」，那比没有状态行更坏）。
  // 门禁没有因此变松：**状态行仍然必须存在**，只是允许的取值多了一个。
  const decisionStatuses = ['accepted', 'superseded', 'proposed']
  if (!decisionStatuses.some(status => body.includes(`状态：${status}`))) {
    failures.push(`${file} has no accepted/superseded/proposed status`)
  }
}

// 坑位索引 ↔ PITFALLS 正文：**双向**一致。
//
// 索引写的是「触发词」，正文是同名 `###` 标题；漂移时读者照索引翻不到条目，
// 而这类不一致不会让别的检查变红。三处讲究：
// - 双向：只查「索引 → 正文」时，索引解析失败（0 条）会永远满足、被判成通过；
// - 下限：格式变了导致只解析出几条时，双向可能「双双为空而一致」，下限直接对解析失败报警；
// - 不按编号找小节：本仓索引在 §6、姊妹仓在 §7 —— 写死编号必然有一边解析成空。
const agentsDoc = await readFile(path.join(root, 'AGENTS.md'), 'utf8')
// 直接读文件，**不要**从 `contents` 取：那是「必需文档」清单的缓存，而 PITFALLS.md 不在
// 那 10 份里 —— 用 `?? ''` 的写法会静默变成 0 条，然后被下面的下限断言抓成「解析失败」
// （第一次跑就撞上了：0 个标题 + 17 条索引全报「正文里没有」）。
const pitfalls = await readFile(path.join(projectDir, 'PITFALLS.md'), 'utf8')
const indexSection = /^## \d+\.\s*坑位索引[^\n]*$([\s\S]*?)(?=^## \d+\.)/m.exec(agentsDoc)
// `indexSection?.[1]` 在 TS 严格模式下是 `string | undefined` —— 解析失败与「小节为空」
// 在这里是同一件事，一律当空串处理，随后由下面的下限断言报警。
const indexBody = indexSection?.[1] ?? ''
const indexed = [...indexBody.matchAll(/^- `([^`]+)`\s*$/gm)].map(match => match[1] as string)
const titled = [...pitfalls.matchAll(/^### (.+)$/gm)].map(match => (match[1] as string).trim())
if (indexed.length < 10) failures.push(`AGENTS.md 坑位索引只解析出 ${indexed.length} 条（预期 ≥ 10），小节格式可能变了`)
if (titled.length < 10) failures.push(`PITFALLS.md 只解析出 ${titled.length} 个 ### 标题（预期 ≥ 10）`)
for (const name of indexed) if (!titled.includes(name)) failures.push(`AGENTS.md 索引里的「${name}」在 PITFALLS.md 里没有同名标题`)
for (const name of titled) if (!indexed.includes(name)) failures.push(`PITFALLS.md 的「${name}」没有登记进 AGENTS.md 的坑位索引`)

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string; repository?: unknown }
const openapi = await readFile(path.join(root, 'docs', 'api', 'openapi.yaml'), 'utf8')
const asyncapi = await readFile(path.join(root, 'docs', 'api', 'asyncapi.yaml'), 'utf8')
const openapiDoc = parseYaml('OpenAPI', openapi)
const asyncapiDoc = parseYaml('AsyncAPI', asyncapi)
if (openapiDoc.info?.version !== packageJson.version) failures.push('OpenAPI version differs from package.json')
if (asyncapiDoc.info?.version !== packageJson.version) failures.push('AsyncAPI version differs from package.json')
for (const route of [
  '/healthz',
  '/pairings/exchange',
  '/devices/self',
  '/roots',
  '/roots/{rootId}/entries',
  '/roots/{rootId}/content',
  '/trash',
  '/trash/{trashId}/restore',
  '/chat/sessions',
  '/chat/workspaces',
  '/chat/workspaces/{workspaceId}',
  '/chat/sessions/{sessionId}',
  '/chat/sessions/{sessionId}/fork',
  '/chat/sessions/{sessionId}/archive',
  '/chat/sessions/{sessionId}/messages',
  '/chat/sessions/{sessionId}/approvals',
  '/chat/sessions/{sessionId}/approvals/{approvalId}/decision',
  '/chat/sessions/{sessionId}/commands',
  '/chat/sessions/{sessionId}/models',
  '/chat/sessions/{sessionId}/model',
  '/chat/sessions/{sessionId}/agent-preset',
  '/chat/runs/{id}/cancel',
  '/settings/providers',
  '/settings/models',
  '/settings/providers/{providerId}',
  '/settings/providers/{providerId}/discover',
]) if (openapiDoc.paths?.[route] === undefined) failures.push(`OpenAPI is missing ${route}`)
if (asyncapiDoc.channels?.events?.address !== '/api/v1/events') failures.push('AsyncAPI is missing /api/v1/events')

const kotlin = await readFile(
  path.join(root, 'kotlin-sdk', 'src', 'main', 'kotlin', 'ai', 'deepseek', 'dsh', 'workspace', 'DshWorkspaceClient.kt'),
  'utf8',
)
if (!kotlin.includes('API_VERSION: String = "v1"')) failures.push('Kotlin SDK API version differs from v1')
if (!kotlin.includes('selectSessionAgentPreset')) failures.push('Kotlin SDK is missing Agent preset selection')
if (!kotlin.includes('listPendingApprovals') || !kotlin.includes('decideApproval')) failures.push('Kotlin SDK is missing approval interaction')
if (!kotlin.includes('listSessionCommands') || !kotlin.includes('executeSessionCommand')) failures.push('Kotlin SDK is missing slash command interaction')
if (!kotlin.includes('renameChatWorkspace') || !kotlin.includes('deleteChatWorkspace')) failures.push('Kotlin SDK is missing workspace management')
if (!kotlin.includes('renameSession') || !kotlin.includes('forkSession') || !kotlin.includes('archiveSession')) failures.push('Kotlin SDK is missing session management')
if (!asyncapi.includes('chat.message.delta')) failures.push('AsyncAPI is missing stable chat delta events')
if (!asyncapi.includes('chat.approval.requested')) failures.push('AsyncAPI is missing approval events')
// 终局失败帧：限流 429 / 配额 / 密钥。少了它，客户端收到的是与"正常跑完"
// 一模一样的 chat.turn.end，于是模型早就失败了用户还在傻等。
if (!asyncapi.includes('ChatTurnFailed')) failures.push('AsyncAPI is missing the terminal turn-failure event')

const trackedText = [
  await readFile(path.join(root, 'README.md'), 'utf8'),
  ...contents.values(),
].join('\n')
if (/github\.com\/OWNER\//.test(trackedText)) failures.push('documentation contains an unresolved GitHub owner placeholder')

function parseYaml(name: string, source: string): Record<string, any> {
  const document = parseDocument(source)
  for (const error of document.errors) failures.push(`${name} YAML is invalid: ${error.message}`)
  return document.toJS() as Record<string, any>
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`docs:check: ${failure}`)
  process.exitCode = 1
} else {
  console.log(`docs:check: ${requiredDocs.length} project docs, ${tasks.size} tasks, ${decisionFiles.length} ADRs, and API/SDK versions are consistent`)
}
