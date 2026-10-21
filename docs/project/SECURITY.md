# 安全模型

## 信任边界

- 安装后 listener 默认只绑定回环地址。远程启用成功后才绑定管理员配置的数值 IPv4/IPv6 地址并生成配对码；默认远程目标为 `0.0.0.0:3090`。
- 绑定 IP 和端口只能由回环管理面修改。远程已启用时必须先关闭再修改；重绑定失败会恢复原监听地址，不提交错误配置。
- 登记根、授权设备、撤销、切换监听和永久清理只接受回环 socket 与可信本机 Origin；`Origin: null` 被拒绝。内部文件调用还必须携带插件管理头。不信任 `X-Forwarded-For`，普通本机 API 请求不会自动提升为管理员。
- **管理身份的判据不是「来源是回环」，而是四层同时成立**（2.5.1 起，见下节「管理面的信任边界」）。判据实现在 `src/host/auth.ts` 的 `adminRefusal`，`requireAdmin`（`/manage`）与 `principal({allowAdmin})`（`/api/v1`）**共用同一份**，两者对同一请求必须给出同一结论。
- 外部文件操作同时需要设备 scope 和 root grant。新根不会自动授予现有设备。
- 令牌由 256 位随机数生成，数据库只保存 SHA-256 摘要；撤销即时生效。
- 审计不保存令牌、文件正文或聊天正文。
- host 斜杠命令要求设备同时具备 `chat.write` 和会话所属 root grant；服务端只允许执行当前 DSH command registry 已列出的命令。审计保存命令名但不保存整行参数，避免 `/model` 等命令参数进入日志。
- 未分类系统错误统一脱敏，不把绝对路径或底层数据库错误发给外部客户端。
- DSH 工作区列表必须同时通过设备 `chat.read` 和 root grant；响应使用 `workspaceId` 与根内相对路径，不返回 DSH 工作区绝对路径。Agent Preset 只暴露选择所需元数据，损坏详情等宿主内部诊断不进入外部响应。
- WebSocket 使用 Upgrade Authorization 或 `bearer.<token>` 子协议，不接受会进入代理日志的 query token。每条事件重新读取设备状态，并同时检查实时 root grant 与 `files.read`/`chat.read` scope。
- Provider 列表只返回凭据的 `configured/source/writable` 元数据，绝不读取或回传 API 密钥。供应商读取和修改分别要求 `settings.read`、`settings.write`；密钥只通过 DSH credential service 写入或清除，审计不记录正文。
- 待审批列表要求 `chat.read`，决定要求 `chat.write`，两者还会重新检查会话所属 root grant。插件仅在 Host 内保存 DSH `rpcId`，向设备返回独立审批 ID；工具参数按 API Key、token、密码、Bearer 等常见形式脱敏并限长，审计不记录原因或命令。`danger-full-access` 标记为高风险，Android 必须二次确认且只允许单次授权。
- 图片交接的**只读**路由（`GET /plugin/dsh-remote-bridge/raw`）不要求设备令牌 —— 浏览器不会给 `<img>` 加 `Authorization`，这条口子也无法进 REST 前缀（那条前缀上的每个请求都需要令牌或回环管理身份）。它的守门条件是：`Host` 必须回环（DNS 重绑定防护）、跨站请求（`Sec-Fetch-Site`）一律 403、文件名必须匹配 `^[0-9a-f]{64}\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$`、**目录永远由宿主按会话推出**（客户端只递会话与裸文件名，递不进目录或绝对路径）、扩展名声明必须与魔术字节一致、体积上限 32 MiB。取不到一律 404 且不区分「会话不存在」与「文件不存在」。把 GUI 绑到非回环网卡时必须同步放宽 `image-handoff.ts` 的 `loopbackHost`。
- 识图路径（交接目录名）只接受**单段**目录名：空值、超长、`/`、`\`、NUL、`.`、`..` 一律拒绝（`400 IMAGE_SUBDIR_INVALID`）。因此它无法把图片落点带出会话工作目录。改动进审计（`image.subdir`），记录的是新目录名，不含任何路径正文。

## 管理面的信任边界（2.5.1 起）

管理面 `/manage/**` 与「回环管理员」身份（`X-Dsh-Workspace-Admin: 1`）的判据是**四层**，
任意一层不成立就拒绝。实现在 `src/host/auth.ts` 的 `adminRefusal`，两个入口共用。

| # | 判据 | 拒绝时的错误码 | 为什么 |
|---|---|---|---|
| 0 | 我们自管的隧道**没有**在运行（`CloudflaredTunnelManager.tunnelActive === false`） | `TUNNEL_MODE_ADMIN_DISABLED` | 唯一与请求头无关的判据：隧道是我们自己拉的进程，状态握在手里，伪造不了 |
| 1 | 请求不带任何转发头（`Forwarded` / `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Real-IP`） | `ADMIN_PROXY_FORWARDED` | 本机浏览器与 `curl 127.0.0.1` 都不会发这些头；发了就说明前面有一层不认识的反代 |
| 2 | `Host` 是回环（`127.0.0.1` / `localhost` / `[::1]`，缺失也拒） | `ADMIN_HOST_NOT_LOOPBACK` | 公网域名与 **DNS 重绑定**都只能靠 Host 露馅 |
| 3 | socket 来源是回环，且 `Origin` 存在时必须是回环 | `ADMIN_LOOPBACK_REQUIRED` | 修复前就有的那条，保留作兜底 |

四条错误码是**分别可证伪**的对外契约：客户端按码给不同提示，不要把它们糊成一个码。
`ADMIN_LOOPBACK_REQUIRED` 是 2.5.0 就存在的码，安卓端只消费它的文案，因此升级不受影响。

### `Origin` 缺失仍然放行（刻意的取舍）

`isLoopbackOrigin(undefined) === true` 这一行**保留**。修复前它是漏洞的地基
（「不带 Origin = 可信」直接换来管理员身份），修复后它不再有决定权：真正确立信任的是
判据 0/1/2。保留它是为了不切断 `curl` 与本机脚本调试 —— 而那些进程本来就能直接读这些文件。
**不要把它「顺手改严」**：改了只会打死本机调试，挡不住任何一条隧道攻击（隧道流量先撞判据 0）。

### 隧道模式下的规则

- 隧道运行时 `/manage/**` 一律 403（判据 0），管理操作只能在本机 WebUI 做。
- **唯一例外**是 `GET /manage/cloudflare/status` 与 `/activity`：它们只读、无副作用，
  目的是让面板能读到「隧道开着」这个信号并给出人话提示（否则隧道一开，连这个信号也 403，
  面板只剩一个无法解读的失败）。它们只豁免判据 0，判据 1/2/3 照旧生效。
- 豁免**只针对判据 0**。判据 1/2/3 对这两个端点照旧生效，所以隧道来源的请求连状态端点
  也是 403 —— 它读不到隧道地址（Quick Tunnel 地址本身就是一次对外入口），
  也读不到任何其他东西。「远程能读到 running 但读不到 url」被明确**否决**了：
  那需要为状态端点在判据 1 上再开一个口子，而那正是这次修复要消灭的东西。
  见 `tests/admin-loopback-escalation.spec.ts` 的
  “still refuses a real tunnel caller on the exempt status endpoints”。
- 判据 1 里的 **Cloudflare 边缘头**（`Cf-Connecting-IP` / `Cf-Ray` / `Cf-IpCountry` /
  `Cf-Visitor`）是必要的：**cloudflared 的 `httpHostHeader` 默认为空，会把 `Host`
  改写成源站地址**，真实隧道下判据 2 挡不住它。实测确认（
  `.local-backup/security-audit/verify-fix-tunnel-admin.mjs`：只改 Host 能拿到 200，
  加上边缘头才被挡住）。
- 隧道只用于 `/api/v1` 数据面；管理面永不暴露。隧道地址是**公开可猜的**（会出现在日志与
  配置文本里），必须与「管理面不可达」配合，不能只靠地址保密。

### 信任边界的两个前提（2.5.1）

管理面的安全性建立在**两个**前提之上，缺一个都不成立：

1. **拓扑不可达**：监听口（默认 `3090`）没有暴露给任何能把请求转进本机回环的第三方；
2. **来源判据**：四层判据把关本机来源。

**只要有第三方反代 / SSH 端口转发 / 他人的 frp 把请求转进回环，前提 1 就破了，
而前提 2 在这条路径上原理上不可能成立**（理由见下节）。所以：

- **不要在 listener 前挂任意反代 / SSH 转发来访问管理面**。
- 要远程连，用**本插件自己的 Cloudflare 隧道**：它受判据 0 管辖（进程状态在我们手里），
  且隧道只应服务于数据面 `/api/v1`。
- 已经挂过第三方转发的：检查 `/manage/audit`（`root.add` / `pairing.create` / `config.text`）、
  `/manage/roots`（陌生目录）、`/manage/devices`（多余设备，有则撤销）。

### 残余风险（如实记录，不要因为「已经修了」就跳过）

**准确表述：本插件自带的隧道已堵死；外部反代 / SSH 转发在特定配置下仍可提权。**
以下都不是「已经修好了不用管」，而是**在「认来源」框架内原理上无法修掉**的部分。

1. **外部反代 / SSH 端口转发可绕过全部四层判据（已实测 201）。**
   可复现条件：`tunnelActive === false`（插件不知道它在跑）+ 客户端自控 `Host`
（填 `127.0.0.1:PORT`）+ 不带 `Origin` + 不带任何转发头。逐条原因：
   - 判据 0 只反映**本插件自己 `spawn` 的 cloudflared 进程**，对 SSH `-L`、别人的 frp、
     剥了头的 Caddy 一无所知；
   - 判据 1：SSH 转发的是**裸 TCP**，不会加任何 `X-Forwarded-*`；反代也可以配置成不加；
   - 判据 2：`Host` 是**客户端自己填的**，攻击者填回环地址即可通过
     （真实 cloudflared 会改写 Host，SSH 转发不会）；
   - 判据 3：`Origin` 缺失仍放行（为保住 `curl`，刻意的）。

   实测（`.local-backup/security-audit/probe-external-proxy-residual.mjs`）：
   `POST /manage/pairings` → **201**，兑换后设备数 0 → 1，scopes 含 `files.write`。
   对照：同一请求在 `tunnelActive=true` 时 → **403 `TUNNEL_MODE_ADMIN_DISABLED`**。

   **限制这条洞**：不要给监听口挂第三方转发；本插件自带隧道的场景由判据 0 兜住。

2. **判据 1/2/3 全都可以被伪造，只有判据 0 是硬防线。**
   让反代把 `Host` 改写成 `127.0.0.1`、自己设一个回环 `Origin` 就能拿到 200。
   → **判据 0 必须永远保留**：一旦有人删掉「隧道运行时禁用管理面」，管理面立刻回到
   2.5.0 的敞口状态。真实 cloudflared 场景是被判据 0 + 判据 1 的 `Cf-*` 双重覆盖的。

3. **「认来源」的原理性极限**。
   「本机进程能做的事，SSH 转发进来的攻击者也能做」—— 两者在 socket 层面无法区分。
   所以**任何基于请求头 / Host / Origin / socket 的加固在这条路径上都是无效的**
   （包括「缺失 Origin 时额外要求一个标记头」这类想法：头本身就能伪造）。
   已在报告里明确否决了这种「看起来很美但无效」的加固。
   **根治只有两条**：① 管理面改「**认凭据**」（独立管理令牌）；
   ② **端口分离**（管理面只绑独立回环端口，拓扑上让隧道打不到）。
   两条都记为后续项，见 `CHANGELOG-DEV.md` 的「未做的事」与实施记录 §7。

### 桌面端为什么不受影响

桌面端面板（`src/client/api.ts`）通过 `/dsh-workspace-api/manage` + `X-Dsh-Workspace-Admin: 1`
访问管理面，它跑在只绑 `127.0.0.1` 的 DSH WebUI 里 —— 浏览器发出的 Origin 与 Host
**必然都是回环**，且不带任何转发头，于是判据 0/1/2/3 全过，照常放行。
`tests/admin-loopback-escalation.spec.ts` 有一条「桌面端仍然放行」的专门断言钉住这条红线。
安卓端 dsh-companion **完全不调用 `/manage`**（全仓 grep 证实，只消费
`ADMIN_LOOPBACK_REQUIRED` 这个错误码文案），所以无需任何改动。

## HTTP 与 HTTPS

HTTP 是受支持的连接方式，不会被强制跳转或拒绝。但 Bearer token、聊天和文件内容都可能被同网段监听者读取或修改。公网、不可信 Wi-Fi 和共享局域网应在 listener 前使用 Caddy/Nginx HTTPS 或 VPN。

> **这条建议在 2.5.1 之前是反向的，别再照抄旧版本**：旧版这里写的是「…或**可信隧道**」。
> 但隧道恰恰是管理面越权的放大器 —— 任何把外部请求转到本机回环的拓扑（cloudflared、
> ngrok、frp、Caddy/Nginx `proxy_pass 127.0.0.1`、SSH 端口转发、Tailscale Serve）都会让
> `socket.remoteAddress` 恒为 `127.0.0.1`，而修复前的管理面就只看这一条。照旧版建议开隧道
> 等于把管理面无凭据敞到公网（v2.5.0 实测 200/201）。隧道仍可用于**数据面**，
> 但只在 2.5.1 及之后、并且遵守下一节的规则。

## 路径威胁

wire path 拒绝绝对路径、盘符、UNC、反斜杠、空字节、空段、`.` 和 `..`。服务从已解析的真实根开始逐段 `lstat`；中间 symlink/junction 一律拒绝，末端链接不能读取内容，删除时只处理链接本身。

逐段检查用于阻止静态链接逃逸，但 Node 当前没有覆盖三平台的 `openat` 等目录句柄相对 API；同权限本机进程若在检查与操作之间持续竞态改名，仍存在窄 TOCTOU 残余风险。该进程本就能直接访问用户文件，因此首期不把它视作插件可独立防御的攻击者。

## 非目标

- 插件不充当多租户隔离边界；DSH 主机管理员仍能访问主机文件。
- 首期不签发 TLS 证书，不实现云账户或互联网中继。
- 聊天正文和工具输出是用户可见内容，不对其中的自然语言路径做破坏性重写。

## Android 客户端

- App 允许用户显式连接 `http://`，但连接页和设置持续提示明文令牌风险；不会把 HTTP 静默升级为强制 HTTPS。
- 设备令牌使用 Android Keystore 中的应用专属 AES-GCM 密钥加密后落盘，不写日志、崩溃报告、剪贴板或明文偏好。
- Release APK 使用独立生成的正式 keystore；keystore、别名和密码文件位于 App 仓库外且不得提交。Debug 构建不作为交付物。
- App 只请求当前功能需要的 scope。Provider 设置使用 `settings.read/settings.write`；会话内审批沿用 `chat.read/chat.write`，但仍受对应 session/root grant、单次结果、服务端脱敏与审计约束，不能形成通用主机管理能力。
- DSH 黑色鲸鱼图标取自 MIT 许可的上游 `apps/web/public/favicon.svg`，保留来源与许可说明。
