# 开发日志

## 2026-10-09 · v2.0.0 下游适配版发布（`REL-005`）

### 为什么发 major

不是代码风格洁癖，是**宿主契约变了**：`apiProxy` 在 DSH 0.2.x 已不存在，host bridge 整体迁到
host services。插件的入口签名与生命周期钩子跟着换，这一类改动对下游集成方就是破坏性的，
哪怕四个新端点本身都是向后兼容的新增。压成 v1.0.1 会让半年后有人对着旧文档调试新内核，
那才是真正的破坏。

### 这一版带了什么

| 端点 | 任务 | 解决的用户原话 |
| --- | --- | --- |
| `GET /api/v1/settings/plugins` | `PLUGIN-001` | 「无法查看已装插件情况」 |
| `POST /manage/config/text` + WebUI 按钮 | `CFG-001` | 「电脑在哪里生成？」（配对码本来就在远程访问页） |
| `GET /api/v1/roots/resolve` | `FS-003` | 「会话中的文件无法查看」 |
| `GET /api/v1/attachments/:id` | 附件读取 | 会话里发的图片/文件在客户端不可见 |

### 版本号的四处战场

改版本号时踩了一个坑，值得记下来：`package.json` 只是**四个**版本源之一。
`docs/api/openapi.yaml`（含 `pluginVersion` 的 `const` 约束）、`docs/api/asyncapi.yaml`、
`kotlin-sdk/build.gradle.kts` 各有一份，而运行时真正对外报版本的是
`src/shared/version.ts` 里的 `PLUGIN_VERSION`——它才是 `healthz` 与客户端设置页显示的那个值。

只改 `package.json` 而漏掉 `src/shared/version.ts` 的结果是：
`pnpm docs:check` 全绿（它只校对文档与 package.json 的版本），
只有 `tests/http-api.spec.ts` 的 `healthz` 断言会红。一条测试抓住一个真实的漏项。

`docs/api/openapi.yaml` 里那个 `const: 2.0.0` 也要一起改，否则规范会把响应钉死在旧版本上。

### 验证

`pnpm check` 全绿：`tsc --noEmit`、**17 个测试文件 / 101 用例**、`docs:check`（9 份项目文档、
37 项任务、6 份 ADR 与 API/SDK 版本一致性）、三份 bundle 构建。
产物 `artifacts/dsh-workspace-2.0.0.tgz`，2,676,271 字节，
SHA-256 `6657DD9C24BB644FBD7245499E51533D51D5D6E83EB676D9708EDC9ED12A6C74`。

### 发布形态

`feat/plugin-inventory` 合并进 `main`，在 `main` 上打 `v2.0.0`，tag 推 GitHub + Gitee，
GitHub Release 附 tarball 与 `SHA256SUMS.txt`。上游 `Hakunm/dsh-workspace` 与 AtomGit 远端不动。

---

## 2026-10-08 · 配置文本的 WebUI 入口（`CFG-001`，下游分支）

### 为什么：一句被用户戳穿的话

README 把「配置导入」写成主路径：

> 电脑上生成一行文本 → 发给自己（微信 / 邮件 / 私密笔记）→ 到了外面粘贴进 App

用户追问：**「电脑 在哪里生成？」**

**这一问是对的。** 当时的生成端只有一个命令行脚本（在另一个仓库里）：
用户得装 Node、开终端、`cd` 到仓库、记命令。对一个「人已出门、电脑在家」的场景，
这等于「请先编译源码」，不是入口。而配对码本来就在 WebUI 的「远程访问」页一键生成 ——
配置文本理应出现在同一处。

### 干了什么

- 新增 `src/host/config-text.ts`：线格式编码 + 本机地址探测。
  - `detectEndpoints()` 枚举非回环 IPv4，**排除 `169.254.*`**（只在没有 DHCP 时出现，
    给用户只会换来「为什么这个地址连不上」的困惑）。
  - `classifyHost()` 与 Kotlin `EndpointKind.infer` 的规则一致（含 `100.64.0.0/10` 归虚拟网，
    因为 Tailscale 与 BeyondTunnel 都在用这个 CGNAT 网段）。
  - `encodeConfigText()` 用**对象字面量固定键顺序**，不依赖 `JSON.stringify` 的字典序。
- `src/host/router.ts` 新增 `POST /manage/config/text`（回环管理面）：
  内部走既有的 `createPairing` → `exchangePairing`，默认授予 5 项**非破坏性**权限
  （刻意不含 `files.delete` 与 `settings.write` —— 那是用户显式要求才给的东西）。
