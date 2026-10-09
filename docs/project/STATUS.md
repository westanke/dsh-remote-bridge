# 当前状态

- 日期：2026-10-09
- 阶段：`dsh-remote-bridge` v2.0.4（改名 + 桌面端收敛为纯设置面板 + cordis 容错修复）
- 当前任务：`REL-005`
- DSH 基线：`master` / `47f943859bef60e4160492346772ded9b24f765a`
- 插件路径：本仓库（历史上游为 `Hakunm/dsh-workspace`，v1.0.0 保持原样不动）
- 已完成：Host/Client 外置插件、授权根与回收站、独立 listener、设备授权、聊天/审批/命令/模型 BFF、OpenAPI/AsyncAPI、Kotlin SDK、中英双语和版本展示
- v2.0.0（DSH 0.2.x 下游适配）：host bridge 从 `apiProxy` 迁到 host services；新增插件清单 `GET /api/v1/settings/plugins`（`PLUGIN-001`）、配置文本 `POST /manage/config/text`（`CFG-001`）、绝对路径解析 `GET /api/v1/roots/resolve`（`FS-003`）、会话附件读取 `GET /api/v1/attachments/:id`
- 2.0.1 / 2.0.2 / 2.0.3：**已知有缺陷，不建议安装**。2.0.1 把 cordis 注入属性的读取提前到 `apply` 期间导致插件整个激活失败；2.0.2 只给 `attachments` 加了容错、漏了 `fileUploads`；2.0.3 才把两者一并处理
- 2.0.4：改名 `dsh-workspace` → `dsh-remote-bridge`（旧名比内容窄）；桌面端入口收敛为**纯设置面板**（侧栏齿轮按钮，五行设置），文件树与编辑器移出桌面面板、保留在独立页 `/dsh-workspace`
- 附件能力边界：会话历史图片需要宿主提供 `ctx.attachments` 服务；缺失时插件照常激活，读取接口返回 `ATTACHMENT_STORE_UNAVAILABLE`，附件类上传返回 `FILE_UPLOADS_UNAVAILABLE`
- 最近验证：`pnpm check` 全绿 —— `tsc --noEmit`、**17 个测试文件 / 104 个用例**、`docs:check` 一致性、三个 entry 构建完成
- 界面截图：**已删除**（改名前的旧界面，含 v1.0.0 徽章与旧的 1400px 文件树对话框）。重录需要能驱动插件面板的浏览器环境，目前不具备
- 仓库：`https://github.com/westanke/dsh-workspace`，topic 包含 `dsh-plugin`
- Release：`https://github.com/westanke/dsh-workspace/releases`（v2.0.0 及其后为已知缺陷版；v2.0.4 待发）
- 阻塞项：npm 包尚未发布；Android 与 DSH WebUI 的后续完整能力对等仍按 `PARITY-001` 推进