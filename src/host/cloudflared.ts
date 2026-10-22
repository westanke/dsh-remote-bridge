import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Cloudflare 隧道（cloudflared）管理。
 *
 * ## 它解决什么
 *
 * 用户在外网想连回家里的电脑。bridge 默认只监听本机/局域网，公网不可达。
 * Cloudflare Tunnel 让电脑**主动连出**到 Cloudflare 边缘，换取一个 `wss://` 地址，
 * 两个 Channel：
 *
 * - **命名隧道（Named Channel）**：需要 Cloudflare 账户 + 域名（DNS）→ 固定地址。
 * - **快速隧道（Quick Tunnel）**：一条命令即起、无需账户域名 → 临时地址。
 *
 * 本模块直接实现 **Quick Tunnel 的自动拉起**（「无账户、一键"国内优先 + 自动创建"」的最小
 * 闭环）；命名隧道因需要交互式登录 + 域名 DNS，面板只负责指示用户手动配置后，
 * 用 `setNamed` 把地址喂进来，走同一套 `DSH1:` 生成。
 *
 * ## 为什么用子进程
 *
 * cloudflared 是 Cloudflare 官方 Go 二进制，本仓不自带（体积大、无原生 TS 等价物），
 * 必须下载到本机再 `spawn`。这也是「国内优先下载核心功能」的落点之一。
 *
 * ## 下载与版本
 *
 * cloudflared 官方二进制只在 GitHub Releases（`cloudflared-linux-amd64` 等）。
 * 国内裸连 GitHub 时好时坏。设计上：
 * - 架构按 `process.platform/arch` 判定（UOS20 x86_64 → linux-amd64），**不**写死；
 * - 下载源用环境变量 `CLOUDFLARED_MIRROR` 控制：裸二进制镜像基址（拼架构后缀）
 *   或 `deb+` 前缀的 .deb 完整地址（下载后 `dpkg-deb -x` 提取 `usr/bin/cloudflared`）；
 * - 已存在的可执行文件直接复用，不重复下载。
 *
 * **真实择源**：`deb+https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb`
 * 已在真机（GitHub 直连被墙的环境）验证可下载解包并成功拉起 Quick Tunnel——官方 `pkg.cloudflare.com`
 * 仓库比 GitHub 直连更稳。见 PITFALLS §国内下载 cloudflared 必须择源。
 *
 * ## 进程生命周期
 *
 * - [startQuick] spawn 一次；[stop] 结束进程。
 * - 进程非预期退出会通过 [onStatus] 回调把状态推进到 `stopped` 并留错误摘要。
 *
 * ## 地址归一
 *
 * Quick Tunnel 从进程输出抓到的原生地址是 `https://<random>.trycloudflare.com`。
 * 放进 `DSH1:` 配置文本时客户端只认 `http(s)://` 前缀（App 会自动拼 `/events` 并把 https
 * 升级成 wss），所以模块对外统一暴露 `https://` 原文 —— 见 PITFALLS §wss 端点必须归一成 https。
 */

/** 隧道当前状态（面板据此渲染按钮/提示）。 */
export type TunnelChannel = 'quick' | 'named'

export interface TunnelPublicState {
  channel: TunnelChannel | null
  /** 对外地址，已统一为 `https://` 前缀原文，供配置文本直接使用。 */
  url: string | null
  running: boolean
  /**
   * 兜底的**英文短消息**（调试/日志用）。
   *
   * 2.5.2 起它**已脱敏**：不含完整 URL、不含绝对路径（见 `sanitizeDownloadError`）。
   * 客户端应优先用 `errorKey` 本地化；这个字段只在没有键可用时兜底。
   */
  error?: string
  /**
   * 结构化错误键（客户端据此本地化）。渲染优先级 **errorKey > error**。
   */
  errorKey?: TunnelErrorKey
  /** `errorKey` 的插值参数。 */
  errorParams?: Record<string, string | number>
}

