import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { checkRouteContract } from './docs-contract.ts'

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
  // 2026-10-21 新增：给 AI 与改代码的人用的两张导航图。
  // 它们**不是**散文型文档，末尾带机检锚点区，由下面「目录结构与接口说明」一节双向校验。
  'STRUCTURE.md',
  'INTERFACES.md',
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

// ─────────────────────────────────────────────────────────────────────────────
// 目录结构与接口说明（2026-10-21 新增）
//
// ## 为什么要有这一节
//
// 用户的要求是「加目录结构与接口说明，方便 AI 阅读改代码，**后期改代码要同步改**」。
// 前两句写两份 md 就够，难的是第三句：没有门禁的「请记得同步」等于没写 ——
// 本仓已有实锤先例（README 双站漂移连续三版无人发现，见 PITFALLS.md 同名条目），
// 所以这里把它做成机检。
//
// ## 为什么是**双向**
//
// - 只查「文档 → 源码」（锚点里的路径/文件必须存在）时，**新增文件不会被发现** ——
//   新加一个 `src/host/foo.ts` 压根没登记，文档侧的旧条目全部有效，检查照样全绿。
//   那样的门禁只会惩罚「删文件忘删条目」，而漏掉真正高频的那一半。
// - 只查「源码 → 文档」（src 下每个文件都必须在锚点里）时，锚点里写错路径、
//   指向一个不存在的文件同样发现不了。
// 两向都查才是「清单与事实一致」。
//
// ## 为什么要**下限断言**
//
// 解析失败（标记被改、表格格式变了、把代码块套在了锚点上）会让两个集合**双双为空而一致**，
// 于是「零解析」被当成「零问题」—— 这正是本仓坑位索引那一节最初撞上的假绿。
// 下限断言直接对「解析出几条」报警，与上面的坑位检查同一套写法。
const structureDoc = await readOrReport('STRUCTURE.md')
const interfacesDoc = await readOrReport('INTERFACES.md')

// `readOrReport` 而不是从 `contents` 取：`contents` 只缓存必需文档，缺文件时不报错直接缺键，
// 用 `?? ''` 取会静默变成 0 条 —— 那正是下面下限断言要抓的假绿。
async function readOrReport(name: string): Promise<string> {
  try {
    return await readFile(path.join(projectDir, name), 'utf8')
  } catch {
    // 必需文档缺失在上面已经报过一条，这里不重复刷屏。
    return ''
  }
}

/** 取出 begin/end 标记之间的正文；缺任意一个标记都返回 undefined（调用方按解析失败处理）。 */
function anchorBlock(text: string, begin: string, end: string): string | undefined {
  const from = text.indexOf(begin)
  if (from === -1) return undefined
  const to = text.indexOf(end, from + begin.length)
  if (to === -1) return undefined
  return text.slice(from + begin.length, to)
}

/** 从「签名片段」里取出最后一个标识符 —— 锚点用 `export function apply` 这种半行写法也认得。 */
function lastIdentifier(symbol: string): string | undefined {
  return [...symbol.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].at(-1)?.[0]
}

const structureCount = { rows: 0 }
const structureBlock = anchorBlock(structureDoc, '<!-- structure-check:begin -->', '<!-- structure-check:end -->')
if (structureBlock === undefined) {
  failures.push('STRUCTURE.md 缺少 `<!-- structure-check:begin/end -->` 机检锚点（格式见文末），解析不出任何条目')
} else {
  const declared = new Set<string>()
  // 只认带反引号路径的数据行：表头 `| 路径 | 类型 | 职责 |` 与分隔行 `| --- |` 都不匹配。
  for (const match of structureBlock.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(file|dir)\s*\|/gm)) {
    const relative = (match[1] as string).trim()
    const kind = match[2] as string
    declared.add(relative)
    structureCount.rows += 1
    let info
    try {
      info = await stat(path.join(root, relative))
    } catch {
      failures.push(`STRUCTURE.md 锚点里的 \`${relative}\` 不存在 —— 文件已删除/移动，请同步锚点`)
      continue
    }
    if (kind === 'file' && !info.isFile()) failures.push(`STRUCTURE.md 锚点把 \`${relative}\` 标成 file，但它不是文件`)
    if (kind === 'dir' && !info.isDirectory()) failures.push(`STRUCTURE.md 锚点把 \`${relative}\` 标成 dir，但它不是目录`)
  }
  if (structureCount.rows < 30) {
    failures.push(`STRUCTURE.md 锚点只解析出 ${structureCount.rows} 行（预期 ≥ 30），表格格式可能变了 —— 不许静默通过`)
  }
  // **反向**：src 下每个源文件都必须登记。这条才是「新增文件必须同步文档」的兑现。
  for (const relative of await collectSourceFiles()) {
    if (!declared.has(relative)) {
      failures.push(`\`${relative}\` 未登记进 STRUCTURE.md 机检锚点 —— 新增/移动/删除 src 下源文件时请同步（AGENTS.md §3.4）`)
    }
  }
}

