/**
 * 图片交接与附件读取：纯文本模型的图片落盘为工作区文件（handoff）、
 * 手机端回读（readHandoffImageFile）与界面语言（HandoffLocale）。
 * （原 `dsh-0.2-bridge.ts` 内的 handoff 区，#2 拆分时原样搬出。）
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from '../chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from '../image-handoff.ts'
import { recordFrameHubDropped, recordRpc } from '../metrics.ts'
import { wireRelative } from '../path-policy.ts'
import type { SettingsApiProxy } from '../settings-adapter.ts'
import type { Dsh02HostServices } from './kernel-services.ts'
import type { PromptContentPartLike } from './kernel-services.ts'
import { timeoutSignal, SESSION_DIR_LOOKUP_TIMEOUT_MS } from './rpc.ts'


// ── 纯文本模型的图片交接（零插件依赖） ────────────────────────────────────

/**
 * 内核在 prompt 准入里会因为「模型看不到图」拒收整条消息
 * （`MODEL_DOES_NOT_SUPPORT_IMAGES`）。手机端拿不到桌面 WebUI 那套
 * 「粘贴即落成临时文件、路径进输入框」的浏览器半边，所以图片在手机上
 * **直接发不出去** —— 而用户明明装了识图插件。
 *
 * 这里补上手机端缺的那一步，但**刻意不引用任何插件的 API**：
 * 判定用内核自己的 `llm.resolveModelInfo()`（与内核拒收时查的是同一份元数据），
 * 动作只是「图片落成文件 + 消息里给路径」—— 任何「按路径读图」的工具都能接手。
 * 哪天换插件、甚至不用插件，这段代码都不需要改。
 *
 * 三条保守原则（宁可退回原样、也不要自作聪明）：
 * 1. 元数据拿不到 / 解析不出模型 → **不动**（内核这时也不会拒，交给它）；
 * 2. 模型声明了 image → **不动**（原生图片能显示缩略图，别抢它的活）；
 * 3. 落盘失败 → **不动**（退回内核自己的报错，至少用户能看懂发生了什么）。
 *
 * 两个落点（按优先级）：
 * - **会话工作目录下的 `.dsh-images/`**（首选）：文件在用户的项目里，
 *   人和 agent 都找得到，也符合「产物放工作目录、别塞进 DSH 私有目录」；
 * - 解析不出工作目录时退回 DSH 目录（[DEFAULT_IMAGE_HANDOFF_DIR]）——
 *   宁可落到私有目录也不能让「发消息」本身失败。
 */
export const DEFAULT_IMAGE_HANDOFF_DIR = join(homedir(), '.dsh', 'image-handoff')

/**
 * 交接图片读取的体积上限（32 MiB）。
 *
 * 与只读图片路由里的 `MAX_BYTES`（`image-handoff.ts`）**同值但不同职责**：
 * 那边是「浏览器要不要显示」，这边是「服务端要不要把字节读进内存」。
 * 这里必须**在读之前**判 —— 先读完再判等于闸门形同虚设。
 */
export const MAX_HANDOFF_BYTES = 32 * 1024 * 1024

export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

/** 扩展名优先按声明的 mediaType，认不出再从魔数嗅，最后 .bin。 */
export function handoffExtension(mediaType: string, bytes: Buffer): string {
  const declared = IMAGE_EXTENSIONS[mediaType.trim().toLowerCase()]
  if (declared !== undefined) return declared
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return 'bin'
}

/**
 * 把一张内联图片写成文件，返回 `{ absolute, relative }`。
 *
 * 文件名用**内容哈希**：同一张图重复发不会堆副本（与内核附件存储同一思路），
 * 也让「同一路径 → 同一内容」对下游工具成立（可安全缓存）。
 * `relative` 是相对会话工作目录的短路径，给人看；`absolute` 给读图工具用。
 * 目录 0700、文件 0600：这些字节可能包含用户隐私。
 */