/** 「创建云隧道」进行中任务的阶段状态，供前端轮询显示进度。`percent=null` 表示该阶段无确定百分比（流动条）。 */
export interface TunnelActivity {
  /** 阶段标识：locating / downloading / unpacking / starting；`idle` 表示当前无进行中任务。 */
  stage: 'idle' | 'locating' | 'downloading' | 'unpacking' | 'starting'
  /**
   * 阶段文案的 **i18n 键**（不是给人看的句子）。
   *
   * 2.5.2 起取代原来的 `label: string`：服务端不再决定用哪种语言说这句话，
   * 由客户端按自己的界面语言渲染。`''` 表示 idle（无进行中任务）。
   *
   * 键清单是**跨端契约**（见 `TunnelStageKeys`），改名会让 UI 显示原始键名。
   * `''` = idle（没有进行中的任务，UI 不显示进度条）。
   */
  labelKey: TunnelStageKey | ''
  /** 键里的插值参数（如下载进度的 `{ mb, all }`）。 */
  labelParams?: Record<string, string | number>
  /** 0-100 的进度百分比；null = 该阶段无法量化（前端显示流动条）。 */
  percent: number | null
}

/**
 * 隧道阶段文案的 i18n 键 —— **跨端契约，不得随意改名**。
 *
 * 客户端（`dsh-companion` / 桌面面板）按这套键查词典。改名 = UI 直接显示键名。
 */
export type TunnelStageKey =
  /** 正在定位本机二进制。 */
  | 'tunnelStageLocating'
  /** 已找到本机二进制，直接复用（不需要下载）。 */
  | 'tunnelStageBinaryFound'
  /** 正在从官方 GitHub 下载。 */
  | 'tunnelStageDownloadGithub'
  /** 正在从官方 deb 仓库下载。 */
  | 'tunnelStageDownloadDeb'
  /** 下载中，带进度：`labelParams = { mb, all }`。 */
  | 'tunnelStageDownloadProgress'
  /** 下载完成但**没有校验和可用**：内容未经验证（H5 的可见化）。 */
  | 'tunnelStageDownloadUnverified'
  /** 正在解包 deb 并提取二进制。 */
  | 'tunnelStageUnpackDeb'
  /** 正在写入二进制并赋执行权限。 */
  | 'tunnelStageWriteBinary'
  /** 正在启动 cloudflared 隧道。 */
  | 'tunnelStageStarting'

/** 键的**有序**清单，供客户端词典覆盖度检查与测试断言。 */
export const TunnelStageKeys: readonly TunnelStageKey[] = [
  'tunnelStageLocating',
  'tunnelStageBinaryFound',
  'tunnelStageDownloadGithub',
  'tunnelStageDownloadDeb',
  'tunnelStageDownloadProgress',
  'tunnelStageUnpackDeb',
  'tunnelStageWriteBinary',
  'tunnelStageStarting',
] as const

/** 「下载完成但未校验」的键（不在常规阶段序列里，由校验和缺席时上报）。 */
export const UNVERIFIED_DOWNLOAD_KEY = 'tunnelStageDownloadUnverified' as const

/**
 * 隧道错误的结构化键。与 `error`（兜底英文短消息）并存：
 * 客户端渲染优先级 **errorKey > error**。
 */
export type TunnelErrorKey =
  /** cloudflared 进程退出且没拿到地址：`errorParams = { code, signal }`。 */
  | 'tunnelErrorExited'
  /** 下载/解包失败（已脱敏，无参数）。 */
  | 'tunnelErrorDownload'
  /** 已经在运行，拒绝重复启动。 */
  | 'tunnelErrorAlreadyRunning'

/**
 * 平台/架构 -> cloudflared 归档后缀。
 *
 * **架构必须能单独传**，不能读 `process.arch`：
 * 2026-10-20 CI 实锤 —— 旧实现里 platform 是参数、arch 却写死 `process.arch`，
 * 于是 `archSuffix('linux')` 在 macOS runner（arm64）上返回 `linux-arm64`，
 * 而调用方要的是「linux 平台该用哪个官方归档」。同一函数里 platform 可控、
 * arch 不可控，是**自相矛盾的设计**；测试在 macOS 上红、Linux 上绿，全平台矩阵
 * （ubuntu/windows/macos × 两个 Node 版本）里只有 Linux 那两格能过。
 *
 * 两个参数都带默认值时保持旧行为（本机平台 + 本机架构）；显式传入时，
 * 结果只由入参决定 —— 这才让「算一个别的平台的后缀」成为可能。
 */
