import {mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe('slash-command REST contract', () => {
  it('lists and executes host commands without auditing arguments', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-command-api-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const auth = new AuthService(database)
    const events = new WorkspaceEventBus()
    const files = new FileService(database, event => events.emit(event))
    const executions: unknown[] = []
    const chat = {
      listCommands: async (_principal: unknown, sessionId: string) => [{
        name: 'permission',
        description: `Permission for ${sessionId}`,
        input: { hint: 'preset' },
      }],
      executeCommand: async (_principal: unknown, sessionId: string, line: string) => {
        executions.push({ sessionId, line })
        return { commandId: 'permission', result: { kind: 'text', text: 'workspace-write' } }
      },
    }
    const router = new ApiRouter({
      database,
      auth,
      files,
      chat: chat as never,
      settings: {} as never,
      remote: {} as never,
      maxUploadBytes: 1024,
    })
    const server = createServer((req, res) => { void router.handle(req, res) })
    await listen(server)
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    const headers = {
      Origin: 'http://127.0.0.1:3080',
      'X-Dsh-Workspace-Admin': '1',
      'Content-Type': 'application/json',
    }
    try {
      const listed = await fetch(`${baseUrl}/chat/sessions/session%2F1/commands`, { headers })
      expect(listed.status).toBe(200)
      await expect(listed.json()).resolves.toMatchObject({
        items: [{ name: 'permission', input: { hint: 'preset' } }],
      })

      const executed = await fetch(`${baseUrl}/chat/sessions/session%2F1/commands`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ line: '/permission danger-full-access private-argument' }),
      })
      expect(executed.status).toBe(200)
      await expect(executed.json()).resolves.toMatchObject({
        execution: { commandId: 'permission', result: { text: 'workspace-write' } },
      })
      expect(executions).toEqual([{
        sessionId: 'session/1',
        line: '/permission danger-full-access private-argument',
      }])
      const audit = JSON.stringify(database.listAudit())
      expect(audit).toContain('chat.command.execute')
      expect(audit).toContain('permission')
      expect(audit).not.toContain('private-argument')
    } finally {
      await close(server)
      database.close()
    }
  })
})

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
}
