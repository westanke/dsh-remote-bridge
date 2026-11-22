const WebSocket = require('ws')
const url = process.argv[2]
const token = process.argv[3]
const sessionId = process.argv[4]
const t0 = Date.now()
const ws = new WebSocket(url + '/ws/mobile', ['dsh-mobile-v1', 'dsh-auth.' + token], { handshakeTimeout: 30000 })
let bytes = 0
ws.on('open', () => {
  console.log('open', Date.now() - t0, 'ms')
  setTimeout(() => {
    console.log('send history at', Date.now() - t0)
    ws.send(JSON.stringify({ type: 'history', sessionId, requestId: 'r1' }))
  }, 500)
})
ws.on('message', (data) => {
  bytes += data.length
  const text = data.toString()
  const kind = JSON.parse(text).kind
  if (kind === 'history' || kind === 'error') {
    console.log('frame', kind, 'bytes', data.length, 'at', Date.now() - t0, 'ms'); console.log(text.slice(0, 400))
    console.log('total bytes', bytes)
    ws.close(); process.exit(0)
  }
})
ws.on('error', (e) => { console.log('error', e.message, Date.now() - t0); process.exit(1) })
ws.on('close', (c, r) => { console.log('closed', c, r.toString(), Date.now() - t0) })
setTimeout(() => { console.log('TIMEOUT at', Date.now() - t0); process.exit(2) }, 120000)