async function writeHandoffFile(
  dir: string,
  workspace: string | undefined,
  mediaType: string,
  data: string,
): Promise<{ absolute: string; relative: string }> {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) throw new Error('EMPTY_IMAGE')
  // ⚠️ 这里原来是 `mkdirSync` / `existsSync` / `writeFileSync` —— **同步 IO 跑在
  // prompt 请求链上**。一张 8 MiB 的图（base64 → 6 MiB 字节）在慢盘上足以让
  // 同时在跑的 WS 广播整体顿一下，因为 Node 的事件循环被这条系统调用占住了。
  // 换成 fs/promises 之后，等待期间事件循环照常处理其它连接。
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const fileName = `${createHash('sha256').update(bytes).digest('hex')}.${handoffExtension(mediaType, bytes)}`
  const absolute = join(dir, fileName)
  // 已存在就是同一张图（内容寻址），直接复用，不重写。
  // `flag: 'wx'` 把「存在与否」的判断交给内核原子完成：并发两张同样的图不会互相覆盖，
  // 也不会有「检查完到写之间被别人建了」的窗口（原来的 existsSync + writeFileSync 有）。
  try {
    await writeFile(absolute, bytes, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // 同一张图已经落过盘：幂等复用，不报错。
  }
  // 落进工作目录时给人看的是 `.dsh-images/xxx.jpg` 这样的短相对路径；
  // 退回私有目录时只有绝对路径有意义，relative 就用文件名。
  //
  // ⚠️ 前缀比较必须用 **path.sep**（Windows 上是 '\'），不能写死 '/'：
  // 写死时 Windows 上判断恒不成立 → relative 退化成裸文件名 → 给模型的提示里
  // 丢了 `.dsh-images/` 目录，模型按提示找不到图（2026-10-20 CI 实锤）。
  const relative = workspace !== undefined && absolute.startsWith(workspace + sep)
    // ⚠️ 必须转成 **wire 形式（正斜杠）**：这段文字是给**模型**看的路径提示，
    // 也是客户端摘除该行时依赖的标记。Windows 上 path.relative 产出的是
    // `\` 分隔，直接给出去会让模型按 `dir\file` 去找而找不到
    // （2026-10-20 CI 在 windows-latest 上实锤）。
    // 对照 `wireRelative()`（path-policy.ts）的做法：split(sep).join('/')。
    ? absolute.slice(workspace.length + 1).split(sep).join('/')
    : fileName
  return { absolute, relative }
}

/** 已配置的授权根（id + 真实路径）。由 `index.ts` 从数据库注入。 */
export type HandoffRoot = { id: string; realPath: string }

/** 交接文件名只允许「内容哈希 + 图片扩展名」：挡住一切路径穿越。 */
/**
 * 交接文件名的白名单与媒体类型表现在住在 `image-handoff.ts` —— 设置面板、只读图片路由
 * 和这里读的是**同一份**判据，分开写两份迟早漂移。这里只是就近取个别名。
 */
export const HANDOFF_NAME = HANDOFF_FILE_NAME

/**
 * 读出一张交接图片的字节（供手机端把它**显示**出来）。
 *
 * 只接受裸文件名，目录永远由「会话工作目录 + <识图路径>」（或兜底目录）推出，
 * 客户端给绝对路径也不认 —— 否则这条读文件的口子会变成任意文件读取。
 * 工作目录与 [writeHandoffFile] 用的是同一套解析，保证「写在哪、从哪读」；
 * `<识图路径>` 也来自同一个地方（设置里的当前值），改设置后写读同步跟着走。
 *
 * **导出**是给同源只读图片路由（`image-handoff.ts`）用的：那条路由不校验设备 token，
 * 所以它更需要「目录不由客户端给」这条约束 —— 直接复用这里，而不是另写一套解析。
 */
export async function readHandoffImageFile(
  host: Dsh02HostServices,
  roots: readonly HandoffRoot[],
  fallbackDir: string,
  subdir: string,
  sessionId: string,
  name: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const fileName = name.split(/[/\\]/).pop() ?? name
  const match = HANDOFF_NAME.exec(fileName)
  if (match === null) throw new Error('BAD_HANDOFF_NAME')
  const ext = (match[1] ?? '').toLowerCase()
  const mediaType = HANDOFF_MEDIA_TYPES[ext] ?? 'application/octet-stream'
  const workspace = await sessionWorkspaceDir(host, roots, sessionId)
  const candidates = [
    ...(workspace !== undefined ? [join(workspace, subdir, fileName)] : []),
    join(fallbackDir, fileName),
  ]
  // 先 `stat` 再读，而且**两条都异步**：
  //
  // 修复前是 `existsSync` + `readFileSync` —— 同步 IO 跑在 HTTP 请求链上，
  // 一张 32 MiB 的图足以把事件循环按住几百毫秒（期间 WS 广播、其它请求全排队）。
  // 而且「先整份读进来、再在上层判 32 MiB」意味着超限时内存**已经花掉了** ——
  // 一个反复请求大文件的客户端能把服务端 RSS 顶上去。
  //
  // 所以顺序改成：stat（O(1)、异步）→ 体积闸门 → readFile（异步）。
  // 闸门放在读之前，超限一个字节都不读。
  let target: string | undefined
  let size = 0
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (!info.isFile()) continue
      target = candidate
      size = info.size
      break
    } catch {
      // 这个候选不存在：继续下一个（工作目录 → 兜底目录）。
    }
  }
  if (target === undefined) throw new Error('HANDOFF_IMAGE_NOT_FOUND')
  if (size === 0) throw new Error('HANDOFF_IMAGE_EMPTY')
  if (size > MAX_HANDOFF_BYTES) throw new Error('HANDOFF_IMAGE_TOO_LARGE')
  return { bytes: new Uint8Array(await readFile(target)), mediaType }
}