- WebUI「远程访问」页在「生成配对码」旁加「生成配置文本」（见 `CFG-001` 的客户端部分）。

### 一个刻意的字段省略

响应**不返回 `pairing.expiresAt`**。它是**配对码**的十分钟有效期，而设备令牌本身
**不过期**（`devices` 表没有过期列）。回传它会被读成「这段文本十分钟后就失效」，
诱发没必要的重复生成。同理，响应也**不单独回传 token** —— 它已在 `text` 内，
多一份只会让它出现在日志、浏览器历史与开发者工具里；有测试断言响应字段集合防止后人加回。

### 三处实现必须逐字节一致

同一套线格式现在有三处实现：Kotlin 编解码（`ConnectionShare.kt`）、命令行脚本
（`dsh-companion/tools/emit-config.mjs`）、本模块。任何一处在键顺序或「空值不写键」上跑偏，
都会产出**字节不同但都能被解码**的文本 —— 三处单测各自都绿，跨端却不再兼容。

因此 `tests/config-text.spec.ts` 里钉了一条 **golden 逐字节断言**，输入取自脚本的真实
stdout（而该脚本的输出已被 Kotlin 端 `ConnectionShareInteropTest` 断言与 `ConnectionShare.encode()`
相同）。一条断言同时钉住三处实现。

### 测了什么

| 测试文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/config-text.spec.ts` | 9 | **golden 逐字节**、空值不写键、键顺序稳定、`/api/v1` 剥离、无地址拒绝生成、各网段分类（含 `100.128`/`100.63` 两个边界外必须归 WAN）、探测结果不含回环与 link-local |
| `tests/plugin-inventory-api.spec.ts` | 11 | 真起 HTTP server：配置文本可解码且**响应不含 token**、生成的设备确实入库、未给地址时自动探测、**非回环 origin 不可触发** |

全量：`17` 个测试文件 / `94` 用例通过；`tsc --noEmit` 通过。

---

## 2026-10-08 · 绝对路径解析端点（`FS-003`，下游分支）

### 基于什么

- 上游 `Hakunm/dsh-workspace` v1.0.0，接在 `PLUGIN-001` 之后。
- 触发自真实使用反馈：**「会话中的文件无法查看」**。

### 为什么：一次被实测推翻的判断

我最初判断这一条**不需要改服务端**，理由是「客户端可以把绝对路径与授权根做最长前缀匹配」。
**这个判断是错的**，实测三条事实推翻了它：

| 事实 | 实测结果 |
| --- | --- |
| `/api/v1/roots` 是否返回根的绝对路径 | **不返回**，只有 `{ id, label, createdAt }`（既有安全设计） |
| 会话的 `cwd` 字段是否可用 | **71/71 全为空字符串** |
| 绝对路径能否直传 `roots/:id/content` | **400**（`PATH_INVALID`，接口只接受相对路径；`../` 逃逸同样 400） |

于是客户端的处境是：手里有「一个绝对路径」和「一个 rootId」，**中间那一环它永远拿不到**。
必须由服务端做这一次转换。

### 干了什么

新增 `GET /api/v1/roots/resolve?path=<绝对路径>`（要求 `files.read`）：

```json
{ "rootId": "...", "path": "dsh-companion/README.md", "kind": "file",
  "size": 1234, "modifiedAt": 1791498310753, "contentType": "text/markdown" }
