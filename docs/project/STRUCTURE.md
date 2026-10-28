# 目录结构（代码地图）

本文回答三个问题：**东西在哪、谁调谁、新东西该放哪**。
「为什么这么设计」看 [ARCHITECTURE.md](ARCHITECTURE.md)，「接口长什么样」看
[INTERFACES.md](INTERFACES.md)，「原先踩过什么坑」看 [PITFALLS.md](PITFALLS.md)。

> **本文是给 AI 与人共用的导航图，不是目录复述。** 改代码前先按这张图定位，
> 改完按文末「机检锚点」同步 —— 那份锚点归 `pnpm docs:check` 双向校验，
> 漏登记 `src/` 下任何一个文件都会让门禁变红（见 [AGENTS.md](../../AGENTS.md) §3.4）。

---

## 1. 顶层目录树

```
dsh-remote-bridge/
├── src/                     源码（插件的全部实现，见 §3 分层）
│   ├── index.ts             插件入口：apply / inject / 生命周期装配
│   ├── host/                宿主侧：HTTP 服务、路由、各类 adapter、持久层
│   ├── client/              DSH WebUI 浏览器半边（React 面板 + 图片交接渲染）
│   └── shared/              双端共享的契约类型与版本号
├── tests/                   vitest 单元与合约测试（44 个 spec，见 §5）
├── e2e/                     playwright 样式契约（4 用例，无需服务器）
├── scripts/                 发版 / 推送 / 文档门禁 / 探针脚本（不是运行时代码）
├── kotlin-sdk/              给 Android 客户端的 Kotlin SDK（随包分发）
├── docs/
│   ├── api/                 OpenAPI + AsyncAPI：wire schema 的**权威**
│   └── project/             开发事实来源（状态 / 决策 / 坑位 / 本文）
├── assets/                  面板截图与应用下载二维码（进发布包）
├── artifacts/               本地打包产物与 Release 正文（**勿手改**）
├── lib/                     构建产物（tsdown 输出，**勿手改**）
└── .github/workflows/       CI 与镜像从站同步
```

根级配置文件各自的分工：

| 文件 | 用途 |
| --- | --- |
| `package.json` | 包身份、`exports`、`engines.dsh`（内核范围真值来源）、全部 npm 脚本 |
| `tsdown.config.ts` | 打包配置（产出 `lib/index.js` / `lib/client.cjs` / 类型声明） |
| `vitest.config.ts` | 单测配置 |
| `playwright.config.ts` | e2e（样式契约）配置 |
| `cordis.patch.yml` | Profile patch：插入 Host row 并声明 `inject`（与 `src/index.ts` 双向对齐，`docs:check` 盯着） |
| `tsconfig.json` | `tsc --noEmit` 的口径 |

---

## 2. 分层与依赖方向

```
                     ┌──────────────────────────────────────────┐
  HTTP/SSE/WS 请求 →  │ src/host/server.ts                        │  监听器 + 鉴权装配 + 事件扇出
                     │  （RemoteApiServer / attachEmbeddedRoutes）│
                     └───────────────┬──────────────────────────┘
                                     ↓
                     ┌──────────────────────────────────────────┐
                     │ src/host/router.ts  (ApiRouter)            │  唯一路由分派点
                     └───┬───────┬───────┬───────┬───────┬──────┘
                         ↓       ↓       ↓       ↓       ↓
              file-service  chat-adapter  settings-adapter  plugin-inventory  job-adapter
                         ↓       ↓       ↓       ↓       ↓
                     ┌──────────────────────────────────────────┐
                     │ src/host/dsh-0.2-bridge.ts                 │  重建 0.1.x apiProxy 面容
                     │ （适配层，不是业务层 —— 全部 @patch 在这里） │
                     └───────────────┬──────────────────────────┘
                                     ↓
                            DSH 内核 host services
                （sessionController / workspaceController / settingsController /
                  agentPresets / llm / webServer / agents / commands / …）

  横切与支撑（不参与上面这条主链）：
    auth.ts / rate-limit.ts     鉴权与限流
    database.ts                 持久层（node:sqlite）
    event-bus.ts                进程内事件总线 → server.ts 扇出到 WebSocket
    image-handoff.ts            识图路径设置 + 只读图片路由
    cloudflared.ts              Cloudflare 隧道进程管理
    config-text.ts              DSH1: 配置文本编解码
    path-policy.ts / root-resolver.ts / history-budget.ts / wire-json.ts / errors.ts
    host-service-probe.ts       注入面探针（观测，不参与业务）
```

