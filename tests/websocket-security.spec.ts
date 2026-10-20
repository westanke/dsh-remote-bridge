import {mkdtemp, mkdir,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { DshSettingsAdapter } from '../src/host/settings-adapter.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe('WebSocket authorization', () => {
  it('applies scopes and live root grants to every event', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-ws-'))
    cleanup.dir(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const root = await database.addRoot(project, 'Project')
    const pairing = database.createPairing([root.id], ['files.read'])
    const credentials = database.exchangePairing(pairing.code, 'Socket device')
    const events = new WorkspaceEventBus()
    const auth = new AuthService(database)
    const files = new FileService(database, event => events.emit(event))
    const chat = new DshChatAdapter(fakeApi() as never, database)
    const settings = new DshSettingsAdapter(fakeApi() as never)
    let router!: ApiRouter
    const remote = new RemoteApiServer({
      port: 0,
      database,
      auth,
      chat,
      events,
      handle: (req, res) => router.handle(req, res),
    })
    router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 })
    try {
      await remote.start()
      const socket = new WebSocket(`ws://127.0.0.1:${remote.status().port}/api/v1/events`, {
        headers: { Authorization: `Bearer ${credentials.token}` },
      })
      const received: { id: string; type: string }[] = []
      socket.on('message', data => { received.push(JSON.parse(data.toString()) as { id: string; type: string }) })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      await waitFor(() => received.some(event => event.type === 'connection.ready'))

      events.emit({ id: 'chat', type: 'chat.delta', time: Date.now(), data: { rootId: root.id } })
      events.emit({ id: 'file', type: 'file.changed', time: Date.now(), data: { rootId: root.id, path: 'a.txt' } })
      await waitFor(() => received.some(event => event.type === 'file.changed'))
      expect(received.map(event => event.type)).not.toContain('chat.delta')

      for (const id of ['ordered-1', 'ordered-2', 'ordered-3']) {
        events.emit({ id, type: 'file.changed', time: Date.now(), data: { rootId: root.id, path: `${id}.txt` } })
      }
      await waitFor(() => received.some(event => event.id === 'ordered-3'))
      expect(received.filter(event => event.id.startsWith('ordered-')).map(event => event.id))
        .toEqual(['ordered-1', 'ordered-2', 'ordered-3'])

      database.updateDevice(credentials.device.id, ['files.read'], [])
      const fileEventCount = received.filter(event => event.type === 'file.changed').length
      events.emit({ id: 'removed', type: 'file.changed', time: Date.now(), data: { rootId: root.id, path: 'b.txt' } })
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(received.filter(event => event.type === 'file.changed')).toHaveLength(fileEventCount)

      const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
      database.revokeDevice(credentials.device.id)
      events.emit({ id: 'revoked', type: 'file.changed', time: Date.now(), data: { rootId: root.id, path: 'c.txt' } })
      await expect(closed).resolves.toBe(4001)
    } finally {
      await remote.stop()
      database.close()
    }
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for a WebSocket event.')
}

function fakeApi() {
  const empty = async function* () { /* no live events in this test */ }
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
    },
    events: { mux: empty, host: empty },
  }
}
