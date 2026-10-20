# AGENTS.md — dsh-remote-bridge 工程宪法

> 本文件是每次会话**必然读到**的那份约定。规矩写在这里，不靠记忆、不靠口头。
> 与姊妹仓库 `dsh-companion` 的 `AGENTS.md` 同源同制度（2026-10-15 一起立），
> 但按本项目（DSH 服务端插件 / TypeScript）的特色裁剪——**两边职责不同，不要照抄**。
>
> **体积纪律**：本文件只写**命令、契约、触发词与一两行的铁律**；
> 「说不清、要摆证据」的内容一律进 `docs/project/`（坑位 → `PITFALLS.md`，
> 设计 → `decisions/`），这里只留指针。超长会被静默截尾，读者就丢了末尾的规矩。

---

## 0. 一分钟上手

| 我想… | 先读 |
|---|---|
| 知道现在到哪了 | `docs/project/STATUS.md` → `ROADMAP.md` |
| 知道某个接口长什么样 | `docs/project/API.md` + `docs/api/openapi.yaml` + `docs/api/asyncapi.yaml` |
| 知道为什么这么设计 | `docs/project/ARCHITECTURE.md` → `docs/project/decisions/`（9 条 ADR，其中 ADR-0009 为 **proposed**） |
| 改 wire schema | 先改 `API.md` + OpenAPI + AsyncAPI + Kotlin SDK + 测试，**再**改实现 |
| 改代码前避坑 | `docs/project/PITFALLS.md`（名字 = 触发词 = 锚点） |
| 发版 | `docs/project/RELEASE.md` |
| 某功能「一直不工作」 | `docs/project/RETRO-question-card.md` 的「该记住的」一节 |

> **本文档目录是开发事实来源**。聊天记录可以帮助讨论，但不得替代这里的状态、接口和决策记录。

---

## 1. 本项目是什么（一句话与边界）

- **定位**：把 DSH 内核的私有 remote 协议翻译成**版本化 REST**，供手机与第三方客户端远程访问；
  同时在 DSH WebUI 设置里提供「📱 手机设置」面板（七张折叠卡片，**只做设置**）。
- **上游**：`Hakunm/dsh-workspace` v1.0.0（AGPL-3.0），本仓库是它的延续与改名
  （`dsh-workspace` → `dsh-remote-bridge`）。
- **与谁配**：Android 客户端 `dsh-companion`（**要求 bridge ≥ 2.3.7** —— 与 README 双站的安装要求
  一致，姊妹仓 `AGENTS.md` §1 已同步）。客户端会解析 `connection.ready` 的能力位做**运行时**探测
  （见 `src/host/capabilities.ts`），因此「最低版本」是**安装门槛**，不是功能判据。
- **不做什么**：不跑内核、不做移动端 UI 适配。
  WebUI 的移动端适配是 `dsh-web-mobile` 那条线，**与本项目的「手机设置」面板不是一回事**——
  我们的面板是给原生客户端配套的**桌面端设置入口**，不与它竞争。

### 三条不可动的对外契约

| 契约 | 位置 | 为什么不能改 |
|---|---|---|
| REST 前缀 `/dsh-workspace-api` | `src/host/server.ts:325` | **已发布的 App 把它写死了**（`server.ts:316` 注释明示） |
| 状态目录 `dsh-workspace` | DSH profile 配置 | 换目录 = 用户的授权根配置与回收站全部消失 |
| 端口默认 `3090` | `src/host/config-text.ts` | 客户端示例与 DSHA 生态都认它；改要双站文档同步 |

> 改名前已核过：`/dsh-workspace-api` 前缀与 `dsh-workspace` 目录**刻意保留旧名**，
> 看到它们不是改名没改干净。页面 `/dsh-workspace`（2.2.0 已删）与 REST 前缀是两回事。

---

## 2. 命令（本地唯一可信口径）

```sh
bash scripts/release.sh   # 一键发版：门禁→npm 打包→tag→双推→两站 Release→npm 发布→全渠道回读
pnpm check          # typecheck → test → docs:check → build（提交前跑这个）
pnpm test           # vitest run
pnpm typecheck      # tsc --noEmit
pnpm docs:check     # 文档一致性（10 必需文档 + ROADMAP 状态 + STATUS 引用 + ADR 索引 + 根 README 双站与 CHANGELOG）
pnpm build          # clean + tsdown
pnpm test:e2e       # playwright
```

**铁律**：
- **提交前跑 `pnpm check`**，不是 `pnpm build`。`build`（tsdown）**不查类型**——
  见 `PITFALLS.md` §build 不查类型（`RETRO-question-card.md` 坑 B 的实锤）。