```

- **仍然不返回根的绝对路径** —— 原有安全边界没有被削弱，这正是把转换放在服务端做的原因。
- 多个根相互嵌套时取**最长**匹配，否则外层根会把内层根下的文件解析成更长的相对路径，
  绕过内层更严格的授权语义。
- 相对路径一律 `400 PATH_NOT_ABSOLUTE`：`path.resolve` 会按服务端 cwd 解析，语义不确定，
  拒绝比猜更安全。
- 不在任何授权根内 → `404 PATH_OUTSIDE_ROOTS`。
- **目录不算错误**：会话里提到的路径可能是目录，返回 `kind: "directory"` 比抛 400 更合理。

新增 `src/host/root-resolver.ts`，分为两层：

1. `matchAuthorizedRoot()` —— **纯字符串**粗筛（找出候选根），因此可脱离文件系统单测；
2. `inspectResolvedPath()` —— 真正的安全校验，委托给既有的 `resolveAuthorizedPath`
   （它逐段 `lstat` 并拒绝路径中的符号链接）。

**为什么必须分两层**：字符串前缀相等不代表真实落在根内 —— 根内可能存在指向外部的符号链接。
复用 `resolveAuthorizedPath` 而不是自己写一遍，是为了不重复实现（也就不会重复实现错）。
另外 `ContentDescriptor` 里带 `absolutePath`，本端点刻意**不返回**该字段。

### 测了什么

| 测试文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/root-resolver.spec.ts` | 13 | 单根内文件、根本身、嵌套根取最长、**同前缀兄弟目录必须拒绝**（`/srv/database` vs 根 `/srv/data`）、越界、空根集合、文件/目录/根本身的描述、不存在、**符号链接逃逸被拒**、`../` 逃逸被拒、响应不含绝对路径 |
| `tests/plugin-inventory-api.spec.ts` | 8 | 真起 HTTP server：resolve 成功且**响应不含根路径**、越界 404、相对路径 400、无 `files.read` 403，外加 `PLUGIN-001` 的四条 |

全量：`16` 个测试文件 / `82` 用例通过；`tsc --noEmit` 通过。

### 教训

「客户端能不能自己做到」这类判断，必须**对着真实响应验证**，不能靠推理。
我这次先给出结论、后来被自己的实测推翻，代价是多写了一个端点；
但如果照原判断交付，用户拿到的是一个**永远点不开文件**的功能。

---

## 2026-10-08 · 插件清单端点（`PLUGIN-001`，下游分支）

### 基于什么

- 上游 `Hakunm/dsh-workspace` v1.0.0，同分支内接在 DSH 0.2.x 兼容适配之后。
- 触发自真实使用反馈：**「功能单调点，无法查看装的插件情况」**。

### 为什么

用户人在外面用手机时，想知道这台机器装了哪些插件、有没有出问题的，**必须回到电脑前的 WebUI**。
核实过插件的对外 API 面：`/api/v1` 当时共 10 个端点
（`healthz` / `pairings/exchange` / `devices/self` / `roots` / `trash` / `chat/sessions` /
`chat/workspaces` / `chat/agent-presets` / `settings/models` / `settings/providers`），
外加 WS `events` —— **没有任何一个与插件相关**；loopback 管理面 `/manage/status` 也只回
`remote` / `roots` / `devices`。所以这个信息在远程侧完全不可见。

### 数据源与依据

DSH 把每个 profile 的插件状态放在同一个 `package.json` 的两个字段里，缺一不可：

| 字段 | 含义 |
|---|---|
| `dependencies` | **装了哪些包**（含版本声明，如 `^0.4.5`） |
| `dsh.profile.bundles` | **实际加载了哪些包** |

两者之差是有意义的信息：
- 在 `dependencies` 但不在 `bundles` → **装了但没启用**；
- 在 `bundles` 但找不到 → **声明加载却缺失**，通常意味着启动有问题。

另外 `node_modules/<name>/package.json` 的 `version` 才是**实际装上的版本** ——
只看 `dependencies` 的 `^0.4.5` 回答不了「我现在跑的是哪个版本」。

profile 名取自 `DSH_PROFILE` 环境变量 → `--profile=<name>` → `--profile <name>`（实测 DSH 以
`dsh --profile web --port …` 启动）；`DSH_HOME` 缺省为 `~/.dsh`。都拿不到时**不猜**，
返回 `PROFILE_UNKNOWN` 让界面如实说明。

### 干了什么

- 新增 `src/host/plugin-inventory.ts`：纯逻辑，不做 IO 之外的副作用，`resolveProfileName` /
  `resolveDshHome` / `readPluginInventory` / `resolveState` 均可单测，支持注入 env 与 argv。
- `src/host/router.ts` 新增 `GET /api/v1/settings/plugins`，要求 scope `settings.read`
  （与 `settings/models` 一致）。读取失败不抛 500，而是返回 `available:false` + `reason` ——
  一个只读的信息端点不该因为文件缺失就让整个请求失败。
- 返回字段被**限制**为「包名 + 版本 + 状态」，不回传任何文件内容；另有测试断言字段集合，
  防止将来有人顺手把整个 manifest 塞进去。

### 一处真实数据才能暴露的设计缺陷（重要）

首版把「在 `bundles` 里但 `node_modules` 找不到」一律判为 `declared-missing`。
**单元测试全绿**（mock 数据里没有官方包），但在真实机器上一次性产生了 **5 条假警报**：