/**
 * 解析会话当前的工作目录（绝对路径），冷会话也能用。
 *
 * 不走 live agent（冷会话没有 agent）：直接用 `sessionController.list()`
 * 里那条会话的 `cwd`（相对授权根的 wire 路径），再与数据库里的根拼出真实路径。
 * 解析不出来（没有授权根 / cwd 不在任何根下）就返回 undefined —— 交给上层兜底。
 */
async function sessionWorkspaceDir(
  host: Dsh02HostServices,
  roots: readonly HandoffRoot[],
  sessionId: string,
): Promise<string | undefined> {
  if (roots.length === 0) return undefined
  // 带超时：这条调用在 prompt（交接图落盘）与只读读图两条热路径上。
  // 修复前它用永不 abort 的 signal —— 内核卡住时「发一条带图的消息」会无限挂着。
  const list = await host.sessionController.list({}, timeoutSignal(SESSION_DIR_LOOKUP_TIMEOUT_MS))
  const item = (list.items as readonly { sessionId?: unknown; cwd?: unknown }[] | undefined)
    ?.find(entry => entry.sessionId === sessionId)
  const cwd = typeof item?.cwd === 'string' ? item.cwd : undefined
  if (cwd === undefined) return undefined
  for (const root of roots) {
    const relative = wireRelative(root.realPath, cwd)
    if (relative !== undefined) return join(root.realPath, relative)
  }
  return undefined
}


/** 会话当前生效的模型（pending > lastUsed > 目录默认），取不到返回 undefined。 */
async function currentModelSelection(
  host: Dsh02HostServices,
  sessionId: string,
): Promise<{ provider: string; model: string } | undefined> {
  // 同上：判定「模型看不看得到图」这一跳也在 prompt 热路径上，必须有上限。
  const baseline = await host.sessionController.projections({ sessionId }, timeoutSignal(SESSION_DIR_LOOKUP_TIMEOUT_MS))
  const selection = baseline?.values?.['modelSelection'] as { lastUsed?: unknown; next?: unknown } | undefined
  const catalog = await host.sessionController.modelCatalog()
  // 字段名必须用对外**wire 视图**的名字：内核 `wire.view` 产出的是 `{ lastUsed, next }`，
  // `next = pending ?? lastUsed`；`pending` 只存在于内部 state，投影对外**没有**这个字段。
  // 早先这里读 `pending`，于是永远 undefined、一路退回 `lastUsed` —— 而 `lastUsed` 是
  // 「上一次真正跑过的模型」：用户刚切到新模型、还没用它跑过一轮时，这里拿到的是**旧模型**。
  // 实测症状：切到纯文本模型 agnes-2.5-flash 后发图，判定读成旧模型、认为「不用插手」，
  // 图片原样交给内核，被内核以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒收。
  const current = (selection?.next ?? selection?.lastUsed ?? catalog.default) as
    | { provider?: unknown; model?: unknown }
    | undefined
  const provider = current?.provider
  const model = current?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return { provider, model }
}


/**
 * 内核会不会因为「这个模型看不到图」拒收？判据与内核**逐字一致**：
 * `inputModalities` 已声明且不含 `image`。
 *
 * 元数据缺失（`undefined`）**不算**「确认看不到图」—— 内核在那种情况下也不拒，
 * 我们跟着不插手（拿不准就走原路）。
 */
async function modelIsConfirmedTextOnly(
  host: Dsh02HostServices,
  sessionId: string,
): Promise<boolean> {
  const selection = await currentModelSelection(host, sessionId)
  if (selection === undefined) return false
  const info = await host.llm.resolveModelInfo(selection.provider, selection.model)
  const modalities = info?.inputModalities
  if (!Array.isArray(modalities)) return false
  return !modalities.includes('image')
}


/**
 * 需要交接时，把每个 `image` 部件换成**两行文本**；否则原样返回。
 *
 * 同一行路径要同时伺候两类读者：
 * - **给人看**（第一行）：图片序号、原始文件名、工作目录里的短路径；
 * - **给机器看**（第二行 `[Image: source: <绝对路径>]`）：这是读图技能明确
 *   识别的占位形状之一（带图片扩展名的绝对路径同样触发），任何按路径读图的
 *   工具都能接手，不出现任何具体插件名。
 *
 * 任何一步抛错都退回原内容：这个功能的失败**不该**把「发消息」本身弄坏。
 */