- 发版前**必须先 dry-run 一次**：`npm pack` / `npm publish --dry-run` 会触发
  `prepack → pnpm check`，那是发布前最后一道闸，比单独 `build` 严格得多。
- 产物用 `npm pack --pack-destination artifacts`，**不用 `pnpm pack`**——
  目的是让本地产物与 npm 上那份的 shasum/integrity 哈希一致（`RELEASE.md` 新规矩）。
- **发版时 git 与 npm 必须同批**：只推 git + 建 Release 不算发完，`npm publish` 是同一件事的一部分。
  一键脚本 `scripts/release.sh` 已把两者串起来并逐步回读——**别再手敲清单，会漏**（v2.4.2 漏过一次）。
- `docs:check` 有**两段**：`docs/project/` 的必需清单式校验（10 份文档 + ADR 索引齐全，
  新增文档不会让它红），以及根 **README 双站 + CHANGELOG** 的关键口径校验
  （内核版本范围双语一致且对上 `engines.dsh`、当前版本对上 `package.json`、变更记录有当前版本条目）。
  注意 `requiredDocs` 里的 `README.md` 指的是 `docs/project/README.md`（文档索引），
  与仓库根的对外 README 不是一份 —— 前者归 ADR 索引查，后者归第二段查。

---

## 3. 架构纪律

### 3.1 分层与边界

```
src/host/            ← 宿主侧：router / chat-adapter / dsh-0.2-bridge / database /
                       file-service / settings-adapter / plugin-inventory / image-handoff / server
kotlin-sdk/          ← 给 App 的 SDK（与 wire schema 同步变更）
docs/api/            ← OpenAPI + AsyncAPI（wire schema 的权威）
```

- **wire schema 是跨仓契约**：改它必须同步 `API.md` + `openapi.yaml` + `asyncapi.yaml`
  + `kotlin-sdk` + 合约测试，五处一起。只改实现不改 schema 文档 = 下游 SDK 静默失配。
- **`src/host/dsh-0.2-bridge.ts`（约 1 790 行）是适配层，不是业务层**：它重建 0.1.x 的
  `apiProxy` 面容（0.2.x 起 `@deepseek-ai/dsh-host-apiproxy` 被
  `@deepseek-ai/dsh-api-gateway` 替换，Cordis 服务名 `apiProxy` → `typertGateway`，
  0.2.x 上**没有任何东西再提供 `apiProxy`**）。适配代码见下节 `@patch` 制度。
- 路由鉴权分两类：`/dsh-workspace-api` 前缀上的请求要**设备 token 或 loopback admin**；
  另一条不能并进该前缀（`server.ts:320` 注释）。

### 3.2 债务台账（只许收紧）

台账放 `docs/project/TECH-DEBT.md`：

- 每条含：位置、为什么是债、清账阶段。
- **只许收紧**：债务消失，同一提交里删条目（自证非空转）。
- 当前行数预算：**600 行/文件**（TS 单文件心智负担低于 Kotlin，故比 companion 的 800 更紧）。
  基线在册（**以 `docs/project/TECH-DEBT.md` 为准，这里只给大致量级**）：
  `dsh-0.2-bridge.ts` ≈1 790、`router.ts` ≈1 250、`chat-adapter.ts` ≈1 370。
  > 不要把精确数字抄进本文件：2026-10-17 就发生过「AGENTS 与 TECH-DEBT 各自记着半年前的
  > 行数、三个文件全部对不上」的事。数字只有一个事实来源。
  > 这三个是**已登记的债，不是许可**。新增超预算文件必须先入台账再写码。

### 3.3 兼容补丁四要素（`@patch`）

凡因 DSH 内核/上游行为而写的适配代码（本项目的重灾区就是 `dsh-0.2-bridge.ts`），
必须在源码里自报四要素：

```ts
// @patch
// id: short-kebab-id
// for: 适配什么（内核哪个服务/哪一代）
// why: 为什么不能用正规写法（没理由 = 债务）
// until: 什么条件达成就能删（如「上游恢复 apiProxy」）
// test: 哪个测试盯着它（必须真实存在）
```

- `test` 指向的测试**必须存在**——这条**已可机检**：`tests/patch-discipline.spec.ts`
  会校验五要素齐全、`test` 里的文件与**用例名**都真实存在（含下限断言防「零解析被当成零问题」）。
- 没有 `@patch` 的适配代码 = 没人认领的补丁，后来者不敢删，只会在上面继续堆。
- 本项目已有先例可照：`cordis.patch.yml` 的 patch 行、`DSH-0.2-COMPAT.md` 的适配说明。

