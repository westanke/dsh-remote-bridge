# 当前状态

- 日期：2026-10-09
- 阶段：`dsh-workspace` v2.0.0 下游适配版发布（DSH 0.2.x）
- 当前任务：`REL-005`
- DSH 基线：`master` / `47f943859bef60e4160492346772ded9b24f765a`
- DSH 路径：`C:\Users\nyanya\Desktop\dsh\deepseek-harness`
- 插件路径：`C:\Users\nyanya\Desktop\dsh\dsh-workspace`
- 已完成：Host/Client 外置插件、DSH WebUI 内文件工作区、授权根与回收站、独立 listener、设备授权、聊天/审批/命令/模型 BFF、OpenAPI/AsyncAPI、Kotlin SDK、中英双语和版本展示
- 下游新增（v2.0.0）：DSH 0.2.x host bridge 适配（`apiProxy` → host services）；插件清单端点 `GET /api/v1/settings/plugins`（`PLUGIN-001`）；配置文本端点 `POST /manage/config/text` 与 WebUI 远程访问页按钮（`CFG-001`）；绝对路径解析端点 `GET /api/v1/roots/resolve`（`FS-003`）；会话附件读取端点 `GET /api/v1/attachments/:id`
- 本次刷新：按发布要求删除中英文 README 中的截图环境说明，保留实际效果图片和正文结构
- 最近验证：Windows 本机 Node 22.19.0 连续 5 轮、Node 24 一轮完整回归通过，共执行 144 项 Vitest；GitHub Actions 已覆盖 Windows、Ubuntu、macOS 的 Node 22.19.0/24、浏览器、Kotlin SDK 与三平台 Profile 安装，最终提交状态以仓库 Actions 为准
- 正式产物：`artifacts/dsh-workspace-2.0.0.tgz`，2,676,271 字节，SHA-256 `6657DD9C24BB644FBD7245499E51533D51D5D6E83EB676D9708EDC9ED12A6C74`
- GitHub：`https://github.com/westanke/dsh-workspace`，topic 包含 `dsh-plugin`
- Release：`https://github.com/westanke/dsh-workspace/releases/tag/v2.0.0`
- 上游（不动）：`https://github.com/Hakunm/dsh-workspace`，v1.0.0 保持原样
- 阻塞项：npm 包尚未发布；Android 与 DSH WebUI 的后续完整能力对等仍按 `PARITY-001` 推进
- 下一步：GitHub v1.0.0 已可安装；npm 包仍按后续发布安排处理