**双端共享**：`src/shared/` 被 `src/host/` 与 `src/client/` **同时**引用，
是唯一的共享层。

### 禁止的依赖方向

| 禁止 | 为什么 |
| --- | --- |
| `client/` → `host/` | 浏览器半边只能走 REST/`<img>` 路由；直接 import 宿主实现会把 Node 内置模块拖进浏览器包，构建直接失败 |
| `host/*` → `client/*` | 同上，反向同样不成立 |
| 业务 adapter → `server.ts` | 分层单向：server 装配 router，router 调 adapter；反过来会绕开鉴权与审计 |
| 任何模块 → `lib/` | `lib/` 是构建产物，import 它等于自己吃自己的尾巴 |
| 业务代码 → `scripts/` | `scripts/` 只在开发/发版时跑，不是运行时代码 |

**`dsh-0.2-bridge.ts` 的定位要说清**：它是**适配层**，唯一职责是在 0.2.x 的
host services 之上重建 0.1.x 的 `apiProxy` 面容，让 `chat-adapter` / `settings-adapter`
不必改写。因内核行为而加的补丁**全部**要打 `@patch` 四要素（[AGENTS.md](../../AGENTS.md) §3.3），
`tests/patch-discipline.spec.ts` 机检。

---

## 3. 逐目录说明

### 3.1 `src/host/` —— 宿主侧

**入口与装配**

| 文件 | 职责 | 谁调用它 |
| --- | --- | --- |
| `router.ts` | `ApiRouter`：唯一路由分派点，含 `/api/v1` 版本化 REST 与 `/manage` 回环管理面 | `index.ts` 装配；`server.ts` 转发 |
| `server.ts` | `RemoteApiServer`（监听器启停/状态）、`attachEmbeddedRoutes`（把 API 代理与图片路由挂到 DSH webServer） | `index.ts`、`router.ts` |
| `auth.ts` | `AuthService`：设备 token / loopback admin 两种身份，scope 与 root 校验，限流 | `router.ts`、`server.ts` |
| `capabilities.ts` | `BRIDGE_CAPABILITIES` 能力位清单与 `connection.ready` 载荷（**清单与数量以本文件源码为准，勿在文档抄数字**） | `server.ts`（发首帧）、`tests/capabilities.spec.ts` |

**业务 adapter（router 的下游）**

| 文件 | 职责 | 谁调用它 |
| --- | --- | --- |
| `chat-adapter.ts` | `DshChatAdapter`：会话、历史、prompt、附件、审批与提问、命令、模型选择 | `router.ts` |
| `file-service.ts` | `FileService`：授权根内的列目录/读写/移动/回收站，含路径策略落地 | `router.ts` |
| `settings-adapter.ts` | `DshSettingsAdapter`：提供商与模型目录（`SettingsApiProxy` 面）、通用设置命名空间读写 | `router.ts` |
| `settings-namespace.ts` | 通用设置命名空间的纯逻辑：写允许策略、密钥脱敏、ops 校验、对外视图投影（不碰内核 RPC） | `settings-adapter.ts` |
| `provider-url-policy.ts` | 供应商 `baseURL` 的地址策略（SEC-H11）：协议白名单、私网/回环默认拒绝、`allowPrivateProviderHosts` 显式放行 | `settings-adapter.ts` |
| `device-identity.ts` | 设备身份的探测与展示：解析 `X-Dsh-Device` 头、从 `User-Agent` 兜底判平台、拼「平台 · 型号」显示名（纯函数，不做授权判断） | `auth.ts`、`router.ts` |
| `plugin-inventory.ts` | 插件清单读取、状态裁决（`resolveState`）、启停（`togglePlugin`）、更新检查 | `router.ts` |
| `job-adapter.ts` | `JobAdapter`：后台任务 roster / 输出 / kill（依赖可选服务 `jobController`） | `router.ts` |