const interfaceCount = { rows: 0 }
const interfaceBlock = anchorBlock(interfacesDoc, '<!-- interfaces-check:begin -->', '<!-- interfaces-check:end -->')
if (interfaceBlock === undefined) {
  failures.push('INTERFACES.md 缺少 `<!-- interfaces-check:begin/end -->` 机检锚点（格式见文末），解析不出任何条目')
} else {
  const sourceCache = new Map<string, string>()
  for (const match of interfaceBlock.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([a-z]+)\s*\|/gm)) {
    const symbol = match[1] as string
    const relative = (match[2] as string).trim()
    interfaceCount.rows += 1
    let body = sourceCache.get(relative)
    if (body === undefined) {
      try {
        body = await readFile(path.join(root, relative), 'utf8')
        sourceCache.set(relative, body)
      } catch {
        failures.push(`INTERFACES.md 锚点里的 \`${relative}\` 不存在 —— 文件已删除/移动，请同步锚点`)
        continue
      }
    }
    const identifier = lastIdentifier(symbol)
    if (identifier === undefined) {
      failures.push(`INTERFACES.md 锚点条目「${symbol}」里取不出标识符，格式应为 \`<签名片段>\` | \`<文件路径>\` | <类型>`)
      continue
    }
    if (!new RegExp(`\\b${identifier}\\b`).test(body)) {
      failures.push(`INTERFACES.md 锚点说 \`${relative}\` 有「${identifier}」，但源码里找不到 —— 导出改名/搬文件后请同步（AGENTS.md §3.4）`)
    }
  }
  if (interfaceCount.rows < 25) {
    failures.push(`INTERFACES.md 锚点只解析出 ${interfaceCount.rows} 行（预期 ≥ 25），表格格式可能变了 —— 不许静默通过`)
  }
}

/** 递归收集 `src/` 下的 `.ts` / `.tsx`，返回仓库相对的 posix 路径（与锚点写法一致）。 */
async function collectSourceFiles(directory = path.join(root, 'src')): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...await collectSourceFiles(full))
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      found.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  return found
}


// ─────────────────────────────────────────────────────────────────────────────
// 根 README 双站与 CHANGELOG（2026-10-20 新增）
//
// 为什么单独成节、不塞进 `requiredDocs`：
//   1. `requiredDocs` 里第一项 `'README.md'` 指的是 **docs/project/README.md** ——
//      那是文档索引（ADR 表在里头），不是仓库根的对外 README。
//      把「根 README 必须存在」加到那个清单里只会改错文件、并把 ADR 索引检查一起弄坏。
//   2. 根 README 是**对外承诺**（安装门槛、内核范围、当前版本），它的漂移不像
//      STATUS/ROADMAP 那样会让开发者当场卡住，而是让用户按旧版本装、按旧内核范围找
//      不兼容的内核。所以这里查的是「关键口径」，不是「文件齐全」。
//
// 本节的共同纪律 —— **下限断言**（与上面坑位索引同一套写法）：
// 正则一条都没匹配到时**必须**报「格式可能变了」，不许静默通过。
// 否则 README 一旦把 `>=0.2.0-rc.2 <0.3.0` 改写面（比如去掉反引号、拆成两行、
// 换成 `^0.2.x`），检查会双双为空而「一致」，于是漂移照旧通行。
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  version: string
  repository?: unknown
  // `engines.dsh` 是内核按 semver 裁决的真值来源（不满足时该插件被 disabled，
  // 宿主进程不退出）。README 双站必须与它一致 —— 见本节后半。
  engines?: { dsh?: string }
}
const rootReadmes = ['README.md', 'README.en.md'] as const
const readmeText = new Map<string, string>()
// 本小节跑过的检查条数，只在全部通过时打印。为什么要报这个数：2026-10-20 之前
// README 双站漂移长期没人发现，正是因为汇总行只提第一段（project docs / tasks / ADRs），
// 读输出的人无从判断「第二段到底跑没跑」。把条数打出来，删掉某条检查也会立刻在输出里显形。
let rootCheckCount = 0
for (const name of rootReadmes) {
  try {
    readmeText.set(name, await readFile(path.join(root, name), 'utf8'))
    rootCheckCount += 1
  } catch {
    failures.push(`missing root ${name}`)
  }
}
const zhReadme = readmeText.get('README.md') ?? ''
const enReadme = readmeText.get('README.en.md') ?? ''

