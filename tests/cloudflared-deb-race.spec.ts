import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFromDeb } from '../src/host/cloudflared.ts'

/**
 * writeFromDeb 并发安全（#11）。
 *
 * 真机事故（2026-11-04）：临时文件名只用 pid（`.cloudflared.deb-<pid>`），而插件跑在
 * DSH 主进程内——同一 pid 会并发处理多个 create 请求（客户端超时重试是常态）。
 * 两个解包链路共用同名临时文件时，先完成者的 finally rm 删掉后写者刚落的 deb，
 * dpkg-deb 报「读取归档失败: 没有那个文件或目录」。
 *
 * 测试把 `execFile` mock 成「挂到放行才退出」，锁死真实事故的交错：
 * A 与 B 先后进入解包（dpkg-deb 都挂着）→ 后排队的 B 先放行，走完整个
 * writeFromDeb（写 deb、解包、finally 清理）→ 再放行 A。旧实现下 A 的 deb
 * 与 B 同名，早被 B 的 writeFile 覆盖、finally rm 删走，dpkg-deb 必报
 * 「没有那个文件或目录」；修复后（随机后缀）两条链路互不可见，双双成功。
 * gate 状态收进 vi.hoisted（vi.mock 工厂被提升，不能引用文件顶层变量）。
 * 解包产物在 mock 里直接写出（不依赖真实 deb 结构，网络零依赖）。
 */

const gate = vi.hoisted(() => {
  const waiters: Array<() => void> = []
  return {
    wait: () => new Promise<void>((r) => { waiters.push(r) }),
    release: () => { waiters.pop()?.() }, // LIFO：后排队者先放行（见用例内注释）
    pending: () => waiters.length,
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      file: string,
      args: readonly string[],
      cb: (err: Error | null) => void,
    ) => {
      if (path.basename(file) !== 'dpkg-deb') {
        return actual.execFile(file, args as never, cb)
      }
      void (async () => {
        try {
          await gate.wait()
          // 放行时 deb 必须还在（未被并发者删掉）——本回归的核心断言。
          const debPath = args[1]!
          if (!existsSync(debPath)) {
            cb(new Error(`dpkg-deb: 读取归档 ${debPath} 失败: 没有那个文件或目录`))
            return
          }
          // 解包语义：在 extractDir（args[2]）写出 usr/bin/cloudflared。
          const extractDir = args[2]!
          const binDir = path.join(extractDir, 'usr', 'bin')
          await mkdir(binDir, { recursive: true })
          await writeFile(path.join(binDir, 'cloudflared'), '#!/bin/sh\necho fake-cloudflared\n', { mode: 0o755 })
          cb(null)
        } catch (cause) {
          cb(cause instanceof Error ? cause : new Error(String(cause)))
        }
      })()
      return undefined as never
    },
  }
})

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cloudflared-race-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (gate.pending() > 0) gate.release()
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('writeFromDeb 并发安全（#11）', () => {
  it('concurrent calls with the same pid do not delete each other\'s deb (regression: 读取归档失败)', async () => {
    const dataDir = await scratch()
    const deb = Buffer.from('fake deb bytes; unpacking is mocked')

    // A 先进解包（被 gate 挂住），B 随后也进解包 —— 锁死真实事故的交错。
    const a = writeFromDeb(dataDir, deb, 'http://host:test/mini.deb')
    await vi.waitFor(() => expect(gate.pending()).toBe(1))
    const b = writeFromDeb(dataDir, deb, 'http://host:test/mini.deb')
    await vi.waitFor(() => expect(gate.pending()).toBe(2))

    // LIFO 放行：B 后排队先走完整个流程（含 finally 清理），再放 A ——
    // 旧实现下 A 的 deb 与 B 同名，早被 B 的 writeFile 覆盖、finally rm 删走。
    gate.release() // B
    const bOut = await b
    expect(bOut).toBe(path.join(dataDir, 'cloudflared'))
    gate.release() // A
    const aOut = await a
    expect(aOut).toBe(path.join(dataDir, 'cloudflared'))

    const bin = await readFile(path.join(dataDir, 'cloudflared'), 'utf8')
    expect(bin).toContain('fake-cloudflared')
    // 无临时文件残留。
    const names = await readdir(dataDir)
    expect(names).toEqual(['cloudflared'])
  })

  it('serial call still works (smoke: mock unpacks and binary lands)', async () => {
    const dataDir = await scratch()
    const deb = Buffer.from('fake deb bytes; unpacking is mocked')
    const p = writeFromDeb(dataDir, deb, 'http://host:test/mini.deb')
    await vi.waitFor(() => expect(gate.pending()).toBe(1))
    gate.release()
    await expect(p).resolves.toBe(path.join(dataDir, 'cloudflared'))
    const bin = await readFile(path.join(dataDir, 'cloudflared'), 'utf8')
    expect(bin).toContain('fake-cloudflared')
  })
})