**适配层**

| 文件 | 职责 | 谁调用它 |
| --- | --- | --- |
| `dsh-0.2-bridge.ts` | **0.2.x 适配层（≈2 150 行，已在 TECH-DEBT 登记）**：重建 `apiProxy` 面容、可选服务探测、图片交接读盘、权限目录归一 | `index.ts` 构造后注入各 adapter |

**支撑件**

| 文件 | 职责 |
| --- | --- |
| `database.ts` | `WorkspaceDatabase`：node:sqlite 持久层（根/设备/配对/设置/回收站/审计），含迁移与撤销清理 |
| `event-bus.ts` | `WorkspaceEventBus`：进程内订阅/发布，server 据此扇出到 WS |
| `rate-limit.ts` | `FixedWindowLimiter`：固定窗口限流（鉴权失败、配对尝试、普通请求三档） |
| `errors.ts` | `ApiError` / `asApiError`：REST 错误码与 HTTP 状态的统一载体 |
| `wire-json.ts` | 出网 JSON 安全序列化（孤立 UTF-16 代理项换 U+FFFD） |
| `path-policy.ts` | 相对路径校验（拒绝绝对路径/盘符/UNC/`..`/Windows 保留名） |
| `root-resolver.ts` | 绝对路径 → 「属于哪个授权根 + 相对路径」 |
| `history-budget.ts` | 历史响应的字节预算与从最旧端裁剪（防手机端 OOM） |
| `listener-config.ts` | 监听地址/端口归一化 |
| `config-text.ts` | `DSH1:` 配置文本编解码与端点分类 |
| `image-handoff.ts` | 识图路径设置、文件名词白名单、媒体类型嗅探、只读图片路由 handler |
| `cloudflared.ts` | `CloudflaredTunnelManager`：cloudflared 二进制下载（择源）与隧道进程管理 |
| `host-service-probe.ts` | 注入面探针：记录哪些 host service 真的注入了（**只在 apply 期间采样**） |

### 3.2 `src/client/` —— DSH WebUI 浏览器半边（8 个文件）

| 文件 | 职责 |
| --- | --- |
| `index.tsx` | 客户端插件入口：向 `settings.section` 等 slot 注册组件 |
| `workspace.tsx` | 「📱 手机设置」面板主体（七张折叠卡片：根目录/远程访问/设备/识图/回收站/插件/App 下载） |
| `plugins.tsx` | 插件清单的右侧栏形态：`SidebarRightTabDefinition` + guide 卡片（rc.3 起可 pin），body 复用 `/settings/plugins` |
| `handoff.tsx` | 图片交接消息 → 真图片（只认用户消息里的行首标记，挂在 `conversation.chat.turnTail` 座位） |
| `i18n.tsx` | 双语文案与语言 store（`zh-CN` / `en`），跨 slot 同步 |
| `styles.ts` | 面板全部 CSS（含 `.daw-root` 与 `.daw-settings-section` 双覆盖的不变量） |
| `api.ts` | 浏览器侧 REST 客户端（`DirectoryPage` / `ContentResult` / `WorkspaceApiError`） |
| `app-qr.ts` | 应用下载二维码 data URL，**由 `scripts/generate-app-qr.mjs` 生成，勿手改** |

### 3.3 `src/shared/` —— 双端共享（2 个文件）

| 文件 | 职责 |
| --- | --- |
| `contracts.ts` | 共享契约类型：`DeviceScope` / `RootView` / `DeviceView` / `FileEntryView` / `WorkspaceEvent` / `Principal` |
| `version.ts` | `PLUGIN_VERSION`（随版本号同步的唯一出处） |

