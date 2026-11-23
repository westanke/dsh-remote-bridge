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
- 未分类系统错误统一脱敏，不把绝对路径或底层数据库错误发给外部客户端。未知异常经 `asApiError`（`src/host/errors.ts`）归一为固定文案的 500 `INTERNAL_ERROR`；cloudflared 下载/解包错误在 `src/host/cloudflared.ts` 的 `sanitizeDownloadError` 先过一遍（完整 URL → 仅保留 host、绝对路径 → 仅保留 basename），`router.ts` 的 `TUNNEL_DOWNLOAD_FAILED` 出口再固定兜底文案并附结构化 `errorKey`，两层脱敏（2.5.2 / SEC-H7）。
- DSH 工作区列表必须同时通过设备 `chat.read` 和 root grant；响应使用 `workspaceId` 与根内相对路径，不返回 DSH 工作区绝对路径。Agent Preset 只暴露选择所需元数据，损坏详情等宿主内部诊断不进入外部响应。
- WebSocket 使用 Upgrade Authorization 或 `bearer.<token>` 子协议，不接受会进入代理日志的 query token。每条事件重新读取设备状态，并同时检查实时 root grant 与 `files.read`/`chat.read` scope。连接级闸口（真值在 `src/host/server.ts`）：默认最多 32 条连接（可配置），**鉴权先于计数**——超额连接在通过鉴权后才于 Upgrade 阶段收到 HTTP 429（`Retry-After: 5`），未鉴权请求不消耗名额；单帧上限 1 MiB，超限 close(1009)；30 秒 ping 心跳，连续 2 个周期缺 pong 即 terminate；每连接发送队列 512 帧，背压溢出时优先丢可重建的 `chat.message.delta` 并补发 `connection.resyncRequired` 通知客户端改走 REST 补历史，状态帧也塞不进时 close(1013,'Backpressure')。
- Provider 列表只返回凭据的 `configured/source/writable` 元数据，绝不读取或回传 API 密钥。供应商读取和修改分别要求 `settings.read`、`settings.write`；密钥只通过 DSH credential service 写入或清除，审计不记录正文。
- 供应商 `baseURL`（三个写入口：创建、修改、`discover`）必须过地址策略：协议限 `http`/`https`，私网/回环/链路本地/CGNAT **默认拒绝**，且已有凭据的供应商换 host 必须同时给新 key。理由是内核会带着真实凭据去请求这个地址——实测能直接收到 `Bearer sk-…`（2.6.1 / SEC-H11）。放宽只走部署方配置 `allowPrivateProviderHosts`。详见下节「供应商 `baseURL` 的地址策略」。
- 配对默认只给五档 scope（`chat.read`/`chat.write`/`files.read`/`files.write`/`settings.read`），**刻意不含** `files.delete` 与 `settings.write`；三条配对路径共用 `DEFAULT_DEVICE_SCOPES`。用户仍可手动勾选破坏性权限（2.6.1）。
- 通用设置命名空间（`/settings/namespaces`）要求 `settings.read` / `settings.write`，但**默认只有 `ui-*` 与以 `locale` 结尾的命名空间可写**；`llm-*`、`permission`、`agent-default-model`、`subagent-*` 等一律只读。理由、放宽开关与两道脱敏见下节「通用设置命名空间的写权限（2.6.0 起）」。
- 待审批列表要求 `chat.read`，决定要求 `chat.write`，两者还会重新检查会话所属 root grant。插件仅在 Host 内保存 DSH `rpcId`，向设备返回独立审批 ID；工具参数按 API Key、token、密码、Bearer 等常见形式脱敏并限长，审计不记录原因或命令。`danger-full-access` 标记为高风险，Android 必须二次确认且只允许单次授权。
- **审批的降级方向是「拒」不是「准」（2026-11-11 起，#13）**：审批请求现在**进入即委托**给官方 WebUI
  那条远端 answerer（不调 `next()` 在 Cordis waterfall 里等于否决整条链，电脑端就永远收不到这张卡），
  然后与手机端 `Promise.race`，**谁先答谁赢**。三条可证伪的断言：
  ① **挂起超时不自动批准** —— 超时按内核兜底 `'unavailable'` 结算（= 没有审批通道 → 工具被拒），
  **绝不** `'allowed-once`；「没人回答 = 默认批准」等于把安全判据交给一个定时器。
  ② **内核兜底值 `'unavailable'` 不是答复** —— 下游给这个值时必须继续等手机端，
  当成答复等于手机端还没答就被拒掉。
  ③ **落败端的响应一律 `not-pending`**（409 APPROVAL_NOT_PENDING），不得二次结算。
  认下来的代价：两端各一张卡，手机端先赢时电脑端那张卡没有外部撤销通道，要用户点一下才消失。
  回归钉子：`tests/approval-timeout.spec.ts`（超时回落 `'unavailable'` / 下游兜底值不算答复 /
  电脑端先赢后迟到响应 `not-pending`）。