---

## 4. 测试纪律

| 层 | 命令 | 说明 |
|---|---|---|
| 类型 | `pnpm typecheck` | `tsc --noEmit` |
| 单元 | `pnpm test` | vitest；当前 37 个测试文件 / 275 用例（随代码变化，勿当常量） |
| 文档 | `pnpm docs:check` | 10 文档 / ROADMAP 状态 / STATUS 引用 / ADR 索引 / 根 README 双站 + CHANGELOG 口径 |
| e2e | `pnpm test:e2e` | playwright；**4 个样式契约用例**，渲染真实 DOM 量计算样式，**不需要服务器**（插件已无可访问的独立页），只需 chromium。本机 `pnpm` 坏时用 `node_modules/.bin/playwright test` |
| 真机 | 人工 | **单测绿 ≠ 行为对**。涉及内核交互、审批、问答卡片的一律真机确认 |

**铁律**：
- 修 bug 必须带回归用例（`TESTING.md` 记录演进）。
- `prepack` 比 `build` 严格——发版前务必 dry-run。
- 不许为凑数加空断言测试。

---

## 5. 对外表述纪律

- **「已合并」≠「已发布」≠「用户吃到了」**。三态必须分清，未发版前明说「等下个 release」。
  （本仓有过实测教训：把「已合并」说成「已处理」，用户拍板纠正。）
- 公开文本（PR / issue / Release notes）只写事实：改了什么、为什么、门验结果。
  私聊验收口语、内部原话、自封头衔一律不进公开文本。
- 双站链接三类处理：上游引用（`Hakunm/*`）保持 GitHub 不改；本仓库自身/姊妹仓库的
  绝对地址双列「GitHub · Gitee」；仓库内相对链接两站自动解析。
- **禁止**：推送（push / release / tag / 上传产物）未经用户明确同意。
  本地 commit、构建、测试、清理、写文档可直接做。

---

## 6. 坑位索引（名字 = 触发词 = 锚点）

正文在 `docs/project/PITFALLS.md`，动手前按名字读对应条目。**不看就改 = 重踩。**

- `build 不查类型`
- `README 双站漂移`
- `apiProxy 消失`
- `前缀契约`
- `端口 3090 归属`
- `归档点了不消失`
- `审批与提问卡片全灭`
- `抢答与 next() 委托`
- `waterfall 不 prepend 就等于没注册`
- `wait.callId 判据过严`
- `npm pack 与 pnpm pack`
- `Gitee Release 死链`
- `npm 发布：本地 npm 不支持 staged，报错方向还相反`
- `孤立代理项打死整条连接`
- `pnpm store 打不开数据库`
- `截断标记与内容必须同源`
- `论证要先追到消费侧`
- `空结果的来源要验证`
- `wss 端点必须归一成 https`
- `国内下载 cloudflared 必须择源`
- `Quick 隧道地址漂移后不会自动更新`
- `创建隧道无提示`

> 新坑位：名字加进上面清单 + 原文写进 `PITFALLS.md` 并补 `### 同名` 锚点。

---

## 7. 与 dsh-companion 宪法的差异（别互相抄）

| 项 | dsh-remote-bridge（本仓） | dsh-companion |
|---|---|---|
| 语言 | TypeScript | Kotlin |
| 命令口径 | `pnpm check`（四道门一条命令） | `scripts/build.sh <task>` |
| 行数预算 | **600**/文件 | 800/文件 |
| 文档门禁 | `pnpm docs:check`（10 文档 + ADR 索引 + 根 README 双站/CHANGELOG） | `docsCheck`（8 文档） |
| 独有坑位 | apiProxy 消失、前缀契约、抢答委托、pack 差异 | WebView 双实现、熄屏断流、图片附件元数据与字节读取 |
| 共有坑位 | README 双站漂移、端口 3090 归属、对外表述三态 | 同 |

> 两边**共有**的三条（README 双站漂移、端口 3090 归属、对外表述三态）措辞保持一致，
> 改一处记得改另一处。

---

## 8. 制度来源

本文件借鉴 [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) 的 `AGENTS.md` 制度设计
（文档路由表、补丁四要素、债务台账只许收紧、坑位索引），
与 `dsh-companion/AGENTS.md` 同批建立、按各自特色裁剪。

**本项目已有的好底子**（立宪时保留并显式化）：`pnpm check` 四道门、
`docs:check` 含 ADR 索引校验、9 条 ADR、`RELEASE.md` 发版清单、`RETRO-question-card.md` 复盘。