// 内核版本范围：形如 `>=0.2.0-rc.2 <0.3.0`。**两侧必须都出现且完全相同**。
// 为什么不是「都提到 0.2.x」：旧版 README 曾一侧写 `>=0.2.0-rc.2`、另一侧写 `>=0.2.0-rc.2 <0.3.0`，
// 于是英文站的用户以为 rc.2 之后所有版本都行，中文站的用户却收到范围告警。
const dshRanges = new Map<string, string[]>()
for (const [name, text] of readmeText) {
  // 捕获 `>=X <Y` 这个**成对**形状（单边 `>=0.2.0-rc.2` 不收）：
  // 反引号两侧可有可无（README 里是 `` `>=…` ``，但从文档里 AS-IS 拷贝到别处时会丢）；
  // `[^\s`]+` 里的反引号是为了不让反引号被吃进捕获组。
  dshRanges.set(name, [...text.matchAll(/>=([^\s`]+)\s+<([^\s`]+)/g)].map(match => match[0] as string))
}
for (const name of rootReadmes) {
  const found = dshRanges.get(name) ?? []
  if (found.length === 0) {
    failures.push(`${name} 没有解析出 DSH 内核版本范围（形如 >=0.2.0-rc.2 <0.3.0），格式可能变了`)
  } else if (new Set(found).size > 1) {
    failures.push(`${name} 的 DSH 内核范围自相矛盾：${[...new Set(found)].join(' / ')}`)
  } else {
    rootCheckCount += 1
  }
}
const zhRange = dshRanges.get('README.md')?.[0]
const enRange = dshRanges.get('README.en.md')?.[0]
if (zhRange !== undefined && enRange !== undefined) {
  if (zhRange !== enRange) {
    failures.push(`README 双站的 DSH 内核范围不一致：中文 \`${zhRange}\` / 英文 \`${enRange}\``)
  } else {
    rootCheckCount += 1
  }
}
// package.json 改了、文档没跟：这是「范围漂移」最高频的一条（engine 范围属于发布决策，
// 改它的人通常只想着 npm 包，不会顺手翻两份 README）。
const declaredRange = packageJson.engines?.dsh
if (declaredRange !== undefined) {
  if (zhRange === undefined || zhRange !== declaredRange) {
    failures.push(`README.md 的 DSH 内核范围 ${zhRange === undefined ? '缺失' : `为 ${zhRange}`}，与 package.json engines.dsh（${declaredRange}）不一致`)
  } else {
    rootCheckCount += 1
  }
  if (enRange === undefined || enRange !== declaredRange) {
    failures.push(`README.en.md 的 DSH 内核范围 ${enRange === undefined ? '缺失' : `为 ${enRange}`}，与 package.json engines.dsh（${declaredRange}）不一致`)
  } else {
    rootCheckCount += 1
  }
}