export function archSuffix(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform !== 'linux') {
    throw new Error(`cloudflared 尚不支持 ${platform} 平台。`)
  }
  switch (arch) {
    case 'x64':
      return 'linux-amd64'
    case 'arm64':
      return 'linux-arm64'
    default:
      throw new Error(`cloudflared 尚不支持 ${process.arch} 架构。`)
  }
}

/**
 * cloudflared 的**唯一**版本号（导出给测试与配置文本用）。
 *
 * ⚠️ 「钉版本」必须只有一处事实来源：2.5.1 及之前 GitHub 基线钉 `2024.11.1`，
 * 而 deb 兜底 URL 里写死了另一个版本 `2026.10.1` —— 同一个函数对「装哪个版本」
 * 给出两个不同答案，等于**没有钉住**。现在 deb URL 也从这里派生。
 */
export const CLOUDFLARED_VERSION = '2024.11.1'
const OFFICIAL_BASE =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-`

/**
 * 官方 deb 兜底仓库（GitHub 被墙时回退）。
 *
 * `pkg.cloudflare.com` 是 Cloudflare 官方仓库，实测在 GitHub 直连被墙的机器上可达可用
 * （见 PITFALLS §国内下载 cloudflared 必须择源）。仅在官方 GitHub 失败时兜底，
 * 不改变「默认先 GitHub」的语义。
 *
 * 版本**从 `CLOUDFLARED_VERSION` 派生**，不再写死第二个版本号。
 */
export function debFallbackUrl(debArch: string): string {
  return `https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_${CLOUDFLARED_VERSION}_${debArch}.deb`
}

/**
 * 用原生 `node:https` 下载完整文件（Buffer），配合 `setTimeout` 硬销毁 socket。
 *
 * 为什么不用全局 `fetch`：被墙网络的 TCP 连接是「半开挂起」，Node 24 的 `fetch`（undici）
 * 对这类连接**不响应 `AbortController.abort()`**（实测 15s 超时根本不触发，请求永久挂起）。
 * 而 `req.destroy()` 从 socket 层直接掐断，必然立刻触发 `error`/`abort` 回调返回。
 * 见 PITFALLS §国内下载 cloudflared 必须择源（真机实测：GitHub 被墙连接 fetch 超时失效）。
 *
 * 超时语义：`ms` 只约束「到响应头为止」（连接/TTFB）。一旦收到响应头进入流传，就放开，
 * 让大文件（deb ≈20MB）慢慢下完——否则会把「下载慢」误判成「超时源不可达」。
 *
 * 返回 `{ ok, status, body }`；在 ms 内未收到响应头才抛超时 Error。
 */
interface DownloadResult {
  ok: boolean
  status: number
  body: Buffer
}

/** 下载进度回调：已收到字节数 / Content-Length（未知为 -1）。 */
export type DownloadProgress = (received: number, total: number) => void

export async function downloadHttps(
  url: string,
  ms: number,
  onProgress?: DownloadProgress,
): Promise<DownloadResult> {
  // 仅支持 http/https；本模块下载源都是 https。
  const mod = url.startsWith('http:') ? await import('node:http') : await import('node:https')
  const res: DownloadResult = await new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: { 'User-Agent': 'dsh-remote-bridge' } }, (response) => {
      // 收到响应头：超时目标已达成，放开，让响应流慢慢收。
      clearTimeout(timer)
      const total = Number(response.headers['content-length'] ?? -1)
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (c) => {
        const buf = c as Buffer
        chunks.push(buf)
        received += buf.length
        onProgress?.(received, total)
      })
      response.on('error', (cause) => reject(new Error(`下载中止：${url}（${cause.message}）`)))
      response.on('end', () => {
        resolve({ ok: statusOk(response.statusCode), status: response.statusCode ?? 0, body: Buffer.concat(chunks) })
      })
    })
    // 到「响应头」为止硬超时：连接挂起/被墙/TTFB 太久都在这掐断。
    const timer = setTimeout(() => {
      req.destroy(ms < Number.POSITIVE_INFINITY ? new Error(`连接${ms}ms无响应：${url}`) : undefined)
    }, ms)
    req.on('error', (cause) => reject(new Error(`下载失败：${url}（${cause.message}）`)))
    req.on('close', () => clearTimeout(timer))
  })
  return res
}

function statusOk(code: number | undefined): boolean {
  return typeof code === 'number' && code >= 200 && code < 300
}

/**
 * 校验下载到的字节是否匹配期望的 SHA-256。
 *
 * 大小写不敏感、允许 `sha256:` 前缀（常见发行格式）。**长度不对一律 false** ——
 * 不做「宽松接受」：一个 3 字符的期望值只可能是配置错误，接受它就是放弃校验。
 */
export function verifySha256(bytes: Uint8Array, expectedHex: string): boolean {
  const normalized = expectedHex.trim().replace(/^sha256:/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) return false
  const actual = createHash('sha256').update(bytes).digest('hex')
  return actual === normalized
}

/**
 * 期望的校验和：读 `CLOUDFLARED_SHA256` 环境变量。
 *
 * 空串/纯空白视为**没有声明**（返回 undefined）—— 否则「随手 export 一个空值」
 * 会让所有下载都被判成不匹配。
 */
export function expectedSha256From(): string | undefined {
  const raw = process.env.CLOUDFLARED_SHA256?.trim() ?? ''
  return raw === '' ? undefined : raw
}

/**
 * 把下载/解包错误**脱敏**成可以对外（与本机日志）说的一行字。
 *
 * ## 为什么需要它
 *
 * 底层错误有三类敏感残留：
 * 1. **完整 URL** —— `downloadHttps` 的 `` `下载失败：${url}（${cause.message}）` ``，
 *    而镜像 URL 可能带 token（`https://mirror/token/...`）；
 * 2. **绝对路径** —— `execFile('dpkg-deb', ...)` 的错误形如
 *    `Command failed: dpkg-deb -x /home/user/.../x.deb /home/user/.../dir`；
 * 3. 两者都可能被 `router.ts` 原样塞进 502 响应体。
 *
 * ## 取舍
 *
 * 保留**可诊断的线索**（host 名、文件名），去掉**不该外传的部分**（完整 URL、目录）。
 * 一句话：能说「哪个源、哪个文件」；不能说「你家目录长什么样、URL 里那个 token 是什么」。
 */
