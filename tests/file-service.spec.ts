import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { FileService } from '../src/host/file-service.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe('file service', () => {
  it('creates, saves with ETags, trashes, and restores a file', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-files-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const events: string[] = []
    const files = new FileService(database, event => events.push(event.type))
    try {
      const root = await database.addRoot(base, 'Temporary')
      await files.createEntry(root, 'hello.txt', 'file')
      const empty = await files.inspectContent(root, 'hello.txt')
      const saved = await files.writeContent(root, 'hello.txt', new TextEncoder().encode('hello'), { ifMatch: empty.etag })
      await expect(files.writeContent(root, 'hello.txt', new TextEncoder().encode('stale'), { ifMatch: empty.etag }))
        .rejects.toMatchObject({ code: 'ETAG_MISMATCH' })
      expect(await readFile(path.join(base, 'hello.txt'), 'utf8')).toBe('hello')
      const trash = await files.trashEntry(root, 'hello.txt')
      expect(files.listTrash().map(item => item.id)).toContain(trash.id)
      await files.restoreTrash(root, trash.id)
      expect(await readFile(path.join(base, 'hello.txt'), 'utf8')).toBe('hello')
      expect(saved.etag).not.toBe(empty.etag)
      expect(events).toEqual(expect.arrayContaining(['file.created', 'file.changed', 'file.trashed', 'file.restored']))
    } finally {
      database.close()
    }
  })

  it('preserves a conflicting restore destination', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-restore-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const files = new FileService(database, () => undefined)
    try {
      const root = await database.addRoot(base)
      await writeFile(path.join(base, 'value.txt'), 'old')
      const trash = await files.trashEntry(root, 'value.txt')
      await writeFile(path.join(base, 'value.txt'), 'new')
      await expect(files.restoreTrash(root, trash.id)).rejects.toMatchObject({ code: 'RESTORE_CONFLICT' })
      expect(await readFile(path.join(base, 'value.txt'), 'utf8')).toBe('new')
    } finally {
      database.close()
    }
  })
})

/**
 * 列目录的**受控并发**（PERF-5 后续）。
 *
 * 修复前每个子项一次 `await lstat`，串行：单页 200 条 = 200 次连续系统调用，
 * 上限 500 时最坏 500 次。这些用例钉的不是「更快」（那要基准测试），而是
 * **并发不改变语义** —— 后者才是敢合并这种改动的唯一前提。
 */
describe('directory listing concurrency', () => {
  it('keeps locale-sorted order and pagination cursor stable across batches', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-list-conc-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    const files = new FileService(database, () => undefined)

    // 70 个文件：跨过 32 的批边界，且名字故意乱序写入（排序必须由 list 负责）。
    const names = Array.from({ length: 70 }, (_, index) => `f-${String(69 - index).padStart(3, '0')}.txt`)
    for (const name of names) await writeFile(path.join(project, name), name)

    // 分页大小 25 → 三页，每页都要按 localeCompare 严格递增。
    const first = await files.list(root, '', 25)
    expect(first.entries).toHaveLength(25)
    expect(first.entries.map(entry => entry.name)).toEqual([...names].sort((left, right) => left.localeCompare(right)).slice(0, 25))

    const second = await files.list(root, '', 25, first.nextCursor)
    const third = await files.list(root, '', 25, second.nextCursor)
    const collected = [...first.entries, ...second.entries, ...third.entries].map(entry => entry.name)
    // 不重不漏，且顺序就是全量排序结果。
    expect(collected).toEqual([...names].sort((left, right) => left.localeCompare(right)))
    expect(new Set(collected).size).toBe(70)
    // 最后一页没有游标（到底了）。
    expect(third.nextCursor).toBeUndefined()
  })

  it('reports per-entry metadata that the concurrent stat still provides', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-list-meta-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    const files = new FileService(database, () => undefined)
    await writeFile(path.join(project, 'plain.txt'), 'hello')
    await mkdir(path.join(project, 'subdir'))

    const page = await files.list(root, '', 50)
    const byName = new Map(page.entries.map(entry => [entry.name, entry]))
    expect(byName.get('plain.txt')?.kind).toBe('file')
    expect(byName.get('plain.txt')?.size).toBe(5)
    expect(byName.get('plain.txt')?.modifiedAt).toBeGreaterThan(0)
    // 目录的 size 恒为 0（既有语义），不是「stat 拿不到所以是 0」。
    expect(byName.get('subdir')?.kind).toBe('directory')
    expect(byName.get('subdir')?.size).toBe(0)
  })

  it('surfaces a stat failure for a vanished entry instead of silently skipping it', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-list-race-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    const files = new FileService(database, () => undefined)
    // readdir 与 stat 之间的竞态：条目在列出来之后被删掉。
    // 行为必须是**抛错**（交由上层映射 404/500），而不是静默少一条 ——
    // 静默少一条会让客户端以为文件不存在，而它可能只是被另一个进程挪走了。
    await writeFile(path.join(project, 'gone.txt'), 'x')
    const listing = files.list(root, '', 10)
    await rm(path.join(project, 'gone.txt'), { force: true })
    await expect(listing).rejects.toThrow()
  })
})
