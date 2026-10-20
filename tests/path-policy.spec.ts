import {mkdtemp, mkdir, symlink, writeFile} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../src/host/errors.ts'
import { canonicalRoot, resolveAuthorizedPath, validateRelativePath, wireRelative } from '../src/host/path-policy.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe('authorized path policy', () => {
  it('rejects absolute and traversal wire paths', () => {
    for (const value of ['../secret', 'a/../secret', '/etc/passwd', 'C:/Windows', '\\\\server\\share', 'a\\b', 'a//b']) {
      expect(() => validateRelativePath(value)).toThrow(ApiError)
    }
    expect(validateRelativePath('src/main.ts')).toEqual(['src', 'main.ts'])
    expect(validateRelativePath('')).toEqual([])
  })

  it('resolves a canonical root and reports a wire-relative child', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'daw-path-'))
    cleanup.dir(root)
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {}')
    const canonical = await canonicalRoot(root)
    const resolved = await resolveAuthorizedPath(canonical, 'src/index.ts')
    expect(wireRelative(canonical, resolved.absolutePath)).toBe('src/index.ts')
  })

  it('does not traverse a directory link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'daw-link-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'daw-outside-'))
    cleanup.dir(root, outside)
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    try {
      await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    await expect(resolveAuthorizedPath(await canonicalRoot(root), 'linked/secret.txt')).rejects.toMatchObject({
      code: 'LINK_TRAVERSAL_FORBIDDEN',
    })
  })
})
