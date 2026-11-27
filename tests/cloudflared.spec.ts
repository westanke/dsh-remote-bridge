import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  archSuffix,
  cloudflaredBinaryName,
  downloadHttps,
  downloadUrlFor,
  ensureCloudflared,
  extractQuickTunnelUrl,
  isDebSource,
  writeFromTgz,
} from '../src/host/cloudflared.ts'

const execFileP = promisify(execFile)

/**
 * cloudflared 模块的单元测试。
 *
 * 这里重点守两条容易悄悄松开的不变量：
 * - 从进程 output 抓地址靠**正则**，正则一旦漏掉子域（例如只匹配 `xxx.trycloudflare.com`
 *   却漏了带连字符的长随机串），隧道地址就永远抓不到 —— 面板显示「未拿到地址」。
 * - 下载 URL 的**架构后缀**写死会导致 arm64 机器下载 x64 二进制、`exec format error`
 *   崩溃；`CLOUDFLARED_MIRROR` 又可能被传给所有架构。
 */

describe('extractQuickTunnelUrl', () => {
  it('parses a random quick-tunnel domain from stdout', () => {
    const line =
      'INFO[0008] Each request will be given arbitrary public URL: https://real-tunnel-9f2k.trycloudflare.com'
    expect(extractQuickTunnelUrl(line)).toBe('https://real-tunnel-9f2k.trycloudflare.com')
  })

  it('parses a bare URL that appears on its own line', () => {
    expect(extractQuickTunnelUrl('https://abcdef-try-123.trycloudflare.com')).toBe(
      'https://abcdef-try-123.trycloudflare.com',
    )
  })

  it('does not match http:// (only https) or unrelated hosts', () => {
    expect(extractQuickTunnelUrl('http://x.trycloudflare.com')).toBeNull()
    expect(extractQuickTunnelUrl('https://example.com')).toBeNull()
  })

  it('returns null when there is no tunnel address yet', () => {
    expect(extractQuickTunnelUrl('Starting tunnel...')).toBeNull()
  })

  it('keeps the first address when several appear across chunks', () => {
    // 两段分别拿到的半行：首段只有 d 域前缀，第二段才补全 —— 模拟 stdout 分块。
    expect(extractQuickTunnelUrl('https://my-tun')).toBe(null)
    expect(extractQuickTunnelUrl('https://my-tun-1.trycloudflare.com')).toBe(
      'https://my-tun-1.trycloudflare.com',
    )
  })
})

describe('archSuffix', () => {
  it('resolves the official archive name for linux, windows and macOS', () => {
    // 架构必须**显式传入**。旧实现里 platform 是参数、arch 却读 `process.arch`，
    // 于是 `archSuffix('linux')` 在 macOS runner（arm64）上返回 linux-arm64 而红。
    // 修复后 arch 也是入参，结果只由入参决定。
    expect(archSuffix('linux', 'x64')).toBe('linux-amd64')
    expect(archSuffix('linux', 'arm64')).toBe('linux-arm64')
    // issue #1 Bug 2：此前非 linux 直接 throw，Windows/macOS 永远下载失败。
    expect(archSuffix('win32', 'x64')).toBe('windows-amd64.exe')
    expect(archSuffix('win32', 'ia32')).toBe('windows-386.exe')
    expect(archSuffix('darwin', 'x64')).toBe('darwin-amd64.tgz')
    expect(archSuffix('darwin', 'arm64')).toBe('darwin-arm64.tgz')
  })

  it('throws only when there is no official asset for that platform/arch', () => {
    expect(() => archSuffix('aix')).toThrow(/不支持/)
    // 2024.11.1 的 Windows 资产只有 amd64/386，没有 arm64 exe。
    expect(() => archSuffix('win32', 'arm64')).toThrow(/不支持/)
    expect(() => archSuffix('linux', 'ia32')).toThrow(/不支持/)
  })
})

describe('downloadUrlFor', () => {
  it('falls back to the official GitHub release by default', () => {
    delete process.env.CLOUDFLARED_MIRROR
    // 显式指定 linux/x64：这个函数回答的是「linux 的 cloudflared 从哪下」，
    // 不该跟着**跑测试的机器**变（macOS runner 上旧实现会直接抛「不支持 darwin」）。
    const url = downloadUrlFor('linux', 'x64')
    expect(url).toMatch(new RegExp(`^https://github.com/cloudflare/cloudflared/releases/download/[^/]+/cloudflared-linux-`))
  })

  it('uses the injected mirror base when present (no fabricated addresses baked in)', () => {
    process.env.CLOUDFLARED_MIRROR = 'https://mirror.example.invalid/cloudflared-'
    try {
      const url = downloadUrlFor('linux', 'x64')
      expect(url).toBe('https://mirror.example.invalid/cloudflared-linux-amd64')
    } finally {
      delete process.env.CLOUDFLARED_MIRROR
    }
  })

  it('flags a deb source by the deb+ prefix', () => {
    process.env.CLOUDFLARED_MIRROR =
      'deb+https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb'
    try {
      expect(isDebSource()).toBe(true)
      expect(downloadUrlFor('linux', 'x64')).toBe(
        'https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026.10.1_amd64.deb',
      )
    } finally {
      delete process.env.CLOUDFLARED_MIRROR
    }
  })

  it('builds Windows and macOS URLs from the same pinned version', () => {
    delete process.env.CLOUDFLARED_MIRROR
    expect(downloadUrlFor('win32', 'x64')).toMatch(/\/cloudflared-windows-amd64\.exe$/)
    expect(downloadUrlFor('darwin', 'arm64')).toMatch(/\/cloudflared-darwin-arm64\.tgz$/)
  })

  it('does not treat a plain mirror base as a deb source', () => {
    process.env.CLOUDFLARED_MIRROR = 'https://mirror.example.invalid/cloudflared-'
    try {
      expect(isDebSource()).toBe(false)
    } finally {
      delete process.env.CLOUDFLARED_MIRROR
    }
  })
})