export function sanitizeDownloadError(message: string): string {
  let safe = message
  // 1) URL → host（保留可诊断性）。
  safe = safe.replace(/https?:\/\/[^\s）)（("']+/gi, (raw) => {
    try {
      return `host:${new URL(raw).host}`
    } catch {
      return 'host:unknown'
    }
  })
  // 2) 绝对路径 → basename。
  //    只匹配「以 / 或盘符开头、且至少含一个分隔符」的串，避免把 `HTTP 404` 这类误伤。
  safe = safe.replace(/(?:[A-Za-z]:)?(?:\/[^\s:：/（）()]+)+\/?/g, (raw) => {
    const trimmed = raw.replace(/[\/]+$/, '')
    const base = trimmed.split(/[\\/]/).pop() ?? trimmed
    return base === '' ? trimmed : base
  })
  return safe
}

/** 环境变量注入的下载源配置；空则回退官方。 */
function mirrorBase(): string {
  return process.env.CLOUDFLARED_MIRROR?.trim() ?? ''
}

/**
 * 判定当前下载源是否为「Deb 仓库」。用 `deb+` 前缀声明：后续拼一个 `https://...deb` 完整地址。
 * 例：`CLOUDFLARED_MIRROR=deb+https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb`
 * 与「裸二进制基址」镜像（拼 `cloudflared-linux-amd64`）区分开。
 */
export function isDebSource(): boolean {
  return mirrorBase().startsWith('deb+')
}