- 诊断端点 `GET /api/v1/debug/host-services` 与其它 `/api/v1` 路由同级鉴权：先过 `principal()`，再要求 `settings.read` scope（admin 身份自动继承）；本构建未注入报告时回 404。2.5.2 修复（SEC-H1）：它此前位于 `principal()` 之前、无需任何凭据即可读到宿主注入面与内核原始错误文本，而 openapi 全局 `bearerAuth` 从未给它豁免——属于契约违约。新增的运行期 metrics 字段挂在这份报告上而**不另开路由**（另开一条就再造一个要单独守的鉴权面）。回归断言见 `tests/security-h1.spec.ts`；免设备令牌的端点集合由 `scripts/docs-contract.ts` 在 `docs:check` 中与 openapi 的 `security: []` 集合双向核对，目前恰好只有 `GET /healthz` 与 `POST /pairings/exchange`。
- 图片交接的**只读**路由（`GET /plugin/dsh-remote-bridge/raw`）不要求设备令牌 —— 浏览器不会给 `<img>` 加 `Authorization`，这条口子也无法进 REST 前缀（那条前缀上的每个请求都需要令牌或回环管理身份）。它的守门条件是：`Host` 必须回环（DNS 重绑定防护）、**浏览器带 `Sec-Fetch-Site` 时跨站一律 403**（仅 `same-origin` 与 `none` 放行）、同源 `/plugin/` 前缀页面的 `Referer` 放行、文件名必须匹配 `^[0-9a-f]{64}\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$`、**目录永远由宿主按会话推出**（客户端只递会话与裸文件名，递不进目录或绝对路径）、扩展名声明必须与魔术字节一致、体积上限 32 MiB。取不到一律 404 且不区分「会话不存在」与「文件不存在」。**刻意的口子（SEC-H8，与代码对齐）**：无 `Sec-Fetch-Site` 且无 `Origin` 的调用方不是浏览器页面（`curl`、脚本、测试），此时回环可达性本身就是访问模型（与本地 GUI 其余部分一致），直接放行——浏览器一定发这两个头之一，所以这条口子对网页攻击不成立。判定真值在 `image-handoff.ts` 的 `sameOrigin()`。把 GUI 绑到非回环网卡时必须同步放宽 `image-handoff.ts` 的 `loopbackHost`。
- 识图路径（交接目录名）只接受**单段**目录名：空值、超长、`/`、`\`、NUL、`.`、`..` 一律拒绝（`400 IMAGE_SUBDIR_INVALID`）。因此它无法把图片落点带出会话工作目录。改动进审计（`image.subdir`），记录的是新目录名，不含任何路径正文。

## 通用设置命名空间的写权限（2.6.0 起）

DSH 的设置是一份**按插件命名空间划分**的文档。桥把它整份暴露给手机端是必要的
（否则每装一个插件都要为它加一个专用接口），但**能读**不等于**能写**：

| 命名空间 | 默认 | 为什么 |
|---|---|---|
| `ui-*`（如 `ui-chat`、`ui-theme`） | 可写 | 改的是界面偏好（`transcriptView`、`fontSize`），最坏结果是界面难看 |
| 以 `locale` 结尾 | 可写 | 语言/区域偏好，可随时改回 |
| `llm-*`（供应商、模型、Base URL） | **只读** | 手机能改 Base URL = 把模型请求引到攻击者的端点；令牌泄露后这是最直接的数据外泄路径。**注意**：供应商还有一条专用路由，不经过本策略 —— 它的守门是下节的地址策略 |
| `permission`（审批档位/策略） | **只读** | 手机能改权限 = 把审批闸门拆掉，之后所有危险工具调用都无人拦截 |
| `agent-default-model` / `subagent-*` | **只读** | 同样是把「用哪个大脑、放多少自主权」交给远端 |

一句话：**让手机改模型和权限，等于把遥控器连同保险柜钥匙一起交出去。** 这些设置
仍然可以读（客户端要显示当前值），只在写入侧拒绝。

放宽只能由部署方在插件配置里显式做：`settingsWriteNamespaces` 接受精确 ns 或
`前缀*`，默认空数组。它是**唯一的**放宽入口，不经客户端、不进 REST 请求体。

可证伪的判据与回归断言：

- `GET` 对每个不可写 ns 返回 `writable: false` 与 `reason`；`reason` 只有
  `HOST_READONLY`（整份宿主文档只读）与 `HIGH_RISK_NAMESPACE`（策略拒绝）两值。
- `PATCH` 不在策略内的 ns 返回 403 `SETTINGS_NAMESPACE_READONLY`，**且一次内核
  `settings.mutate` 都不会发生**（否则「先写后拒」等于已经改坏）；由
  `tests/settings-namespaces.spec.ts` 的「拒绝非允许命名空间」用例盯着。
- 密钥有两道脱敏：内核以 `redactSecrets` 报告 `value`/`user`；桥再按内核给出的
  `secrets[].path` **与**键名正则 `apiKey|secret|token|password|credential|apiKeyEnv`
  把字符串值替换成 `***`（`apiKeyEnv` 是变量名不是密钥，但它暴露供应商配置）。
- 成功写入的审计是 `settings.namespace.mutate`，`details` 只含 `ns`、`fields`
  （字段路径）与 `credentialChanged`（路径是否命中 `secrets[].path`）；**绝不记录值**。

### 供应商 `baseURL` 的地址策略（2.6.1 起，SEC-H11）

上表的 `llm-*` 只读挡的是**命名空间那条路**。供应商还有一条专用路由
（`POST /settings/providers`、`PATCH /settings/providers/{id}`、
`POST /settings/providers/{id}/discover`），它写的是同一批字段，却**不经过**
`isSettingsNamespaceWriteAllowed` —— 也就是说，只要设备拿到 `settings.write`，
上面那句「手机不能改 Base URL」就形同虚设。这是 2.6.0 及之前版本的真实状态。

更严重的是，`discover` 会把 `baseURL` 交给内核去发 `GET {baseURL}/models`，而内核
**带着该供应商已配置的真实 API key**。实测（2.6.0）：把 `baseURL` 指向自己的服务器，
就能在服务端日志里收到 `authorization: Bearer sk-…`。所以这条不只是 SSRF，是
**凭据外泄**。`PATCH` 改 `baseURL` 的持久化变体更彻底：配置真的被改掉，此后每次
聊天都把 key 打到新地址，而审计只记 `providerId` 不记地址，事后无法追溯。

三道闸门（策略本体在 `src/host/provider-url-policy.ts`，接线在
`src/host/settings-adapter.ts`）：

| # | 判据 | 拒绝码 | 为什么 |
|---|---|---|---|
| 1 | 必须是绝对 URL，协议限 `http`/`https` | `400 PROVIDER_BASE_URL_INVALID` | 挡 `file:`、`gopher:`、`data:` 这类由 URL 解析器自己发起的协议 |
| 2 | 私网 / 回环 / 链路本地 / CGNAT 默认拒绝 | `403 PROVIDER_BASE_URL_FORBIDDEN` | 挡 SSRF：内网探测与云元数据 `169.254.169.254` |
| 3 | 已有凭据的供应商换 host 时必须同时提供新 `apiKey` | `403 PROVIDER_BASE_URL_REPOINT_FORBIDDEN` | 挡「换成攻击者的**公网**域名」——闸门 2 对公网地址无能为力 |

三条都在 `createProvider`、`updateProvider`、`discover` **三个入口**生效，缺一即留后门
（`tests/settings-adapter.spec.ts` 每个入口都有拒绝用例）。闸门 3 只在 `baseURL` 的
host 真的变了、且该供应商**确实存有凭据**（`credentials.describe` 报
`configured: true`）时才查 —— 所以改模型列表、改显示名、同 host 内改 path 都是零额外
开销的日常操作，不会被误伤。

**放行自建 LLM**：默认拒绝会打死本机 ollama / LM Studio。部署方用插件配置
`allowPrivateProviderHosts` 显式放行，接受两种粒度：

```yaml
allowPrivateProviderHosts:
  - 127.0.0.1:11434     # 推荐：只放行这一个端口
  - 192.168.1.5         # 裸 host：放行该主机任意端口