```
[declared-missing] @deepseek-ai/dsh-base
[declared-missing] @deepseek-ai/dsh-web-app
[declared-missing] @deepseek-ai/dsh-experimental-*
```

原因是**官方内核包随 DSH 主包安装，不会出现在 profile 的 `node_modules` 下**，这是正常状态。
修正为新增状态 `runtime-provided`（`official && loaded && !installed`），并在 `problemCount`
中排除它。修正后真实机器上「需注意」从 7 条降到 **2 条**，且这两条是真实洞察：

```
[installed-not-loaded] dsh-hyperframes  声明=^0.4.2  实装=0.4.2
[installed-not-loaded] dsh-remotion     声明=^0.3.4  实装=0.3.4
```

**教训**：mock 数据只能证明逻辑自洽，证明不了判定规则符合真实世界。这类「把正常状态误判为异常」
的缺陷，只有拿真实环境跑一遍才会暴露 —— 而假警报比没有信息更糟，它会让用户学会忽略警告。

### 测了什么

| 测试文件 | 用例 | 覆盖 |
|---|---|---|
| `tests/plugin-inventory.spec.ts` | 19 | profile 解析（含 `--profile --port` 不误判）、`DSH_HOME` 缺省、三种状态分类、scoped 包名展开、`runtime-provided` 判定、官方/非官方、排序稳定、profile 未知、manifest 缺失与格式损坏、字段集合不泄漏 |
| `tests/plugin-inventory-api.spec.ts` | 4 | 真起 HTTP server：有 `settings.read` → 200 且结构正确；无该 scope → 403；未认证 → 401；profile 不可解析 → 200 且带 `reason` |

全量：`15` 个测试文件 / `65` 用例通过；`tsc --noEmit` 通过；`tsdown` 构建通过。

### 安装

```sh
pnpm pack        # prepack 自动跑 typecheck + test + docs:check + build
```

产物需安装进 profile 并**重启 DSH** 才生效。

---

## 2026-10-08 · DSH 0.2.x 兼容适配（下游分支）

- **背景**：DSH 0.2.x 起用 `@deepseek-ai/dsh-api-gateway`（服务名 `typertGateway`）替换了
  `@deepseek-ai/dsh-host-apiproxy`（服务名 `apiProxy`，最后一版 `0.1.1-rc.2`）。0.2.x 上不再有任何
  服务提供 `apiProxy`，插件的 `inject` 无法满足，Cordis 让该行永久停在 `pending`，`apply()` 从不执行，
  HTTP 路由从未挂载——用户侧表现为「添加根目录返回 405」，而非任何显式报错。
- **做法**：新增 `src/host/dsh-0.2-bridge.ts`，在 0.2.x 宿主服务之上重建旧版 `apiProxy` 门面
  （25 个方法），插件的 `chat-adapter.ts` / `settings-adapter.ts`（约 1300 行）零改动。
  桥接层只用结构化类型，不 import 任何 `@deepseek-ai/*` 运行时模块。
- 桥接层同时承担三项非转发职责：事件中继（0.2.x 无进程级会话事件流，改为按运行中会话 `follow()` 后扇出）、
  审批桥（认领 Cordis 瀑布 `approval/request`，转成 `approval/requested`，答复后经 `next()` 放行，
  无人应答则委托下一个 answerer）、门面翻译（`SessionAddress` 判别联合、`AsyncIterable` 流、
  `{ rpcId, payload } → { result: { ok, value } }` 信封）。
- 适配过程中修复 **10 处契约缺口**，全部为「不抛错的静默失败」：`agent-presets` 缺 `trust`；
  会话模型缺 `current`/`routable`；history 恒为空（`page()` 的 `throughSeq` 必须取自 `follow()`
  开场帧，硬编码 `-1` 返回结构合法的空页）；冷会话命令发现失败（0.2.x 激活 Agent 的正路是
  `resolveAgent()`，`agents.get()` 只读）；实时流式输出缺失（新增 `SessionEventRelay`）；
  `api-session/status` 签名误读（参数是 `(sessionId, running)`，首参为裸 id 非对象）；
  事件名不符（应为 `host/session-status`）；`agent-preset/selected` 未转发；
  流式帧未产生（`follow()` 的 `assistantStream` 是 opt-in，不传宿主不产生任何增量帧）；
  内部会话混入列表并报 409（0.2.x `list()` 返回 subagent 拥有的会话，而 `resolveAgent()`
  按设计拒绝激活它们——过滤 `origin === 'subagent'` 并把命令发现改为可降级返回空列表）。