/** 返回要下载的源 URL：deb 源返回完整 .deb 地址；裸镜像基址拼架构后缀；否则官方 GitHub。 */
/**
 * cloudflared 官方归档的下载地址。
 *
 * **platform/arch 都能显式传入**（2026-10-20 CI 实锤后加）：旧实现里
 * `downloadUrlFor()` 走 `archSuffix()` 的默认参数 —— 也就是**本机** platform/arch。
 * 于是这个函数在 macOS runner 上直接抛「尚不支持 darwin 平台」，
 * 而它要回答的问题其实是「linux 的 cloudflared 该从哪下」。
 *
 * 默认值保持本机（生产调用点 `ensureCloudflared` 就在 linux 上跑，行为不变），
 * 但显式传入后结果只由入参决定 —— 这才让「算别的平台的 URL」成为可能，
 * 也让测试不依赖跑在什么机器上。
 */
export function downloadUrlFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const suffix = archSuffix(platform, arch)
  const mirror = mirrorBase()
  if (mirror === '') return `${OFFICIAL_BASE}${suffix}`
  if (mirror.startsWith('deb+')) return mirror.slice(4)
  return `${mirror}${suffix}`
}

/** 从进程输出文本提取 `trycloudflare.com` 地址；找不到返回 null。 */
export function extractQuickTunnelUrl(text: string): string | null {
  const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(text)
  return match?.[1] ? `https://${match[1]}` : null
}

/**
 * 确保 cloudflared 可执行文件就位：先看 `dataDir/cloudflared` 是否已存在，否则下载。
 * 返回可执行文件绝对路径。
 *
 * 下载失败会把错误抛给调用方（router -> 面板可见），不会把半个文件当「已就位」——
 * 用临时文件 + rename 原子落盘。
 *
 * @param report 可选进度上报：下载/解包过程各阶段推进时回调（前端据此渲染进度条）。
 */
export async function ensureCloudflared(
  dataDir: string,
  report?: (a: TunnelActivity) => void,
): Promise<string> {
  const existing = path.join(dataDir, 'cloudflared')
  report?.({ stage: 'locating', labelKey: 'tunnelStageLocating', percent: null })
  try {
    if ((await stat(existing)).isFile()) {
      report?.({ stage: 'locating', labelKey: 'tunnelStageBinaryFound', percent: 100 })
      return existing
    }
  } catch {
    // 不存在，继续下载
  }
  await mkdir(dataDir, { recursive: true })

  // 取源顺序：显式 `CLOUDFLARED_MIRROR`（若设）→ 官方 GitHub → 官方 deb 兜底。
  // 逐个尝试，命中即落盘；全部失败则抛出带具体原因的错误（面板可见）。
  const explicit = mirrorBase()
  const candidates: Array<{ url: string; deb: boolean }> =
    explicit !== ''
      ? [{ url: downloadUrlFor(), deb: isDebSource() }]
      : [{ url: downloadUrlFor(), deb: false }, { url: debFallbackUrl('amd64'), deb: true }]

  // 期望校验和：声明了就**强校验**（不匹配即拒绝落盘），没声明就放行但把
  // 「未校验」显式上报。理由见文件头 H5 那一段与 `verifySha256` 的注释。
  const expected = expectedSha256From()

  const errors: string[] = []
  for (const { url, deb } of candidates) {
    report?.({
      stage: 'downloading',
      labelKey: deb ? 'tunnelStageDownloadDeb' : 'tunnelStageDownloadGithub',
      percent: null,
    })
    try {
      const res = await downloadHttps(url, 15_000, (received, total) => {
        const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null
        if (percent !== null) {
          const mb = (received / 1024 / 1024).toFixed(1)
          const all = (total / 1024 / 1024).toFixed(1)
          report?.({
            stage: 'downloading',
            labelKey: 'tunnelStageDownloadProgress',
            labelParams: { mb, all },
            percent,
          })
        }
      })
      if (!res.ok) {
        errors.push(`HTTP ${res.status}`)
        continue
      }
      // ---- 校验（H5）----
      if (expected !== undefined && !verifySha256(res.body, expected)) {
        // 声明了期望值却对不上 → **拒绝落盘**，并尝试下一个源。
        // 报错本身也脱敏（不含完整 URL）。
        errors.push('SHA-256 mismatch')
        continue
      }
      if (expected === undefined) {
        // 没有校验和可用：放行，但让这件事**可见**（UI 显示「未校验」标记）。
        report?.({
          stage: 'downloading',
          labelKey: 'tunnelStageDownloadUnverified',
          percent: 100,
        })
      }
      if (deb) {
        report?.({ stage: 'unpacking', labelKey: 'tunnelStageUnpackDeb', percent: null })
        return writeFromDeb(dataDir, res.body, url)
      }
      report?.({ stage: 'unpacking', labelKey: 'tunnelStageWriteBinary', percent: null })
      const tmp = path.join(dataDir, `.cloudflared.tmp-${process.pid}`)
      await writeFile(tmp, res.body)
      await chmod(tmp, 0o755)
      await rename(tmp, existing)
      return existing
    } catch (cause) {
      // 脱敏后再收集（H7）：完整 URL 与绝对路径都不留。
      errors.push(sanitizeDownloadError(cause instanceof Error ? cause.message : String(cause)))
    }
  }
  // 只报**数量与源的 host**，不报完整 URL 列表 —— 后者可能带镜像 token。
  const triedHosts = [...new Set(candidates.map((c) => {
    try { return new URL(c.url).host } catch { return 'unknown' }
  }))].join(', ')
  throw new Error(
    `下载 cloudflared 失败（已尝试 ${candidates.length} 个源：${triedHosts}）`
    + (errors.length === 0 ? '' : `；原因：${errors.join('；')}`),
  )
}

