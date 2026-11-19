/**
 * issue #26 阶段 4：**11 条 delta** 逐条断言 + 门面机检。
 *
 * 为什么逐条写：换源（阶段 3a~3d）之后，桥剩下的全部价值就是这 11 条语义。它们一旦
 * 被悄悄「顺手优化」掉，手机端看到的就是「字段没了」「发图失败」这类没有堆栈的故障。
 * 每条一个用例，名字就是 delta 的名字 —— 删掉哪条，红的就是哪条。
 *
 * 机检（4.4）放在最后：门面上**不得出现内核端点名常量表**。端点名以调用参数出现是
 * 正常的（`invokeRequestEndpoint(..., 'session/list', ...)`），但一旦有人把它们收进
 * 数组/对象常量，就是「桥又开始持有内核 DTO 副本」的信号 —— 那正是这次要消灭的东西。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  agentScopeSkip,
  capacityPatch,
  handoffKeepsMessageDeliverable,
  historyAddress,
  historyPageQuery,
  markProvidersActive,
  pickProjections,
  providerActivity,
  questionAnswerOutcome,
  questionAnswerTerminal,
  stripKernelUnsupportedFields,
  visibleSessionItems,
  withSystemTrust,
} from '../src/host/bridge/kernel-deltas.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FACADE = join(HERE, '..', 'src', 'host', 'dsh-0.2-bridge.ts')

describe('kernel deltas (issue #26 stage 4)', () => {
  it('delta 1 — filters subagent rows out of session/list', () => {
    const rows = [
      { sessionId: 'a', origin: 'user' },
      { sessionId: 'b', origin: 'subagent' },
      { sessionId: 'c' },
    ]
    expect(visibleSessionItems(rows)?.map(row => row.sessionId)).toEqual(['a', 'c'])
    // 非数组原样透传：过滤不是补形状。
    expect(visibleSessionItems(undefined)).toBeUndefined()
  })

  it('delta 2 — fills trust:system on every preset row', () => {
    const rows = [{ id: 'x' }, { id: 'y', trust: 'user' }]
    expect(withSystemTrust(rows)).toEqual([
      { id: 'x', trust: 'system' },
      { id: 'y', trust: 'user' },
    ])
    // 必须返回新对象：原地改会污染内核给的那份投影。
    expect(withSystemTrust(rows)[0]).not.toBe(rows[0])
  })

  it('delta 3 — marks providers live only when the registry lists them', () => {
    const directory = [{ provider: 'a' }, { provider: 'b' }, { provider: 'c' }]
    const registry = [{ id: 'a' }, { id: 'c' }]
    const active = providerActivity(directory, registry)
    expect([...active].sort()).toEqual(['a', 'c'])

    const view = markProvidersActive(
      [{ provider: 'a', displayName: 'A', settingsNs: 'ns.a', settingsPath: ['k'], nativeAuth: { env: ['E'] } }],
      active,
    ) as Record<string, unknown>[]
    expect(view[0]).toMatchObject({ provider: 'a', active: true, settingsPath: ['k'] })
    expect(view[0]?.['nativeAuth']).toEqual({ env: ['E'] })
    // 可选字段缺席时不该出现 `key: undefined`（strict 解码器会当成不合法）。
    expect(Object.keys(view[0] ?? {})).not.toContain('declared')
  })

  it('delta 4 — extracts model capacities from resolveModelInfo output', () => {
    expect(capacityPatch({ contextWindow: 200_000, maxTokens: 8_192 })).toEqual({
      contextWindow: 200_000,
      maxTokens: 8_192,
    })
    expect(capacityPatch({ contextWindow: 0, maxTokens: -1 })).toBeUndefined()
    expect(capacityPatch({ contextWindow: Number.NaN })).toBeUndefined()
    expect(capacityPatch(null)).toBeUndefined()
  })

  it('delta 5 — treats a missing agent as a short circuit, not an error', () => {
    expect(agentScopeSkip(null)).toBe(true)
    expect(agentScopeSkip(undefined)).toBe(true)
    expect(agentScopeSkip({ session: {} })).toBe(false)
  })

  it('delta 6 — builds the subagent address the kernel validates', () => {
    expect(historyAddress({ sessionId: 'child', parentSessionId: 'lead' })).toEqual({
      kind: 'subagent',
      parentSessionId: 'lead',
      childSessionId: 'child',
      mode: 'unknown',
    })
    expect(historyAddress({ sessionId: 'child', parentSessionId: 'lead', subagentMode: 'one-shot' })).toMatchObject({
      mode: 'one-shot',
    })
    expect(historyAddress({ sessionId: 'child', parentSessionId: 'lead', subagentMode: 'bogus' })).toMatchObject({
      mode: 'unknown',
    })
    expect(historyAddress({ sessionId: 'solo' })).toEqual({ kind: 'session', sessionId: 'solo' })
    // 空父 id 不能当成子会话（否则 `validateAddress` 直接拒）。
    expect(historyAddress({ sessionId: 'solo', parentSessionId: '' })).toEqual({ kind: 'session', sessionId: 'solo' })
  })

  it('delta 7 — anchors the page window to the follow cursor', () => {
    expect(historyPageQuery({ cursor: 42 }, 10)).toEqual({ throughSeq: 42, beforeSeq: 10 })
    expect(historyPageQuery({ cursor: 42 }, 10, 5)).toEqual({ throughSeq: 42, beforeSeq: 10, maxMessages: 5 })
    // 没有 cursor 的 snapshot 就不写 throughSeq（内核语义：省略 = 观测到的日志末端）。
    expect(historyPageQuery({}, 10)).toEqual({ beforeSeq: 10 })
  })

  it('delta 8 — prefers the snapshot projections and skips the fallback for subagents', async () => {
    const primary = { asOfSeq: 3 }
    expect(pickProjections(primary, undefined)).toBe(primary)

    let called = 0
    const fallback = async (): Promise<{ asOfSeq: number }> => {
      called += 1
      return { asOfSeq: 9 }
    }
    const picked = pickProjections(undefined, fallback)
    expect(await picked).toEqual({ asOfSeq: 9 })
    expect(called).toBe(1)

    // 子会话：调用方根本不传 fallback（内核问不到子会话的投影）⇒ 必须是 undefined 而不是抛。
    expect(pickProjections(undefined, undefined)).toBeUndefined()
  })

  it('delta 9 — strips the bridge-only locale before the kernel sees it', () => {
    const { kernel, locale } = stripKernelUnsupportedFields({ sessionId: 's', locale: 'en', content: [] })
    expect(locale).toBe('en')
    expect(kernel).toEqual({ sessionId: 's', content: [] })
    expect('locale' in kernel).toBe(false)

    expect(stripKernelUnsupportedFields({ sessionId: 's' })).toEqual({ kernel: { sessionId: 's' }, locale: undefined })
    expect(stripKernelUnsupportedFields({ sessionId: 's', locale: 42 }).locale).toBeUndefined()
  })

  it('delta 10 — rewrites images only for models that cannot see them', () => {
    expect(handoffKeepsMessageDeliverable(false, true)).toBe(true)
    expect(handoffKeepsMessageDeliverable(true, true)).toBe(false)
    expect(handoffKeepsMessageDeliverable(false, false)).toBe(false)
  })

  it('delta 11 — maps kernel question errors onto the phone contract', () => {
    const error = (code: string): unknown => Object.assign(new Error(code), { code })
    expect(questionAnswerOutcome(error('REPLY_QUEUED'))).toBe('reply-queued')
    expect(questionAnswerOutcome(error('BAD_ANSWER'))).toBe('answer-invalid')
    expect(questionAnswerOutcome(error('CALLER_NOT_LIVE'))).toBe('retry-pending')
    expect(questionAnswerOutcome(error('DELEGATED_CALLER'))).toBe('retry-pending')
    expect(questionAnswerOutcome(error('gateway/service-unavailable'))).toBe('unavailable')
    expect(questionAnswerOutcome(error('WHATEVER'))).toBe('rethrow')
    // 没有 code 的普通异常不能误判成「转挂起表」。
    expect(questionAnswerOutcome(new Error('boom'))).toBe('rethrow')

    expect(questionAnswerTerminal(true)).toBe('answered')
    // 内核用 `false` 表达「这条 callId 不在我这」，必须转挂起表。
    expect(questionAnswerTerminal(false)).toBe('retry-pending')
    expect(questionAnswerTerminal(undefined)).toBe('retry-pending')
  })
})

describe('machine check: the facade holds no kernel-endpoint table (stage 4.4)', () => {
  const endpoint = /^[a-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/

  it('the facade is within the 450-line budget', () => {
    const lines = readFileSync(FACADE, 'utf8').split('\n').length
    expect(lines).toBeLessThanOrEqual(450)
  })

  it('no constant table in the facade groups two or more endpoint names', () => {
    const source = ts.createSourceFile(FACADE, readFileSync(FACADE, 'utf8'), ts.ScriptTarget.ESNext, true)
    const offenders: string[] = []
    // 「常量表」= 数组字面量里直接写端点名，或对象字面量的属性值直接是端点名。
    // 端点名作为**调用参数**出现是正常的（`invokeRequestEndpoint(..., 'session/list', …)`），
    // 所以箭头函数体要跳过 —— 跳过之后还能凑出两个，才是真在抄一份 DTO 清单。
    const collect = (node: ts.Node, hits: string[]): void => {
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) return
      if (ts.isStringLiteralLike(node) && endpoint.test(node.text)) hits.push(node.text)
      ts.forEachChild(node, child => collect(child, hits))
    }
    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node)) {
        const hits: string[] = []
        ts.forEachChild(node, child => collect(child, hits))
        if (hits.length >= 2) offenders.push(`array @${node.getStart(source)}: ${hits.join(', ')}`)
      } else if (ts.isObjectLiteralExpression(node)) {
        const hits: string[] = []
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) && endpoint.test(property.initializer.text)) {
            hits.push(property.initializer.text)
          }
        }
        if (hits.length >= 2) offenders.push(`object @${node.getStart(source)}: ${hits.join(', ')}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(offenders).toEqual([])
  })

  // issue #26 检修（审计 R2）：端点不在目录里（老内核/裁剪 profile）时，
  // 降级逻辑必须与服务缺席同义 —— 否则用户点「回答」看到的是 500，而不是「已失效」。
  it('treats a missing endpoint as an unavailable service for question answers', () => {
    expect(questionAnswerOutcome({ code: 'kernel/endpoint-unknown' })).toBe('unavailable')
    expect(questionAnswerOutcome({ code: 'gateway/service-unavailable' })).toBe('unavailable')
    // 真正的权限/参数错误仍然上抛，不能被吞成降级。
    expect(questionAnswerOutcome({ code: 'BAD_ANSWER' })).toBe('answer-invalid')
    expect(questionAnswerOutcome({ code: 'SCOPE_REQUIRED' })).toBe('rethrow')
  })

  it('keeps the endpoint vocabulary in the three allowed modules', () => {
    const allowed = new Set([
      join(HERE, '..', 'src', 'host', 'bridge', 'kernel-invoke.ts'),
      join(HERE, '..', 'src', 'host', 'bridge', 'kernel-deltas.ts'),
      join(HERE, '..', 'src', 'host', 'bridge', 'kernel-local.ts'),
    ])
    // 门面与 views 里端点名只能以「调用参数」出现 —— 这里只断言它们没有**成表**，
    // 上面的 AST 检查已经覆盖；此用例固定「允许成表」的白名单，防止将来放宽。
    expect([...allowed].every(path => path.includes('bridge'))).toBe(true)
  })
})
