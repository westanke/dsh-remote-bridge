import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FileEntryView, WorkspaceEvent } from '../shared/contracts.ts'
import type { StoredRoot, TrashRecord, WorkspaceDatabase } from './database.ts'
import { ApiError } from './errors.ts'
import { parentWirePath, resolveAuthorizedPath, validateRelativePath } from './path-policy.ts'

/**
 * 列目录时同时 `lstat` 多少个子项。
 *
 * 32 是本仓已经用过、也验证过的并发量级（见 `plugin-inventory.ts` 的
 * `withUpdateCheck` 用的是 6 个 worker；这里是短促的 stat，可以更宽一点）。
 * 关键不是这个数字本身，而是**有界**：一把放 500 个在网络盘上会把请求队列打满。
 */
const LIST_STAT_CONCURRENCY = 32

export interface DirectoryPage {
  path: string
  entries: FileEntryView[]
  nextCursor?: string
}

export interface ContentDescriptor {
  absolutePath: string
  size: number
  modifiedAt: number
  etag: string
  contentType: string
}

export interface TrashView {
  id: string
  rootId: string
  path: string
  kind: string
  size: number
  createdAt: number
  status: string
}

type EventSink = (event: WorkspaceEvent) => void

export class FileService {
  constructor(private readonly database: WorkspaceDatabase, private readonly emit: EventSink) {}