/**
 * 从 `.deb` 包字节中提取 `usr/bin/cloudflared`，原子落到 `dataDir/cloudflared`。
 * 不调用系统 `dpkg -i`（避免污染包数据库），只做解包 + 提取。
 *
 * 失败时抛出的错误**已脱敏**：`execFile` 的原始错误含两个绝对路径
 * （deb 与解包目录），直接外传会泄露本机目录结构。
 */
async function writeFromDeb(dataDir: string, debBuffer: Buffer, url: string): Promise<string> {
  await mkdir(dataDir, { recursive: true })
  const debPath = path.join(dataDir, `.cloudflared.deb-${process.pid}`)
  const extractDir = path.join(dataDir, `.cloudflared-extract-${process.pid}`)
  await writeFile(debPath, debBuffer)
  await mkdir(extractDir, { recursive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('dpkg-deb', ['-x', debPath, extractDir], (err) => {
        if (err === null) {
          resolve()
          return
        }
        // 只保留 basename 与退出状态：绝对路径在这条错误里出现过（H7）。
        reject(new Error(sanitizeDownloadError(`dpkg-deb 解包失败：${err.message}`)))
      })
    })
    const inner = path.join(extractDir, 'usr', 'bin', 'cloudflared')
    const out = path.join(dataDir, 'cloudflared')
    // 解包里没有那个二进制（损坏的 deb / 结构不符）必须明确报错，
    // 而不是把空文件当成功 —— 否则下一次 spawn 会在更难懂的地方失败。
    const bin = await readFile(inner)
    if (bin.byteLength === 0) throw new Error('解包后的 cloudflared 为空文件')
    await writeFile(out, bin)
    await chmod(out, 0o755)
    return out
  } finally {
    await rm(debPath, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 一次 cloudflared 子进程生命周期 + 对外状态机。 */
export class CloudflaredTunnelManager {
  private process: ChildProcess | null = null
  private url: string | null = null
  private channel: TunnelChannel | null = null
  private errorText: string | undefined = undefined
  private errorKey: TunnelErrorKey | undefined = undefined
  private errorParams: Record<string, string | number> | undefined = undefined
  private listeners: Array<() => void> = []
  private activity: TunnelActivity = { stage: 'idle', labelKey: '', percent: null }

  /** 当前进行中任务的阶段进度（无任务时 stage 为 idle）。 */
  get activityState(): TunnelActivity {
    return this.activity
  }

  /** 上报一条阶段进度（前端轮询 /cloudflare/activity 可见）。 */
  reportActivity(a: TunnelActivity): void {
    this.activity = a
    this.emit()
  }

  /** 任务结束（成功或失败）时清空进行中进度。 */
  clearActivity(): void {
    this.activity = { stage: 'idle', labelKey: '', percent: null }
    this.emit()
  }

  /**
   * 是否有隧道在运行 —— 管理面鉴权的**判据 0**。
   *
   * 判据取自**进程持有状态**，不是请求头，所以它对「隧道把外部流量转进 127.0.0.1」
   * 这条绕过路径 100% 可靠：不管转发进来的请求长什么样，只要隧道开着，管理面就关门。
   * 见 `auth.ts` 的 `adminRefusal` 与 `PITFALLS.md` §隧道让回环判据失效。
   *
   * `running` 与 `publicState.running` 是同一个表达式（同一份真相），这里单独暴露是为了
   * 让鉴权层不必构造一个含 url 的视图对象 —— 少一处把地址带进意外地方的机会。
   */
  get tunnelActive(): boolean {
    return this.process !== null && !this.process.killed
  }

  get publicState(): TunnelPublicState {
    return {
      channel: this.channel,
      url: this.url,
      running: this.tunnelActive,
      ...(this.errorText === undefined ? {} : { error: this.errorText }),
      ...(this.errorKey === undefined ? {} : { errorKey: this.errorKey }),
      ...(this.errorParams === undefined ? {} : { errorParams: this.errorParams }),
    }
  }

  /** 订阅状态变化；返回取消函数。 */
  onStatus(cb: () => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== cb)
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  /**
   * 记录一次错误。`error` 保留脱敏后的短消息（兜底/日志），
   * `errorKey` + `errorParams` 供客户端本地化（优先级 errorKey > error）。
   */
  private setError(errorKey: TunnelErrorKey, message: string, errorParams?: Record<string, string | number>): void {
    this.errorText = message
    this.errorKey = errorKey
    this.errorParams = errorParams
    this.emit()
  }

  /**
   * 启动一次 Quick Tunnel。
   * @param exe cloudflared 可执行文件路径（来自 [ensureCloudflared]）
   * @param port bridge 监听端口，cloudflared 把外网请求转发到 localhost:port
   */
  async startQuick(exe: string, port: number): Promise<TunnelPublicState> {
    if (this.process !== null && !this.process.killed) {
      // 结构化：客户端按 `tunnelErrorAlreadyRunning` 本地化，不需要读懂这句英文。
      // 这里抛 Error 而不是 ApiError：调用方（router）会把它包成 502/409，
      // 错误键通过 activity/state 传达，不走异常消息。
      throw new Error('Tunnel is already running; stop it first.')
    }
    this.errorText = undefined
    this.errorKey = undefined
    this.errorParams = undefined
    this.reportActivity({ stage: 'starting', labelKey: 'tunnelStageStarting', percent: null })
    const child = spawn(
      exe,
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    this.process = child
    this.channel = 'quick'
    this.emit()

    const onData = (buf: Buffer): void => {
      const found = extractQuickTunnelUrl(buf.toString('utf8'))
      if (found !== null && this.url === null) {
        this.url = found
        this.clearActivity()
        this.emit()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code, signal) => {
      const wasThis = this.process === child
      this.process = null
      this.channel = null
      this.emit()
      if (wasThis) {
        if (this.url === null) {
          // 结构化退出错误：code/signal 作为参数交给客户端插值。
          this.setError(
            'tunnelErrorExited',
            `cloudflared exited (code=${code ?? '?'}, signal=${signal ?? '?'}) without a tunnel URL.`,
            { code: String(code ?? '?'), signal: String(signal ?? '?') },
          )
        }
        this.url = null
        if (this.channel === null) this.clearActivity()
      }
    })
    return this.publicState
  }

  /** 停止当前隧道。 */
  stop(): TunnelPublicState {
    const child = this.process
    if (child !== null && !child.killed) child.kill('SIGTERM')
    this.process = null
    this.channel = null
    this.url = null
    this.emit()
    return this.publicState
  }

  /** 注入已抓到的地址 + 通道（命名隧道用）。 */
  setNamed(url: string): TunnelPublicState {
    this.url = url
    this.channel = 'named'
    this.emit()
    return this.publicState
  }
}