// 当前版本号：`v2.4.2`。中英两站的「项目信息 / Project」小节都必须与 package.json 一致。
// 只在该小节里找，是为了不让页眉 badge、安装命令里的 `v2.4.2.tgz` 混进真值判断——
// 那些位置改了也是好事，但它们不是「当前版本」这一行。
const expectedVersion = `v${packageJson.version}`
const versionSections = [
  { name: 'README.md', text: zhReadme, heading: /^## 项目信息[^\n]*$/m },
  { name: 'README.en.md', text: enReadme, heading: /^## Project[^\n]*$/m },
]
for (const { name, text, heading } of versionSections) {
  // 从小节标题切到下一个 `## `：本文件不引入 markdown 解析库（这个脚本要能被
  // tsx 单跑），所以用「标题 + 到下一个同级标题为止」这个够用的近似。
  const start = heading.exec(text)
  if (start === null) {
    failures.push(`${name} 缺少「项目信息 / Project」小节，无法核对当前版本号`)
    continue
  }
  const rest = text.slice(start.index + start[0].length)
  const next = /^## /m.exec(rest)
  const section = next === null ? rest : rest.slice(0, next.index)
  const versions = [...section.matchAll(/`(v\d+\.\d+\.\d+(?:-[\w.]+)?)`/g)].map(match => match[1] as string)
  if (versions.length === 0) {
    failures.push(`${name} 的项目信息小节没有解析出形如 ${expectedVersion} 的当前版本号，格式可能变了`)
  } else if (!versions.includes(expectedVersion)) {
    failures.push(`${name} 的当前版本是 ${versions.join(' / ')}，package.json 是 ${expectedVersion}`)
  } else {
    rootCheckCount += 1
  }
}

// CHANGELOG：仓库根**没有** CHANGELOG.md（本仓的变更记录是 docs/project/CHANGELOG-DEV.md，
// 它已在 `requiredDocs` 里被查过存在性）。这里补两件事：
//   1. 根**长出** CHANGELOG.md 时一并纳入（两条路都查，谁在就算谁）；
//   2. 当前版本必须在变更记录里有条目 —— 否则「发完版才发现日志停在上一个版本」。
const changelogs = [
  { label: 'CHANGELOG.md', file: path.join(root, 'CHANGELOG.md') },
  { label: 'docs/project/CHANGELOG-DEV.md', file: path.join(projectDir, 'CHANGELOG-DEV.md') },
]
const changelogBodies: Array<{ label: string; body: string }> = []
for (const { label, file } of changelogs) {
  let body: string | undefined
  try {
    body = await readFile(file, 'utf8')
  } catch {
    // 根 CHANGELOG.md 缺失是**正常状态**（本仓就没有），不报；
    // docs/project/CHANGELOG-DEV.md 缺失上面已经报过了。
    if (label === 'CHANGELOG.md') continue
  }
  if (body !== undefined) changelogBodies.push({ label, body })
}
if (changelogBodies.length === 0) failures.push('没有任何 CHANGELOG（CHANGELOG.md 或 docs/project/CHANGELOG-DEV.md）可供核对')
for (const { label, body } of changelogBodies) {
  // 条目形如 `## 2.4.2 · …` 或 `## v2.4.2 · …`。下限断言同样必要：
  // 标题层级若从 `##` 改成 `###`，正则会一条不中而被当成「没有该版本条目」——
  // 那是**假阴性**（绿着但条目其实在），所以先报解析失败再报缺失。
  const versionEntries = [...body.matchAll(/^#{1,6}\s*v?\d+\.\d+\.\d+/gm)]
  if (versionEntries.length === 0) {
    failures.push(`${label} 没有解析出任何版本条目标题（形如 ## 2.4.2 · …），格式可能变了`)
    continue
  }
  if (!versionEntries.some(match => match[0].includes(packageJson.version))) {
    failures.push(`${label} 缺少 ${expectedVersion} 的条目（package.json 是 ${packageJson.version}）`)
  } else {
    rootCheckCount += 1
  }
}
const openapi = await readFile(path.join(root, 'docs', 'api', 'openapi.yaml'), 'utf8')
const asyncapi = await readFile(path.join(root, 'docs', 'api', 'asyncapi.yaml'), 'utf8')
const openapiDoc = parseYaml('OpenAPI', openapi)
const asyncapiDoc = parseYaml('AsyncAPI', asyncapi)
if (openapiDoc.info?.version !== packageJson.version) failures.push('OpenAPI version differs from package.json')
if (asyncapiDoc.info?.version !== packageJson.version) failures.push('AsyncAPI version differs from package.json')
// FUNC-3 / SEC-H1 根治门禁：OpenAPI paths 与 router.ts 真实路由双向 diff
// （代码有 yaml 没有 → 红；yaml 有代码没有 → 红），并强制「yaml security:[] 豁免集
// == principal() 之前返回的端点集」，防止再出现 host-services 那种裸奔端点。
// 解析逻辑与显式豁免（OPTIONS 预检、bare /jobs/{id} 的 405 守卫）见 scripts/docs-contract.ts。
{
  const routerSource = await readFile(path.join(root, 'src', 'host', 'router.ts'), 'utf8')
  failures.push(...(await checkRouteContract({ routerSource, openApiYaml: openapi })))
}
if (asyncapiDoc.channels?.events?.address !== '/api/v1/events') failures.push('AsyncAPI is missing /api/v1/events')

// ── /ws/mobile：帧词汇表必须与代码里的联合类型对齐 ──────────────────────────
//
// 为什么这条值得一个门禁：`/ws/mobile` 的帧类型集合写在 `src/host/ws-protocol.ts`
// 的两个联合类型里，而对外契约写在 asyncapi 的 enum 里。两处各自演进时，
// **多一个帧**是静默的（服务端照收，SDK 不认识），**少一个帧**也是静默的
// （客户端发了，服务端回 UNKNOWN_TYPE，看着像客户端 bug）。两个方向都要抓。
//
// 解析失败（联合类型被改名/挪走、enum 不是数组）会得到两个空集合，
// 那样「双向一致」是假绿，所以先做下限断言再比内容 —— 与 STRUCTURE/INTERFACES
// 那两段的处置一致。
if (asyncapiDoc.channels?.mobile?.address !== '/ws/mobile') failures.push('AsyncAPI is missing /ws/mobile')

/** 从 `export type X = 'a' | 'b' | ...` 里抽成员；找不到返回空数组（由调用方报红）。 */
function unionMembers(source: string, typeName: string, endMarker: string): string[] {
  const start = source.indexOf(`export type ${typeName} =`)
  if (start === -1) return []
  const rest = source.slice(start)
  const end = rest.indexOf(endMarker)
  const block = end === -1 ? rest : rest.slice(0, end)
  return [...block.matchAll(/'([a-z0-9-]+)'/g)].map(match => match[1] as string)
}

/**
 * 契约 enum 里允许出现的「代码联合类型尚未收录」的成员。
 *
 * 这些不是遗漏，是**已核实的实现细节帧**：handler 会处理/发送它们，但
 * `ClientFrameType` / `ServerFrameKind` 两个联合类型还没收录（见
 * `docs/project/TECH-DEBT.md` 的 DEBT-005）。白名单是台账不是豁免：谁把联合类型
 * 补齐，就必须把这里对应的项删掉，否则「白名单里有、联合类型里也有」不会报错
 * —— 所以下面同时断言白名单与联合类型**不相交**，保证它只会自动变短。
 */
const MOBILE_CLIENT_ONLY_IN_CONTRACT = ['fork', 'workspace-create', 'file-list', 'directory-create', 'directories']
const MOBILE_SERVER_ONLY_IN_CONTRACT = [
  'paired', 'fork', 'workspace-create',
  'host', 'models', 'default-model', 'providers', 'permission', 'permission-options',
  'agent-presets', 'session-stats', 'context-usage',
]
{
  const protocolSource = await readFile(path.join(root, 'src', 'host', 'ws-protocol.ts'), 'utf8')
  const clientUnion = unionMembers(protocolSource, 'ClientFrameType', '/** 服务端')
  const serverUnion = unionMembers(protocolSource, 'ServerFrameKind', '// ─')
  const clientEnum = asyncapiDoc.components?.schemas?.MobileClientFrame?.properties?.type?.enum
  const serverEnum = asyncapiDoc.components?.schemas?.MobileServerFrame?.properties?.kind?.enum

  // 下限断言：联合类型各自 60+ 成员、enum 各自 60+ 项。低于阈值说明解析失效，不是「一致」。
  if (clientUnion.length < 60) failures.push(`ws-protocol.ts 的 ClientFrameType 只解析出 ${clientUnion.length} 个成员（格式可能变了）`)
  if (serverUnion.length < 60) failures.push(`ws-protocol.ts 的 ServerFrameKind 只解析出 ${serverUnion.length} 个成员（格式可能变了）`)
  if (!Array.isArray(clientEnum) || clientEnum.length < 60) failures.push('AsyncAPI MobileClientFrame.type.enum 缺失或条目过少（格式可能变了）')
  if (!Array.isArray(serverEnum) || serverEnum.length < 60) failures.push('AsyncAPI MobileServerFrame.kind.enum 缺失或条目过少（格式可能变了）')

  if (clientUnion.length >= 60 && Array.isArray(clientEnum)) {
    const declared = new Set(clientUnion)
    const documented = new Set(clientEnum as string[])
    const missing = clientUnion.filter(type => !documented.has(type))
    if (missing.length > 0) failures.push(`AsyncAPI MobileClientFrame 缺少客户端帧类型：${missing.join(', ')}（ws-protocol.ts 声明了它）`)
    const undocumented = (clientEnum as string[]).filter(type => !declared.has(type) && !MOBILE_CLIENT_ONLY_IN_CONTRACT.includes(type))
    if (undocumented.length > 0) failures.push(`AsyncAPI MobileClientFrame 出现了代码里不存在的帧类型：${undocumented.join(', ')}（契约比实现更宽）`)
    const stale = MOBILE_CLIENT_ONLY_IN_CONTRACT.filter(type => declared.has(type))
    if (stale.length > 0) failures.push(`ClientFrameType 已收录 ${stale.join(', ')}，请从 MOBILE_CLIENT_ONLY_IN_CONTRACT 白名单里删掉（白名单只许变短）`)
  }
  if (serverUnion.length >= 60 && Array.isArray(serverEnum)) {
    const declared = new Set(serverUnion)
    const documented = new Set(serverEnum as string[])
    const missing = serverUnion.filter(kind => !documented.has(kind))
    if (missing.length > 0) failures.push(`AsyncAPI MobileServerFrame 缺少服务端帧 kind：${missing.join(', ')}（ws-protocol.ts 声明了它）`)
    const undocumented = (serverEnum as string[]).filter(kind => !declared.has(kind) && !MOBILE_SERVER_ONLY_IN_CONTRACT.includes(kind))
    if (undocumented.length > 0) failures.push(`AsyncAPI MobileServerFrame 出现了代码里不存在的帧 kind：${undocumented.join(', ')}（契约比实现更宽）`)
    const stale = MOBILE_SERVER_ONLY_IN_CONTRACT.filter(kind => declared.has(kind))
    if (stale.length > 0) failures.push(`ServerFrameKind 已收录 ${stale.join(', ')}，请从 MOBILE_SERVER_ONLY_IN_CONTRACT 白名单里删掉（白名单只许变短）`)
  }

  // 握手与关联约定的结构必须在（形状细节由 tests/mobile-frame-contract.spec.ts 钉）。
  for (const schema of ['MobileHello', 'MobilePaired', 'MobileError', 'MobileConnectionLimits']) {
    if (asyncapiDoc.components?.schemas?.[schema] === undefined) failures.push(`AsyncAPI is missing components.schemas.${schema}`)
  }
  if (asyncapiDoc.components?.schemas?.MobileHello?.properties?.protocol?.const !== 3) {
    failures.push('AsyncAPI MobileHello.protocol must be const 3')
  }
  // 三个子协议前缀 + 禁 query 带 token，是鉴权面的硬约定，写死在契约里才不会被悄悄改。
  for (const literal of ['dsh-mobile-v1', 'dsh-pair.', 'dsh-auth.', 'X-DSH-Device-ID', 'X-DSH-Device-Name']) {
    if (!asyncapi.includes(literal)) failures.push(`AsyncAPI 的 /ws/mobile 契约缺少握手约定 ${literal}`)
  }
}

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

// 根 README 的未解析占位符扫描。用上面 `readmeText` 里**已经容错读到的**内容，
// 不要再 `readFile` 一次：那一行在 README 缺失时会抛 ENOENT，
// 把「missing root README.md」这条本该可读的失败变成一坨堆栈（2026-10-20 实测撞上）。
const trackedText = [
  zhReadme,
  enReadme,
  ...contents.values(),
].join('\n')
if (/github\.com\/OWNER\//.test(trackedText)) failures.push('documentation contains an unresolved GitHub owner placeholder')

// ── cordis.patch.yml 的 inject 必须与 src/index.ts 导出的 inject 完全一致 ──────
//
// 为什么这条值得单独一个门禁：patch 里的 `inject` **覆盖**插件自己导出的 `inject`，
// 不是取并集。于是「插件声明了但 patch 漏了」的服务，读起来会报
// `cannot get property "x" without inject` ——
// 与「内核压根没有这个服务」的报错**一模一样**，肉眼分不出来。
//
// 这条坑长期掩盖过真相：`permissionPresets` 一直被当成「web profile 注不进、
// 只能走内置兜底目录」，实际是 patch 没声明它。2026-10-20 加 jobController 时
// 同样注不进，顺着 cordis `_refresh()` 的 INACTIVE 逻辑才反查到这条覆盖规则。
// 代价是三次重启和一次错误的对外结论，所以用门禁钉死。
//
// 双向断言：patch 少了 → 服务读不到；patch 多了 → 声明了一个不存在的依赖，
// entry 会因此永远 INACTIVE（比少的更糟，插件整个不激活）。
const patchYaml = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
const patchDoc = parseYaml('cordis.patch.yml', patchYaml) as unknown
const pluginRow = Array.isArray(patchDoc)
  ? (patchDoc as Record<string, unknown>[])
      .flatMap(entry => (Array.isArray((entry as { insert?: unknown }).insert)
        ? (entry as { insert: Record<string, unknown>[] }).insert
        : []))
      .find(row => row['name'] === 'dsh-remote-bridge')
  : undefined
if (pluginRow === undefined) {
  failures.push('cordis.patch.yml has no insert row for dsh-remote-bridge')
} else {
  const patchInject = pluginRow['inject']
  if (!Array.isArray(patchInject)) {
    failures.push('cordis.patch.yml plugin row has no inject array')
  } else {
    const patchNames = patchInject.map(String)
    // src/index.ts 导出的 inject：直接解析源码里那个数组字面量。
    // 用正则而不是 import，是因为这个脚本要能被 tsx 单跑、不该拉起整个插件。
    const indexSource = await readFile(path.join(root, 'src', 'index.ts'), 'utf8')
    const injectMatch = /export const inject = \[([\s\S]*?)\]/.exec(indexSource)
    if (injectMatch === null) {
      failures.push('src/index.ts has no `export const inject = [...]`')
    } else {
      const sourceNames = [...(injectMatch[1] as string).matchAll(/'([^']+)'/g)].map(m => m[1] as string)
      if (sourceNames.length < 10) {
        failures.push(`src/index.ts 的 inject 只解析出 ${sourceNames.length} 项（预期 ≥ 10），格式可能变了`)
      }
      const missingInPatch = sourceNames.filter(name => !patchNames.includes(name))
      const extraInPatch = patchNames.filter(name => !sourceNames.includes(name))
      for (const name of missingInPatch) {
        failures.push(`cordis.patch.yml 的 inject 缺少「${name}」（src/index.ts 声明了它）—— patch 会覆盖插件导出的 inject，漏了这项就读不到，报错与「内核没有该服务」一模一样`)
      }
      for (const name of extraInPatch) {
        failures.push(`cordis.patch.yml 的 inject 多出「${name}」（src/index.ts 没声明）—— 声明不存在的依赖会让整个 entry 永远 INACTIVE`)
      }
    }
  }
}

function parseYaml(name: string, source: string): Record<string, any> {
  const document = parseDocument(source)
  for (const error of document.errors) failures.push(`${name} YAML is invalid: ${error.message}`)
  return document.toJS() as Record<string, any>
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`docs:check: ${failure}`)
  process.exitCode = 1
} else {
  // 两段各自的通过数都要报：只报第一段的话，「第二段到底跑没跑」从输出上看不出来，
  // 而那正是 2026-10-20 之前 README 双站漂移没人发现的原因 —— 门禁在跑，但没人知道它没查 README。
  console.log(`docs:check: ${requiredDocs.length} project docs, ${tasks.size} tasks, ${decisionFiles.length} ADRs, and API/SDK versions are consistent`)
  // 锚点条数单独打出来：与根 README 那行同理 —— 只报「总数一致」的话，
  // 「目录/接口这节到底跑没跑」从输出上看不出来，而它恰恰是最容易被写成假绿的一节。
  console.log(`docs:check: STRUCTURE.md ${structureCount.rows} anchors (src files all registered) / INTERFACES.md ${interfaceCount.rows} anchors, both directions consistent`)
  console.log(`docs:check: root README bilingual (${rootCheckCount} checks) and CHANGELOG are consistent`)
}
