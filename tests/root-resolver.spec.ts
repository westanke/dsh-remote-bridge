import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../src/host/errors.ts'
import { inspectResolvedPath, matchAuthorizedRoot } from '../src/host/root-resolver.ts'

/**
 * 会话中文件路径解析的测试。
 *
 * 这个功能的价值点在于：会话事件里的路径是**服务器绝对路径**，而 `/roots` 刻意不返回
 * 根的绝对路径（既有安全设计）。客户端无法自己完成映射，因此服务端必须提供转换 ——
 * 而转换一旦写错，要么用户点不开文件，要么越权读到根外的内容。两个方向都要测。
 */

const cleanup: string[] = []

afterEach(async () => {
  for (const target of cleanup.splice(0)) await rm(target, { recursive: true, force: true })
})

async function tempDir(prefix = 'daw-resolve-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

describe('matchAuthorizedRoot', () => {
  const roots = [
    { id: 'root-outer', realPath: '/srv/data' },
    { id: 'root-inner', realPath: '/srv/data/project' },
  ]

  it('matches a file inside a single root and returns the wire relative path', () => {
    expect(matchAuthorizedRoot('/srv/data/notes/todo.md', [{ id: 'r1', realPath: '/srv/data' }]))
      .toEqual({ rootId: 'r1', path: 'notes/todo.md' })
  })

  it('returns an empty path for the root directory itself', () => {
    expect(matchAuthorizedRoot('/srv/data', [{ id: 'r1', realPath: '/srv/data' }]))
      .toEqual({ rootId: 'r1', path: '' })
  })

  it('prefers the longest matching root when roots are nested', () => {
    // 外层根也包含这个路径，但必须归给内层根 —— 否则会绕过内层更严格的授权语义。
    expect(matchAuthorizedRoot('/srv/data/project/src/main.kt', roots))
      .toEqual({ rootId: 'root-inner', path: 'src/main.kt' })
  })

  it('falls back to the outer root for paths outside the inner one', () => {
    expect(matchAuthorizedRoot('/srv/data/other/file.txt', roots))
      .toEqual({ rootId: 'root-outer', path: 'other/file.txt' })
  })

  it('rejects a sibling directory sharing the same prefix', () => {
    // 经典漏洞：字符串 startsWith 会把 /srv/database 当成在根 /srv/data 内。
    expect(matchAuthorizedRoot('/srv/database/secret.db', [{ id: 'r1', realPath: '/srv/data' }])).toBeUndefined()
    expect(matchAuthorizedRoot('/srv/data-backup/x', [{ id: 'r1', realPath: '/srv/data' }])).toBeUndefined()
  })

  it('rejects paths that escape the root via parent segments', () => {
    expect(matchAuthorizedRoot('/etc/passwd', [{ id: 'r1', realPath: '/srv/data' }])).toBeUndefined()
  })

  it('returns undefined when no roots are authorized', () => {
    expect(matchAuthorizedRoot('/srv/data/x', [])).toBeUndefined()
  })
})

describe('inspectResolvedPath', () => {
  it('describes a regular file without leaking an absolute path', async () => {
    const root = await tempDir()
    await writeFile(path.join(root, 'readme.md'), '# hello')

    const entry = await inspectResolvedPath({ id: 'r1', realPath: root } as never, 'readme.md')

    expect(entry).toMatchObject({ rootId: 'r1', path: 'readme.md', kind: 'file', contentType: 'text/markdown' })
    expect(entry.size).toBe(7)
    // 返回结构里不能出现绝对路径 —— 这正是本端点的存在前提（/roots 不暴露根路径）。
    expect(JSON.stringify(entry)).not.toContain(root)
  })

  it('treats a directory as a valid resolution rather than an error', async () => {
    // 会话里提到的路径可能是目录，用户点开它远比收到 400 合理。
    const root = await tempDir()
    await mkdir(path.join(root, 'src'))

    const entry = await inspectResolvedPath({ id: 'r1', realPath: root } as never, 'src')

    expect(entry).toMatchObject({ kind: 'directory', size: null, contentType: null })
  })

  it('resolves the root itself as a directory', async () => {
    const root = await tempDir()
    const entry = await inspectResolvedPath({ id: 'r1', realPath: root } as never, '')
    expect(entry).toMatchObject({ kind: 'directory', path: '' })
  })

  it('reports PATH_NOT_FOUND for a missing path', async () => {
    const root = await tempDir()
    await expect(inspectResolvedPath({ id: 'r1', realPath: root } as never, 'nope.txt'))
      .rejects.toMatchObject({ status: 404, code: 'PATH_NOT_FOUND' })
  })

  it('refuses to follow a symlink out of the root', async () => {
    // 字符串前缀匹配会认为 log 在根内；真正的拦截由 resolveAuthorizedPath 完成。
    const root = await tempDir()
    const outside = await tempDir('daw-outside-')
    await writeFile(path.join(outside, 'secret.txt'), 'top secret')
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'log'))

    await expect(inspectResolvedPath({ id: 'r1', realPath: root } as never, 'log'))
      .rejects.toBeInstanceOf(ApiError)
  })

  it('refuses parent-segment escapes', async () => {
    const root = await tempDir()
    await expect(inspectResolvedPath({ id: 'r1', realPath: root } as never, '../etc/hostname'))
      .rejects.toBeInstanceOf(ApiError)
  })
})
