import { spawn, execFile, type ChildProcess } from 'node:child_process'
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
  error?: string
}

/** 「创建云隧道」进行中任务的阶段状态，供前端轮询显示进度。`percent=null` 表示该阶段无确定百分比（流动条）。 */
export interface TunnelActivity {
  /** 阶段标识：locating / downloading / unpacking / starting；`idle` 表示当前无进行中任务。 */
  stage: 'idle' | 'locating' | 'downloading' | 'unpacking' | 'starting'
  /** 人类可读的阶段文案（如「已找到本机二进制，直接复用」）。 */
  label: string
  /** 0-100 的进度百分比；null = 该阶段无法量化（前端显示流动条）。 */
  percent: number | null
}

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

/** 官方 GitHub 下载基线（不带 `-linux-amd64` 后缀）。稳定版本，不逐日追新。 */
const CLOUDFLARED_VERSION = '2024.11.1'
const OFFICIAL_BASE =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-`

/**
 * 官方 deb 兜底仓库（GitHub 被墙时回退）。
 * `pkg.cloudflare.com` 是 Cloudflare 官方仓库，实测在 GitHub 直连被墙的机器上可达可用
 * （见 PITFALLS §国内下载 cloudflared 必须择源）。版本比 GitHub 默认新（2026.10.1），
 * 仅在官方 GitHub 失败时兜底，不改变「默认先 GitHub」的语义。
 */
const DEB_FALLBACK_URL =
  'https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb'

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
  report?: (a: Omit<TunnelActivity, 'stage'> & { stage: TunnelActivity['stage'] }) => void,
): Promise<string> {
  const existing = path.join(dataDir, 'cloudflared')
  report?.({ stage: 'locating', label: '定位本机二进制…', percent: null })
  try {
    if ((await stat(existing)).isFile()) {
      report?.({ stage: 'locating', label: '已找到本机二进制，直接复用', percent: 100 })
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
      : [{ url: downloadUrlFor(), deb: false }, { url: DEB_FALLBACK_URL, deb: true }]

  const errors: string[] = []
  for (const { url, deb } of candidates) {
    report?.({ stage: 'downloading', label: `正在下载 cloudflared（${deb ? '官方 deb 仓库' : '官方 GitHub'}）…`, percent: null })
    try {
      const res = await downloadHttps(url, 15_000, (received, total) => {
        const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null
        if (percent !== null) {
          const mb = (received / 1024 / 1024).toFixed(1)
          const all = (total / 1024 / 1024).toFixed(1)
          report?.({ stage: 'downloading', label: `正在下载 cloudflared… ${mb}/${all} MB`, percent })
        }
      })
      if (!res.ok) {
        errors.push(`HTTP ${res.status}`)
        continue
      }
      if (deb) {
        report?.({ stage: 'unpacking', label: '解包官方 deb 并提取二进制…', percent: null })
        return writeFromDeb(dataDir, res.body, url)
      }
      report?.({ stage: 'unpacking', label: '写入二进制并赋予执行权限…', percent: null })
      const tmp = path.join(dataDir, `.cloudflared.tmp-${process.pid}`)
      await writeFile(tmp, res.body)
      await chmod(tmp, 0o755)
      await rename(tmp, existing)
      return existing
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const tried = candidates.map((c) => c.url).join('\n  ')
  throw new Error(`下载 cloudflared 失败：\n  ${tried}\n原因：${errors.join('；')}`)
}

/**
 * 从 `.deb` 包字节中提取 `usr/bin/cloudflared`，原子落到 `dataDir/cloudflared`。
 * 不调用系统 `dpkg -i`（避免污染包数据库），只做解包 + 提取。
 */
async function writeFromDeb(dataDir: string, debBuffer: Buffer, url: string): Promise<string> {
  await mkdir(dataDir, { recursive: true })
  const debPath = path.join(dataDir, `.cloudflared.deb-${process.pid}`)
  const extractDir = path.join(dataDir, `.cloudflared-extract-${process.pid}`)
  await writeFile(debPath, debBuffer)
  await mkdir(extractDir, { recursive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('dpkg-deb', ['-x', debPath, extractDir], (err) => (err ? reject(err) : resolve()))
    })
    const inner = path.join(extractDir, 'usr', 'bin', 'cloudflared')
    const out = path.join(dataDir, 'cloudflared')
    const bin = await readFile(inner)
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
  private listeners: Array<() => void> = []
  private activity: TunnelActivity = { stage: 'idle', label: '', percent: null }

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
    this.activity = { stage: 'idle', label: '', percent: null }
    this.emit()
  }

  get publicState(): TunnelPublicState {
    return {
      channel: this.channel,
      url: this.url,
      running: this.process !== null && !this.process.killed,
      ...(this.errorText === undefined ? {} : { error: this.errorText }),
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

  private setError(message: string): void {
    this.errorText = message
    this.emit()
  }

  /**
   * 启动一次 Quick Tunnel。
   * @param exe cloudflared 可执行文件路径（来自 [ensureCloudflared]）
   * @param port bridge 监听端口，cloudflared 把外网请求转发到 localhost:port
   */
  async startQuick(exe: string, port: number): Promise<TunnelPublicState> {
    if (this.process !== null && !this.process.killed) {
      throw new Error('隧道已经在运行中，请先停止。')
    }
    this.errorText = undefined
    this.reportActivity({ stage: 'starting', label: '正在启动 cloudflared 隧道…', percent: null })
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
          this.setError(`cloudflared 退出（code=${code ?? '?'}, signal=${signal ?? '?'}），未拿到隧道地址。`)
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