### 3.4 `tests/` —— 单元与合约测试（44 个 spec）

按主题分组，**新增测试按这张表找位置**：

| 主题 | spec |
| --- | --- |
| 路由与 HTTP 合约 | `http-api`、`approval-api`、`attachment-api`、`command-api`、`job-api`、`plugin-inventory-api`、`security` |
| 鉴权与设备 | `database-auth`、`device-revocation`、`pairing-continuity`、`scope-picker`、`websocket-security` |
| 内核适配 | `dsh-0.2-bridge`、`chat-adapter`、`settings-adapter`、`history-projections`、`capabilities`、`patch-discipline` |
| 文件与路径 | `file-service`、`path-policy`、`root-resolver`、`builtin-root`、`builtin-root-real`、`builtin-coexist` |
| 图片交接 | `image-handoff`、`client-handoff` |
| 事件与预算 | `history-budget`、`interaction-replay`、`session-snapshot`、`deliverables`、`wire-json` |
| 运维脚本与配置 | `config-text`、`listener-config`、`plugin-inventory`、`cloudflared`、`host-service-probe`、`app-qr`、`i18n`、`styles` |
| 数据迁移演练 | `migration-drill`、`purge-drill` |

共享夹具：`temp-database.ts`（临时库）、`test-cleanup.ts`（清理）。

### 3.5 `scripts/` —— 只跑在开发机上的脚本

| 文件 | 用途 |
| --- | --- |
| `release.sh` | **一键发版**：门禁 → npm 打包 → tag → 双推 → 两站 Release → npm 发布 → 回读 |
| `pack-release.sh` / `publish-npm.sh` | 分步打包与 npm 发布 |
| `push-all.sh` / `setup-remotes.sh` | 三远端推送与命名整理 |
| `check-project-docs.ts` | **`pnpm docs:check` 的实现**（必需文档、ROADMAP、ADR 索引、坑位双向、根 README、patch inject、本文锚点） |
| `generate-app-qr.mjs` | 生成 `src/client/app-qr.ts` |
| `generate-screenshots.ts` | 生成 `assets/screenshots/` |
| `validate-entry.ts` / `smoke-profile-install.ts` | 入口与 profile 安装冒烟 |
| `e2e-stream-probe.mjs` | e2e 流探针 |
| `manual-cloudflare-check.ts` | 隧道手工核验 |
| `ci/` | 镜像推送与 Release 同步的 CI 辅助脚本 |

### 3.6 其余目录

| 目录 | 说明 |
| --- | --- |
| `kotlin-sdk/` | 给 App 的 SDK。**wire schema 五处同步之一**，改 REST 契约必须同步（见 INTERFACES.md） |
| `docs/api/` | `openapi.yaml` + `asyncapi.yaml`，wire schema 的权威；`docs:check` 会核对路径与版本号 |
| `docs/project/` | 状态、路线、决策、坑位与本图；`docs/project/README.md` 是索引 |
| `e2e/` | `styles.spec.ts`：渲染真实 DOM 量计算样式，**不需要服务器**，只需 chromium |
| `assets/` | 面板截图与 QR 图，进发布包（`package.json` 的 `files`） |
| `artifacts/`、`lib/` | 产物目录，**勿手改** |

---

## 4. 关键文件速查（改它会影响什么）

