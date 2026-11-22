# 兼容性

## 运行矩阵

| 组件 | 支持范围 | 验证方式 |
| --- | --- | --- |
| Node.js | `^22.19.0 || >=24.0.0` | CI 22.19 和 24 |
| DSH | 源码基线 `master@47f9438`（仓库版本 `0.1.0-rc.5`） | tarball profile 安装、配置组合和真实启动 |
| Windows | Windows Server 2022 / Windows 11 | `windows-latest` |
| macOS | GitHub 当前 macOS runner | `macos-latest` |
| Linux | Ubuntu 当前 LTS runner | `ubuntu-latest` |
| Android | Android 8.0（API 26）及以上；compile/target SDK 36 | Gradle、lint、单元/UI 测试、Android 15 端到端与签名 Release APK |
| dsh-Chat | Flutter `app/`：Android 1.0.18+19 已发版（含 iOS 通道）；HarmonyOS ArkTS `harmony/`：2026-11-15 起步，未发版 | 与 bridge 2.12.1 联调**待实测** |
| dsh-Go | 原生插件协议 `v: 1`；开发基线 App `1.2.0+1`（清单未写 `minApp`，桥接按自身能力裁决） | 清单与中英视图过 App 侧 `node sdk/plugin-kit/bin/check.mjs`；**真机联调待实测** |

dsh-Chat 的协议基线为 bridge ≥ 2.10.0（协议 v3，子协议 `dsh-mobile-v1`），Android 产物名 `dsh-Chat-v<VER>.apk`；下载页见 [GitHub Releases](https://github.com/westanke/dsh-Chat/releases) · [Gitee Releases](https://gitee.com/westanke/dsh-Chat/releases)。收录本身不新增协议能力，也不代表上表之外已完成实测。

### dsh-Go 原生界面（v2.15.0 起）

`dshGo` 清单缺失 / 协议版本不认识 / `ctx.dshGo` 不可用时，**插件其余部分完全照常**：面板与状态条
只是不出现（`attachDshGoPanel` 三层静默失败，`apply` 不抛错）。反过来，老版本本插件（< 2.15.0）
没有 `dshGo` 字段，dsh-Go 只是看不到这个面板，不影响任何既有客户端。

## 协议面与弃用迁移矩阵（2026-11-20 起）

桥的**第一协议面**是 `/ws/mobile` 的双向帧（子协议 `dsh-mobile-v1`；`dshrb-v1` 另开通用内核调用面）。
`/api/v1` REST 与 `/api/v1/events` SSE 是**老协议**：已冻结、只减不增、逐步下线。
规则见 [AGENTS.md](../../AGENTS.md) §1.1，逐端点表见 [API.md](API.md) 的「协议面状态与弃用表」。

| 项 | 现状 | 最早移除 |
| --- | --- | --- |
| REST 已弃用端点（21 个 operation：工作区发现、会话增删改/分叉/归档/等待、消息、审批、提问、命令、模型、Agent Preset、取消） | `openapi.yaml` 已标 `deprecated: true` + `x-dsh-replaced-by` + `x-dsh-removal-not-before`，替代帧见 API.md 表 1 | **3.0.0** |
| REST 对等面：分块上传 / 定时任务 / 语音（13 条） | 帧是主路径；`dsh-companion` 仍在用 REST 回落，迁完后降级为「已弃用」 | **3.0.0** |
| `/api/v1/events`（SSE） | 只作 WS 断线兜底 | 不早于 3.0.0，与 REST 同步评估 |
| 例外（`/manage/*`、图片与裸路由、roots/trash、附件字节、jobs、子会话历史、工作区登记写、设置面） | 没有帧等价物，保留 | 不计划移除 |

**已发布客户端的现状**：`dsh-companion` v2.2.x 以帧为主、REST 仅回落（`DshClientBff.kt` 仍调
三域对等面）；`dsh-Chat` 已接 `dshrb-v1`。移除任一已弃用端点前，两个仓都必须确认不再调用
（`AGENTS.md` §3.5 的三条前置）。

当前 npm 上的旧版 DSH 包存在未发布的内部依赖，独立插件开发仓库设置 `auto-install-peers=false`；插件不在运行时导入这些包，而由已启动的 DSH Host 通过 Cordis service 注入 `apiProxy` 和 `webServer`。

Windows 11 / Node 24.18.0 已完成本地全套验证。GitHub Actions 已配置 Node 22.19/24 核心矩阵、三系统 tarball profile 安装、Ubuntu DSH 真实启动和 JDK 17 SDK 编译；远程仓库创建后才能取得 hosted macOS/Linux 结果。

## 网络监听

- Windows、macOS 和 Linux 均通过 Node `net` 数值地址语义绑定 IPv4/IPv6；指定地址必须属于本机接口，`0.0.0.0`/`::` 表示对应地址族的全部接口。
- Linux 非 root 服务建议选择 `1024–65535` 端口；低端口可能因 `CAP_NET_BIND_SERVICE` 缺失而失败并回滚。
- Docker/Podman 中的绑定只作用于容器网络命名空间，仍需通过 Compose `ports` 或启动参数发布所选端口。
- 云服务器还需在主机防火墙和云安全组中允许所选 TCP 端口；插件不会自动修改防火墙。

## 文件系统规则

- Windows：保留盘符和 UNC 根，wire path 禁止盘符、UNC、反斜杠、冒号、尾随点/空格和保留设备名。junction/reparse point 不得作为穿透路径。
- macOS：不更改真实 Unicode 文件名，不假设大小写敏感或不敏感。
- Linux：保持大小写和权限位，处理 symlink、挂载点及 `EXDEV`。
- 所有平台：路径逐段 `lstat`；内容保存的临时文件与目标同目录；跨卷回收执行复制、摘要校验、清单提交和源删除。

Node 标准库没有跨平台 `openat`/目录句柄相对文件操作，逐段检查与最终操作之间仍存在本机并发改名的窄 TOCTOU 窗口。插件不是恶意本机管理员或同权限进程之间的隔离边界；该残余风险记录在安全模型中。

Android 工程使用 JDK 17 工具链、Jetpack Compose、Material 3 和 OkHttp。HTTP/HTTPS 都可连接；HTTP 需要显式 cleartext 网络配置并持续显示风险提示。Android 15 已验证发布版通过 HTTP listener 配对和恢复；HTTPS 及 Android 8/其他厂商系统仍需扩大实机矩阵。手机、平板和可折叠设备使用自适应 Compose 布局，首期不支持 Android 8.0 以下系统。
