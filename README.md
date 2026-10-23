# dsh-remote-bridge

<p align="center">
  <strong>把 DSH 内核的私有 remote 协议翻译成版本化 REST，供手机与第三方客户端远程访问这台机器；桌面端则提供一个集中设置中心。</strong>
</p>

<p align="center">
  中文 · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v2.6.1-087f8c">
  <img alt="DSH plugin" src="https://img.shields.io/badge/DeepSeek_Harness-plugin-1f2328">
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-586069">
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-2da44e">
</p>

`dsh-remote-bridge` 是 DeepSeek Harness（DSH）的远程访问桥接插件：它把 DSH 内核的私有 remote 协议翻译成版本化的 REST 接口，让 dsh-companion（[GitHub](https://github.com/westanke/dsh-companion) · [Gitee](https://gitee.com/westanke/dsh-companion)）等受信任客户端在离开电脑后仍能使用同一套聊天、工作区与文件能力；桌面端在你的 DSH 设置里提供一个「手机设置」，内联七张设置卡片（根目录 / 远程访问 / 设备 / 识图 / 回收站 / 审计 / App 下载），每张卡片各自折叠、可多张同时展开。）。

界面默认中文，可随时切换 English。插件支持 Windows、macOS 和 Linux，安装包已经包含编译产物，不要求用户在服务器上重新构建。

> **版本警告**：请务必使用  ≥ `v2.0.4`版本。

> **DSH 0.2.x 兼容性**：本分支在上游 `v1.0.0` 的基础上增加了对 DSH `0.2.0-rc.2` 的兼容层。
> 0.2.x 用 `dsh-api-gateway` 替换了提供 `apiProxy` 服务的 `dsh-host-apiproxy`，导致上游版本在
> 0.2.x 上无法启动（表现为「添加根目录返回 405」）。兼容层的完整说明——基于什么、为什么、改了什么、
> 测了什么——见 [DSH 0.2.x 兼容性适配说明](./docs/project/DSH-0.2-COMPAT.md)。
>
> **对 DSH 0.2.1-rc.2 的适配结论**（2026-10-20 复核，依据 `docs/project/DSH-0.2.1-ADAPTATION.md`）：
> 本插件**刻意不 import 任何 `@deepseek-ai/*` 包**，全部宿主服务经结构类型 + Host 注入消费
> （见 `src/host/dsh-0.2-bridge.ts` 头注释）。逐一到 `0.2.1-rc.2` 实装包核对：`cordis.patch.yml`
> 的 10 项 `inject` 服务名**全部仍存在且签名未变**，`engines.dsh` 在 0.2.1 被内核识别
> （`dsh-app-boot/lib/index.js` 的 `prepareProfileEntries`），不满足时只把该 entry 置
> `disabled` 并打 stderr，**宿主进程不退出**。故本插件无需改码即可运行于 `0.2.1-rc.2`。
>
> **两版的功能差异（重要）**：`inject` 里只放**两个版本都存在**的服务 —— cordis 的 inject 是
> **硬依赖**，任何一个服务缺失就整个插件不激活（CI 在 0.2.0-rc.2 基线上实锤过：
> 一度因为把 0.2.1 才有的服务写进 inject 而让插件在 0.2.0 上整体不激活）。
> 因此 0.2.1 才提供的服务（**后台任务** `jobController`、**权限档位目录**
> `permissionPresets`、文件上传 `fileUploads`、附件存储 `attachments`）改为运行时经
> `ctx.reflect.get(name, false)` 读取：**0.2.1-rc.2 上这些功能全部可用，0.2.0-rc.2 上
> 自动降级**（如后台任务端点返回 404、权限档位走内置目录），插件本体两种内核都能跑。
> 用 `GET /api/v1/debug/host-services` 可以查这台机器上哪些可选能力可用。

## 实际效果

桌面端的入口**就在你的 DSH 设置里**：打开设置，找到标题为「📱 手机设置」的一节，点进去直接内联渲染七张折叠卡片，不再另开弹窗。它只做设置。

远程访问默认关闭。管理员可在本机 WebUI 中设置绑定 IP、端口和新设备的初始权限。

![手机设置 —— 默认展开的「根目录」卡片](assets/screenshots/panel-roots.png)

> **关于这几张截图。** `assets/screenshots/` 下的四张图由 `scripts/generate-screenshots.ts` 生成，它用与测试同一份产出来源渲染面板 —— `ADMIN_TABS`、`WORKSPACE_CSS`、`APP_QR_CODES` 全部取自 `src/client/`，所以你看到的是**发布包里的标记与样式表**，不是另画的示意图。图中呈现的是一台刚装好插件、尚未启用远程访问的机器，这是最诚实的默认状态。本 README 早前曾放过两张界面截图，但都摄于改名之前（标题还是「DSH 文件工作区」，远程访问那张还标着 v1.0.0，且把文件树与设置显示成上下两个弹窗），与上文描述的形态已不符，于是撤掉而不是留着误导。
>
> 市场会从 [`screenshots.json`](./screenshots.json) 自动取用这些图 —— 不必再来提 PR、不必等维护者。换了图直接推自己的仓库即可，下一次构建自动生效。


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
- DSH 内核 **`>=0.2.0-rc.2 <0.3.0`**（兼容 `0.2.0-rc.2` 及其后全部 `0.2.x`，含 `0.2.1-rc.2`；由本分支的兼容层支持，见 [DSH 0.2.x 兼容性适配说明](./docs/project/DSH-0.2-COMPAT.md)）。
  `package.json` 的 `engines.dsh` 已声明同一范围 —— 内核按 semver 裁决，不满足时该插件被**禁用**（宿主进程不退出），用户可按内核提示授予精确版本豁免。
- Node.js `^22.19.0` 或 `>=24.0.0`
- 默认端口 `3090` 可用，或准备一个其他端口

使用运行 DSH WebUI 的同一系统用户执行。**推荐用 npm 包名**（三种方式装的是同一份产物）：

```sh
# ① npm 包名（推荐：装的是预构建产物，不需要 pnpm 的构建授权）
dsh plugin --profile web add dsh-remote-bridge

# 国内镜像更快时，指定 registry
dsh plugin --profile web add dsh-remote-bridge --registry https://registry.npmmirror.com

# ② GitHub Release 的 tarball
dsh plugin --profile web add https://github.com/westanke/dsh-remote-bridge/releases/download/v2.6.1/dsh-remote-bridge-v2.6.1.tgz

# ③ Gitee Release 的 tarball（国内访问更快）
dsh plugin --profile web add https://gitee.com/westanke/dsh-remote-bridge/releases/download/v2.6.1/dsh-remote-bridge-v2.6.1.tgz

npx @deepseek-ai/dsh web
```

> `dsh plugin add` 底层就是 `pnpm add`，因此 `--registry` 等 pnpm 选项可直接使用。
>
> 本 README 由 GitHub 与 Gitee 共用同一份文件，因此凡是必须带主机名的地址（安装命令、Release 下载）
> 都会把两站都列出来 —— 相对链接可以跟着站点走，但 `/releases/download/...` 没有相对形式。
> npm 包名与 GitHub 上的仓库同名，两站看到的都一样。

重启 DSH 后，打开设置就能看到「手机设置」。它是**纯设置**，不含文件树；会话视图中工具轨迹旁的「文件」标签页已在 2.0.4 移除。**桌面端不再有浏览或编辑文件的界面**：独立页 `/dsh-workspace` 已在 2.2.0 删除，文件操作请走手机 App，或在会话里让 agent 用工具完成。

从 GitHub Release 下载离线安装包时，可直接安装 tarball：

```sh
dsh plugin --profile web add ./dsh-remote-bridge-v2.6.1.tgz
```

## 第一次使用

1. 打开 DSH 设置，进入「手机设置」；默认落在「根目录」页）。
2. 在「根目录」页默认添加允许管理的DSH当前目录。
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

入口在 DSH 设置里，标题为「手机设置」。设置区**内联渲染**，不另开弹窗；七张折叠卡片平铺，可多张同时展开，默认展开「根目录」：

| 分区 | 用途 |
| --- | --- |
| 根目录 | 添加、移除授权目录并设置显示名称；DSH 当前的工作区会作为**默认根**自动登记（不可删除，但可正常访问） |
| 远程访问 | 设置绑定 IP / 端口，启用远程访问并创建配对码 |
| 设备 | 查看设备权限与根目录授权，随时撤销 |
| 识图 | 设置图片交接目录（识图路径），并只读展示出厂默认 `.dsh-images` 与兜底目录 |
| 回收站 | 查看与恢复被删除的条目（只列出来自手机 App 的删除记录） |
| 审计 | 查看操作类型与对象的审计记录 |
| App 下载 | 扫码下载 Android 客户端，二维码指向两个站点的 Releases 列表页 |


### 图片交接：手机发的图，桌面也看得见

模型看不到图时（纯文本模型），本插件会在**发消息之前**把图存成工作区文件，消息里只留两样东西：一句人话（图存在哪、要看图怎么办）+ 一行给识图工具读的绝对路径。

现在 **DSH WebUI 也会在该轮末尾把这张图画出来** —— 点击看原图、`Escape` 或点任意处关闭，图下面仍然保留那条路径。手机 App 那边一直可以显示，桌面这边此前只有一段文字；两边现在一致了。

- **落点**：`<会话工作目录>/<识图路径>/<sha256>.<ext>`，文件名是内容哈希，所以同一张图反复发不会堆副本（目录 0700、文件 0600）。
- **识图路径**默认 `.dsh-images`，在设置页「识图」里可以改，改完立即生效、不需要重启；**「当前默认」那一栏是只读的** —— 历史交接消息和识图工具都按它写过路径，它不跟着你的修改走。旁边还列出解析不出会话工作目录时用的兜底目录。
- **只认交接句式**，而且只认**你自己发的那条消息**：助手正文、上下文注入、工具输出里出现的 `.dsh-images/…` 不会被渲染成图（对话里到处都是这种引用，读它们只会把别人的话切成碎图）。

> 如果你此前装过 [dsh-image-paths](https://github.com/lunar-tear/dsh-plugins)，请把它那一行**停用**：两个插件的图集会挂在同一个位置，同一张图会被画两遍。本插件已自带这套能力。

### 连接 Android App 或其他客户端

配套的 Android 客户端是 [dsh-companion](https://github.com/westanke/dsh-companion)（[Gitee](https://gitee.com/westanke/dsh-companion)）。
用手机扫描下面任意一个码即可下载 —— 两个码都指向**对应站点的 Releases 列表页**，
所以发新版不需要更换二维码：

| GitHub | Gitee（国内访问更快） |
| --- | --- |
| ![GitHub 上的 dsh-companion Releases](assets/app-qr-github.png) | ![Gitee 上的 dsh-companion Releases](assets/app-qr-gitee.png) |
| <https://github.com/westanke/dsh-companion/releases> | <https://gitee.com/westanke/dsh-companion/releases> |

> 二维码里写的是 Releases **列表页**，不是某个具体的 APK 文件名 ——


装好 App 后，在「手机设置 → 远程访问」里生成配置文本或配对码即可连上本机。
公开 API 不依赖 DSH 私有协议，也可用于其他客户端：

- 查看、新建、重命名和移除 DSH 工作区登记。- 创建、重命名、分叉和归档会话。
- 读取消息、流式接收正文和思考、追加引导或取消运行。
- 查看 TODO、斜杠命令、权限模式和待审批操作。
- 选择 Agent、模型和思考强度。
- 查看或修改模型供应商，支持完全自定义供应商。
- 管理设备获准访问的文件和回收站项目。

### 远程开隧道：人已经出门、电脑还锁着

常见场景：**人已经出门，才发现电脑上的 Cloudflare 隧道没开，配置文本也没发给自己**。
此时公网入口根本不存在，WebUI 和 App 都够不着这台机器。能用的只剩「本机主动连出去」的通道，
装了 `@xmanrui/dsh-im`（微信 / 飞书 / 钉钉 / 企业微信 / Telegram …）或任何带命令栏的客户端时，
有两条入口可以做这件事：

**① 桌面 WebUI 的命令栏（立即可用）**

```
/tunnel
```

回的是这样一段：

```
云隧道已开启。
地址：https://<random>.trycloudflare.com
设备名：Android 设备
配置文本（一行，复制后粘贴到 App 的「导入配置」）：
DSH1:eyJ2IjoxLCJlbmRwb2ludHMiOlt7ImxhYmVsIjoi…
```

**② IM 聊天窗口里用一句话（配合智能体）**

在微信/飞书里直接说「**帮我开隧道，把配置文本发我**」，智能体会调用本插件的
`open_tunnel_config` 工具，把同样的地址与 `DSH1:` 文本回到聊天里。

> 为什么 IM 里不是发 `/tunnel`？因为 `@xmanrui/dsh-im` 的斜杠命令表是**封闭的**：
> 内置 31 条，另外只把 `/compact` `/clear` `/permission` 三条委派给宿主，没有
> 「未知命令转交宿主命令表」的通用派发，也从不查询宿主的命令列表。所以 `/tunnel`
> 在 IM 里会当成一句普通消息交给智能体 —— 这也正是上面第 ② 条走自然语言 + 工具的原因。
> 如果 dsh-im 以后加上通用派发，`/tunnel` 会立刻可用，桥这边不用改。

隧道**已经在跑**时再触发一次不会重复开，而是复用当前地址再给一份配置文本
（每次调用都会新建一台设备，方便在面板里单独吊销）。

能力边界刻意压得很小：**只能开，不能停、不能改配置、不读任何文件**。
带参数一律拒绝，不提供 `/tunnel stop` 这类第二入口。就算口令泄露，损失上限也只是
「隧道被人开了一下」—— 隧道本身不授予任何数据面权限（读文件、发消息仍要设备令牌）。

> ⚠️ **必要前提：IM 机器人必须是白名单模式，且白名单里只有你自己。**
> 这条通道的身份校验**不在本插件里**，而在 IM 插件自己的访问策略（`canExecuteCommands` +
> allowlist）。如果机器人设成「允许所有用户私聊执行命令」，那等于把开机按钮放到公共群里 ——
> 这是部署问题，代码替你兜不住。详见 [SECURITY.md](docs/project/SECURITY.md#im-命令tunnel的信任边界)。

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
- 供应商 `baseURL` 只能指向公网 http(s) 地址；把「已经存有凭据」的供应商换到新 host
  还必须同时提供新的 API key —— 因为内核会带着那把 key 去请求这个地址，这是凭据边界，
  不只是 SSRF。

只有来自回环地址的管理界面可以添加根目录、调整设备权限、生成配对码、修改监听设置和永久清理回收站。

### 自建 LLM（ollama / LM Studio）

私网、回环、链路本地与 CGNAT 的供应商地址**默认拒绝**。要用本机模型服务，在插件配置里
显式放行：

```yaml
allowPrivateProviderHosts:
  - 127.0.0.1:11434     # 推荐：钉住端口
  - 192.168.1.5         # 裸 host：放行该主机的全部端口
```

只接受精确 `host` 或 `host:port`，**不支持 CIDR**。推荐带端口写法：放行 `192.168.1.5`
等于放行它上面所有服务，而 ollama 只在 11434。理由与审计字段见
[docs/project/SECURITY.md](docs/project/SECURITY.md#供应商-baseurl-的地址策略261-起sec-h11)。

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

设备还必须获得相应 `rootId` 的授权。权限和根目录授权都可以在本机 WebUI 的“设备”页随时修改。

**新增的权限是配对前在「远程访问」里勾选的**：勾什么，生成的配对码就带什么；APP 输入配对码后这些权限随设备一起生效。已在用的设备则到「设备」里点它的「权限」修改。

默认勾选是五档 —— `chat.read`、`chat.write`、`files.read`、`files.write`、`settings.read`，**刻意不含** `files.delete` 与 `settings.write`。你仍然可以自己勾上；默认值只是不再替你做这个决定。

### 设备名与型号

配对那一刻桥并不知道将来是谁来用这个令牌，所以新设备先得到一个**平台无关**的占位名（`Mobile device`）。设备第一次连上来时，桥会从请求里识别平台与型号，把名字自动换成「平台 · 型号」（比如 `HarmonyOS · ICL-AL10`）。

平台判定优先看客户端上报的 `X-Dsh-Device: <platform>/<model>` 头，没有就从 `User-Agent` 兜底。**型号只认客户端上报**：OkHttp 与 ArkWeb 的默认 UA 里都没有机型，桥不会去猜 —— 猜错的型号比没有型号更糟。

在「设备」页点「权限」可以直接改名。**你手动改过的名字不会再被自动覆盖**；自动生成的名字在设备上报了新身份时仍会更新。设备名只用于显示与排查，不参与任何授权判断。

**撤销一台设备会直接把它从数据库里删除**，不是打个标记留着；它的授权随之清除，但审计记录（谁在什么时候撤了谁）会保留。

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

入口在 DSH 设置里，标题为「📱 手机设置」。如果看不到，确认插件安装在 `web` profile，并在安装后**重启 DSH**（插件为进程内加载，不重启不生效）。

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

`pnpm check` 覆盖类型检查、文档一致性与测试；当前 **67 个测试文件 / 557 个用例**，外加 **8 个浏览器层用例**（Playwright 实测量出的计算样式，含 375px 窄屏契约），全部通过。

`npm pack` 的产物约 **0.64 MB**（v2.6.1 实测 669,434 字节，SHA-256 `9bf0189b…2cd35`）：2.2.0 删除独立页及其编辑器依赖、并关闭 source map 之后从 1.72 MB 降下来，之后随投影透传、权限 BFF 与五维加固小幅增长。

v2.5.0 在 DSH **0.2.1-rc.2** 上完成真机验证：14/14 宿主服务全部可注入、三个 jobs 端点实测通过、
权限档位目录返回内核真实三档。开发基线为上游 `dsh-v0.2.1-rc.2`（commit `687f282e8625c6b8d11ff58211a90524be2e4317`），
兼容范围见上文 `engines.dsh`。CI 覆盖 Windows、Ubuntu 和 macOS。

**v2.6.1 的验证状态**：74 个测试文件 / 682 个用例全绿、8 个 Playwright 浏览器用例
（含 375px 窄屏契约）、`typecheck`/`docs:check`/构建通过。SEC-H11 的攻击链是**用实测**
确认的（起一个假 LLM 端点，抓到内核把真实 `Authorization: Bearer` 打过去），修复后的
四道闸门各有回归断言；设备身份的三个 spec（27 + 13 + 12 例）覆盖 UA 判定顺序、
「`declared` 永不覆盖」与老表结构迁移幂等。

## 项目信息

- 当前版本：`v2.6.1`
- **v2.6.1 是安全修复 + 设备身份版**：修掉一个**高危**问题 —— 供应商 `baseURL` 的三个入口
  （新建 / 修改 / 探测模型）此前不做任何校验，持有 `settings.write` 的设备可以把 baseURL
  指向自己的服务器，内核会带着**该供应商的真实 API key** 去请求 `/models`，等于凭据直接外泄；
  持久化变体更糟：改完 baseURL 之后正常聊天都会把 key 发过去。现在三道闸门（协议白名单、
  私网默认拒绝 + `allowPrivateProviderHosts` 显式放行、换 host 且已有凭据时必须同时给新 key），
  配对默认权限也从七档收到五档（不再默认给 `settings.write` 与 `files.delete`）。
  另修「设备名永远是『Android 设备』」：桥现在从 `X-Dsh-Device` 头（UA 兜底）识别平台与型号，
  自动把占位名换成「平台 · 型号」，并新增改名通道（手动改过的名字永不被自动覆盖）。
- **v2.6.0 是通用设置面 + IM 入口版**：新增「按插件划分的设置命名空间」两个端点（手机端照 schema 自建表单，新装插件无需改 App），以及「人已出门、电脑还锁着」时用 IM 一句话开隧道并收回配对配置的双入口（宿主命令 `/tunnel` + 工具 `open_tunnel_config`）；另加一键清理 N 天未使用设备、移除审计页，并把「激活期降级保护」补上（apply 尾部抛错不再拆掉整条插件上下文）。
- **v2.5.2 是全量完善版**：落地五维审计（安全/功能/性能/界面/按钮反馈）——含高危的
  `debug/host-services` 免鉴权信息泄露修复、限流双桶、广播背压、弱 ETag、审计保留策略等，
  并把「一键开隧道并生成令牌」做成同一次请求内搭车完成；隧道运行时管理面安全锁定，
  仅保留「停止隧道」出口，停止后自动恢复。v2.5.1 的安全模型（开隧道时 `/manage` 403、
  四层管理判据）保持不变，见 `docs/project/SECURITY.md` §管理面的信任边界。
- **v2.5.1 是安全修复版**：堵住「开隧道/反代后管理面免凭据对公网开放」的远程提权（`/manage/**`
  与回环 admin 头此前只按「TCP 来源是否回环」判定，而隧道转发进来的请求来源恒为 `127.0.0.1`），
  并修复 `.heif` 交接图必被只读路由 415 的问题。
- 作者：上游 [Hakunm](https://github.com/Hakunm)，本 fork 维护 [westanke](https://github.com/westanke)
- 仓库：[GitHub](https://github.com/westanke/dsh-remote-bridge) · [Gitee](https://gitee.com/westanke/dsh-remote-bridge)
- npm：[`dsh-remote-bridge`](https://www.npmjs.com/package/dsh-remote-bridge)（[国内镜像](https://registry.npmmirror.com/dsh-remote-bridge)）
- 许可证：[GNU Affero General Public License v3.0](./LICENSE)
- Android 客户端：dsh-companion（[GitHub](https://github.com/westanke/dsh-companion) · [Gitee](https://gitee.com/westanke/dsh-companion)），上游 [dsh-android-app](https://github.com/Hakunm/dsh-android-app) 的 fork，与本插件配套
