/**
 * 真机链路验证脚本（宿主侧闭环，不触碰正在运行的 dsh）
 *
 * 走 router.ts 同款链条：
 *   ensureCloudflared(dataDir) → 复用已验证的二进制（不联网下载）
 *   → CloudflaredTunnelManager.startQuick(exe, port) → 从 stdout 抓 trycloudflare 地址
 *   → 用地址生成 DSH1 配置文本 → 解码回读验证 → stop()
 *
 * 前置：把 cloudflared 二进制放到 dataDir/cloudflared（本脚本不下载）。
 * 用法：CLOUDFLARED_BIN=/path/to/cloudflared node_modules/.bin/tsx scripts/manual-cloudflare-check.ts
 */
import { ensureCloudflared, CloudflaredTunnelManager } from '../src/host/cloudflared.ts'
import { encodeConfigText } from '../src/host/config-text.ts'

const DATA_DIR = process.env.CLOUDFLARED_DATA_DIR ?? '/media/wangke/OFFICE/workspace/cloudflared-prov/data'
const BIN = process.env.CLOUDFLARED_BIN ?? '/media/wangke/OFFICE/workspace/cloudflared-prov/extracted/usr/bin/cloudflared'

function ok(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? `  →  ${detail}` : ''}`)
  if (!cond) process.exitCode = 1
}

async function main(): Promise<void> {
  // 1) 把二进制放到 ensureCloudflared 会检查的位置
  console.log(`\n[1] ensureCloudflared（复用 Binary） → 检查 ${DATA_DIR}/cloudflared`)
  // ensureCloudflared 若没现成文件会尝试联网下载；这里预先放好已验二进制。
  const exe = await ensureCloudflared(DATA_DIR)
  const { statSync } = await import('node:fs')
  ok('二进制已就位', statSync(exe).isFile(), exe)

  // 2) 起 Quick Tunnel
  const manager = new CloudflaredTunnelManager()
  const port = 3090
  console.log(`\n[2] startQuick(exe, ${port}) 请求 Quick Tunnel…（约 15s）`)
  let gotUrl: string | null = null
  manager.onStatus(() => {
    const s = manager.publicState
    if (s.url && gotUrl === null) {
      gotUrl = s.url
      ok('抓到 Quick Tunnel 地址', /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.test(s.url), s.url)
    }
  })
  await manager.startQuick(exe, port)
  // 等待地址出现（最长 30s）
  const t0 = Date.now()
  while (gotUrl === null && Date.now() - t0 < 30000) {
    const s = manager.publicState
    if (s.url) { gotUrl = s.url; break }
    if (s.error) { ok('隧道异常', false, s.error); break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (gotUrl === null) {
    ok('隧道地址出现', false, `30s 内未抓到，state=${JSON.stringify(manager.publicState)}`)
  } else {
    // 3) 用地址生成 DSH1 配置
    console.log('\n[3] 用隧道地址生成 DSH1 配置文本')
    const text = encodeConfigText({
      displayName: 'cloudflare-真机验证',
      endpoints: [{ label: '云隧道', baseUrl: gotUrl, kind: 'WAN' }],
      token: null,
      deviceName: null,
      scopes: [],
    })
    ok('生成配置文本（DSH1 前缀）', text.startsWith('DSH1:'), text.slice(0, 40) + '…')
    const buf = Buffer.from(text.slice(5), 'base64url')
    const decoded = JSON.parse(buf.toString('utf8'))
    const ep = decoded.endpoints?.[0]
    ok('往返解码 baseUrl 一致', ep?.baseUrl === gotUrl, `endpoints[0].baseUrl=${ep?.baseUrl}`)
  }

  // 4) 停止
  console.log('\n[4] stop()')
  const after = manager.stop()
  ok('运行状态 = false', after.running === false)

  console.log('\n== 宿主侧闭环验证结束 ==')
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exit(1)
})