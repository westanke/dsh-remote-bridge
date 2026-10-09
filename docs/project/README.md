# 项目恢复入口

本文档目录是开发事实来源。聊天记录可以帮助讨论，但不得替代这里的状态、接口和决策记录。

## 每轮开始

1. 阅读 [STATUS.md](STATUS.md)，确认当前基线、正在进行的任务和阻塞项。
2. 阅读 [ROADMAP.md](ROADMAP.md)，只处理状态为 `in-progress` 或下一项 `planned` 的任务。
3. 按任务需要阅读 [ARCHITECTURE.md](ARCHITECTURE.md)、[API.md](API.md)、[SECURITY.md](SECURITY.md) 和相关 ADR。
4. 检查 `git status --short`，不覆盖来源不明的修改。

## 更新规则

- 任务完成、失败或验收条件变化时立即更新 `ROADMAP.md`。
- 当前任务、阻塞、验证命令和下一步变化时更新 `STATUS.md`。
- 公共 wire schema 变化时同步更新 `API.md`、OpenAPI、AsyncAPI、Kotlin SDK 和测试。
- 跨平台结论变化时更新 `COMPATIBILITY.md`；安全边界变化时更新 `SECURITY.md`。
- 不可逆的架构或协议决定写入 `decisions/ADR-NNNN-*.md`，并加入下方索引。
- 每次提交前运行 `pnpm docs:check`，把已运行命令追加到 `TESTING.md` 和 `CHANGELOG-DEV.md`。
- 准备发版、发布 npm 或建双站 Release 时，先读 [RELEASE.md](RELEASE.md) —— 版本号清单、打包器差异、npm 的 2FA 与首次发布暂存审核、发完必做的实测都在那里。

## ADR 索引

| 编号 | 状态 | 决策 |
| --- | --- | --- |
| [ADR-0001](decisions/ADR-0001-out-of-tree-plugin.md) | accepted | 使用独立外置 Profile bundle |
| [ADR-0002](decisions/ADR-0002-authorized-roots.md) | accepted | 使用授权根和相对 wire path |
| [ADR-0003](decisions/ADR-0003-http-remote-listener.md) | accepted | 独立 listener 允许 HTTP，但默认不远程暴露 |
| [ADR-0004](decisions/ADR-0004-configurable-listener-endpoint.md) | accepted | 远程绑定 IP/端口由回环管理面配置并失败回滚 |
| [ADR-0005](decisions/ADR-0005-android-app.md) | accepted | 独立开发原生 Compose Android App，并以版本化 BFF 逐项实现 WebUI 功能对等 |
| [ADR-0006](decisions/ADR-0006-final-project-split.md) | accepted | 正式版拆分为 `dsh-workspace` 与 `dsh-android-app` 两个独立项目，并从 v1.0.0 开始发布 |

## 稳定任务 ID

任务 ID 采用 `<AREA>-NNN`。当前区域为 `BOOT`、`DOC`、`BRAND`、`LICENSE`、`FS`、`AUTH`、`NET`、`CHAT`、`APPROVAL`、`UI`、`SDK`、`APP`、`PARITY`、`TEST` 和 `REL`。
