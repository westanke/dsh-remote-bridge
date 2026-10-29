#!/usr/bin/env node
/**
 * `/ws/mobile` 帧探针 —— 用真实桥连一次，逐帧打印「请求 → 响应」的关键字段。
 *
 * 为什么需要它：契约文档（`docs/api/asyncapi.yaml`）描述的是**本应有的样子**，不是
 * **现在的样子**。2026-10-29 就是靠这个探针发现 requestId 回显只在一半的帧上存在 ——
 * 而当时契约文档和 App 侧设计文档都写着「统一回显」。读 13 个域处理器的代码没能发现，
 * 跑十分钟探针发现了。详见 `docs/project/PITFALLS.md` 的同名坑位。
 *
 * **MockWebServer 测不出这类问题**：它老实回显你伪造的回帧，永远「通过」。
 * 只有真桥才会告诉你「这一帧其实不回显」。
 *
 * 用法：
 *   DSH_TOKEN=<token> node scripts/ws-frame-probe.mjs
 *   DSH_TOKEN=<token> DSH_BASE=192.168.1.126:3090 node scripts/ws-frame-probe.mjs
 *   DSH_TOKEN=<token> DSH_BASE=host:3090 DSH_ONLY=sessions,history node scripts/ws-frame-probe.mjs
 *
 * DSH_TOKEN 必填（从 App 的配对配置里取，或用配对流程换一个）。
 * 探针只读，不改任何服务端状态；`goal-edit` 之类的写操作帧不在探测之列。
 */

import WebSocket from 'ws'

const TOKEN = process.env.DSH_TOKEN
const BASE = process.env.DSH_BASE || '127.0.0.1:3090'
const ONLY = process.env.DSH_ONLY
  ? new Set(process.env.DSH_ONLY.split(',').map(s => s.trim()).filter(Boolean))
  : null

if (!TOKEN) {
  console.error('需要 DSH_TOKEN 环境变量（配对得到的设备令牌）。')
  process.exit(2)
}

// 只在 kind 与 type 同名时才自动往下推。goal 的请求 type 是 `goal`、响应 kind 也是 `goal`；
// 但 tasks / agent-team / subagents 这些是投影帧，响应 kind 与 type 不一定同名，
// 所以链条在这里显式写死，别做成「猜」。
const CHAIN = [
  { type: 'sessions' },
  { type: 'history', needs: 'sessionId', extra: { maxMessages: 5 } },
  { type: 'workspaces' },
  { type: 'models', needs: 'sessionId' },
  { type: 'commands', needs: 'sessionId' },
  { type: 'goal', needs: 'sessionId' },
]

const results = []
let sessionId = null
let step = 0
const ws = new WebSocket(`ws://${BASE}/ws/mobile`, ['dsh-mobile-v1', `dsh-auth.${TOKEN}`])

const describe = (value) => (value === undefined ? 'undefined' : JSON.stringify(value))

function sendNext() {
  while (step < CHAIN.length) {
    const item = CHAIN[step]
    if (ONLY && !ONLY.has(item.type)) { step += 1; continue }
    if (item.needs === 'sessionId' && sessionId === null) {
      console.log(`--- 跳过 ${item.type}：拿不到 sessionId（sessions 帧没返回会话）`)
      step += 1
      continue
    }
    const requestId = `probe-${item.type}`
    const frame = { type: item.type, requestId, ...(item.extra ?? {}) }
    if (item.needs === 'sessionId') frame.sessionId = sessionId
    console.log(`>>> ${item.type}  requestId=${requestId}`)
    ws.send(JSON.stringify(frame))
    return
  }
  summarize()
  ws.close(1000)
}

function summarize() {
  console.log('\n=== 汇总：帧类型 | 外层 frame.requestId | 内层 frame.data.requestId ===')
  for (const row of results) {
    const outer = describe(row.outer)
    const inner = describe(row.inner)
    const verdict = row.inner === undefined && row.outer === undefined
      ? '静默（需按 kind 兜底配对）'
      : '回显'
    console.log(`${row.type.padEnd(12)} | ${outer.padEnd(11)} | ${inner.padEnd(11)} | ${verdict}`)
  }
  if (results.length === 0) {
    console.log('（没有收到任何应答帧，检查 DSH_TOKEN / DSH_BASE / 网络）')
  }
}

ws.on('open', () => {
  console.log(`连上 ws://${BASE}/ws/mobile`)
  sendNext()
})

ws.on('message', (buf) => {
  let frame
  try {
    frame = JSON.parse(buf.toString())
  } catch {
    console.log(`!!! 收到非 JSON 帧：${buf.toString().slice(0, 120)}`)
    return
  }
  if (frame.kind === 'hello') {
    const caps = frame.data?.capabilities ?? []
    console.log(`<<< hello  protocol=${describe(frame.data?.protocol)}  capabilities=${caps.length} 项`)
    return
  }
  if (frame.kind === 'error') {
    console.log(
      `<<< error  code=${describe(frame.data?.code)} message=${describe(frame.data?.message)} `
      + `requestType=${describe(frame.data?.requestType)}`,
    )
    // 出错也要往前走，否则一个帧失败会卡住整条链。
    step += 1
    sendNext()
    return
  }

  const current = CHAIN[step]
  if (!current || frame.kind !== current.type) {
    console.log(`<<< ${frame.kind}（不在探测链上，忽略）`)
    return
  }

  const sessions = frame.data?.sessions
  if (Array.isArray(sessions) && sessions.length > 0 && sessionId === null) {
    sessionId = sessions[0].id
    console.log(`<<< sessions  ${sessions.length} 条，取首条 id=${sessionId}`)
  } else {
    console.log(`<<< ${frame.kind}`)
  }
  results.push({ type: current.type, outer: frame.requestId, inner: frame.data?.requestId })
  console.log(
    `    外层 requestId=${describe(frame.requestId)}  内层 data.requestId=${describe(frame.data?.requestId)}`,
  )
  step += 1
  sendNext()
})

ws.on('close', (code) => {
  console.log(`连接关闭 code=${code}`)
  process.exit(0)
})

ws.on('error', (error) => {
  console.error(`连接错误：${error.message}`)
  process.exit(1)
})

setTimeout(() => {
  console.log('超时（20s）—— 可能是 token 无效、网段不通，或某帧永远不回')
  process.exit(3)
}, 20000)