- 第 6、7、9 项属适配过程中自己引入或遗漏的问题，一并记入 `docs/project/DSH-0.2-COMPAT.md` 作为例证。
- **验证**：`pnpm test` 42 项通过（13 个文件）、`npx tsc --noEmit` 零错误；隔离 `DSH_HOME` 中安装真实
  tarball 后「添加根目录」由 405 变为 **201**，8/8 接口 200，文件读写与会话创建正常；真实设备令牌
  验证 8/8 接口 200 后**立即吊销探针设备**；端到端 WebSocket 实测（订阅事件流并真实发消息）
  从修复前的 `chat.message.delta` **0 帧**变为 **11 帧**、累积流式文本正确输出；70 个真实会话逐个
  探测命令发现，结果 正常 67 / 空列表 3 / **报错 0**，会话列表由 75 收敛到 70。
- 新增 `docs/project/DSH-0.2-COMPAT.md` 完整记录「基于什么、为什么、改了什么、测了什么、已知边界」。
- 未改动公开接口（`docs/api/openapi.yaml`、`asyncapi.yaml` 契约保持不变），未改动许可证（仍为 `AGPL-3.0-only`）。

## 2026-08-15 · v1.0.0

- 完成 `DOC-003` 与 `REL-004`：按发布要求删除中英文 README 的截图环境说明，并继续以单一根提交同步公开分支和标签。
- 完成 `BRAND-002`：插件界面、API 文档、SDK 文档和用户 README 的产品简称统一为 `DSH`；中文安装标题改为“快速安装”，两张 DSH WebUI 实际截图同步重拍。
- 完成 `LICENSE-001`：项目自身许可证和 npm 元数据改为 `AGPL-3.0-only`；上游图标及其他第三方材料继续保留原始许可证，不混入项目主许可证。
- 完成 `REL-003`：v1.0.0 按最终名称、许可证、截图和文档重新打包，公开分支与标签以单一根提交发布，避免暴露开发阶段的提交轨迹。
- GitHub hosted 矩阵发现 Windows / Node 22 在 listener 重绑定后可能复用已关闭的 keep-alive 连接；所有会触发重绑定的 `202` 管理响应现显式返回 `Connection: close`，客户端会在新 listener 上建立新连接，并补充响应头合约测试。
- 修复后的 GitHub Actions `31839360841` 全部通过，覆盖 Windows、Ubuntu、macOS 的 Node 22.19.0/24、浏览器、Kotlin SDK 和三平台 Profile 安装。
- 后续 Windows hosted runner 复现出负载相关的 5 秒测试超时，并发现失败重绑定会短暂关闭仍可用的旧 listener；不同端口现先绑定候选 listener、成功后再切换，端口冲突不会中断现有服务，跨平台集成测试预算同步调整为 15 秒。
- 完成 `CHAT-005`：公开 BFF 新增 DSH 工作区重命名/移除及会话重命名/分叉/归档，所有操作重新执行 scope、session 和 root 授权；归档会话从默认列表隐藏但保留日志。
- 正式项目名统一为 `dsh-workspace`，包、bundle、Cordis row、状态目录、CI、OpenAPI、AsyncAPI 和 Kotlin SDK 版本统一为 `1.0.0`，WebUI 设置页和健康检查显示运行版本。
- 重写中英双语用户 README，补齐安装、远程访问、HTTP 风险、权限、安全语义、完整公开接口和排错说明；新增 ADR-0006 固定插件/App 拆分与版本策略。
- Windows Node 24 下 `pnpm check`、24 项 Vitest、Kotlin SDK JDK 17 编译和真实 tarball profile 安装冒烟通过。正式包 SHA-256 为 `739B0C9FDA032B0E15C323A4A1B36FDE15398BE2ECB2234A00B9CE171F6CC40F`。
- 完成 `DOC-002`：安装 Humanizer-zh，参考 GitHub `dsh-plugin` 主题中高关注项目的首屏、截图、安装和双语组织方式，在保留用户手动删改的前提下重写中文 README，并拆出完整 `README.en.md`。
- 通过隔离 DSH WebUI profile 生成文件编辑器与远程访问两张真实截图；只使用 `C:\DshWorkspaceDemo` 示例根，未展示设备令牌、配对码、外部服务器地址或个人文件。
- 创建 `Hakunm/dsh-workspace` 公开仓库并推送 `main`，设置 `dsh-plugin`、`deepseek-harness`、`dsh`、`file-manager`、`remote-api`、`vibe-coding` topics。重新打包后的 tarball 为 2,622,852 字节，SHA-256 `1F7B8C38D5625880A893B08391607185D329ED2E5EC05CA9B0C9600963AA56E7`。
- 发布 GitHub `v1.0.0` Release，上传正式 tarball 与 `SHA256SUMS.txt`；README 的主安装命令固定到该 Release 资产，不依赖尚未发布的 npm 包。