| 文件 | 量级 | 改它会影响 |
| --- | --- | --- |
| `src/host/dsh-0.2-bridge.ts` | ≈2 150 行 | 所有走内核的链路；改前必读 `DSH-0.2-COMPAT.md` 与 PITFALLS §apiProxy 消失 |
| `src/host/chat-adapter.ts` | ≈1 480 行 | 会话/历史/审批/提问/命令/附件全部 REST 行为 |
| `src/host/router.ts` | ≈1 430 行 | 全部对外路由与鉴权落点；改路由要同步 OpenAPI + capabilities 依据 |
| `src/host/database.ts` | ≈640 行 | 用户数据（根/设备/回收站）；改表要写迁移并跑 `migration-drill` |
| `src/host/plugin-inventory.ts` | ≈640 行 | 插件清单与启停；profile 解析相关 |
| `src/host/server.ts` | ≈450 行 | 监听器、`/dsh-workspace-api` 前缀（**不可动契约**）、WS 扇出与授权过滤 |
| `src/host/settings-adapter.ts` | ≈430 行 | 提供商/模型设置页 |
| `src/host/settings-namespace.ts` | ≈200 行 | 通用设置命名空间的策略/脱敏/校验（纯函数） |
| `src/host/provider-url-policy.ts` | ≈190 行 | 供应商 baseURL 地址策略（纯函数） |
| `src/host/device-identity.ts` | ≈200 行 | 设备身份探测（纯函数） |
| `src/host/cloudflared.ts` | ≈430 行 | 隧道与二进制下载 |
| `src/client/workspace.tsx` | ≈1230 行 | 面板全部交互 |
| `src/shared/version.ts` | 1 行 | 版本号；与 `package.json`、两站 README、OpenAPI/AsyncAPI 版本同源 |

> 行数只是**量级提示**，精确基线与债务状态以 [TECH-DEBT.md](TECH-DEBT.md) 为准
> （行数预算 600/文件）。**不要把这里的近似值当成门禁依据。**

---

## 5. 新增东西放哪里（决策表）

| 我要加… | 放哪 | 还要同步什么 |
| --- | --- | --- |
| 一个新 REST 路由 | `src/host/router.ts` 的 `dispatch` 分支；业务实现优先落到对应 adapter | `docs/api/openapi.yaml`、`docs/project/API.md`、需要就加能力位（附契约依据）、`kotlin-sdk`、合约测试、**本文与 INTERFACES 锚点** |
| 一个新内核适配（因内核行为而写） | `src/host/dsh-0.2-bridge.ts` | `@patch` 五要素（for/why/until/test）、`DSH-0.2-COMPAT.md`、指向的测试必须真实存在 |
| 一个新持久化表/列 | `src/host/database.ts` | 迁移代码 + `tests/migration-drill.spec.ts`、`TECH-DEBT.md`（若涉及历史数据） |
| 一个新的横切工具（路径/预算/序列化） | `src/host/` 下按职责命名的新文件 | **本文机检锚点必须登记**，否则 `docs:check` 变红；补单测 |
| 一个新面板卡片 | `src/client/workspace.tsx`（+ `i18n.tsx` 双语文案） | 面板截图 `assets/screenshots/`、`styles.ts`（若加样式） |
| 一个新浏览器组件/slot | `src/client/index.tsx` 注册 | `package.json` 的 `dsh.client.inject`（若需要新 client 依赖） |
| 一个新测试 | `tests/` 按 §3.4 主题分组，命名 `Xxx.spec.ts` | `TESTING.md` 记演进；修 bug 必须带回归用例 |
| 一份新文档 | `docs/project/` | 若属必需文档，加到 `scripts/check-project-docs.ts` 的 `requiredDocs`；更新 `docs/project/README.md` 索引 |
| 一个新 ADR | `docs/project/decisions/ADR-NNNN-*.md` | `docs/project/README.md` 的 ADR 索引（`docs:check` 校验） |
| 一个新坑位 | `docs/project/PITFALLS.md` 补 `### 同名` | `AGENTS.md` §6 索引同名条目（**双向**校验） |
| 一个新能力位 | `src/host/capabilities.ts` | 必须能指出 OpenAPI 路径+方法或 AsyncAPI 事件；`tests/capabilities.spec.ts` 会核对 |

---

## 6. 机检锚点（docs:check 读取，勿改格式）

> 本区由 `scripts/check-project-docs.ts` 解析。**双向**校验：表里路径必须真实存在，
> `src/` 下每个文件也必须出现在表里。新增/移动/删除源文件时同步这里，否则 `pnpm docs:check` 变红。

