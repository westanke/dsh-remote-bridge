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

describe('approval REST contract', () => {
  it('lists redacted approvals and accepts only explicit one-shot outcomes', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-approval-api-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const auth = new AuthService(database)
    const events = new WorkspaceEventBus()
    const files = new FileService(database, event => events.emit(event))
    const decisions: unknown[] = []
    const chat = {
      listPendingApprovals: async (_principal: unknown, sessionId: string) => [{
        id: 'approval-1',
        sessionId,
        toolName: 'bash',
        reason: 'danger-full-access',
        detail: 'echo [REDACTED]',
        risk: 'full-access' as const,
        requestedAt: 1,
      }],
      decideApproval: async (_principal: unknown, sessionId: string, approvalId: string, outcome: string) => {
        decisions.push({ sessionId, approvalId, outcome })
        return {
          id: approvalId,
          sessionId,
          toolName: 'bash',
          risk: 'full-access' as const,
          requestedAt: 1,
        }
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
      const listed = await fetch(`${baseUrl}/chat/sessions/session-1/approvals`, { headers })
      expect(listed.status).toBe(200)
      const listedText = await listed.text()
      expect(listedText).toContain('approval-1')
      expect(listedText).toContain('[REDACTED]')
      expect(listedText).not.toContain('rpcId')

      const invalid = await fetch(`${baseUrl}/chat/sessions/session-1/approvals/approval-1/decision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ outcome: 'always-allow' }),
      })
      expect(invalid.status).toBe(400)
      await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'BODY_INVALID' } })

      const accepted = await fetch(`${baseUrl}/chat/sessions/session-1/approvals/approval-1/decision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ outcome: 'allowed-once' }),
      })
      expect(accepted.status).toBe(202)
      await expect(accepted.json()).resolves.toEqual({ accepted: true })
      expect(decisions).toEqual([{
        sessionId: 'session-1',
        approvalId: 'approval-1',
        outcome: 'allowed-once',
      }])
      expect(database.listAudit()).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'chat.approval.decide' }),
      ]))
      expect(JSON.stringify(database.listAudit())).not.toContain('danger-full-access')
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
