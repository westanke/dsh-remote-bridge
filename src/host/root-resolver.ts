import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { StoredRoot } from './database.ts'
import { ApiError } from './errors.ts'
import { resolveAuthorizedPath, wireRelative } from './path-policy.ts'

/**
 * 把「服务器上的绝对路径」解析成「它属于哪个授权根、相对路径是什么」。
 *
 * ## 为什么需要它
 *
 * 会话事件里出现的文件路径是**服务器绝对路径**（例如 agent 工具调用里的
 * `data.meta.diffs[].path`）。用户想点开它，但客户端的处境是：
 *
 * - `/api/v1/roots` 只返回 `{ id, label, createdAt }` —— **刻意不含根的绝对路径**
 *   （这是既有的安全设计，不该破坏）；
 * - 于是客户端手里只有「一个绝对路径」和「一个 rootId」，**中间缺的那一环它永远拿不到**。
 *
 * 因此必须由服务端做一次转换。转换的产物**只包含 rootId 与相对路径**，
 * 依然不透露根的绝对路径 —— 安全性没有被削弱。
 *
 * ## 为什么不直接把绝对路径传给 `roots/:id/content`
 *
 * 实测：`GET /api/v1/roots/<id>/content?path=/media/...` 返回 `400 PATH_INVALID`，
 * 接口明确只接受相对路径（`../` 逃逸同样被拦为 400）。所以这条路是封死的，
 * 不是配置问题。
 */

/** 路径落在哪个授权根内。 */
export interface RootMatch {
  rootId: string
  /** 相对该根的 wire 路径（正斜杠分隔）；空串表示根本身。 */
  path: string
}

/**
 * 在授权根集合里找出包含该绝对路径的那一个（**纯字符串匹配，不触碰文件系统**）。
 *
 * 多个根相互嵌套时取**最长**的那个 —— 否则外层根会把内层根下的文件解析成更长的相对路径，
 * 虽然仍能读到同一文件，但会绕过内层根更严格的授权语义。
 *
 * 注意这只是粗筛：字符串前缀相等不代表真实落在根内（根内可能存在指向外部的符号链接）。
 * 真正的安全校验由 [inspectResolvedPath] 经 `resolveAuthorizedPath` 完成。
 */
export function matchAuthorizedRoot(
  absolutePath: string,
  roots: readonly Pick<StoredRoot, 'id' | 'realPath'>[],
): RootMatch | undefined {
  let best: { root: Pick<StoredRoot, 'id' | 'realPath'>; relative: string } | undefined
  for (const root of roots) {
    const relative = wireRelative(root.realPath, absolutePath)
    if (relative === undefined) continue
    if (best === undefined || root.realPath.length > best.root.realPath.length) {
      best = { root, relative }
    }
  }
  return best === undefined ? undefined : { rootId: best.root.id, path: best.relative }
}

/** 解析结果里允许外传的字段 —— 刻意不含任何绝对路径。 */
export interface ResolvedEntry {
  rootId: string
  path: string
  kind: 'file' | 'directory'
  size: number | null
  modifiedAt: number | null
  contentType: string | null
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.kt': 'text/plain',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.yml': 'text/plain',
  '.yaml': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

function contentTypeFor(wirePath: string): string | null {
  return CONTENT_TYPES[path.extname(wirePath).toLowerCase()] ?? null
}

/**
 * 确认该路径确实可访问，并返回可外传的元数据。
 *
 * 安全校验交给 `resolveAuthorizedPath`（它逐段 `lstat` 并拒绝路径中的符号链接），
 * 因此这里既不重复实现校验，也不会因为字符串匹配的局限而放行越界访问。
 *
 * 不存在 → `404 PATH_NOT_FOUND`；目录不会被当成错误（会话里提到的路径可能是目录，
 * 用户点开它远比收到一个 400 更合理）。
 */
export async function inspectResolvedPath(root: StoredRoot, wirePath: string): Promise<ResolvedEntry> {
  const resolved = await resolveAuthorizedPath(root.realPath, wirePath)
  const info = await lstat(resolved.absolutePath)

  if (info.isDirectory()) {
    return {
      rootId: root.id,
      path: wirePath,
      kind: 'directory',
      size: null,
      modifiedAt: info.mtimeMs,
      contentType: null,
    }
  }

  if (!info.isFile()) {
    // 设备文件、FIFO、socket 之类：既不是可读文件也不是目录，如实拒绝。
    throw new ApiError(400, 'PATH_NOT_FILE', 'Only regular files and directories can be resolved.')
  }

  return {
    rootId: root.id,
    path: wirePath,
    kind: 'file',
    size: info.size,
    modifiedAt: info.mtimeMs,
    contentType: contentTypeFor(wirePath),
  }
}
