# dsh-remote-bridge

<p align="center">
  <strong>把 DSH 内核的私有 remote 协议翻译成版本化 REST，供手机与第三方客户端远程访问这台机器；桌面端则提供一个集中设置中心。</strong>
</p>

<p align="center">
  中文 · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v2.2.0-087f8c">
  <img alt="DSH plugin" src="https://img.shields.io/badge/DeepSeek_Harness-plugin-1f2328">
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-586069">
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-2da44e">
</p>

`dsh-remote-bridge` 是 DeepSeek Harness（DSH）的远程访问桥接插件：它把 DSH 内核的私有 remote 协议翻译成版本化的 REST 接口，让 dsh-companion（[GitHub](https://github.com/westanke/dsh-companion) · [Gitee](https://gitee.com/westanke/dsh-companion)）等受信任客户端在离开电脑后仍能使用同一套聊天、工作区与文件能力；桌面端在你的 DSH 设置里提供一个「手机设置」，内联六个分区（根目录 / 远程访问 / 设备 / 回收站 / 审计 / App 下载）。**桌面端不再提供文件管理界面**：文件树与编辑器已于 2.2.0 删除，电脑上管理文件请走手机 App，或在会话里让 agent 用工具完成（见「桌面端不再有文件管理界面」）。

界面默认中文，可随时切换 English。插件支持 Windows、macOS 和 Linux，安装包已经包含编译产物，不要求用户在服务器上重新构建。

> **版本警告**：已发布的 `v2.0.0` 与 `v2.0.1` 存在严重缺陷（`v2.0.0` 历史图片读取全部失败，`v2.0.1` 插件无法激活）。请务必使用 **`v2.2.0`**（或 ≥ `v2.0.4`）。
> `v2.0.2` 与 `v2.0.3` **从未发布**，请不要按这两个版本号寻找安装包。

> **DSH 0.2.x 兼容性**：本分支在上游 `v1.0.0` 的基础上增加了对 DSH `0.2.0-rc.2` 的兼容层。
> 0.2.x 用 `dsh-api-gateway` 替换了提供 `apiProxy` 服务的 `dsh-host-apiproxy`，导致上游版本在
> 0.2.x 上无法启动（表现为「添加根目录返回 405」）。兼容层的完整说明——基于什么、为什么、改了什么、
> 测了什么——见 [DSH 0.2.x 兼容性适配说明](./docs/project/DSH-0.2-COMPAT.md)。

## 实际效果

桌面端的入口**就在你的 DSH 设置里**：打开设置，在「📱 手机访问」下面就是「📱 手机设置」，点进去直接内联渲染六个分区，不再另开弹窗。它只做设置，**不含文件树**——独立页 `/dsh-workspace` 以及其中的文件树、CodeMirror 编辑器已于 2.2.0 一并删除，理由与代价见下文「桌面端不再有文件管理界面」。

远程访问默认关闭。管理员可在本机 WebUI 中设置绑定 IP、端口和新设备的初始权限。

> 本节原先配有两张界面截图，但那是改名前的旧界面（标题仍是「DSH 文件工作区」；远程访问那张还标着 v1.0.0，且是文件树与设置两个弹窗叠加的形态），与上面描述的当前形态完全不符，已删除以免误导。缓存的旧截图不会自动更新，请以本节文字与 `docs/project/ARCHITECTURE.md` 为准。

## 关于改名（2.0.4）

插件由 `dsh-workspace` 改名为 `dsh-remote-bridge`。改名理由是：旧名字比内容窄——插件实际承担的是「把 DSH 内核的私有 remote 协议翻译成版本化 REST，供手机端远程访问这台机器」再加一个设置中心，而「workspace」只是其中一页。

**改名只动「安装时叫什么、bundle 叫什么」，以下几处对外契约刻意保持不变：**

| 保持不变 | 位置 | 为什么不能改 |
| --- | --- | --- |
| REST 前缀 `/dsh-workspace-api` | `src/host/server.ts` | 已发布的 App 把它写死了 |
| 状态目录（`dataDir`，默认 `dsh-workspace`） | DSH profile 配置 | 换目录等于让用户的授权根配置与回收站全部消失 |

**已不再列入契约的两项**（2.2.0 随独立页一并退役）：

- **独立页路径 `/dsh-workspace`**：该页面（文件树 + CodeMirror 编辑器）已删除，路径随之下线。注意它与 REST 前缀 `/dsh-workspace-api` 是两回事 —— **前缀还在，是 App 的对外契约；页面没了，不再承诺任何东西**。
- **浏览器存储键 `dsh-workspace-device-token`**：它只被那个已删的页面读写过，现在全仓库（含 App）已无任何读写方。一个没人读的键不构成契约，所以不列入上表；键名本身也不回收，以免日后排查时多一个迷惑项。

所以安装后看到 REST 地址或状态目录里仍然是 `dsh-workspace`，是**预期行为**，不是改名没改干净。

## 快速安装

### 环境要求

- 已安装并能正常启动的 DeepSeek Harness WebUI
- DSH 内核 `0.1.x` 或 `0.2.x`（0.2.x 由本分支的兼容层支持，见 [DSH 0.2.x 兼容性适配说明](./docs/project/DSH-0.2-COMPAT.md)）
- Node.js `^22.19.0` 或 `>=24.0.0`
- 默认端口 `3090` 可用，或准备一个其他端口

使用运行 DSH WebUI 的同一系统用户执行（两站任选其一，内容相同）：

```sh
# GitHub
dsh plugin --profile web add https://github.com/westanke/dsh-remote-bridge/releases/download/v2.2.0/dsh-remote-bridge-2.2.0.tgz

# Gitee（国内访问更快）
dsh plugin --profile web add https://gitee.com/westanke/dsh-remote-bridge/releases/download/v2.2.0/dsh-remote-bridge-2.2.0.tgz

npx @deepseek-ai/dsh web
```

> 本 README 由 GitHub 与 Gitee 共用同一份文件，因此凡是必须带主机名的地址（安装命令、Release 下载）
> 都会把两站都列出来 —— 相对链接可以跟着站点走，但 `/releases/download/...` 没有相对形式。

重启 DSH 后，打开设置就能看到「手机设置」（在「手机访问」下面）。它是**纯设置**，不含文件树；会话视图中工具轨迹旁的「文件」标签页已在 2.0.4 移除。**桌面端不再有浏览或编辑文件的界面**：独立页 `/dsh-workspace` 已在 2.2.0 删除，文件操作请走手机 App，或在会话里让 agent 用工具完成。

从 GitHub Release 下载离线安装包时，可直接安装 tarball：

```sh
dsh plugin --profile web add ./dsh-remote-bridge-2.2.0.tgz
```

## 第一次使用

1. 打开 DSH 设置，进入「手机设置」（在「手机访问」下面；默认落在「根目录」页）。
2. 在「根目录」页添加允许管理的本机目录，并为它起一个容易识别的名字。
3. 需要连接手机时，进入「远程访问」，填写绑定 IP 和端口并保存。
4. 点击“启用并创建配对”，再将十分钟内有效的一次性配对码填入 App。
5. 在手机 App 的文件页里选择授权根，即可浏览和编辑文件。

远程访问只有在至少存在一个授权根时才能开启。安装插件本身不会把服务暴露到局域网，未启用时只监听回环地址。

## 你可以做什么

### 桌面端不再有文件管理界面

2.2.0 删除了独立页 `/dsh-workspace`，包括整个文件树、上传下载入口和 CodeMirror 6 编辑器。原因是手机 App 的文件页已经原生覆盖同一套能力，桌面端这个页面没人用，却让发布包从 **0.25 MB 撑到 1.72 MB**。

代价要说清楚：**现在在电脑上动文件只剩两条路** ——

1. 在会话里对 agent 说话，让它用工具读写文件；
2. 打开终端自己操作。

手机端不受影响：App 的文件页照旧可用，走的是插件保留的同一套 REST 文件接口（`/dsh-workspace-api` 前缀与 `/roots`、`/roots/{rootId}/content` 等端点一个都没删）。回收站里的删除记录现在只来自手机 App。

### 桌面端设置面板

入口在 DSH 设置里，标题为「手机设置」。设置区**内联渲染**导航与内容，不另开弹窗；导航横排，默认落在「根目录」：

| 分区 | 用途 |
| --- | --- |
| 根目录 | 添加、移除授权目录并设置显示名称 |
| 远程访问 | 设置绑定 IP / 端口，启用远程访问并创建配对码 |
| 设备 | 查看设备权限与根目录授权，随时撤销 |
| 回收站 | 查看与恢复被删除的条目（只列出来自手机 App 的删除记录） |
| 审计 | 查看操作类型与对象的审计记录 |
| App 下载 | 扫码下载 Android 客户端，二维码指向两个站点的 Releases 列表页 |

侧栏那个齿轮按钮**已移除**：入口分散在侧栏图标和设置页两处，会让同一件事有两个起点。会话视图中工具轨迹旁的「文件」标签页也早已移除，桌面端现在只有这一个入口。

### 连接 Android App 或其他客户端

配套的 Android 客户端是 [dsh-companion](https://github.com/westanke/dsh-companion)（[Gitee](https://gitee.com/westanke/dsh-companion)）。
用手机扫描下面任意一个码即可下载 —— 两个码都指向**对应站点的 Releases 列表页**，
所以发新版不需要更换二维码：

| GitHub | Gitee（国内访问更快） |
| --- | --- |
| ![GitHub 上的 dsh-companion Releases](assets/app-qr-github.png) | ![Gitee 上的 dsh-companion Releases](assets/app-qr-gitee.png) |
| <https://github.com/westanke/dsh-companion/releases> | <https://gitee.com/westanke/dsh-companion/releases> |

> 二维码里写的是 Releases **列表页**，不是某个具体的 APK 文件名 ——
> 这样每次发新版都不必重新出图，扫码的人总能拿到最新版。
> 两张图由 `pnpm qr:app` 生成（`scripts/generate-app-qr.mjs`），
> 生成时用独立的解码器回读校验，测试也会把提交进仓库的图解回来核对。

装好 App 后，在「手机设置 → 远程访问」里生成配置文本或配对码即可连上本机。
公开 API 不依赖 DSH 私有协议，也可用于其他客户端：

- 查看、新建、重命名和移除 DSH 工作区登记。
- 创建、重命名、分叉和归档会话。
- 读取消息、流式接收正文和思考、追加引导或取消运行。
- 查看 TODO、斜杠命令、权限模式和待审批操作。
- 选择 Agent、模型和思考强度。
- 查看或修改模型供应商，支持完全自定义供应商。
- 管理设备获准访问的文件和回收站项目。

## 远程访问与安全

默认远程地址为 `0.0.0.0:3090`，IP 和端口都可修改。客户端可以使用能到达服务器的 IP 或域名连接。

插件允许直接使用 HTTP，不强制配置证书。这对可信局域网和临时部署比较方便，但要清楚它的代价：

> HTTP 会明文传输设备令牌、聊天内容和文件内容。在公网或不可信网络中，请使用 Caddy/Nginx 配置 HTTPS，或通过 VPN、Tailscale/WireGuard、SSH 隧道等可信通道连接。

无论是否使用 HTTPS，以下保护都会生效：

- 十分钟有效且只能使用一次的配对码。
- 256 位设备令牌，服务器只保存摘要。
- 可撤销的设备权限与独立根目录授权。
- 配对、认证和普通请求分别限流。
- 审计记录操作类型和对象，但不记录令牌、文件正文或聊天正文。
- 新增根目录不会自动授权给已经配对的设备。

只有来自回环地址的管理界面可以添加根目录、调整设备权限、生成配对码、修改监听设置和永久清理回收站。

## 文件边界

外部接口只接受 `rootId + relativePath`，不会接收服务器绝对路径。路径还会经过以下检查：

- wire path 统一使用 `/`。
- 拒绝绝对路径、盘符、UNC、反斜杠、空字节以及 `.`、`..` 路径段。
- 每次操作逐段检查 symlink、junction 和 reparse point，禁止借助链接逃出授权根。
- 删除末端链接时只删除链接本身，不递归进入链接目标。
- 临时保存文件放在目标目录中，避免跨挂载点替换失败。

“移除 DSH 工作区”只删除 WebUI 中的登记，服务器目录、文件和会话日志不会被删除。“归档会话”只将会话从默认列表隐藏，日志仍会保留。

## 对外接口

REST 基址：

```text
http://HOST:PORT/api/v1
```

除健康检查和配对交换外，请求需要设备令牌：

```http
Authorization: Bearer DEVICE_TOKEN
```

| 接口 | 用途 |
| --- | --- |
| `GET /healthz` | 查看服务状态、API 版本和插件版本 |
| `POST /pairings/exchange` | 使用一次性配对码换取设备令牌 |
| `GET /devices/self` | 查看当前设备、权限和根目录授权 |
| `GET /roots` | 列出设备可访问的文件根 |
| `GET/POST/PATCH/DELETE /roots/{rootId}/entries` | 列目录、新建、移动、重命名和移入回收站 |
| `GET/PUT /roots/{rootId}/content` | 读取、Range 下载、上传和带 ETag 保存 |
| `GET /trash`、`POST /trash/{id}/restore` | 查看与恢复回收项 |
| `GET/POST /chat/workspaces` | 列出或登记 DSH 工作区 |
| `PATCH/DELETE /chat/workspaces/{id}` | 重命名或移除工作区登记 |
| `GET/POST /chat/sessions` | 列出或创建会话 |
| `PATCH /chat/sessions/{id}` | 重命名会话 |
| `POST /chat/sessions/{id}/fork` | 分叉会话 |
| `POST /chat/sessions/{id}/archive` | 归档会话 |
| `GET/POST /chat/sessions/{id}/messages` | 读取历史、发送消息或追加引导 |
| `GET/POST /chat/sessions/{id}/commands` | 列出或执行 host 斜杠命令 |
| `GET/POST /chat/sessions/{id}/approvals...` | 查看和处理待审批操作 |
| `GET /chat/sessions/{id}/models`、`PUT .../model` | 读取模型目录并切换模型或思考强度 |
| `PUT /chat/sessions/{id}/agent-preset` | 在首条消息前切换 Agent |
| `POST /chat/runs/{id}/cancel` | 取消正在运行的会话 |
| `GET/POST/PATCH/DELETE /settings/...` | 管理供应商、凭据状态、模型发现和自定义供应商 |
| `WS /events` | 接收聊天增量、运行、审批和文件变更事件 |

完整字段、响应和错误模型见 [OpenAPI 3.1](./docs/api/openapi.yaml)，实时事件格式见 [AsyncAPI](./docs/api/asyncapi.yaml)。仓库同时提供 [Kotlin SDK](./kotlin-sdk/README.md)。

错误响应保持统一：

```json
{"error":{"code":"ERROR_CODE","message":"Readable message","requestId":"..."}}
```

## 设备权限

| Scope | 允许的操作 |
| --- | --- |
| `chat.read` | 查看工作区、会话、消息、TODO、命令和审批 |
| `chat.write` | 管理工作区与会话、发消息、切换配置、执行命令和处理审批 |
| `files.read` | 浏览、读取和下载文件，查看回收站 |
| `files.write` | 新建、编辑、上传、移动和重命名 |
| `files.delete` | 将文件或目录移入插件回收站 |
| `settings.read` | 查看供应商有效配置和凭据是否已配置 |
| `settings.write` | 修改供应商、写入凭据和创建自定义供应商 |

设备还必须获得相应 `rootId` 的授权。权限和根目录授权都可以在本机 WebUI 的“设备”页随时修改或撤销。

## 升级与卸载

升级前建议先停止 DSH WebUI，再安装新版本并重新启动。卸载命令：

```sh
dsh plugin --profile web remove dsh-remote-bridge
```

默认状态保存在当前 `DSH_HOME` 下的 `dsh-workspace` 目录。卸载插件不会自动删除状态目录或回收站，以免误删尚未恢复的数据。

插件改名（2.0.4）不会改变这个目录名：升级后原有的授权根配置与回收站仍在原处，无需迁移。

## 兼容性与已知限制

### 某些 DSH 构建缺少附件存储服务

DSH 的 cordis 注入属性（`ctx.attachments` / `ctx.fileUploads`）是惰性解析的：读取一个没有任何组件提供的服务会抛错。2.0.3 起改为**容错读取**——服务缺席时插件照常激活，只有真正用到该能力的接口返回可读错误：

- `ATTACHMENT_STORE_UNAVAILABLE`：拿不到 `ctx.attachments`，历史图片的字节无法读取。
- `FILE_UPLOADS_UNAVAILABLE`：拿不到 `ctx.fileUploads`，无法发送附件。

用户可见的后果：**如果这台机器的 DSH 不提供附件存储服务，会话历史里的图片会读不出来，但插件其余功能全部正常**；客户端会显示具体原因，而不是含糊的「图片不可用」。

## 常见问题

**安装后看不到「手机设置」**

入口在 DSH 设置里，位于「手机访问」下面。如果看不到，确认插件安装在 `web` profile，并在安装后**重启 DSH**（插件为进程内加载，不重启不生效）。

**桌面上找不到浏览或编辑文件的界面**

这是 2.2.0 的有意改动：独立页 `/dsh-workspace` 已删除，桌面端不再提供文件管理界面。请在手机 App 的文件页操作，或在会话里让 agent 用工具读写文件。

**“启用并创建配对”按钮不可用**

先添加至少一个授权根。如果刚修改过绑定 IP 或端口，还需要先保存监听设置。

**手机无法连接**

检查远程访问是否已启用，服务器防火墙和云安全组是否放行端口，以及 App 中填写的地址是否能从手机到达。不要填写服务器自己的 `127.0.0.1`。

**保存文件时提示冲突**

文件已经被其他窗口或程序修改。重新加载，合并需要保留的内容后再保存。

## 从源码构建

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

`pnpm check` 覆盖类型检查、文档一致性与测试；当前 **19 个测试文件 / 113 个用例**，外加 **3 个浏览器层用例**（Playwright 实测量出的计算样式），全部通过。

`pnpm pack` 的产物约 **0.25 MB**：2.2.0 删除独立页及其编辑器依赖、并关闭 source map 之后，从 1.72 MB 降下来。

v2.2.0 基于 DSH `master@47f943859bef60e4160492346772ded9b24f765a` 开发，CI 覆盖 Windows、Ubuntu 和 macOS。

## 项目信息

- 当前版本：`v2.2.0`
- 作者：上游 [Hakunm](https://github.com/Hakunm)，本 fork 维护 [westanke](https://github.com/westanke)
- 仓库：[GitHub](https://github.com/westanke/dsh-remote-bridge) · [Gitee](https://gitee.com/westanke/dsh-remote-bridge)
- 许可证：[GNU Affero General Public License v3.0](./LICENSE)
- Android 客户端：dsh-companion（[GitHub](https://github.com/westanke/dsh-companion) · [Gitee](https://gitee.com/westanke/dsh-companion)），上游 [dsh-android-app](https://github.com/Hakunm/dsh-android-app) 的 fork，与本插件配套
