import { describe, expect, it } from 'vitest'

import { unwrapDsh } from '../src/host/chat-contracts.ts'
import { ApiError } from '../src/host/errors.ts'

function failure(code: string, message = 'boom'): never {
  return { rpcId: 'r', result: { ok: false, error: { code, message } } } as never
}

describe('unwrapDsh error mapping', () => {
  it('rpc/timeout 归一为可重试的 TIMEOUT/504（而不是 400 DSH_RPC_TIMEOUT）', () => {
    try {
      unwrapDsh(failure('rpc/timeout', 'The host did not answer sessions.list within 10000ms.'))
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.status).toBe(504)
      expect(apiError.code).toBe('TIMEOUT')
    }
  })

  it('其它内核错误保持原有映射（not-found → 404 / DSH_ 前缀）', () => {
    try {
      unwrapDsh(failure('session/not-found'))
      throw new Error('should have thrown')
    } catch (error) {
      const apiError = error as ApiError
      expect(apiError.status).toBe(404)
      expect(apiError.code).toBe('DSH_SESSION/NOT_FOUND')
    }
  })
})