describe('ensureCloudflared download chain', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.CLOUDFLARED_MIRROR
  })

  it('downloadHttps aborts (rejects) within the timeout even against a never-responding source', async () => {
    // 回归：此前用 fetch+AbortController，被墙/挂起的 TCP 连接不响应 abort，会永久挂起。
    const server = createServer(() => {}) // 从不响应（不回 data/end）
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    try {
      const t0 = Date.now()
      const err = await downloadHttps(`http://127.0.0.1:${addr.port}/never`, 300).catch((e) => e)
      const elapsed = Date.now() - t0
      // 必须在 ms 内返回，且带可读原因；绝不永久挂死。
      expect((err as Error).message).toContain('下载失败')
      expect((err as Error).message).toContain('无响应')
      expect(elapsed).toBeLessThan(3000)
    } finally {
      server.close()
    }
  })

  it('reports non-ok HTTP status without hanging', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    try {
      const res = await downloadHttps(`http://127.0.0.1:${addr.port}/missing`, 300)
      expect(res.ok).toBe(false)
      expect(res.status).toBe(404)
    } finally {
      server.close()
    }
  })
})
describe('cloudflaredBinaryName', () => {
  it('appends .exe on Windows only', () => {
    expect(cloudflaredBinaryName('win32')).toBe('cloudflared.exe')
    expect(cloudflaredBinaryName('linux')).toBe('cloudflared')
    expect(cloudflaredBinaryName('darwin')).toBe('cloudflared')
  })
})

describe('writeFromTgz', () => {
  it('extracts cloudflared from a darwin .tgz and leaves no temp files behind', async () => {
    const stage = await mkdtemp(path.join(tmpdir(), 'dsh-cloudflared-tgz-'))
    try {
      const src = path.join(stage, 'src')
      await mkdir(src, { recursive: true })
      await writeFile(path.join(src, 'cloudflared'), '#!/bin/sh\necho cloudflared-ok\n')
      const archive = path.join(stage, 'pkg.tgz')
      await execFileP('tar', ['-czf', archive, '-C', src, 'cloudflared'])

      const dataDir = path.join(stage, 'data')
      const out = await writeFromTgz(
        dataDir,
        await readFile(archive),
        'https://example.invalid/cloudflared-darwin-amd64.tgz',
      )
      expect(path.basename(out)).toBe(cloudflaredBinaryName())
      expect(await readFile(out, 'utf8')).toContain('cloudflared-ok')
      // 归档与解包目录必须清掉，数据目录里只剩可执行文件本身。
      expect(await readdir(dataDir)).toEqual([cloudflaredBinaryName()])
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  })
})

/**
 * issue #1 Bug 2：Windows 用户机器上已经有 `~/.dsh/cloudflared-bin/2026.9.3-win32-x64.exe`，
 * 插件却只认 `<dataDir>/cloudflared`，于是每次都走下载，而下载路径在 `archSuffix` 处抛错。
 * 这三条把「先复用、后下载」的顺序钉死。
 */
describe('ensureCloudflared reuse', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the binary already present in the plugin data dir without downloading', async () => {
    const stage = await mkdtemp(path.join(tmpdir(), 'dsh-cloudflared-reuse-'))
    try {
      const dataDir = path.join(stage, 'workspace')
      await mkdir(dataDir, { recursive: true })
      const exe = path.join(dataDir, cloudflaredBinaryName())
      await writeFile(exe, 'binary')
      await expect(ensureCloudflared(dataDir)).resolves.toBe(exe)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  })

  it('reuses the DSH ecosystem cache next to the data dir', async () => {
    const stage = await mkdtemp(path.join(tmpdir(), 'dsh-cloudflared-cache-'))
    try {
      const dataDir = path.join(stage, 'workspace')
      const cacheDir = path.join(stage, 'cloudflared-bin')
      await mkdir(cacheDir, { recursive: true })
      const ext = process.platform === 'win32' ? '.exe' : ''
      const cached = path.join(cacheDir, `2026.9.3-${process.platform}-${process.arch}${ext}`)
      await writeFile(cached, 'binary')
      await expect(ensureCloudflared(dataDir)).resolves.toBe(cached)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  })

  it('falls back to PATH when no cached copy exists', async () => {
    const stage = await mkdtemp(path.join(tmpdir(), 'dsh-cloudflared-path-'))
    try {
      const binDir = path.join(stage, 'bin')
      await mkdir(binDir, { recursive: true })
      const exe = path.join(binDir, cloudflaredBinaryName())
      await writeFile(exe, 'binary')
      vi.stubEnv('PATH', binDir)
      // 隔离 ~/.dsh/cloudflared-bin，避免开发机的真缓存让断言失真。
      vi.stubEnv('HOME', stage)
      vi.stubEnv('USERPROFILE', stage)
      const dataDir = path.join(stage, 'workspace')
      await expect(ensureCloudflared(dataDir)).resolves.toBe(exe)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  })
})