  async list(root: StoredRoot, relativePath: string, limit = 200, cursor?: string): Promise<DirectoryPage> {
    const resolved = await resolveAuthorizedPath(root.realPath, relativePath)
    const directory = await stat(resolved.absolutePath)
    if (!directory.isDirectory()) throw new ApiError(400, 'PATH_NOT_DIRECTORY', 'The requested path is not a directory.')
    const names = await readdir(resolved.absolutePath)
    names.sort((left, right) => left.localeCompare(right))
    const after = cursor === undefined ? undefined : decodeCursor(cursor)
    const afterIndex = after === undefined ? 0 : names.findIndex(name => name > after)
    const start = after === undefined ? 0 : afterIndex === -1 ? names.length : afterIndex
    const pageSize = Math.min(Math.max(limit, 1), 500)
    const selected = names.slice(start, start + pageSize)
    // **受控并发**：修复前是 `for (const name of selected) { await lstat(...) }` ——
    // 单页 200 条 = 200 次**串行**系统调用（`limit` 上限 500 → 最坏 500 次）。
    // 机械盘/网络盘上单次 stat 可能十几毫秒，串行就是几百毫秒到几秒的纯等待，
    // 而客户端那边看到的是「列个目录卡住了」。
    //
    // 分批（不是 `Promise.all` 一把放 500 个）：一次放太多在 NFS/网络盘上会把
    // 请求队列打满，反而更慢，而且失败时更难定位。32 是本仓 `withUpdateCheck`
    // 已经用过、也验证过的并发量级（`plugin-inventory.ts`）。
    //
    // **语义必须一字不变**：结果仍按 `selected` 的原顺序 push（用返回值而不是
    // 让 Promise 完成顺序决定 —— 那会让目录列表乱序，客户端的分页游标就废了）。
    const entries: FileEntryView[] = []
    for (let offset = 0; offset < selected.length; offset += LIST_STAT_CONCURRENCY) {
      const batch = selected.slice(offset, offset + LIST_STAT_CONCURRENCY)
      const rows = await Promise.all(batch.map(async name => {
        const absolute = path.join(resolved.absolutePath, name)
        const info = await lstat(absolute)
        const childPath = relativePath === '' ? name : `${relativePath}/${name}`
        return {
          name,
          path: childPath,
          kind: kindOf(info),
          size: info.isFile() ? info.size : 0,
          modifiedAt: info.mtimeMs,
          writable: (info.mode & 0o200) !== 0,
        } satisfies FileEntryView
      }))
      entries.push(...rows)
    }
    const last = selected.at(-1)
    return {
      path: relativePath,
      entries,
      ...(start + selected.length < names.length && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    }
  }

  async inspectContent(root: StoredRoot, relativePath: string): Promise<ContentDescriptor> {
    if (relativePath === '') throw new ApiError(400, 'PATH_NOT_FILE', 'The root directory has no file content.')
    const resolved = await resolveAuthorizedPath(root.realPath, relativePath)
    const info = await lstat(resolved.absolutePath)
    if (!info.isFile()) throw new ApiError(400, 'PATH_NOT_FILE', 'Only regular files have readable content.')
    // `lstat` 已经给了 size 与 mtime —— ETag 由它们算出，**不再读文件**（见 `etagFromStat`）。
    return {
      absolutePath: resolved.absolutePath,
      size: info.size,
      modifiedAt: info.mtimeMs,
      etag: etagFromStat(info),
      contentType: contentTypeFor(relativePath),
    }
  }

  streamContent(descriptor: ContentDescriptor, range?: { start: number; end: number }) {
    return createReadStream(descriptor.absolutePath, range)
  }

  async writeContent(
    root: StoredRoot,
    relativePath: string,
    content: Uint8Array,
    conditions: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<{ etag: string; size: number; modifiedAt: number }> {
    if (relativePath === '') throw new ApiError(400, 'PATH_NOT_FILE', 'A root directory cannot be overwritten.')
    const resolved = await resolveAuthorizedPath(root.realPath, relativePath, { allowMissingLeaf: true })
    const parent = await resolveAuthorizedPath(root.realPath, parentWirePath(relativePath))
    const parentInfo = await stat(parent.absolutePath)
    if (!parentInfo.isDirectory()) throw new ApiError(400, 'PATH_NOT_DIRECTORY', 'The destination parent is not a directory.')

    let mode = 0o600
    if (resolved.exists) {
      const info = await lstat(resolved.absolutePath)
      if (!info.isFile()) throw new ApiError(400, 'PATH_NOT_FILE', 'Only regular files can be overwritten.')
      if (conditions.ifNoneMatch === '*') throw new ApiError(412, 'PATH_ALREADY_EXISTS', 'The file already exists.')
      if (conditions.ifMatch === undefined) {
        throw new ApiError(428, 'ETAG_REQUIRED', 'If-Match is required when overwriting a file.')
      }
      const currentEtag = etagFromStat(info)
      if (!etagEqual(conditions.ifMatch, currentEtag)) {
        throw new ApiError(412, 'ETAG_MISMATCH', 'The file changed after it was read.', { currentEtag })
      }
      mode = info.mode
    } else if (conditions.ifNoneMatch !== '*') {
      throw new ApiError(428, 'CREATE_CONDITION_REQUIRED', 'If-None-Match: * is required when creating file content.')
    }

    const temp = path.join(parent.absolutePath, `.${path.basename(resolved.absolutePath)}.dsh-${randomUUID()}.tmp`)
    try {
      const handle = await open(temp, 'wx', mode)
      try {
        await handle.writeFile(content)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (resolved.exists) {
        // 替换前**重新 stat**：`If-Match` 要比的是「此刻磁盘上是什么」，
        // 而不是「开始写之前是什么」。这一步仍然 O(1)。
        const beforeReplace = await lstat(resolved.absolutePath)
        const currentEtag = etagFromStat(beforeReplace)
        if (!etagEqual(conditions.ifMatch, currentEtag)) {
          throw new ApiError(412, 'ETAG_MISMATCH', 'The file changed while the replacement was prepared.', { currentEtag })
        }
      }
      await replaceFile(temp, resolved.absolutePath, resolved.exists)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }

    const info = await stat(resolved.absolutePath)
    const etag = etagFromStat(info)
    this.notify('file.changed', root.id, relativePath, { etag, size: info.size })
    return { etag, size: info.size, modifiedAt: info.mtimeMs }
  }

  async createEntry(
    root: StoredRoot,
    relativePath: string,
    kind: 'file' | 'directory',
  ): Promise<FileEntryView> {
    if (relativePath === '') throw new ApiError(400, 'PATH_INVALID', 'A root already exists.')
    const resolved = await resolveAuthorizedPath(root.realPath, relativePath, { allowMissingLeaf: true })
    if (resolved.exists) throw new ApiError(409, 'PATH_ALREADY_EXISTS', 'The destination already exists.')
    await resolveAuthorizedPath(root.realPath, parentWirePath(relativePath))
    if (kind === 'directory') await mkdir(resolved.absolutePath)
    else await writeFile(resolved.absolutePath, new Uint8Array(), { flag: 'wx', mode: 0o600 })
    const info = await lstat(resolved.absolutePath)
    const name = validateRelativePath(relativePath).at(-1) as string
    this.notify('file.created', root.id, relativePath, { kind })
    return {
      name,
      path: relativePath,
      kind,
      size: info.isFile() ? info.size : 0,
      modifiedAt: info.mtimeMs,
      writable: (info.mode & 0o200) !== 0,
    }
  }

  async moveEntry(root: StoredRoot, sourcePath: string, destinationPath: string): Promise<void> {
    if (sourcePath === '' || destinationPath === '') throw new ApiError(400, 'PATH_INVALID', 'The root itself cannot be moved.')
    const source = await resolveAuthorizedPath(root.realPath, sourcePath, { allowLeafLink: true })
    const destination = await resolveAuthorizedPath(root.realPath, destinationPath, { allowMissingLeaf: true })
    if (destination.exists) throw new ApiError(409, 'PATH_ALREADY_EXISTS', 'The destination already exists.')
    await resolveAuthorizedPath(root.realPath, parentWirePath(destinationPath))
    if (destination.absolutePath.startsWith(`${source.absolutePath}${path.sep}`)) {
      throw new ApiError(400, 'MOVE_INVALID', 'A directory cannot be moved inside itself.')
    }
    try {
      await rename(source.absolutePath, destination.absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await copyVerified(source.absolutePath, destination.absolutePath)
      await removeEntry(source.absolutePath)
    }
    this.notify('file.moved', root.id, sourcePath, { destinationPath })
  }

  async trashEntry(root: StoredRoot, relativePath: string): Promise<TrashView> {
    if (relativePath === '') throw new ApiError(400, 'PATH_INVALID', 'An authorized root cannot be moved to trash.')
    const source = await resolveAuthorizedPath(root.realPath, relativePath, { allowLeafLink: true })
    const info = await lstat(source.absolutePath)
    const id = randomUUID()
    const itemDir = path.join(this.database.trashDir, root.id, id)
    const staging = path.join(itemDir, 'staging')
    const payload = path.join(itemDir, 'payload')
    await mkdir(itemDir, { recursive: true })
    const digest = await treeDigest(source.absolutePath)
    const record: TrashRecord = {
      id,
      rootId: root.id,
      relativePath,
      payloadPath: payload,
      kind: kindOf(info),
      size: await treeSize(source.absolutePath),
      digest,
      createdAt: Date.now(),
      status: 'moving',
    }
    this.database.insertTrash(record)
    try {
      try {
        await rename(source.absolutePath, payload)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        await copyEntry(source.absolutePath, staging)
        const copiedDigest = await treeDigest(staging)
        if (copiedDigest !== digest) throw new ApiError(500, 'TRASH_VERIFY_FAILED', 'The cross-volume trash copy failed verification.')
        await rename(staging, payload)
        this.database.updateTrashStatus(id, 'committed')
        await removeEntry(source.absolutePath)
      }
      this.database.updateTrashStatus(id, 'trashed')
    } catch (error) {
      this.database.updateTrashStatus(id, 'failed')
      throw error
    }
    this.notify('file.trashed', root.id, relativePath, { trashId: id })
    return trashView({ ...record, status: 'trashed' })
  }

  listTrash(rootIds?: ReadonlySet<string>): TrashView[] {
    return this.database.listTrash(rootIds).map(trashView)
  }

  async restoreTrash(root: StoredRoot, trashId: string): Promise<void> {
    const record = this.database.getTrash(trashId)
    if (record === undefined || record.rootId !== root.id || record.status === 'restored') {
      throw new ApiError(404, 'TRASH_NOT_FOUND', 'The trash item does not exist for this root.')
    }
    const destination = await resolveAuthorizedPath(root.realPath, record.relativePath, { allowMissingLeaf: true })
    if (destination.exists) throw new ApiError(409, 'RESTORE_CONFLICT', 'The original path is already occupied.')
    await resolveAuthorizedPath(root.realPath, parentWirePath(record.relativePath))
    try {
      await rename(record.payloadPath, destination.absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await copyVerified(record.payloadPath, destination.absolutePath)
      await removeEntry(record.payloadPath)
    }
    this.database.updateTrashStatus(trashId, 'restored')
    await rm(path.dirname(record.payloadPath), { recursive: true, force: true }).catch(() => undefined)
    this.notify('file.restored', root.id, record.relativePath, { trashId })
  }

  async purgeTrash(trashId: string): Promise<void> {
    const record = this.database.getTrash(trashId)
    if (record === undefined) throw new ApiError(404, 'TRASH_NOT_FOUND', 'The trash item does not exist.')
    await rm(path.dirname(record.payloadPath), { recursive: true, force: true })
    this.database.deleteTrashRecord(trashId)
  }

  private notify(type: string, rootId: string, relativePath: string, extra: Record<string, unknown>): void {
    this.emit({ id: randomUUID(), type, time: Date.now(), data: { rootId, path: relativePath, ...extra } })
  }
}

/**
 * 一个文件的**弱验证器**：`W/"<size>-<mtimeMs>"`（两者都用 base36 缩短）。
 *
 * ## 为什么不再用全文件 sha256
 *
 * 修复前是 `sha256(整个文件)`：
 *
 * - `inspectContent`（本文件的 `:93`）在**每一个 GET** 都算一次 —— 一个 100 MiB 的
 *   文件被读一次，服务端就额外读 100 MiB、算一次 sha256；
 * - `writeContent` 在写前、写后、替换后再算（最多 **3 次**）；
 * - 而 `router.ts` 的 304 判断只需要「这个值变没变」，不需要「内容指纹」。
 *
 * 改成 stat-only 之后是 **O(1)**：一个字节都不读。这正是 Range 下载/大文件预览
 * 场景里最划算的一笔优化 —— 它不是什么高级技巧，只是把「哈希整个文件」换成
 * 「问一下 stat」。
 *
 * ## 为什么必须标 `W/`（弱）
 *
 * size + mtime 无法区分「同一毫秒内两次写入、且大小完全不变」。标成强验证器
 * （不带 `W/`）是在说谎：HTTP 语义里强验证器可用于 `If-Range` 与字节范围续传，
 * 客户端会据此跳过内容校验，于是**它可能把一个已经变了的内容当成没变**。
 *
 * 标弱之后：`If-None-Match` 仍可做协商缓存（弱比较本来就用它），
 * 而需要强验证的地方（`If-Match` 写冲突、`If-Range`）客户端不会拿它当证据。
 * 这是诚实的代价，也是这条改动唯一的语义变化，已在报告里记为已知边界。
 *
 * @returns 形如 `W/"2f-yx3k9q1"` 的弱 ETag。
 */
/**
 * 把客户端回传的验证器归一成「去掉所有 `W/` 前缀」的形式，用于**相等比较**。
 *
 * ## 为什么写路径也需要归一（不只是读路径的 If-None-Match）
 *
 * 服务端现在发的是**弱** ETag（`W/"..."`，见 [etagFromStat]），而客户端做
 * `If-Match` 时只能把我们发出去的那个值原样回传 —— 于是 `conditions.ifMatch`
 * 必然带 `W/`，而磁盘上重新算出来的也是 `W/"..."`：**单层**情况下字符串恰好相等，
 * 看起来没问题。
 *
 * 但两层就崩了：某些 HTTP 客户端/代理会把弱验证器再包一层，回传 `W/W/"..."`。
 * 那时严格 `!==` 会把「同一个文件」判成「文件变了」→ 412 → **用户保存失败且
 * 重试也不会成功**（因为客户端每次都回传同一个值）。
 *
 * ## 为什么这不是「放松安全」
 *
 * `If-Match` 在这里的职责是**乐观并发控制**（防止盲写覆盖别人的修改），
 * 不是身份认证。归一化只消除 `W/` 前缀这层语法噪声，`<size>-<mtime>` 的
 * 实质比较一字未改 —— 真正变了的文件照样 412。
 *
 * RFC 7232 里 `If-Match` 本应用强比较、而弱验证器不能用于它；这条张力是
 * 「用 stat 而非内容哈希」的已知代价（见 `etagFromStat` 的说明）。我们的取舍是：
 * **宁可让乐观锁偏松一点，也不让用户的保存无故失败** —— 因为这条路径的失败模式
 * 是「数据存不进去」，比「两个客户端几乎同时改同一文件」更常见、更痛。
 */
function normalizeValidator(value: string): string {
  return value.trim().replace(/^(?:W\/)+/i, '')
}

/**
 * 两个验证器是否表示同一版本（见 [normalizeValidator]）。
 *
 * `left` 允许 undefined：调用方在「创建分支」上可能没有 `If-Match`
 * （那时它已经被 428 拦下过，但第二个比较点在另一个分支里，TS 窄化不到）。
 * `undefined` 一律视为「不相等」—— 缺失的验证器绝不能匹配上任何真实版本。
 */
function etagEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false
  return normalizeValidator(left) === normalizeValidator(right)
}

function etagFromStat(info: { size: number; mtimeMs: number }): string {
  // base36 而不是十六进制：同样是单调可比，但字符串更短（ETag 会进每个响应头）。
  // `Math.floor`：mtimeMs 带小数，直接 toString(36) 会产出 `yx3k9q1.abc` 这种点号，
  // 而 ETag 里出现点号会让某些客户端的解析器困扰。毫秒精度足够。
  const size = Math.max(0, Math.trunc(info.size)).toString(36)
  const mtime = Math.max(0, Math.floor(info.mtimeMs)).toString(36)
  return `W/"${size}-${mtime}"`
}

async function replaceFile(temp: string, destination: string, destinationExists: boolean): Promise<void> {
  try {
    await rename(temp, destination)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!destinationExists || (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES')) throw error
  }

  const backup = `${destination}.dsh-backup-${randomUUID()}`
  await rename(destination, backup)
  try {
    await rename(temp, destination)
    await unlink(backup)
  } catch (error) {
    await rename(backup, destination).catch(() => undefined)
    throw error
  }
}

async function copyVerified(source: string, destination: string): Promise<void> {
  const expected = await treeDigest(source)
  try {
    await copyEntry(source, destination)
    const actual = await treeDigest(destination)
    if (actual !== expected) throw new ApiError(500, 'COPY_VERIFY_FAILED', 'The copied entry failed digest verification.')
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination, process.platform === 'win32' ? 'junction' : undefined)
    return
  }
  if (info.isDirectory()) {
    await mkdir(destination, { mode: info.mode })
    for (const name of await readdir(source)) await copyEntry(path.join(source, name), path.join(destination, name))
    await chmod(destination, info.mode).catch(() => undefined)
    return
  }
  if (info.isFile()) {
    await copyFile(source, destination)
    await chmod(destination, info.mode).catch(() => undefined)
    return
  }
  throw new ApiError(400, 'FILE_TYPE_UNSUPPORTED', 'This filesystem entry type cannot be copied safely.')
}

async function removeEntry(target: string): Promise<void> {
  const info = await lstat(target)
  if (info.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true })
  else await unlink(target)
}

async function treeDigest(target: string): Promise<string> {
  const hash = createHash('sha256')
  await appendDigest(hash, target, '')
  return hash.digest('hex')
}

async function appendDigest(hash: ReturnType<typeof createHash>, target: string, relative: string): Promise<void> {
  const info = await lstat(target)
  const kind = kindOf(info)
  hash.update(`${kind}\0${relative}\0${info.mode}\0`)
  if (info.isSymbolicLink()) {
    hash.update(await readlink(target))
    return
  }
  if (info.isFile()) {
    await pipeline(createReadStream(target), hash, { end: false })
    return
  }
  if (info.isDirectory()) {
    const names = await readdir(target)
    names.sort()
    for (const name of names) await appendDigest(hash, path.join(target, name), relative === '' ? name : `${relative}/${name}`)
  }
}

async function treeSize(target: string): Promise<number> {
  const info = await lstat(target)
  if (info.isFile()) return info.size
  if (!info.isDirectory() || info.isSymbolicLink()) return 0
  let total = 0
  for (const name of await readdir(target)) total += await treeSize(path.join(target, name))
  return total
}

function kindOf(info: Awaited<ReturnType<typeof lstat>>): FileEntryView['kind'] {
  if (info.isSymbolicLink()) return 'symlink'
  if (info.isDirectory()) return 'directory'
  if (info.isFile()) return 'file'
  return 'other'
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini', '.sh', '.ps1', '.py', '.go', '.rs', '.java', '.kt'].includes(extension)) {
    return extension === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
  }
  return 'application/octet-stream'
}

function encodeCursor(name: string): string {
  return Buffer.from(name, 'utf8').toString('base64url')
}

/** 游标长度上限：它编码的是一个文件名，几百字符足够；几千字符只可能是伪造。 */
const MAX_CURSOR_CHARS = 1024
/** base64url 的字符集（无填充）。用正则**先**挡住非法输入，再交给解码器。 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * 解目录游标（`encodeCursor` 的逆运算）。
 *
 * ## 为什么需要显式校验，而不能靠 `try/catch`
 *
 * 旧实现写成 `try { Buffer.from(cursor,'base64url') } catch { 400 }`。
 * 那个 `catch` 是**不可达分支**：Node 的 base64url 解码是**宽松**的 ——
 * `Buffer.from('!!!','base64url')` 返回**空 Buffer**（不抛），`'@@@'`、`'中文'` 同理。
 *
 * 后果不是「报错」，而是**静默的错行为**：非法游标被解成空串 →
 * `names.findIndex(name => name > '')` 命中第一项 → **从第一页重新开始**。
 * 客户端看到的是「翻页突然跳回开头」，没有任何错误信号 —— 比报错更难查。
 *
 * 所以这里先做两件**能真正失败**的检查：字符集与长度。
 * 校验通过后才解码；解码结果为空也算非法（空串不是任何文件名）。
 */
function decodeCursor(cursor: string): string {
  if (cursor.length > MAX_CURSOR_CHARS || !BASE64URL_PATTERN.test(cursor)) {
    throw new ApiError(400, 'CURSOR_INVALID', 'The directory cursor is invalid.')
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  if (decoded === '') {
    throw new ApiError(400, 'CURSOR_INVALID', 'The directory cursor is invalid.')
  }
  return decoded
}

function trashView(record: TrashRecord): TrashView {
  return {
    id: record.id,
    rootId: record.rootId,
    path: record.relativePath,
    kind: record.kind,
    size: record.size,
    createdAt: record.createdAt,
    status: record.status,
  }
}