/**
 * 交接文案用哪种语言。
 *
 * 判据是**发消息那个客户端的界面语言**，由 HTTP `Accept-Language` 头带进来
 * （router → chat-adapter → 这里）。拿不到就退回中文 —— 那是这个功能既有的默认口径，
 * 判断不出来的时候不该突然换语言。
 */
export type HandoffLocale = 'zh' | 'en'

/** 从 `Accept-Language` 里挑一个我们支持的语种；认不出来就是中文。 */
export function handoffLocaleOf(acceptLanguage: string | undefined): HandoffLocale {
  if (acceptLanguage === undefined) return 'zh'
  // 形如 `zh-CN,zh;q=0.9,en;q=0.8`：按出现顺序取第一个认识的，尊重客户端排的优先级。
  for (const tag of acceptLanguage.split(',')) {
    const language = (tag.split(';')[0] ?? '').trim().toLowerCase()
    if (language.startsWith('zh')) return 'zh'
    if (language.startsWith('en')) return 'en'
  }
  return 'zh'
}

/**
 * 交接说明的第一行（给人看的那行）。
 *
 * 写的是**人话**，不是挂在用户眼前的祈使句 —— 早期版本写「请先用读图工具打开下面那行的
 * 绝对路径」，那是写给机器看的措辞，用户看了的反馈是看不懂。现在一句话说清两件事：
 * 模型看不到图、图存在哪；要看图该怎么办。语言跟随界面（见 [handoffLocaleOf]）。
 * 第二行的 `[Image: source: …]` 是机器契约，跨语言不变。
 */
function handoffLine(index: number, name: string, relative: string, locale: HandoffLocale): string {
  if (locale === 'en') {
    return `🖼️ Image ${index} "${name}" (this model can't see images, saved to ${relative}; to view it, open the path below with an image-reading tool)`
  }
  return `🖼️ 图片 ${index}「${name}」（当前模型看不到图，已存到 ${relative}；要看图，请用识图工具打开下面那行的路径）`
}

export async function handoffImagesForTextOnlyModel(
  host: Dsh02HostServices,
  roots: readonly HandoffRoot[],
  fallbackDir: string,
  subdir: string,
  locale: HandoffLocale,
  sessionId: string,
  content: readonly PromptContentPartLike[],
): Promise<readonly PromptContentPartLike[]> {
  if (!content.some(part => part.type === 'image')) return content
  try {
    if (!(await modelIsConfirmedTextOnly(host, sessionId))) return content
    const workspace = await sessionWorkspaceDir(host, roots, sessionId)
    const dir = workspace !== undefined ? join(workspace, subdir) : fallbackDir
    let index = 0
    // 逐张 await：图片数量少（一条消息里通常 1~4 张），但每张都要落盘。
    // 用 for 循环而不是 `Promise.all` 是刻意的 —— 保持**原顺序**与**原编号**，
    // 而且并发写同一目录在重负载下没有收益（都是小文件）。
    const mapped: PromptContentPartLike[] = []
    for (const part of content) {
      if (part.type !== 'image') {
        mapped.push(part)
        continue
      }
      index += 1
      const { absolute, relative } = await writeHandoffFile(dir, workspace, part.mediaType, part.data)
      const name = typeof part.name === 'string' && part.name.trim() !== ''
        ? part.name.trim()
        : (locale === 'en' ? `image ${index}` : `图片 ${index}`)
      const text = [
        // 第一行有两个读者，所以两句都塞在这一行里**而不另起一行**：
        // - 给人看：图片序号、原始文件名、存在哪、要看图该怎么办（写人话，见 handoffLine）；
        // - 给模型看：明确要求「先读图再回答」。实测纯文本模型拿到路径后**并不一定会去读** ——
        //   曾经出现过它先去加载界面技能、图放着不看的场面（用户的原话是"你啥都不显示"）。
        //   只递路径是"可以读"，加上这一句才是"被要求读"。
        // 另外，客户端（dsh-companion）按行首 `🖼️ 图片 ` 与 `[Image: source:` 两个标记整行摘除，
        // **不看括号里的字**，所以改文案不需要手机端跟着出包。
        handoffLine(index, name, relative, locale),
        `[Image: source: ${absolute}]`,
      ].join('\n')
      mapped.push({ type: 'text' as const, text })
    }
    return mapped
  } catch {
    return content
  }
}