```

**不支持 CIDR** —— 只接受精确 `host` 或 `host:port`。带端口的条目按 `host:port` 精确
比对，裸 host 条目匹配该主机任意端口。**推荐永远带端口**：放行 `192.168.1.5` 等于放行
它上面所有服务，而 ollama 只在 11434。这是部署方的显式决定，不进 REST 请求体、不经客户端。

**刻意不做 DNS 解析**：校验时解析一次、内核发请求时再解析一次，两次之间可以变
（TOCTOU），而且会给出一层「已经校验过」的错觉。所以攻击面被收窄到「攻击者必须
控制一个公网域名」，而不是「攻击者必须控制 DNS」。

**审计**：三个写入口的审计都带 `baseURLHost`（`host[:port]`，**不记完整 URL** ——
path/query 可能带凭据）。`discover` 的 `baseURL` 是临时覆盖、不写配置，所以这条尤其
重要：不记 host 就完全无法知道凭据被打到哪个地址。

**回归断言**：`tests/provider-url-policy.spec.ts`（29 例：协议白名单、12 种私网形态、
白名单粒度、`::ffff:` 十六进制映射绕过）与 `tests/settings-adapter.spec.ts` 的
「credential repoint guard」6 例。其中 `::ffff:127.0.0.1` 一例是实施时发现的真绕过：
`new URL()` 会把 IPv4 映射地址归一化成 `[::ffff:7f00:1]`，只匹配点分十进制等于完全没挡。

### 配对的默认权限（2.6.1 起）

修复前，WebUI「生成配对码」这条路径默认勾选**全部七档** scope（含 `files.delete` 与
`settings.write`），而「生成配置文本」那条路径刻意只给五档（注释原文
`No scopes on purpose`）。同一个产品两条配对路径的默认权限不一样，且宽的那条恰好是
用户更常用的那条。

现在三条路径（配对码 / 配置文本 / 隧道配置文本）共用 `src/shared/contracts.ts` 的
`DEFAULT_DEVICE_SCOPES`（五档：`chat.read`、`chat.write`、`files.read`、`files.write`、
`settings.read`），**刻意不含** `files.delete` 与 `settings.write`。破坏性权限仍可由用户
在配对界面上手动勾选 —— 默认值与「能给它」是两件事。这与 `CHANGELOG-DEV.md` 里
「`settings.write` 是用户显式要求才给的东西」那句声明对齐。

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
- **例外有三个**：`GET /manage/cloudflare/status`、`/activity`（只读）与
  `POST /manage/cloudflare/stop`。前两个让面板能读到「隧道开着」这个信号并给出人话提示
  （否则隧道一开，连这个信号也 403，面板只剩一个无法解读的失败）。
- `stop` 是 v2.5.2 加入的**唯一豁免判据 0 的写操作**。起因是真机回归：隧道一开连停机端点
  也 403，本机面板没有任何体面出口（只能杀进程），同时 status 403 导致根列表刷空、主按钮
  永久禁用——「开了就关不掉、按钮全灰」。它不构成提权：①唯一效果是把管理面**重新锁回**
  判据 0（一个让系统更安全、且让隧道自身下线的动作，对隧道外攻击者毫无收益）；
  ②判据 1 仍然生效，真实隧道来源必带 `cf-*` 边缘头，打 stop 照样 403；
  ③`config/text`（能签发令牌）与 `create` 绝不豁免。
- 豁免**只针对判据 0**。判据 1/2/3 对这三个端点照旧生效，所以隧道来源的请求连状态端点
  也是 403 —— 它读不到隧道地址（Quick Tunnel 地址本身就是一次对外入口），
  也读不到任何其他东西。「远程能读到 running 但读不到 url」被明确**否决**了：
  那需要为状态端点在判据 1 上再开一个口子，而那正是这次修复要消灭的东西。
  见 `tests/admin-loopback-escalation.spec.ts` 的
  “still refuses a real tunnel caller on the exempt status endpoints” 与
  “lets the LOCAL panel STOP the tunnel … but still blocks edge callers”。
- 判据 1 里的 **Cloudflare 边缘头**（`Cf-Connecting-IP` / `Cf-Ray` / `Cf-IpCountry` /
  `Cf-Visitor`）是必要的：**cloudflared 的 `httpHostHeader` 默认为空，会把 `Host`
  改写成源站地址**，真实隧道下判据 2 挡不住它。实测确认（
  `.local-backup/security-audit/verify-fix-tunnel-admin.mjs`：只改 Host 能拿到 200，
  加上边缘头才被挡住）。
- 隧道只用于 `/api/v1` 数据面；管理面永不暴露。隧道地址是**公开可猜的**（会出现在日志与
  配置文本里），必须与「管理面不可达」配合，不能只靠地址保密。
- **issue #26 阶段 0.2 起这条从「规则」变成「拓扑」**：cloudflared 只转到隧道专用数据端口，
  管理面在主端口，两者不在同一个监听上。见下节 §隧道数据面的端口分离。

### IM 命令 `/tunnel` 的信任边界（2.5.2 起）

`/tunnel` 是**宿主命令**（`ctx.commands.register`），`open_tunnel_config` 是**工具**
（`ctx.tools.register`），两者实现同在 `src/host/im-command.ts`、共用同一个
`ApiRouter.openTunnelForCommand()`。它们让用户把隧道拉起来并取回一行 `DSH1:` 配置文本。
存在的理由是它绕开了本插件的整个入站面：IM 机器人是**本机主动连出去**的长连接，
所以「没有隧道」时这条路照样通。

两个入口都要有，是因为 `@xmanrui/dsh-im` 5.4.0 的斜杠命令表是**封闭的**（内置 31 条 +
`/compact` `/clear` `/permission` 三条固定委派，没有通用派发，也从不调用 `commands.list`）：
IM 里发 `/tunnel` 只会当成普通消息交给智能体。所以命令服务于「能发命令的客户端」，
工具服务于「只会说话的 IM 窗口」。

它对管理面判据 **没有任何豁免**，也不新增任何 REST 端点：

- 命令在插件进程内直接调用 `ApiRouter.openTunnelForCommand()`，走的是与
  `POST /manage/cloudflare/create` **同一套** `createTunnel()` 实现（审计标签为 `im-command`，
  便于和本机管理面的 `loopback-admin` 分开查）。因此它不需要、也不应该给 `/manage` 开口子。
- 隧道**已在运行时**复用当前地址出配置文本，不再 `startQuick` —— 这一条同样不是提权：
  它签发的新设备令牌与面板上点一次「生成配置文本」完全等价（一样的 scope、一样要落审计）。
- **能力边界**：只开不停、不接受参数、不读文件。刻意不提供 `/tunnel stop`：停机已经有面板
  出口，再开一个远程入口只会把「关掉公网入口」变成一个可被滥用的动作。

> ⚠️ **本命令的身份校验不在本仓**。它依赖 `@xmanrui/dsh-im` 的访问策略
> （`canExecuteCommands` / `defaultCanExecuteCommands` + allowlist）：非白名单发送者的消息
> 在 IM 插件里就被拒，根本到不了命令处理函数。因此**部署前提**是机器人保持 allowlist 模式，
> 且白名单只包含自己。若把机器人设为「允许所有用户执行命令」，本命令就是一个公开的开机按钮 ——
> 这一点写进 README「在聊天窗口里远程开隧道」一节的告警框。

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
   **②已在 issue #26 阶段 0.2 落地**（见下节）；①仍未做，记为后续项，
   见 `CHANGELOG-DEV.md` 的「未做的事」与实施记录 §7。

### 隧道数据面的端口分离（issue #26 阶段 0.2 起）

以上残余风险的 ①② 是「认来源」框架唯一可能的出路。②已落地：桥另起一个只绑
`127.0.0.1`、端口由系统分配的**隧道专用监听**（`src/host/tunnel-listener.ts`），
cloudflared 只转到它，主监听端口（默认 `3090`）不再被隧道触及。

**可证伪断言（有测试认领，改这里必须同时改测试）**：

1. **隧道端口上不存在管理面**：`/manage`、`/manage/status`、`/manage/roots`、
   `/manage/audit`、`/manage/config/text`、`/manage/pairings`、
   `/manage/cloudflare/status` 经隧道端口一律 `404 ROUTE_NOT_FOUND`
   —— **即便**请求伪造了 `X-Dsh-Workspace-Admin: 1`、`Host: 127.0.0.1`、回环 `Origin`
   且不带任何转发头。这不是「判据挡住了」，而是**那条路由在这个端口上不存在**。
   → `tests/admin-loopback-escalation.spec.ts`
   "has no management route at all on the tunnel port (端口分离，issue #26 阶段 0.2)"
2. **隧道端口不产生回环管理员身份**：经隧道端口带 `X-Dsh-Workspace-Admin: 1` 访问
   `/api/v1/roots` ⇒ `401 AUTH_REQUIRED`（头在进入路由分派前就被剥掉）。
   → 同文件同用例的后半段。
3. **数据面照旧可用**：隧道端口上 `/api/v1/healthz` ⇒ `200`；`/api/v1/roots` 无令牌 ⇒ `401`；
   带有效设备令牌 ⇒ `200`；`/ws/mobile` 能用设备令牌完成握手并收到 `hello`
   （复用主端口同一个 handler 实例，鉴权口径完全一致）。
   → 同文件 "keeps the data plane working on the tunnel port (issue #26 阶段 0.2)"
4. **隧道端口不放行别的 upgrade**：除 `/ws/mobile` 以外的 upgrade 直接销毁连接
   （`/api/v1/events` 也不通 —— 它是桥自己的广播通道，只走主端口）。
5. **端口由代码定死**：`cloudflared` 的 `--url` 取自 `status().tunnelPort`，
   调用方不能指定；端口号 <= 0 时 `create` 返回 `503 TUNNEL_PORT_UNAVAILABLE`，
   绝不回落到主端口。

**这为什么比「加判据」强**：残余风险第 1 条里，攻击者靠「自控 `Host` + 无 `Origin` +
无转发头 + 插件不知道外部转发在跑」拿 201。端口分离把攻击面从「有没有识别出代理」
换成「那个端口上有没有这条路由」—— 后者不依赖任何可伪造的请求属性，也没有
「插件不知道」的盲区。**但前提 1 仍然要守**：别给主监听端口挂第三方反代 / SSH 转发，
否则管理面还是在公网上。

**未覆盖的部分（如实记录）**：手机端要用隧道，就仍需要 `/api/v1/**` 跟着隧道出去，
所以数据面本身（设备令牌 + scope/root 授权 + 限流）仍是隧道暴露面。端口分离只解决
**管理面**，不解决「数据面被公网可达」。

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

## 入站 wire JSON 纪律（issue #IKXGYR，2026-11-23 起）

`/ws/mobile` 入站帧与 `/api/v1` REST body 的 JSON 解析走同一条严格路径
（`src/host/wire-json.ts` 的 `parseWireJson`）：对象内**重复键一律拒绝**——包括
JSON 转义后同名（`{"a":1,"\u0061":2}`）——REST 侧还要求 body 是**严格 UTF-8**
（fatal 解码，坏字节不再静默替换成 U+FFFD）。为什么是安全性质而不只是「洁癖」：
重复键在不同语言的 JSON 解码器里行为各不相同（取末值 / 报错 / 合并），同一份载荷
在服务端与客户端可能解析成**不同对象**，鉴权与业务判据读到的字段就可能不一致；
把它在边界上钉死，才谈得上「两端看到同一个请求」。

**可证伪断言（有测试认领，改这里必须同时改测试）**：

1. **重复键帧被拒且不断链**：`/ws/mobile` 上发送含重复键（直名或转义同名）的帧
   ⇒ 收到 `error` 帧 `INVALID_FRAME`，同一连接随后仍能正常收发（拒帧 ≠ 断链）。
   → `tests/wire-json.spec.ts`（单元：直名 / 转义同名 / 嵌套 / 数组元素）
   + `tests/mobile-gateway-ws.spec.ts`
   "answers a duplicate-key frame with INVALID_FRAME and keeps the connection usable"
2. **REST body 重复键 / 坏字节 ⇒ 400 JSON_INVALID**：合法载荷不受影响。
   → `tests/bff-rest.spec.ts` "rejects duplicate-key and invalid-UTF-8 bodies with 400 JSON_INVALID"
3. **失败文案泛化**：解析失败对外只给统一文案（`Invalid wire JSON.` /
   `The request body is not valid JSON.`），不回显解析器内部细节（位置、栈、V8 报错）。
   → `tests/wire-json.spec.ts` 对 `reason` 不含解析器细节的断言。

## REST BFF：分块上传 / 定时任务 / 官方语音（2026-10-28 起，未发版）

这三项原本只在 `/ws/mobile` 上提供，现在有同语义的 `/api/v1` 端点。新增对外端点必须重新过一遍
信任边界，不能因为「WS 那边已经安全」就默认 REST 也安全：

- **scope 分离**：读目录/列表/进度要 `chat.read`，开票/传块/合并/建改删任务/转写/改语音配置要
  `chat.write`；每个新端点都先过 `requireScope`，没有「先查后判」的绕过路径。
- **归属校验**：分块票据绑定开票时的 `sessionId` 与 principal 的授权范围；`sessionId` 不匹配、
  票据过期或不存在**一律 404**（不区分「别人的」与「没有的」，避免枚举）。定时任务每次请求都
  用当前 principal 重新判会话可见性，不复用跨请求缓存。
- **落盘**：spool 在 `<dataDir>/uploads-rest/<uploadId>/`，目录 0700、块文件 0600，`open` 用
  `O_EXCL` 防预置；合并成功后立即删除，票据取消/过期/停机也删除。文件名只接受裸名
  （拒绝路径分隔符与控制字符），不参与磁盘路径拼接。
- **请求体上限**：JSON ≤ 32 KiB、单个 chunk ≤ `chunkSize`（1 MiB）+ 4 KiB、语音 base64 ≤ 8 MiB
  （解码后仍≤ 4 MiB，与 WS 同一硬线）。超限一律 413，**不**读完整请求再判。
- **不回显上游细节**：内核 speech/schedule 的原始错误消息可能带主机路径，REST 只回稳定的
  `code` + 自写的 `details.reason`；`503 UPSTREAM_UNAVAILABLE` 不区分内核是「没装」还是「坏了」的
  内部堆栈。
- **不新增 scope**：复用既有七个，没有为这三项开新权限位；分块上传也不放宽单条附件的 24 MiB 体限制，
  它走独立的票据与 spool 路径。
- **429 / 限流**：沿用设备 token 桶；分块上传每连接不设独立并发闸（票据有 1 小时 TTL 与 256 MiB
  上限兜底），语音转写沿用 WS 同源的 4 MiB/180 s 约束，避免单个设备持锁。

对应的拒绝路径断言在 `tests/bff-rest.spec.ts`：未带凭据 401、缺 scope 403、跨会话 404、
缺块 409、超限 413、内核缺服务 503/200 两种退化形状。

## 内核端点归一：4 条永久留桥与 5 条可证伪断言（issue #26，2026-11-19）

issue #26 把桥手抄的 31 条内核语义入口换成了「内核端点 + 描述符驱动」（手机协议零改动）。
换源之后，**桥对手机的安全责任没有变**，但执行点变了：原来每条入口各自判，现在全部经
`kernel-invoke` 的参数预校验与（阶段 5 起）白名单。这五条是那次改造的验收断言，任何一条
不再成立都说明「安全面被换掉了一部分」：

1. **白名单之外的内核端点不可达。** 通用调用面只接受白名单里的端点，其余一律
   `METHOD_NOT_ALLOWED`，且错误码与白名单内**同样形状** —— 不能让客户端靠错误码差异
   枚举出「内核有这个端点、只是桥没开」。
2. **设备 scope 与授权根都不可绕过。** 缺 scope 一律 403；白名单要求的 scope 与 `auth.ts`
   的 `requireScope` 是同一份判据。**第二维**是会话可见性：会话类端点先过
   `chat.isSessionAuthorized(principal, sessionId)`，`session/search` 的结果在返回前按同一判据
   过滤 —— 内核网关看到的是 owner 主体，它自己的过滤恒放行，所以这一维只有桥能判。
   已建立的连接同样受约束：设备被撤销/降权后，下一条帧就会被复核并 `close(4001,'Device revoked')`。
3. **`kernel-call` 路径不产生交互。** owner peer 以 `interactions:'none'` 建立，
   通用调用面拿不到审批/提问交互入口 —— 一个被脚本化的客户端不能替人点「允许」。
4. **桥不再持有内核端点的 DTO 副本。** 门面里没有端点名常量表；端点名的唯一来源是
   内核描述符（wire 键、参数 schema 都从描述符读，不手写）。
5. **4 条永久留桥仍由桥执行。** `approvals.respond` / `userQuestions.cancel` /
   `sessions.readHandoffImage` / `sessions.uploadAttachmentStream` 的内核等价物不存在
   或语义更差（见 [ADR-0010](decisions/ADR-0010-kernel-endpoint-unification.md) 的落地登记表），
   它们仍在桥里，且流式上传的内存峰值不退化。

> **2026-11-19 检修补充（issue #26 后续）**：一审发现三处「单测测不到、线上会中」的缺口，
> 已修并各带回归用例 —— ①跨根读会话（上面断言 2 的第二维）②幂等键不含 endpoint 且失败也落表
> （同 callId 换个端点会回放上一条的结果；瞬时失败被缓存 24 h）③`retention` 的清理器没有生产
> 定时调用方，24 h 窗口必须由读取侧判。另修：`plugin-install-status` 缺 `installId` 时不再发
> `{requestId: undefined}`、未声明 `cancellation` 的端点不再假装「已取消」、整链补 30 s 截止时间。
> 路径探测端点 `session/workspacePathApplications` 已**移出**白名单（`chat.read` 即可拿任意宿主
> 绝对路径做存在性探测，属不必要的攻击面）。
>
> **按设计保留的两处暴露面**（不是漏，写在这里避免下次审计再报一遍）：①`kernel-endpoints`
> 帧会把白名单内每个端点的 `wires`/`scope`/`stream`/`summary` 广播给**任何**协商到 `dshrb-v1`
> 的连接（默认配对设备也算）—— 这是为了让客户端不必硬编码 wire 键，代价是低权限设备能看见
> 「白名单里有什么」（看不见内核全量，也看不见被拒端点）；②`ws-host.ts` 的 `canOpenPath`
> 仍恒 `false`（桌面侧「能否打开路径」的能力探测），与白名单里的 `session/canOpenWorkspacePath`
> 不是同一件事，前者不改。

**认领**（删掉哪条，红的就是哪条）：

| 断言 | 测试 |
|---|---|
| 1 | `tests/kernel-allowlist.spec.ts` › raises one indistinguishable error for a real-but-unlisted endpoint and for a nonexistent one；`tests/kernel-call.spec.ts` › denies an endpoint outside the allowlist before touching the catalog / reports an allowlisted endpoint that the catalog does not know |
| 2 | `tests/kernel-allowlist.spec.ts` › does not swallow a scope failure；`tests/kernel-call.spec.ts` › maps a missing device scope to 403-shaped failures / refuses a session outside the authorized roots without calling the kernel / filters search hits down to the sessions this device may read；`tests/mobile-gateway-ws.spec.ts` › closes an established connection once the device is revoked |
| 3 | `tests/kernel-call.spec.ts` › never lets the call surface reach an interaction（owner peer 由 `ws-host-services.ts` 以 `interactions:'none'` 建立） |
| 4 | `tests/kernel-deltas.spec.ts` › machine check（门面 ≤450 行；门面零端点名常量表） |
| 5 | `tests/dsh-0.2-bridge.spec.ts` › claims an approval request… / cancels a bridged front-of-house question…；`tests/handoff-hardening.spec.ts` › reads the bytes of an existing handoff file…；`tests/ws-file-transfer.spec.ts` › hands the kernel a byte stream… / falls back to the base64 path… |

> 写在这里的每一条都必须是**能跑红的**，不是「已具备」。断言 1~3 属阶段 5 的通用调用面
> （`kernel-allowlist.ts` 是唯一执法点、`kernel-call.ts` 是执行器）：默认拒绝先于目录查找、
> 默认拒绝先于 scope 判定 —— 顺序反过来就等于送攻击者一个免费的存在性探针。

## 插件帧（issue #26 阶段 7）：把「装插件」暴露成一次 WS 调用

手机侧新增的十个插件帧（`plugin-catalog` / `plugin-detail` / `plugin-inspect` /
`plugin-install` / `plugin-install-status` / `plugin-remove` / `plugin-update` /
`plugin-versions` / `plugin-registries` / `plugin-settings`）最终调用的是内核
`pluginManager/*`，其中 `installBundle` / `updateBundle` 会让宿主**执行新代码**。
这条攻击面不是新开的（`REST /api/v1/settings/plugins` 一直允许有 `settings.write`
的设备这么做），但阶段 7 把它挪到了通用面上，因此约束必须写清楚：

- **权限**：全部十条都要 `settings.read` 或 `settings.write`；`DEFAULT_DEVICE_SCOPES`
  不含 `settings.write`，设备必须被显式授予才能装/删/升/停用。
- **单一路径**：帧 → 端点只有 `kernel-allowlist.ts` 的 `KERNEL_FRAME_CALLS` 一张表，
  与 `kernel-call` 共用同一个 `KernelCallService` ⇒ 默认拒绝、scope 判据、在飞表、
  幂等全部同源；`tests/ws-kernel-frames.spec.ts` 断言「帧表里每个端点都在白名单内」，
  往表里塞一个没进白名单的端点会先红。
- **`inspect` 按写权限放行**：它收任意 spec（可含远端 URL），解析会出网 —— 用
  `settings.read` 就能让宿主替陌生地址发请求，所以按 `settings.write` 判。
- **不扩大内核能力**：`pluginManager` 不在钉死命名空间里是刻意选择 —— 它改的是
  profile 的插件配置，够不到本机凭据、也不起本桥的进程；安装脚本由内核自己的
  白名单执行，桥只做 scope 与参数校验，不做二次判定。
- **能力面**：未协商 `dshrb-v1`（或宿主无该服务）时这十帧回 `NOT_IMPLEMENTED`，
  老客户端行为逐字不变。

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
