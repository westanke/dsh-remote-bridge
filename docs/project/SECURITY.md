# 安全模型

## 信任边界

- 安装后 listener 默认只绑定回环地址。远程启用成功后才绑定管理员配置的数值 IPv4/IPv6 地址并生成配对码；默认远程目标为 `0.0.0.0:3090`。
- 绑定 IP 和端口只能由回环管理面修改。远程已启用时必须先关闭再修改；重绑定失败会恢复原监听地址，不提交错误配置。
- 登记根、授权设备、撤销、切换监听和永久清理只接受回环 socket 与可信本机 Origin；`Origin: null` 被拒绝。内部文件调用还必须携带插件管理头。不信任 `X-Forwarded-For`，普通本机 API 请求不会自动提升为管理员。
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

## HTTP 与 HTTPS

HTTP 是受支持的连接方式，不会被强制跳转或拒绝。但 Bearer token、聊天和文件内容都可能被同网段监听者读取或修改。公网、不可信 Wi-Fi 和共享局域网应在 listener 前使用 Caddy/Nginx HTTPS、VPN 或可信隧道。

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
