# 项目恢复入口

本文档目录是开发事实来源。聊天记录可以帮助讨论，但不得替代这里的状态、接口和决策记录。

## 工程宪法

仓库根的 `AGENTS.md` 是每次会话必然读到的那份约定：命令口径（`pnpm check` 而非 `pnpm build`）、
三条不可动的对外契约、wire schema 五处同步、债务台账（行数预算 600）、`@patch` 四要素、
测试纪律、对外表述三态、坑位索引。**规矩写在那里，不靠记忆、不靠口头。**

## 每轮开始

1. 阅读 [STATUS.md](STATUS.md)，确认当前基线、正在进行的任务和阻塞项。
2. 阅读 [ROADMAP.md](ROADMAP.md)，只处理状态为 `in-progress` 或下一项 `planned` 的任务。
3. 按任务需要阅读 [ARCHITECTURE.md](ARCHITECTURE.md)、[API.md](API.md)、[SECURITY.md](SECURITY.md) 和相关 ADR。
   不知道**某个文件/目录是干什么的、新文件该放哪** → [STRUCTURE.md](STRUCTURE.md)；
   不知道**某个模块导出什么、接口签名长什么样** → [INTERFACES.md](INTERFACES.md)。
4. 检查 `git status --short`，不覆盖来源不明的修改。
5. **改代码前**按名字读 [PITFALLS.md](PITFALLS.md) 对应坑位；超行数预算前先入 [TECH-DEBT.md](TECH-DEBT.md)。

## 更新规则

- 任务完成、失败或验收条件变化时立即更新 `ROADMAP.md`。
- 当前任务、阻塞、验证命令和下一步变化时更新 `STATUS.md`。
- 公共 wire schema 变化时同步更新 `API.md`、OpenAPI、AsyncAPI、Kotlin SDK 和测试。
- 新增/移动/删除 `src/` 下文件，或改导出符号/签名/REST 路由时，**同一提交**更新
  `STRUCTURE.md` / `INTERFACES.md` 的机检锚点（`docs:check` 双向校验，见 `AGENTS.md` §3.4）。
- 跨平台结论变化时更新 `COMPATIBILITY.md`；安全边界变化时更新 `SECURITY.md`。
- 不可逆的架构或协议决定写入 `decisions/ADR-NNNN-*.md`，并加入下方索引。
- 每次提交前运行 `pnpm docs:check`（本机 pnpm store 不可用时用 `./node_modules/.bin/tsx scripts/check-project-docs.ts`），把已运行命令追加到 `TESTING.md` 和 `CHANGELOG-DEV.md`。
- **提交前跑 `pnpm check`**（typecheck → test → docs:check → build），不是 `pnpm build` —— 见 [PITFALLS.md](PITFALLS.md) §build 不查类型。
- 因内核/上游行为写的适配代码必须打 `@patch` 四要素标（`AGENTS.md` §3.3），存量见 [TECH-DEBT.md](TECH-DEBT.md) DEBT-003/004。
- 准备发版、发布 npm 或建双站 Release 时，先读 [RELEASE.md](RELEASE.md) —— 版本号清单、打包器差异、npm 的 2FA 与首次发布暂存审核、发完必做的实测都在那里。
- 排查「某个功能不工作」之前，先读 [RETRO-question-card.md](RETRO-question-card.md) 的「该记住的」一节。

## 导航文档

| 文档 | 记的是 |
| --- | --- |
| [STRUCTURE.md](STRUCTURE.md) | **代码地图**：顶层目录树、分层与依赖方向、逐目录职责、关键文件速查、新增东西放哪里。文末锚点归 `docs:check` 双向校验。 |
| [INTERFACES.md](INTERFACES.md) | **契约与签名**：对外 REST/流/能力位、内部模块导出与逐字签名、改接口检查清单。文末锚点归 `docs:check` 双向校验。 |

> 这两份是给「要改代码的人与 AI」用的。对外正式契约仍是 [API.md](API.md) +
> `../api/openapi.yaml` + `../api/asyncapi.yaml`；设计动机仍是 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 复盘

| 文档 | 记的是 |
| --- | --- |
| [RETRO-question-card.md](RETRO-question-card.md) | 问答卡片「一直不显示」的排查复盘：**卡片代码从头到尾都是对的**，错的是排查方法 —— 先解释现象，却没先确认现象真的发生过。另含两个真实技术坑：`wait.callId` 的判据过严（把 plan 模式整条挡在门外）、`pnpm build` 不查类型而 `prepack` 才查。 |

## ADR 索引

| 编号 | 状态 | 决策 |
| --- | --- | --- |
| [ADR-0001](decisions/ADR-0001-out-of-tree-plugin.md) | accepted | 使用独立外置 Profile bundle |
| [ADR-0002](decisions/ADR-0002-authorized-roots.md) | accepted | 使用授权根和相对 wire path |
| [ADR-0003](decisions/ADR-0003-http-remote-listener.md) | accepted | 独立 listener 允许 HTTP，但默认不远程暴露 |
| [ADR-0004](decisions/ADR-0004-configurable-listener-endpoint.md) | accepted | 远程绑定 IP/端口由回环管理面配置并失败回滚 |
| [ADR-0005](decisions/ADR-0005-android-app.md) | accepted | 独立开发原生 Compose Android App，并以版本化 BFF 逐项实现 WebUI 功能对等 |
| [ADR-0006](decisions/ADR-0006-final-project-split.md) | accepted | 正式版拆分为 `dsh-workspace` 与 `dsh-android-app` 两个独立项目，并从 v1.0.0 开始发布 |
| [ADR-0007](decisions/ADR-0007-image-handoff-route.md) | accepted | 图片交接的显示链路并入本插件，只读路由改收「会话 + 裸文件名」，识图路径成为可改设置、出厂默认只读 |
| [ADR-0008](decisions/ADR-0008-seq-single-meaning.md) | accepted | `seq` 只表示会话持久事件序号；流式 delta 不再输出它（`index` 承载 chunk 位置）——同一字段名不再有两种语义 |
| [ADR-0009](decisions/ADR-0009-single-winner-interactions.md) | **proposed** | 审批/提问的单胜方：身份比对与迟到响应 `not-pending` 已有；并行下发与「abort 下游收起 WebUI 弹窗」待拍板（后者本仓不可证，附一个低成本验证实验） |

## 稳定任务 ID

任务 ID 采用 `<AREA>-NNN`。当前区域为 `BOOT`、`DOC`、`BRAND`、`LICENSE`、`FS`、`AUTH`、`NET`、`CHAT`、`APPROVAL`、`MODEL`、`IMAGE`、`UI`、`SDK`、`APP`、`PARITY`、`TEST` 和 `REL`。
