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
├── tests/                   vitest 单元与合约测试（95 个 spec，见 §3.4）
├── e2e/                     playwright 样式契约（4 用例，无需服务器）
├── scripts/                 发版 / 推送 / 文档门禁 / 探针脚本（不是运行时代码）
├── kotlin-sdk/              给 Android 客户端的 Kotlin SDK（随包分发）
├── docs/
│   ├── api/                 OpenAPI + AsyncAPI：wire schema 的**权威**
│   └── project/             开发事实来源（状态 / 决策 / 坑位 / 本文）
├── assets/                  面板截图与应用下载二维码（进发布包）
├── artifacts/               本地打包产物与 Release 正文（**勿手改**）
├── lib/                     构建产物（tsdown 输出，**勿手改**）
└── .github/workflows/       CI、镜像从站同步与 npm 可信发布（publish.yml）
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
                     │ src/host/router.ts + routes/*.ts (ApiRouter)│  唯一路由分派点（能力块按 capability 拆 routes/）
                     └───┬───────┬───────┬───────┬───────┬──────┘
                         ↓       ↓       ↓       ↓       ↓
              file-service  chat-adapter  settings-adapter  plugin-inventory  job-adapter
                         ↓       ↓       ↓       ↓       ↓
                     ┌──────────────────────────────────────────┐
                     │ src/host/dsh-0.2-bridge.ts（组装根）        │  重建 0.1.x apiProxy 面容
                     │ （适配层不是业务层；链路实现在 bridge/      │
                     │   九模块，@patch 随所在链路整段搬移）       │
                     └───────────────┬──────────────────────────┘
                                     ↓
                            DSH 内核 host services
                （sessionController / workspaceController / settingsController /
                  agentPresets / llm / webServer / agents / commands / …）

  横切与支撑（不参与上面这条主链）：
    auth.ts / rate-limit.ts     鉴权与限流
    database.ts + db/            持久层组合根 + 按表族拆的 db/*.ts（node:sqlite）
    event-bus.ts                进程内事件总线 → server.ts 扇出到 WebSocket
    image-handoff.ts            识图路径设置 + 只读图片路由
    cloudflared.ts              Cloudflare 隧道进程管理
    config-text.ts              DSH1: 配置文本编解码
    path-policy.ts / root-resolver.ts / history-budget.ts / wire-json.ts / errors.ts / error-codes.ts
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
| `router.ts` | `ApiRouter` 组合根：分发装配 + 保留 healthz / 配对兑换 / `/manage` 门；能力块按 capability 委托 `routes/*.ts` | `index.ts` 装配；`server.ts` 转发 |
| `server.ts` | `RemoteApiServer`（监听器启停/状态）、`attachEmbeddedRoutes`（把 API 代理与图片路由挂到 DSH webServer） | `index.ts`、`router.ts` |
| `auth.ts` | `AuthService`：设备 token / loopback admin 两种身份，scope 与 root 校验，限流 | `router.ts`、`server.ts` |
| `capabilities.ts` | `BRIDGE_CAPABILITIES` 能力位清单与 `connection.ready` 载荷（**清单与数量以本文件源码为准，勿在文档抄数字**） | `server.ts`（发首帧）、`tests/capabilities.spec.ts` |

**业务 adapter（router 的下游）**

| 文件 | 职责 | 谁调用它 |
| --- | --- | --- |
| `chat-adapter.ts` | `DshChatAdapter`：会话、历史、prompt、附件、审批与提问、命令、模型选择。issue #26 阶段 9 起它是**装配根**（92 行：类字段/构造/合并接口/`Object.assign`），方法体在 `chat/` 五族 + `chat-contracts.ts` 契约面 | `router.ts` |
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
| `dsh-0.2-bridge.ts` | **0.2.x 适配层（组装根，≈594 行）**：工厂 `createDsh02ApiProxy` + `bridge/` re-export 面；链路实现在 `bridge/` 九模块（结构视图/宿主读取/RPC/帧中枢/审批提问/附件/权限/投影/模型） | `index.ts` 构造后注入各 adapter |

**支撑件**

| 文件 | 职责 |
| --- | --- |
| `database.ts` | `WorkspaceDatabase`：node:sqlite 持久层**组合根**（连接/PRAGMA/迁移装配/跨表族事务），公开方法一行委托到 `db/*.ts` 表族模块（根/设备/配对/设置/回收站/审计/幂等） |
| `event-bus.ts` | `WorkspaceEventBus`：进程内订阅/发布，server 据此扇出到 WS |
| `rate-limit.ts` | `FixedWindowLimiter`：固定窗口限流（鉴权失败、配对尝试、普通请求三档） |
| `errors.ts` | `ApiError` / `asApiError`：REST 错误码与 HTTP 状态的统一载体 |
| `wire-json.ts` | 出网 JSON 安全序列化（孤立 UTF-16 代理项换 U+FFFD）；入站严格解析（重复键拒绝） |
| `error-codes.ts` | mobile WS `error` 帧错误码语义表：五组分组 + `retryable` 判定（`sendFrame` 出口统一注入，未知码不写字段） |
| `path-policy.ts` | 相对路径校验（拒绝绝对路径/盘符/UNC/`..`/Windows 保留名） |
| `root-resolver.ts` | 绝对路径 → 「属于哪个授权根 + 相对路径」 |
| `history-budget.ts` | 历史响应的字节预算与从最旧端裁剪（防手机端 OOM） |
| `listener-config.ts` | 监听地址/端口归一化 |
| `config-text.ts` | `DSH1:` 配置文本编解码与端点分类 |
| `image-handoff.ts` | 识图路径设置、文件名词白名单、媒体类型嗅探、只读图片路由 handler |
| `cloudflared.ts` | `CloudflaredTunnelManager`：cloudflared 二进制下载（择源）与隧道进程管理 |
| `host-service-probe.ts` | 注入面探针：记录哪些 host service 真的注入了（**只在 apply 期间采样**） |
| `dsh-go-panel.ts` | dsh-Go 原生界面（v2.15.0）：只读「接入」面板 + 状态条，读 `server.status` / `CloudflaredTunnelManager.publicState` / `database.listDevices`；挂载点只有 `index.ts`，与设备协议面无交叉 |

### 3.2 `src/client/` —— DSH WebUI 浏览器半边（9 个文件 + `cards/` 下的 11 个卡片文件）

| 文件 | 职责 |
| --- | --- |
| `index.tsx` | 客户端插件入口：向 `settings.section` 等 slot 注册组件 |
| `workspace.tsx` | 「📱 手机设置」面板**外壳**：分区常量（`ADMIN_TABS` 5 张 / `ADVANCED_TABS` 3 张）、共享状态（refresh / 隧道 / 通知）、`CardsProvider` 接线。每张卡的内容在 `cards/*.tsx` |
| `cards/*.tsx` | 每张设置卡一个文件（11 个）。`context.ts` 是共享层，`shell.tsx` 是卡片外壳，`shared.tsx` 是跨卡小部件；其余 8 个各是一张卡 |
| `plugins.tsx` | 插件清单的右侧栏形态：`SidebarRightTabDefinition` + guide 卡片（rc.3 起可 pin），body 复用 `/settings/plugins` |
| `handoff.tsx` | 图片交接消息 → 真图片（只认用户消息里的行首标记，挂在 `conversation.chat.turnTail` 座位） |
| `i18n.tsx` | 双语文案与语言 store（`zh-CN` / `en`），跨 slot 同步 |
| `styles.ts` | 面板全部 CSS（含 `.daw-root` 与 `.daw-settings-section` 双覆盖的不变量） |
| `api.ts` | 浏览器侧 REST 客户端（`DirectoryPage` / `ContentResult` / `WorkspaceApiError`） |
| `app-qr.ts` | 应用下载二维码 data URL（dsh-Chat × GitHub / Gitee 两个），**由 `scripts/generate-app-qr.mjs` 生成，勿手改** |

### 3.3 `src/shared/` —— 双端共享（2 个文件）

| 文件 | 职责 |
| --- | --- |
| `contracts.ts` | 共享契约类型：`DeviceScope` / `RootView` / `DeviceView` / `FileEntryView` / `WorkspaceEvent` / `Principal` |
| `version.ts` | `PLUGIN_VERSION`（随版本号同步的唯一出处） |

### 3.4 `tests/` —— 单元与合约测试（95 个 spec）

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
| 发版与推送链路 | `release-tag-push`（跑真的 `scripts/push-all.sh`，远端用本地 bare 仓库冒充；钉住「tag 推送是发版脚本的义务」这条，issue #25） |
| 数据迁移演练 | `migration-drill`、`purge-drill` |

共享夹具：`temp-database.ts`（临时库）、`test-cleanup.ts`（清理）。

### 3.5 `scripts/` —— 只跑在开发机上的脚本

| 文件 | 用途 |
| --- | --- |
| `release.sh` | **一键发版**：门禁 → npm 打包 → tag → 双推（**分支 + 指向 HEAD 的 tag**，tag 推送是本脚本的义务）→ 两站 Release → npm 发布 → 回读。第 4 步之后有硬闸：两站 tag 未就位就 `exit 1`，**不建 Release、不发 npm** |
| `pack-release.sh` / `publish-npm.sh` | 分步打包与 npm 发布 |
| `push-all.sh` / `setup-remotes.sh` | 三远端推送与命名整理。`push-all.sh` 的 `PUSH_TAGS` 默认 **0**（手工推送默认不推 tag，防误推历史 tag）；要推 tag 显式写 `PUSH_TAGS=1` |
| `check-project-docs.ts` | **`pnpm docs:check` 的实现**（必需文档、ROADMAP、ADR 索引、坑位双向、根 README、patch inject、本文锚点） |
| `generate-app-qr.mjs` | 生成 `src/client/app-qr.ts` |
| `generate-screenshots.ts` | 生成 `assets/screenshots/`（六张设置面板真实渲染图） |
| `generate-promo.ts` | 生成 README 首屏与 GitHub social preview，**中英各两张**：`assets/promo-16x9.png` / `.en.png`（1600×900）与 `assets/promo-social.png` / `.en.png`（1280×640）。素材复用上面那批面板截图，只做排版，不另画界面；文案按 locale 抽在 `TEXT` 里，一条命令出全部四张 |
| `validate-entry.ts` / `smoke-profile-install.ts` | 入口与 profile 安装冒烟 |
| `e2e-stream-probe.mjs` | e2e 流探针 |
| `ws-frame-probe.mjs` | `/ws/mobile` 帧探针：连真桥逐帧打印请求→响应的 requestId 落点（发现「契约说回显、实现不回显」那类问题；MockWebServer 测不出） |
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
| `.github/workflows/` | 三个工作流：`ci.yml`（三平台 × 双 Node 矩阵 + e2e + 安装冒烟 + Kotlin SDK）、`mirror-sync.yml`（Gitee 主源 → GitHub 从站，每 3 小时）、`publish.yml`（tag `v*` 触发，**可信发布者 / OIDC** 自动发 npm，仓库里不存任何 npm 凭据；前置与配置见 [RELEASE.md](RELEASE.md) §2.1） |

---

## 4. 关键文件速查（改它会影响什么）

| 文件 | 量级 | 改它会影响 |
| --- | --- | --- |
| `src/host/chat-adapter.ts` | ≈92 行（装配根） | 会话/历史/审批/提问/命令/附件全部 REST 行为 —— issue #26 阶段 9 拆成装配根 + `chat/` 五族（access 555 / sessions 515 / hitl 374 / content 204 / models-commands 163）+ `chat-contracts.ts`（570），六个模块都在 600 行预算内 |
| `src/host/router.ts` | ≈345 行 | 分发组合根（healthz / 配对兑换 / `/manage` 门 + routes 循环）；改路由去 `src/host/routes/` 并同步 `routes/registry.ts`，鉴权与契约要求不变 |
| `src/host/database.ts` | ≈410 行 | 持久层组合根：全部公开方法与跨表族事务都在这（2026-10-31 拆表族后）；改表结构去 `db/migrations.ts` 并跑 `migration-drill` |
| `src/host/plugin-inventory.ts` | ≈640 行 | 插件清单与启停；profile 解析相关 |
| `src/host/server.ts` | ≈450 行 | 监听器、`/dsh-workspace-api` 前缀（**不可动契约**）、WS 扇出与授权过滤 |
| `src/host/settings-adapter.ts` | ≈430 行 | 提供商/模型设置页 |
| `src/host/settings-namespace.ts` | ≈200 行 | 通用设置命名空间的策略/脱敏/校验（纯函数） |
| `src/host/provider-url-policy.ts` | ≈190 行 | 供应商 baseURL 地址策略（纯函数） |
| `src/host/device-identity.ts` | ≈200 行 | 设备身份探测（纯函数） |
| `src/host/cloudflared.ts` | ≈430 行 | 隧道与二进制下载 |
| `src/host/tunnel-listener.ts` | ≈215 行 | 隧道专用数据端口（issue #26 阶段 0.2）：端口分离的唯一落点，cloudflared 指向它 |
| `src/client/workspace.tsx` | ≈473 行 | 面板外壳（拆卡前是 1308 行的巨型组件） |
| `src/shared/version.ts` | 1 行 | 版本号；与 `package.json`、两站 README、OpenAPI/AsyncAPI 版本同源 |

> 行数只是**量级提示**，精确基线与债务状态以 [TECH-DEBT.md](TECH-DEBT.md) 为准
> （行数预算 600/文件）。**不要把这里的近似值当成门禁依据。**

---

## 5. 新增东西放哪里（决策表）

| 我要加… | 放哪 | 还要同步什么 |
| --- | --- | --- |
| 一个新 REST 路由 | 对应 `src/host/routes/<capability>.ts` 的路由块（新块在 `src/host/routes/registry.ts` 补一行）；healthz / 配对兑换 / `/manage` 门留在 `src/host/router.ts`；业务实现优先落到对应 adapter | `docs/api/openapi.yaml`、`docs/project/API.md`、需要就加能力位（附契约依据）、`kotlin-sdk`、合约测试、**本文与 INTERFACES 锚点** |
| 一个新内核适配（因内核行为而写） | 对应 `src/host/bridge/<链路>.ts`；跨链路的挂组装根 `dsh-0.2-bridge.ts` | `@patch` 五要素（for/why/until/test）、`DSH-0.2-COMPAT.md`、指向的测试必须真实存在 |
| 一个新持久化表/列 | `src/host/db/<表族>.ts`（迁移在 `src/host/db/migrations.ts`） | 迁移代码 + `tests/migration-drill.spec.ts`、`TECH-DEBT.md`（若涉及历史数据）；新文件登记本文机检锚点 |
| 一个新的横切工具（路径/预算/序列化） | `src/host/` 下按职责命名的新文件 | **本文机检锚点必须登记**，否则 `docs:check` 变红；补单测 |
| 一个新面板卡片 | 新建 `src/client/cards/<name>.tsx`，在 `workspace.tsx` 的对应分组常量与渲染里各加一行（+ `i18n.tsx` 双语文案） | 面板截图 `assets/screenshots/`、`styles.ts`（若加样式）、`TAB_DESC_KEYS`（`cards/shell.tsx`） |
| 一个新浏览器组件/slot | `src/client/index.tsx` 注册 | `package.json` 的 `dsh.client.inject`（若需要新 client 依赖） |
| 一个新 GitHub Actions 工作流 | `.github/workflows/<name>.yml`（沿用 `ci.yml` 的 action 版本风格：checkout@v4 / pnpm/action-setup@v4 / setup-node@v4） | 若与发布链路相关：同步 [RELEASE.md](RELEASE.md) §2.1 的前置清单；`package.json` 的 `repository.url` 必须与 GitHub 仓库完全一致；npm 网页「可信的发布者」里填的**工作流文件名**必须与本文件名一致 |
| 一个新测试 | `tests/` 按 §3.4 主题分组，命名 `Xxx.spec.ts` | `TESTING.md` 记演进；修 bug 必须带回归用例 |
| 一个新的发版/推送脚本 | `scripts/`（§3.5），shell 脚本放 `.sh`、需要复用逻辑的放 `.ts` | 脚本里的**默认值与注释必须一致** —— 注释说反过一次（见 `PITFALLS.md` §发版脚本不推 tag）；改 `scripts/` 下的脚本要有回归用例（`tests/release-tag-push.spec.ts` 跑真脚本、远端用本地 bare 仓库冒充） |
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
| `src/host/bff-rest.ts` | file | App 侧 REST BFF 分发（分块上传/定时任务/官方语音九条路由的薄路由层，逻辑在 bff-*.ts） |
| `src/host/bff-schedule.ts` | file | REST 定时任务（五段 Vixie cron 与 IANA 时区校验、内核记录↔REST cron 视图映射、PATCH 局部更新） |
| `src/host/bff-speech.ts` | file | REST 官方语音（catalog/transcriptions/config，复用 ws-speech 的上限与归一，缺服务回 200 available:false） |
| `src/host/bff-upload.ts` | file | REST 分块上传票据与 spool（1 MiB 切片、1 小时票据、断点续传 alreadyReceived、缺块 409 details.missing） |
| `src/host/bridge/` | dir | 0.2.x 适配层按链路拆的模块（2026-10-31 自 dsh-0.2-bridge.ts 拆出，issue #2） |
| `src/host/bridge/attachments.ts` | file | 图片交接与附件读取：handoff 落盘判定（currentModelSelection/modelIsConfirmedTextOnly）、readHandoffImageFile、HandoffLocale |
| `src/host/bridge/chat.ts` | file | 审批桥 ApprovalBridge 与提问桥 QuestionBridge（挂起态与超时） |
| `src/host/bridge/file-upload-stream.ts` | file | 流式附件上传接线：uploadAttachmentStreamToKernel（走内核 `ctx.fileUploads.uploadStream`）+ 不可流式时的稳定 code FILE_UPLOAD_STREAM_UNSUPPORTED（issue #23） |
| `src/host/bridge/frame-hub.ts` | file | FrameHub 帧中枢（背压/重建）+ SessionEventRelay + wireSessionRegistryRelay（原工厂内联接线） |
| `src/host/bridge/host-reads.ts` | file | 宿主读取助手：sessionIdOfAgent/sessionIdOf/readArchivedSessionIds/createAgentResolver（原工厂内联） |
| `src/host/bridge/kernel-endpoints.ts` | file | 内核端点目录（issue #26 阶段 2）：describeKernelEndpoint/readKernelEndpoints/createKernelEndpointCatalog/readTypertRegistry/kernelCapabilityFlags —— 从 Typert 登记表抄 wire 键与描述，只读、永不抛 |
| `src/host/bridge/kernel-allowlist.ts` | file | 通用内核调用面的**唯一执法点**（issue #26 阶段 5）：KERNEL_ALLOWLIST（24 条 unary；7 条带 `sessions` 第二维、`session/search` 带结果过滤）/ KERNEL_DENIED_NAMESPACES（terminal·sandbox·dynamicCordisRunner·workspaceFiles·fileUploads·settings·credentials·account·liveshareShares·cuaAccess·forgePanel·agentTeams 永不外放）/ authorizeKernelEndpoint（默认拒绝先于 scope 判定，文案不区分「没这个端点」与「没被允许」）/ requestSession（从 `request.sessionId` 取第二维判据）/ isKernelEndpointAllowed / kernelAllowlistIndex / BRIDGE_OWNED_ENDPOINTS（35 条）/ singlePathViolations —— 单一路径原则的机检入口 |
| `src/host/bridge/kernel-call.ts` | file | 通用内核调用面的执行器（issue #26 阶段 5）：createKernelCallService —— 授权（scope）→ 幂等回放（键含 endpoint，仅成功入表，读取侧判 24 h）→ 同 callId 在飞行拒绝 → 目录查找 → 本地参数校验 → **第二维**会话可见性（`KernelCallGuard.sessionVisible`；`session/search` 结果再过滤）→ invoke/stream → 归一错误；流式端点收集到 streamFrameLimit（默认 64）帧并带 truncated；30 s 硬截止（`call/timeout`，没声明 cancellation 的端点取消时回 false 而不假装已取消）；endpoints() 只报「白名单 ∩ 目录」 |
| `src/host/bridge/kernel-invoke.ts` | file | 内核端点调用封装（issue #26 阶段 2）：assertKernelArguments/wrapRequestArgument/kernelCallSignal/requireKernelEndpoint/invokeKernelEndpoint/streamKernelEndpoint/kernelRpcError —— 参数校验文案与内核逐字一致 |
| `src/host/bridge/kernel-local.ts` | file | 进程内传输（issue #26 阶段 3a / 3b）：createLocalKernelGateway —— 没有 typertGateway 时（单测 / 缺席的可选服务）把同一套端点语义接到宿主服务上，表从 11 条增到 31 条（3b 起承载 workspace 写侧 / settings / credentials，3c 起承载 llm / agentPresets / permissionPresets，3d 起承载 fileUploads / session attachment·prompt / userQuestions.answer，并支持多顶层参与 agent lookup）；`assertWires` 补上与内核同一条「拒多余键」判定；wires 手写，由 tests/kernel-local.spec.ts 在装了内核的机器上与真实描述符比对防漂 |
| `src/host/bridge/kernel-contracts.ts` | file | 0.2.x 宿主服务的**结构视图**（issue #26 阶段 4 从 kernel-services.ts 拆出，474 行）：全部 `*Like` 类型 + Dsh02HostServices。只放类型不放行为 —— 「内核长什么样」与「桥的补丁」分开后，改签名与改语义不会混在一个 diff 里 |
| `src/host/bridge/kernel-deltas.ts` | file | 11 条 delta 的纯函数（issue #26 阶段 4）：visibleSessionItems / withSystemTrust / providerActivity / markProvidersActive / capacityPatch / agentScopeSkip / historyAddress / historyPageQuery / pickProjections / stripKernelUnsupportedFields / handoffKeepsMessageDeliverable / questionAnswerOutcome / questionAnswerTerminal —— 每条对应 issue #26 正文里一条「内核没有、桥必须有」的语义 |
| `src/host/bridge/kernel-views.ts` | file | 换源后的端点视图（issue #26 阶段 4 从门面搬出）：listSessions / readSessionHistory / promptSession / uploadAttachment / readAttachment / readSessionModels / listWorkspace / listAgentPresets / readLlmProviders / readLlmModels / readPermissionCatalog / listQuestions / answerQuestion —— 门面只留路由与 4 条永久留桥 |
| `src/host/bridge/kernel-services.ts` | file | 永久留桥的语义 + 宿主服务的容错读取（issue #26 阶段 4 缩到 122 行）：optionalService / userQuestionsOf / toUserQuestionView，类型改从 kernel-contracts.ts 再导出 |
| `src/host/bridge/models.ts` | file | 模型目录补容 modelCapacityOf/enrichModelGroups（TTL 缓存，不缓存失败） |
| `src/host/bridge/permissions.ts` | file | 权限档位目录读取与降级清单（normalizePermissionCatalog/FALLBACK_PERMISSION_CATALOG） |
| `src/host/bridge/projections.ts` | file | 会话投影读取 projectionsOf/readSessionProjections（@patch history-projections-passthrough 随行） |
| `src/host/bridge/proxy-options.ts` | file | CreateDsh02ApiProxyOptions（原工厂签名内联类型抽出的命名类型） |
| `src/host/bridge/rpc.ts` | file | RPC 信封与超时纪律（call/ok/toRpcError/timeoutSignal，原样搬出） |
| `src/host/chat-adapter.ts` | file | 会话 adapter 的**装配根**（issue #26 阶段 9，92 行）：class 字段 + 构造 + `interface DshChatAdapter` 合并声明 + `Object.assign` 装配五族方法 + re-export 旧导出面 |
| `src/host/chat-contracts.ts` | file | 会话 adapter 的契约面（issue #26 阶段 9，570 行）：`DshApiProxy` 与全部视图类型/常量（原 13–482 行逐字搬入）+ `ChatAdapterInternals`（五族混入对象的 `this` 类型）+ `unwrapDsh`/`isRecord`/`matchRoot`/`approvalRisk`/`redactApprovalText` |
| `src/host/chat/` | dir | 会话 adapter 按端点族拆的混入模块（issue #26 阶段 9，2026-11-19 自 chat-adapter.ts 拆出）：方法体逐字搬入，`this` 统一 `ChatAdapterInternals` |
| `src/host/chat/access.ts` | file | 可见性/授权根/事件接入（555 行）：`isSessionAuthorized`/`startEvents` + 私有 `requireSession`/`rememberVisibility`/`requireWorkspace`/`visibleWorkspaces`/`requireAuthorizedRoot`/`authorizedRoots`/`sessionRootId`/`commandAgent` + `normalizeDshEvent`/`turnFailureOf`/`hasReplyContentOf` |
| `src/host/chat/content.ts` | file | 会话内容（204 行）：`prompt`/`uploadAttachment`/`uploadAttachmentStream`/`readAttachment`/`readHandoffImage` |
| `src/host/chat/hitl.ts` | file | 审批与提问（374 行）：`listPendingApprovals`/`replayPendingApprovals`/`replayPendingQuestions`/`decideApproval`/`listUserQuestions`/`answerUserQuestion`/`cancelUserQuestion` + 私有 `captureApproval`/`hasPendingApproval` + `publicApproval`/`approvalKey`/`approvalReplayEvents`/`questionReplayEvents` 等纯函数 |
| `src/host/chat/models-commands.ts` | file | 预设/模型/命令（163 行）：`listAgentPresets`/`listPermissionPresets`/`selectAgentPreset`/`models`/`selectModel`/`listCommands`/`executeCommand` |
| `src/host/chat/sessions.ts` | file | 会话与工作区读写（515 行）：`listSessions`/`listWorkspaces`/`createWorkspace`/`renameWorkspace`/`deleteWorkspace`/`createSessionInWorkspace`/`createSession`/`history`/`subagentHistory`/`cancel`/`renameSession`/`forkSession`/`archiveSession`/`sessionWait`/`sessionProjections` + 私有 `reusableBlankId`/`blankSessionInWorkspace`/`blankSessionAtPath` |
| `src/host/cloudflared.ts` | file | Cloudflare 隧道与二进制管理 |
| `src/host/config-text.ts` | file | DSH1 配置文本编解码 |
| `src/host/database.ts` | file | node:sqlite 持久层组合根（连接/PRAGMA/迁移装配/跨表族事务，公开方法委托到 db/*.ts） |
| `src/host/db/` | dir | 持久层按表族拆的模块（2026-10-31 从 database.ts 拆出，issue #5） |
| `src/host/db/audit.ts` | file | 审计表族 AuditTable（append/list/prune 两段删除；只存 id/时间/动作/详情 JSON） |
| `src/host/db/devices.ts` | file | 设备表族 DevicesTable（鉴权/身份/改名/scope 与 root 授权/撤销/修剪；bumpRevision 回调注入） |
| `src/host/db/idempotency.ts` | file | 幂等回放表族 IdempotencyTable（read/save/prune） |
| `src/host/db/migrations.ts` | file | 有序 forward-only 迁移 runMigrations（建表 + 四列 ALTER + roots UNIQUE 重建） |
| `src/host/db/pairings.ts` | file | 配对码表族 PairingsTable（create/lookup/markUsed 原语；跨族兑换事务在组合根） |
| `src/host/db/roots.ts` | file | 授权根表族 RootsTable（add/list/get/ensureBuiltin/remove + dumpSchema） |
| `src/host/db/secrets.ts` | file | hashSecret（sha256 hex，令牌/配对码共用） |
| `src/host/db/trash.ts` | file | 回收站记录表族 TrashTable（insert/updateStatus/get/list/remove） |
| `src/host/dsh-0.2-bridge.ts` | file | DSH 0.2.x 适配层组装根（工厂 + bridge/ re-export 面，公开 API 零改动） |
| `src/host/errors.ts` | file | ApiError 与错误归一 |
| `src/host/error-codes.ts` | file | error 帧错误码语义表（五组 + retryable，issue #IKXGYS） |
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
| `src/host/retention.ts` | file | audit/idempotency 表的保留期清理调度（策略层，SQL 在 db/audit.ts 与 db/idempotency.ts） |
| `src/host/plugin-inventory.ts` | file | 插件清单与启停 |
| `src/host/rate-limit.ts` | file | 固定窗口限流 |
| `src/host/root-resolver.ts` | file | 绝对路径到授权根的解析 |
| `src/host/router.ts` | file | 唯一路由分派点（组合根：healthz / 配对兑换 / `/manage` 门 + routes 循环） |
| `src/host/routes/` | dir | 路由按 capability 拆的模块（2026-10-31 自 router.ts 拆出，issue #3） |
| `src/host/routes/chat.ts` | file | chat 域路由块：workspaces/presets/sessions/幂等回放/会话动作/schedules/speech |
| `src/host/routes/cloudflare.ts` | file | 隧道域：manageCloudflare 路由块 + createTunnel/openTunnelForCommand/buildConfigText/tunnelStateFor |
| `src/host/routes/devices.ts` | file | 设备域路由块：devices/self 与 /manage 设备、配对、访问面管理 |
| `src/host/routes/files.ts` | file | 文件域：roots/trash/uploads/image 路由块 + requireRoot/authorizedRoots/dispatchEntries/dispatchContent |
| `src/host/routes/plugins.ts` | file | 插件域路由块：settings/plugins 清单与启停 |
| `src/host/routes/registry.ts` | file | 路由注册表：path → handler 一屏总览（有序 first-match-wins，routes 为文档性字面量） |
| `src/host/routes/settings.ts` | file | 设置域路由块：host-services/providers/models/namespaces/provider 项级读写 |
| `src/host/routes/shared.ts` | file | 路由上下文 RouteCtx/ApiRouteCtx + 跨块 helper（sendJson/readJson/audit 幂等回放/管道工具） |
| `src/host/server.ts` | file | 监听器与嵌入路由 |
| `src/host/settings-adapter.ts` | file | 提供商/模型设置 adapter |
| `src/host/settings-namespace.ts` | file | 通用设置命名空间的写策略、脱敏与 ops 校验（纯函数） |
| `src/host/tunnel-listener.ts` | file | 隧道专用数据端口监听（issue #26 阶段 0.2）：只绑回环、只放行 `/api/v1/**` 与 `/ws/mobile`，`/manage/**` 与宿主前缀在该端口不存在；进入分派前剥掉 `X-Dsh-Workspace-Admin`，永不产生回环管理员身份 |
| `src/host/wire-json.ts` | file | 出网 JSON 安全序列化 |
| `src/host/ws-basic.ts` | file | 移动端网关 WS 基础帧处理器（message/workspaces/sessions/history/attachment，与 13 个域处理器同构：每连接一个实例，/ws/mobile） |
| `src/host/ws-commands.ts` | file | 移动端网关 WS 命令域（commands/command-execute、model/permission 通用二级菜单 command-options/select、permission 会话档位切换，/ws/mobile） |
| `src/host/ws-connection-policy.ts` | file | 移动端网关 WS 连接策略（连接上限判定 + 心跳调度，持 sockets 引用而非副本，/ws/mobile） |
| `src/host/ws-event-bridge.ts` | file | 移动端网关 WS 事件桥：订阅事件总线，按主体授权 + subscribe 会话白名单过滤后主动推 {kind:'event'}（/ws/mobile） |
| `src/host/ws-file-transfer.ts` | file | 移动端网关 WS 分块文件传输域（file-download open/read/cancel 随机读+末块 SHA-256；file-upload open/chunk/finish/cancel spool 落盘+校验+内核附件换 receiptId；file-upload-status 结果幂等查询，设备级归属，2 分钟 TTL，/ws/mobile） |
| `src/host/ws-files.ts` | file | 移动端网关 WS 文件浏览域（file-list、directory-create，授权根内目录列举/建目录与分页，/ws/mobile） |
| `src/host/ws-goals.ts` | file | 移动端网关 WS 任务/目标/统计域（tasks/goal/session-stats/context-usage 读会话投影；goal-* 写代理内核 goals Remote，缺失回 unsupported） |
| `src/host/ws-handler.ts` | file | 移动端网关 WebSocket 总装（/ws/mobile）：子协议 dsh-pair/dsh-auth、鉴权三入口、hello 帧、消息分发、发送/背压路径；5 个基础帧见 ws-basic.ts，连接上限与心跳见 ws-connection-policy.ts |
| `src/host/ws-hitl.ts` | file | 移动端网关 WS 人机交互域（approval-response/question-answer，/ws/mobile） |
| `src/host/ws-host.ts` | file | 移动端网关 WS 主机快照域（host：版本/主目录/附着会话数/默认模型精简版，/ws/mobile） |
| `src/host/ws-host-services.ts` | file | 可选内核远程服务封装（typertGateway+owner peer，定时任务/语音代理用，缺失即降级） |
| `src/host/ws-models.ts` | file | 移动端网关 WS 会话模型域（models/select-model，无会话全局目录交 ws-settings，/ws/mobile） |
| `src/host/ws-presets.ts` | file | 移动端网关 WS agent 预设域（agent-presets/select-agent-preset，/ws/mobile） |
| `src/host/ws-queues.ts` | file | 移动端网关 WS 队列域（issue IKX1ZM）：session-queues 读 inbox 投影归一成 QueueEntry[]，queue-update 代理内核 session/updateQueue（remove/steer/edit），成功即通知 SessionPushes 推队列快照（/ws/mobile） |
| `src/host/dsh-go-panel.ts` | file | dsh-Go 原生界面（v2.15.0）：只读「接入」面板（状态/监听地址/接入地址/隧道/根目录数/已授权设备）+ 状态条，`ctx.inject(['dshGo'])` 注册、10 秒轮询 + 内容签名去重，唯一动作是复制接入信息（不放写操作，理由见 SECURITY.md） |
| `src/host/ws-pushes.ts` | file | 队列/目标状态推送器（issue IKX1ZM）：按会话去抖后整份重读并扇出 queue-item-updated / goal-updated，按连接签名去重、订阅集合过滤、逐连接授权判定、goal-clear 墓碑压制闪回（/ws/mobile） |
| `src/host/ws-protocol.ts` | file | WS 线路协议常量、帧类型与编解码（/ws/mobile） |
| `src/host/ws-kernel-call.ts` | file | 通用内核调用面 WS 处理器（issue #26 阶段 5）：KernelCallHandler —— 只认 kernel-call / kernel-call-cancel，仅在协商到 dshrb-v1 时启用（否则回 NOT_IMPLEMENTED），连接建立即推一帧 kernel-endpoints（白名单 ∩ 目录），连接关闭 dispose 掉在飞行调用；权限与参数判定不在这里（在 kernel-allowlist / kernel-call） |
| `src/host/ws-kernel-frames.ts` | file | 通用内核调用面「既有帧 → 内核端点」处理器（issue #26 阶段 7）：KernelFrameHandler —— 插件族十帧经 kernel-allowlist 的 KERNEL_FRAME_CALLS 走同一个 KernelCallService（scope 判据/在飞行表/幂等与 kernel-call 帧同源），载荷按描述符 wire 键翻译，结果装进 `{ok,value}` / `{ok,error}` 信封按同 kind 回包；未协商 dshrb-v1 回 NOT_IMPLEMENTED |
| `src/host/ws-schedule.ts` | file | 移动端网关 WS 定时任务域（schedule-*，代理内核 schedule Remote，缺失回 unavailable）；阶段 7 起含五个直通帧（schedule-create/edit/view/run/delete-inactive，`{request}` 原样进内核，同 kind 回 `{ok,value\|error}`） |
| `src/host/ws-sessions.ts` | file | 移动端网关 WS 会话生命周期域（session-create/cancel/archive/rename，/ws/mobile） |
| `src/host/ws-speech.ts` | file | 移动端网关 WS 官方语音域（speech-*，纯代理内核 speech Remote，4MiB/4并发/180s，缺失回 unavailable） |
| `src/host/ws-settings.ts` | file | 移动端网关 WS 全局设置域（default-model 全局目录/providers/permission-options，/ws/mobile） |
| `src/host/ws-team.ts` | file | 移动端网关 WS 智能体团队/子会话域（agent-team/subagents，只读会话投影，/ws/mobile） |
| `src/client/` | dir | DSH WebUI 浏览器半边 |
| `src/client/api.ts` | file | 浏览器侧 REST 客户端 |
| `src/client/app-qr.ts` | file | 应用下载二维码（dsh-Chat × 双站，生成物，勿手改） |
| `src/client/handoff.tsx` | file | 图片交接消息渲染 |
| `src/client/i18n.tsx` | file | 双语文案与语言 store |
| `src/client/index.tsx` | file | 客户端插件入口与 slot 注册 |
| `src/client/plugins.tsx` | file | 插件清单的右侧栏 tab 形态 |
| `src/client/styles.ts` | file | 面板 CSS |
| `src/client/workspace.tsx` | file | 手机设置面板外壳：分区常量、共享状态持有（refresh/隧道/通知）、CardsProvider 接线 |
| `src/client/cards/` | dir | 每张设置卡一个文件（2026-10-31 从 workspace.tsx 拆出） |
| `src/client/cards/context.ts` | file | CardsContext：卡片共享状态与动作（至少两卡要用的才进这里） |
| `src/client/cards/shell.tsx` | file | 折叠卡片外壳 SettingsCard / AdvancedGroup / tabIcon / tabLabelKey / tabDescKey |
| `src/client/cards/shared.tsx` | file | 跨卡复用的小部件与纯函数（CopyButton / formatBytes / messageOf / apiErrorKey 等） |
| `src/client/cards/roots.tsx` | file | 根目录卡（高级设置组首位；没有它远程与隧道都被锁死） |
| `src/client/cards/remote.tsx` | file | 远程访问卡（绑定 IP/端口、配对码、权限勾选、操作轮询 poll） |
| `src/client/cards/tunnel.tsx` | file | 外网隧道卡（Cloudflare 快速隧道的开关与进度） |
| `src/client/cards/devices.tsx` | file | 设备卡（已配对手机、权限与吊销、DeviceRow） |
| `src/client/cards/trash.tsx` | file | 回收站卡（手机端删除记录的恢复与彻底清理，展开才拉取） |
| `src/client/cards/image.tsx` | file | 识图卡（图片落盘目录名，展开才拉取） |
| `src/client/cards/plugins.tsx` | file | 插件卡（profile 插件清单、启停、检查更新） |
| `src/client/cards/app-download.tsx` | file | App 下载卡（dsh-Chat × 双站二维码与地址） |
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
