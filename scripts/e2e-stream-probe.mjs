import { WebSocket } from 'ws'
const [token, sessionId] = process.argv.slice(2)
const counts = {}
let deltaText = ''
const ws = new WebSocket('ws://127.0.0.1:3090/api/v1/events', [`bearer.${token}`])
ws.on('open', async () => {
  console.log('1) 事件流已连接')
  const res = await fetch(`http://127.0.0.1:3090/api/v1/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '只回复两个字：收到',
      mode: 'queue',
      clientTimeZone: 'Asia/Shanghai',
      requestId: crypto.randomUUID(),
    }),
  })
  console.log('2) 发消息 HTTP', res.status)
})
ws.on('message', d => {
  try {
    const f = JSON.parse(d.toString())
    counts[f.type] = (counts[f.type] ?? 0) + 1
    if (f.type === 'chat.message.delta' && f.data?.kind === 'text') deltaText += f.data.text
  } catch {}
})
setTimeout(() => {
  console.log('3) 收到的帧类型统计:')
  for (const [k, v] of Object.entries(counts)) console.log(`   ${k}: ${v}`)
  console.log('4) 累积的流式文本:', JSON.stringify(deltaText.slice(0, 80)) || '(无)')
  ws.close(); process.exit(0)
}, 25000)
