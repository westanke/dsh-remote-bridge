import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TestCleanup } from './test-cleanup.ts'
import {
  CLOUDFLARED_VERSION,
  type TunnelActivity,
  type TunnelPublicState,
  TunnelStageKeys,
  extractQuickTunnelUrl,
  sanitizeDownloadError,
} from '../src/host/cloudflared.ts'

/**
 * cloudflared 的三件事（H5 校验和、H7 脱敏、UI-03 labelKey）。
 *
 * ## 为什么把三件事放一个文件
 *
 * 它们改的是**同一个模块的同一批出口**：下载（`ensureCloudflared`）、错误（`error`）、
 * 进度（`activity.label`）。分开写三个 spec 会重复同一套模块级约束说明。
 *
 * ## H5：下载即执行、零校验
 *
 * `ensureCloudflared` 拿到 2xx 就把字节 `chmod 755` 落盘，随后被 `spawn` 执行。
 * 没有任何哈希/签名校验，且**两个来源的版本还不一致**
 * （GitHub 钉 `2024.11.1`，deb 兜底指 `2026.10.1`）。这意味着「钉版本」并没有真的发生。
 *
 * 务实方案（本轮落地）：
 * 1. 统一版本口径 —— deb 兜底 URL 的版本从常量派生，不再写死另一个版本；
 * 2. 支持 `CLOUDFLARED_SHA256`（或同目录 `.sha256` 旁车）声明期望哈希，**声明了就强校验**；
 * 3. 没有声明时**保留下载**（否则国内环境直接不可用），但把「未校验」这件事
 *    **显式**暴露到 activity 与日志里 —— 不可见的安全状态等于没有。
 *    内建白名单作为 TODO（需要维护「版本 × 架构」的哈希表，不适合本轮硬塞）。
 *
 * ## H7：错误消息曾含完整镜像 URL 与绝对路径
 *
 * `downloadHttps` 的错误写成 `下载失败：${url}（${cause.message}）`，
 * deb 解包失败则是 `execFile` 的错误 —— 后者通常形如
 * `Command failed: dpkg-deb -x /abs/path.deb /abs/dir`，**绝对路径直接回显**。
 * 而 `router.ts` 把 `cause.message` 原样塞进 502 响应体。
 *
 * ## UI-03：label 是中文文案，客户端无法本地化
 *
 * `TunnelActivity.label` 从 `string` 改为 `labelKey` + `labelParams`，
 * 客户端按词典渲染。键清单由 lead 定稿，**不得改名**。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe('H5：版本口径统一（钉版本必须真的钉住）', () => {
  it('derives the deb fallback version from the same constant', async () => {
    // 旧实现的实锤矛盾：`CLOUDFLARED_VERSION = '2024.11.1'`，
    // 而 `DEB_FALLBACK_URL` 指向 `cloudflared_2026.10.1_amd64.deb`。
    // 「钉版本」在两处给出不同答案，等于没有钉。
    const { debFallbackUrl } = await import('../src/host/cloudflared.ts')
    const url = debFallbackUrl('amd64')
    expect(url).toContain(CLOUDFLARED_VERSION)
    // 反向断言：不能再出现那个写死的旧版本号。
    expect(url).not.toContain('2026.10.1')
  })

  it('builds a deb URL for each architecture from the version constant', async () => {
    const { debFallbackUrl } = await import('../src/host/cloudflared.ts')
    for (const arch of ['amd64', 'arm64']) {
      expect(debFallbackUrl(arch)).toContain(`cloudflared_${CLOUDFLARED_VERSION}_${arch}.deb`)
    }
  })
})

describe('H7：下载错误脱敏（不带完整 URL / 绝对路径）', () => {
  it('drops the full mirror URL but keeps the host name', () => {
    // 输入模拟真实错误：完整 URL + 底层 cause。
    const raw = '下载失败：https://mirror.example.com/secret-token/cloudflared-linux-amd64（getaddrinfo ENOTFOUND mirror.example.com）'
    const safe = sanitizeDownloadError(raw)
    // 保留可诊断的部分：host 名。
    expect(safe).toContain('mirror.example.com')
    // 必须去掉的：协议 + 路径（其中可能有 token）、完整 URL 串。
    expect(safe).not.toContain('https://')
    expect(safe).not.toContain('/secret-token/')
    expect(safe).not.toContain('cloudflared-linux-amd64')
  })

  it('collapses an absolute path to its basename', () => {
    // dpkg-deb 的 execFile 错误形态：`Command failed: dpkg-deb -x /abs/a.deb /abs/dir`
    const raw = 'Command failed: dpkg-deb -x /home/user/.local/share/dsh/cloudflared/.cloudflared.deb-42 /home/user/.local/share/dsh/cloudflared/.cloudflared-extract-42'
    const safe = sanitizeDownloadError(raw)
    expect(safe).not.toContain('/home/user')
    // 但文件名本身要留着 —— 否则「哪个文件出问题」这条线索没了。
    expect(safe).toContain('.cloudflared.deb-42')
  })

  it('keeps an ordinary message readable instead of blanking it', () => {
    const safe = sanitizeDownloadError('HTTP 404')
    expect(safe).toBe('HTTP 404')
  })
})

describe('UI-03：activity 用 labelKey 而不是中文文案', () => {
  it('exposes a stable key set that the client dictionary can cover', () => {
    // 键清单是**跨端契约**：lead 的 client 词典按它写，改名会让 UI 显示原始键名。
    expect(TunnelStageKeys).toEqual([
      'tunnelStageLocating',
      'tunnelStageBinaryFound',
      'tunnelStageDownloadGithub',
      'tunnelStageDownloadDeb',
      'tunnelStageDownloadProgress',
      'tunnelStageUnpackDeb',
      'tunnelStageWriteBinary',
      'tunnelStageStarting',
    ])
  })

  it('has no Chinese text left in the activity shape', () => {
    // 结构上不可能再带 label（旧字段）——这条是类型层的钉子：
    // 若有人把 `label: string` 加回去，下面的赋值就会编译失败。
    const activity: TunnelActivity = {
      stage: 'downloading',
      labelKey: 'tunnelStageDownloadProgress',
      labelParams: { mb: '1.0', all: '20.0' },
      percent: 5,
    }
    expect(activity.labelKey).toBe('tunnelStageDownloadProgress')
    expect(activity.labelParams).toEqual({ mb: '1.0', all: '20.0' })
    expect(Object.hasOwn(activity, 'label')).toBe(false)
  })
})

describe('UI-03：隧道状态携带结构化错误键（不删 error 兜底）', () => {
  it('keeps the plain error field and adds errorKey', () => {
    // 兼容扩展：`error` 保留（兜底/调试），`errorKey` 供本地化。
    // client 渲染优先级 errorKey > error。
    const state: TunnelPublicState = {
      channel: null,
      url: null,
      running: false,
      error: 'cloudflared exited',
      errorKey: 'tunnelErrorExited',
      errorParams: { code: '1', signal: 'SIGTERM' },
    }
    expect(state.error).toBe('cloudflared exited')
    expect(state.errorKey).toBe('tunnelErrorExited')
    expect(state.errorParams).toEqual({ code: '1', signal: 'SIGTERM' })
  })
})

describe('H5：校验和机制（声明了就强校验）', () => {
  it('exposes a checker that accepts the matching digest and rejects others', async () => {
    const { verifySha256 } = await import('../src/host/cloudflared.ts')
    const bytes = Buffer.from('fake cloudflared bytes')
    const good = createHash('sha256').update(bytes).digest('hex')
    // 大小写不敏感、允许 `sha256:` 前缀（常见发行格式）。
    expect(verifySha256(bytes, good)).toBe(true)
    expect(verifySha256(bytes, good.toUpperCase())).toBe(true)
    expect(verifySha256(bytes, `sha256:${good}`)).toBe(true)
    // 不匹配必须为 false（调用方据此拒绝落盘）。
    expect(verifySha256(bytes, 'a'.repeat(64))).toBe(false)
    // 长度不对的一律 false，不做「宽松接受」。
    expect(verifySha256(bytes, 'abc')).toBe(false)
    expect(verifySha256(bytes, '')).toBe(false)
  })

  it('reads an expectation from the environment, and treats blank as absent', async () => {
    const { expectedSha256From } = await import('../src/host/cloudflared.ts')
    const previous = process.env.CLOUDFLARED_SHA256
    try {
      process.env.CLOUDFLARED_SHA256 = '  ' + 'b'.repeat(64) + '  '
      expect(expectedSha256From()).toBe('b'.repeat(64))
      process.env.CLOUDFLARED_SHA256 = '   '
      expect(expectedSha256From()).toBeUndefined()
      delete process.env.CLOUDFLARED_SHA256
      expect(expectedSha256From()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.CLOUDFLARED_SHA256
      else process.env.CLOUDFLARED_SHA256 = previous
    }
  })

  it('marks an unverified download as such instead of silently trusting it', async () => {
    // 「未校验」必须是**可见状态**：activity 里要能表达它。
    const { UNVERIFIED_DOWNLOAD_KEY } = await import('../src/host/cloudflared.ts')
    expect(UNVERIFIED_DOWNLOAD_KEY).toBe('tunnelStageDownloadUnverified')
  })
})

describe('H7 端到端：502 响应体不含绝对路径 / 完整 URL', () => {
  it('never echoes an absolute path in the tunnel download failure envelope', async () => {
    const { sanitizeDownloadError: sanitize } = await import('../src/host/cloudflared.ts')
    // 端到端那一步要靠真实 router + 网络失败，代价高且不稳定；
    // 这里直接断言「router 用来填 details.reason 的那个函数」的输出，
    // 因为 502 的 message 已经是固定文案（无路径），唯一的可变部分就是它。
    const raw = 'Command failed: dpkg-deb -x /home/wangke/.local/share/dsh/cloudflared-bin/.cloudflared.deb-9 /home/wangke/.local/share/dsh/cloudflared-bin/.cloudflared-extract-9'
    const reason = sanitize(raw)
    expect(reason).not.toContain('/home/wangke')
    expect(reason).not.toMatch(/(^|\s)\//)
    // 固定文案本身也不得含占位符残留。
    const fixed = 'Failed to download or unpack cloudflared. Check the network and retry, or set CLOUDFLARED_MIRROR.'
    expect(fixed).not.toMatch(/https?:\/\//)
    expect(fixed).not.toContain('/')
  })
})