<!-- structure-check:begin -->
| 路径 | 类型 | 职责 |
| --- | --- | --- |
| `src/` | dir | 插件全部源码 |
| `src/index.ts` | file | 插件入口：apply / inject / 生命周期装配 |
| `src/host/` | dir | 宿主侧实现（HTTP、路由、adapter、持久层） |
| `src/host/auth.ts` | file | 设备 token / loopback admin 鉴权与限流 |
| `src/host/capabilities.ts` | file | 能力位清单与 connection.ready 载荷 |
| `src/host/chat-adapter.ts` | file | 会话/历史/审批/提问/命令 adapter |
| `src/host/cloudflared.ts` | file | Cloudflare 隧道与二进制管理 |
| `src/host/config-text.ts` | file | DSH1 配置文本编解码 |
| `src/host/database.ts` | file | node:sqlite 持久层 |
| `src/host/dsh-0.2-bridge.ts` | file | DSH 0.2.x 适配层（重建 apiProxy 面容） |
| `src/host/errors.ts` | file | ApiError 与错误归一 |
| `src/host/event-bus.ts` | file | 进程内事件总线 |
| `src/host/file-service.ts` | file | 授权根文件服务 |
| `src/host/history-budget.ts` | file | 历史字节预算与裁剪 |
| `src/host/host-service-probe.ts` | file | 宿主服务注入面探针 |
| `src/host/image-handoff.ts` | file | 识图路径设置与只读图片路由 |
| `src/host/im-command.ts` | file | IM `/tunnel` 命令：开隧道并回传 DSH1 配置文本（门禁依赖 IM 插件白名单，见 SECURITY.md） |
| `src/host/job-adapter.ts` | file | 后台任务 adapter |
| `src/host/listener-config.ts` | file | 监听地址/端口归一化 |
| `src/host/metrics.ts` | file | 进程内薄指标收集器（计数 + 固定样本环分位数） |
| `src/host/path-policy.ts` | file | 相对路径校验 |
| `src/host/device-identity.ts` | file | 设备身份探测（结构化头优先，UA 兜底判平台） |
| `src/host/provider-url-policy.ts` | file | 供应商 baseURL 地址策略（私网默认拒绝） |
| `src/host/retention.ts` | file | audit/idempotency 表的保留期清理调度（策略层，SQL 在 database.ts） |
| `src/host/plugin-inventory.ts` | file | 插件清单与启停 |
| `src/host/rate-limit.ts` | file | 固定窗口限流 |
| `src/host/root-resolver.ts` | file | 绝对路径到授权根的解析 |
| `src/host/router.ts` | file | 唯一路由分派点 |
| `src/host/server.ts` | file | 监听器与嵌入路由 |
| `src/host/settings-adapter.ts` | file | 提供商/模型设置 adapter |
| `src/host/settings-namespace.ts` | file | 通用设置命名空间的写策略、脱敏与 ops 校验（纯函数） |
| `src/host/wire-json.ts` | file | 出网 JSON 安全序列化 |
| `src/host/ws-commands.ts` | file | 移动端网关 WS 命令域（commands/command-execute、model/permission 通用二级菜单 command-options/select、permission 会话档位切换，/ws/mobile） |
| `src/host/ws-event-bridge.ts` | file | 移动端网关 WS 事件桥：订阅事件总线，按主体授权 + subscribe 会话白名单过滤后主动推 {kind:'event'}（/ws/mobile） |
| `src/host/ws-file-transfer.ts` | file | 移动端网关 WS 分块文件传输域（file-download open/read/cancel 随机读+末块 SHA-256；file-upload open/chunk/finish/cancel spool 落盘+校验+内核附件换 receiptId，/ws/mobile） |
| `src/host/ws-files.ts` | file | 移动端网关 WS 文件浏览域（file-list、directory-create，授权根内目录列举/建目录与分页，/ws/mobile） |
| `src/host/ws-goals.ts` | file | 移动端网关 WS 任务/目标/统计域（tasks/goal/session-stats/context-usage 读会话投影；goal-* 写代理内核 goals Remote，缺失回 unsupported） |
| `src/host/ws-handler.ts` | file | 移动端网关 WebSocket（/ws/mobile）：子协议 dsh-pair/dsh-auth，hello 帧，双向请求/响应 |
| `src/host/ws-hitl.ts` | file | 移动端网关 WS 人机交互域（approval-response/question-answer，/ws/mobile） |
| `src/host/ws-host.ts` | file | 移动端网关 WS 主机快照域（host：版本/主目录/附着会话数/默认模型精简版，/ws/mobile） |
| `src/host/ws-host-services.ts` | file | 可选内核远程服务封装（typertGateway+owner peer，定时任务/语音代理用，缺失即降级） |
| `src/host/ws-models.ts` | file | 移动端网关 WS 会话模型域（models/select-model，无会话全局目录交 ws-settings，/ws/mobile） |
| `src/host/ws-presets.ts` | file | 移动端网关 WS agent 预设域（agent-presets/select-agent-preset，/ws/mobile） |
| `src/host/ws-protocol.ts` | file | WS 线路协议常量、帧类型与编解码（/ws/mobile） |
| `src/host/ws-schedule.ts` | file | 移动端网关 WS 定时任务域（schedule-*，代理内核 schedule Remote，缺失回 unavailable） |
| `src/host/ws-sessions.ts` | file | 移动端网关 WS 会话生命周期域（session-create/cancel/archive/rename，/ws/mobile） |
| `src/host/ws-speech.ts` | file | 移动端网关 WS 官方语音域（speech-*，纯代理内核 speech Remote，4MiB/4并发/180s，缺失回 unavailable） |
| `src/host/ws-settings.ts` | file | 移动端网关 WS 全局设置域（default-model 全局目录/providers/permission-options，/ws/mobile） |
| `src/host/ws-team.ts` | file | 移动端网关 WS 智能体团队/子会话域（agent-team/subagents，只读会话投影，/ws/mobile） |
| `src/client/` | dir | DSH WebUI 浏览器半边 |
| `src/client/api.ts` | file | 浏览器侧 REST 客户端 |
| `src/client/app-qr.ts` | file | 应用下载二维码（生成物，勿手改） |
| `src/client/handoff.tsx` | file | 图片交接消息渲染 |
| `src/client/i18n.tsx` | file | 双语文案与语言 store |
| `src/client/index.tsx` | file | 客户端插件入口与 slot 注册 |
| `src/client/plugins.tsx` | file | 插件清单的右侧栏 tab 形态 |
| `src/client/styles.ts` | file | 面板 CSS |
| `src/client/workspace.tsx` | file | 手机设置面板主体 |
| `src/shared/` | dir | 双端共享契约与版本 |
| `src/shared/contracts.ts` | file | 共享契约类型 |
| `src/shared/version.ts` | file | PLUGIN_VERSION |
| `tests/` | dir | vitest 单元与合约测试 |
| `e2e/` | dir | playwright 样式契约 |
| `scripts/` | dir | 发版/推送/门禁/探针脚本 |
| `docs/api/` | dir | OpenAPI 与 AsyncAPI（wire schema 权威） |
| `docs/project/` | dir | 开发事实来源 |
| `kotlin-sdk/` | dir | 给 App 的 Kotlin SDK |
| `assets/` | dir | 面板截图与应用二维码 |
<!-- structure-check:end -->

---

## 7. 与其他文档的关系

| 想知道 | 去哪 |
| --- | --- |
| 为什么这样分层、能力位怎么来的 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 某个函数签名、路由表、事件字段 | [INTERFACES.md](INTERFACES.md)、[API.md](API.md) |
| 内核适配的来龙去脉 | [DSH-0.2-COMPAT.md](DSH-0.2-COMPAT.md)、`decisions/` |
| 哪块代码是债、预算多少 | [TECH-DEBT.md](TECH-DEBT.md) |
| 改之前该避什么坑 | [PITFALLS.md](PITFALLS.md) |