## 2026-08-15

- 完成 `CHAT-004`：插件注入 DSH `agents/commands` host service，新增受 session/root 与 `chat.read/chat.write` 约束的命令列举/执行 BFF、OpenAPI、Kotlin SDK 和合约测试；命令直接进入 host registry且审计不保存参数。会话 `todos/permissions` projection 保持在历史响应中供 App 使用。
- 完成 `UI-004`：远程访问页在没有授权根时明确提示必须先添加根目录，启用按钮继续保持禁用；插件标题区和包元数据展示作者 `Github@Hakunm`，中英文同步。
- 当前 tarball 已更新到 Oracle root `web` profile并重启 DSH；`3080/3090` 和健康检查恢复，真实命令列表与四项 Host 注入验证通过，既有授权根、设备和监听设置保持不变。
- 用户明确要求重启后，将已校验的审批 tarball 安装到 Oracle root `web` profile，终止旧 DSH 进程并以相同 root/npx 环境后台启动；`3080/3090`、健康检查、审批 OpenAPI 和 Host bundle 哈希全部验证通过。旧待审批运行随重启终止，后续真实验收使用新会话。

## 2026-08-14

- 完成 `APPROVAL-001`：Host 缓存 DSH mux 待审批请求，公开按 session/root 授权的脱敏查询与“允许一次/拒绝”接口，私有 RPC ID 不出服务端；新增 `chat.approval.requested/resolved`、OpenAPI、AsyncAPI、Kotlin SDK、REST/脱敏/重复决定测试和最小审计。
- 审批发布包已上传至 Oracle `/tmp` 但没有安装或重启；当前真实 Skill 会话仍停在原审批点，避免为部署新功能而破坏用户尚未决定的运行。
- 完成 `CHAT-003`：将 DSH token 级 `assistant/chunk` 规范化为公开 `chat.message.delta`，完成消息/运行状态/Agent 选择使用稳定事件；新增仅空白会话可用的 Agent Preset 切换端点，已开始会话返回明确锁定错误，并同步 OpenAPI、AsyncAPI、Kotlin SDK 与合约测试。
- WebSocket 广播改为单一有序队列，修复并发异步授权查询可能重排 token 的问题；会话到根的固定映射只作定位缓存，每个事件仍重新检查设备撤销、scope 和 root grant。ARM64 Oracle 真实探针验证 24 个增量严格有序、拼接正文与持久消息一致。
- 扩展 `CHAT-002`：新增受 `chat.write` 与 root grant 约束的 `POST /chat/workspaces`，允许 Android 从授权目录登记新的 DSH WebUI 工作区后直接创建会话；同步 OpenAPI、Kotlin SDK 和合约测试。
- 扩展 `MODEL-001`：供应商读取合并 DSH 模板基值与用户覆盖，并从实时模型目录补足继承模型；新增与 DSH WebUI 同规则的完全自定义供应商创建、协议 schema 发现、脱敏凭据写入及 Android 合约。
- 最终 tarball 已更新到 ARM64 Oracle 的 root `web` profile 并重载；真实 listener 验证工作区发现、37 个供应商、自定义协议能力和模型回填后撤销临时探针设备，未改动授权根与既有设备。

- 完成 `MODEL-001`：新增 `settings.read/settings.write`、供应商配置与凭据状态/写入、模型发现、会话模型和思考强度接口；同步 OpenAPI 3.1、Kotlin SDK、脱敏与选择合约测试。当前 tarball 已更新并重载至 ARM64 Oracle DSH，现有手机设备保留根授权并追加设置 scope。

- 将通过完整 prepack 校验的当前插件 tarball 更新到私有 ARM64 Oracle 测试服务器 root `web` profile；把易失的 `/tmp` 文件依赖迁移为 `/root/.dsh/packages/` 持久引用，并通过 bundle 哈希与 `--dump-config` 验证。未修改插件数据、授权根、设备或监听设置。
- 克隆 DSH `master@47f943859bef60e4160492346772ded9b24f765a`，确认 Profile bundle、`dsh.client` 和官方 slot 契约。
- 初始化独立插件仓库、发布清单、构建入口和持久化项目追踪文档。
- 接受外置插件、授权根、独立 HTTP listener 三项架构决策。
- 记录 npm 旧版 DSH peer 链不完整的问题；开发安装关闭 peer 自动补全，运行时代码保持宿主 service 注入。
- 完成授权根文件服务：懒加载列表、Range 读取、ETag 保存、新建/移动、跨卷校验、插件回收站和冲突恢复。
- 完成 SQLite 配对、256 位令牌摘要、设备 scope/root grant、撤销、审计、幂等与限流。
- 完成默认回环、显式远程启停与回滚的独立 listener，并发布版本化 REST/WebSocket BFF。
- 完成 DSH `apiProxy` 聊天 adapter、三个官方 WebUI slot、独立工作区 route、CodeMirror 6 和响应式管理面。
- 发布 OpenAPI 3.1、AsyncAPI 3.0 与带 Gradle Wrapper 的 Kotlin/OkHttp SDK；JDK 17 实际编译通过。
- 增加 null Origin、转发头、scope/root、错误脱敏、实时 WebSocket 授权和撤销安全回归。
- 增加三系统 CI profile 安装脚本与 Ubuntu DSH 运行探针；Windows 本地 tarball 安装、上游构建和完整启动通过。
- 将 DSH 自注册 Client bundle 发布为 `client.cjs`，消除 ESM 包中的格式歧义；生产依赖审计和 publint 均通过。
- 在真实 DSH WebUI 完成 Chromium 交互验证：通过侧栏 `Files` 打开管理 overlay、登记插件源码根，并从 DSH 同源 route 展示完整文件工作区。
- 完成 `UI-002`：新增默认中文的中英双语词典、全局语言按钮、浏览器偏好持久化、状态/错误本地化及动态 DSH slot 标签；桌面、移动和真实 DSH WebUI 均完成双向切换验证。
- 完成 `UI-003`：侧栏“文件”改为在 DSH 根页面直接打开完整工作区 overlay；设置往返保留当前文件和编辑状态，独立 `/dsh-workspace` route 降级为备用入口，并通过真实 DSH 桌面/移动视口验证。
- 完成 `NET-002`：远程访问设置可持久化自定义数值 IPv4/IPv6 与端口，禁用状态下安全重绑定，失败自动恢复旧 listener；DSH 宿主内完成 `3090` 到 `3190` 再恢复的实际验证，并为占用、不可用及权限拒绝提供中英文错误提示。
- 启动 DeepSeek Harness Android App：锁定独立工程、`io.github.hakunm.deepseekharness`、Compose/Material 3、中英双语、上游黑色鲸鱼图标、Android Keystore 令牌保护和仓库外正式签名；建立 `PARITY-001`，明确当前 BFF 与 DSH WebUI 全功能之间的差距。
- Android 基础客户端实现配对/恢复、scope 感知、WebSocket 重连、聊天与完整文件操作，并通过 HTTP 合约单测、lint、R8 Release 和独立签名校验，随后进入真实 DSH/Android 验收。
- 对运行中的真实插件 listener 完成临时设备与根的配对、scope、ETag 文件、回收站恢复和会话过滤回归，测试授权已撤销。
- Android 文件传输改为 Okio 流式 I/O，并补充目录分页与 Compose 默认中文连接首屏测试 APK。
- Android 15 发布版通过真实插件 listener 完成健康检查、一次性配对、设备/scope/根加载、重启恢复及会话/文件/设置导航；Compose 仪器测试在清理登录前置状态后通过。
- 真机发现并修复 OkHttp WebSocket 握手 URL 被提前改为 `ws://` 的回归，增加合约测试；测试临时设备和授权根已撤销。
- 完成 `CHAT-002`：新增受 `chat.read` 与 root grant 约束的 DSH 工作区发现和 Agent Preset 列表，创建会话优先接收 `workspaceId`；OpenAPI、Kotlin SDK、合约测试与真实 listener 同步通过，外部响应不暴露绝对工作区路径或 preset 损坏详情。
