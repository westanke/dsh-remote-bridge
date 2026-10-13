# 开发日志

## v2.3.5 · 给会话补上绝对工作目录，救活手机端的 `@` 补全

用户报「APP 会话中使用 `@` 出现问题，可让选插件授权的根目录」。查下去发现，
**这个 `@` 补全从写出来那天起就没成功列出过一个文件** —— 而且根因是一处
「注释与实现正好相反」的路径语义误解。

### 三层，一层比一层深

| 层 | 问题 | 后果 |
| --- | --- | --- |
| 1 | 会话工作目录 = 授权根本身时，`wireRelative` 返回**空字符串**（`path.relative(root, root) === ''`） | App 把它当成「没有工作目录」，界面显示「读不到这个会话的工作目录」 |
| 2 | App 把**相对根**的 `cwd` 当**绝对路径**送去 `/roots/resolve` | 服务端对相对路径硬拒绝（`PATH_NOT_ABSOLUTE`），补全必然拿不到数据 |
| 3 | App 没有根的 realPath（`RootView` 刻意不含它） | 拼不出官方那种绝对路径 |

第 2 层最要命也最讽刺：服务端 `ChatSessionView.cwd` 的语义一直是「相对授权根的
wire 路径」，而 App 的注释却写着「会话的 cwd 是**绝对路径**，中间必须过一次
`resolvePath` 做翻译」。**那一步翻译纯属多余** —— 会话里本来就有 `rootId`，
列举接口要的正是「根 id + 相对根的路径」，两个值都是现成的。

顺带一个发现：`MentionQuery.absolute` 也按错误语义写的（「cwd + 相对路径」拼接），
而列举接口返回的 `entry.path` 是**相对授权根**的完整路径，会话目录只是它的一段前缀 ——
正确操作是**换前缀**。这条也一并改了，旧单测随之重写。

### 改了（本服务端只承担第 3 层）

- `ChatSessionView` 新增**可选**字段 `cwdAbsolute`：会话工作目录的绝对路径。
  这个值服务端本来就有（`matchRoot` 的入参就是它），而且该会话一定落在**这台设备
  已授权**的根内（不匹配的会话压根不会出现在列表里），所以给出它不扩大可见范围。
- `listSessions` 里把绝对 cwd 收进局部变量，供 `matchRoot` 与 `cwdAbsolute` 共用；
  顺手在契约注释里写明「`cwd` 为空串是合法值，表示会话目录就是授权根本身」——
  这一条正是 App 侧那个判断写错的根源。
- OpenAPI 的 `ChatSession` schema 同步登记该字段（可选、老客户端忽略）。

### 这一版不做什么

**没有改 `cwd` 的语义**。它已经是「相对授权根」，改回绝对既破坏已发布客户端，
又把机器路径铺给所有人。需要绝对路径的地方，由 `cwdAbsolute` 单独承担。
**也没有新增 `reason` 枚举或错误码** —— 任何新增值都会让老 App 掉进更模糊的
兜底文案，比现状更糟。

### 测了

- 新增 1 条用例：**会话工作目录正好等于授权根本身**（也就是线上截图那个场景），
  钉住 `cwd === ''` 与 `cwdAbsolute === <根真实路径>` 两件事。
- 安全断言**没有拆掉**：`chat-adapter.spec.ts` 原本断言「响应 JSON 不含根的绝对
  路径」，加字段后如期失败。处理方式是把例外**精确摘出去**（按 key 过滤掉
  `cwdAbsolute` 再验），防线收窄到一处而不是整条删除。
- `pnpm typecheck` 通过 · `pnpm test` **30 个测试文件 / 221 个用例全绿** ·
  `pnpm docs:check` 通过 · `pnpm build` 两个 entry 构建完成。

## v2.3.4 · 桌面版：profile 参数是目录，不是名字

用户反馈「我的 APP 项目，目前使用桌面版本」，手机插件页红条提示：

> 服务器读不出插件清单：package.json 可能损坏、缺失或没有读取权限。

并特别交代「**你要考虑兼容性**」。这条提示把排查方向带偏了 —— 它听起来像文件出了问题。

### 文件明明是好的

先按提示排除了三个嫌疑：`/home/wangke/.dsh/profiles/desktop/package.json`
**存在**、`0644` 可读、`JSON.parse` 通过。提示里说的三件事一件都不成立。

于是不再猜文件、改为**去问运行中的插件本人**。它监听 `3090`（并内嵌在 WebUI 端口
`36079` 上），对 `/settings/plugins` 的写操作要 `settings.write`，但只读请求走
loopback 管理通道即可 —— 拿到的真实响应是：

```json
{
  "profile": "/home/wangke/.dsh/profiles/desktop",
  "profilePath": "/home/wangke/.dsh/profiles/home/wangke/.dsh/profiles/desktop",
  "available": false,
  "reason": "MANIFEST_UNREADABLE"
}
```

**`profile` 字段本该是 `desktop`，返回的却是一整条绝对路径。** 真相在这里。

### 为什么

内核接受**两种** `--profile` 写法，两者都合法：

- `--profile web` —— profile **名**；
- `--profile /home/u/.dsh/profiles/web` —— profile **目录**。内核启动器文档里写的正是
  `--profile ${basename(profileDir)}`，**内核自己会取 basename**。

而 **`resolveProfileName()` 只认第一种**，把整条路径当成了 profile 名。接下来
`path.join` 又补了一刀：它**不会**因为后面一段是绝对路径就重置（那是 `path.resolve`
的行为），于是拼出：

```
path.join('/home/wangke/.dsh', 'profiles', '/home/wangke/.dsh/profiles/desktop')
= /home/wangke/.dsh/profiles/home/wangke/.dsh/profiles/desktop
                                    ↑ 多出来的一层
```

必然 `ENOENT`。`readJson()` 的 `catch` 把异常吞成 `MANIFEST_UNREADABLE`，界面再把
`MANIFEST_UNREADABLE` 翻译成「package.json 可能损坏、缺失或没有权限」——
**一条把「路径算错了」说成「文件坏了」的误导性提示**。

### 为什么能潜伏这么久

web 版走的是名字形式（`dsh web` / `--profile web`），永远碰不到这条分支。
**只有官方 Electron 桌面版用目录形式启动内核** —— 所以这个 bug 一直躺在那儿，
直到有人在桌面版里打开插件页。

### 改了

- 新增 `normalizeProfileName()`：**含路径分隔符就取最后一段**，不含则原样返回。
  一条规则同时覆盖名字、绝对目录、相对目录、Windows 反斜杠路径、末尾带斜杠五种输入。
- `resolveProfileName()` 的 **4 个取值入口**（`DSH_PROFILE`、`--profile=`、
  `--profile <name>`、子命令简写）**全部**过这道归一化。四者都可能装着一个目录。
- 连带修好 `togglePlugin()`：它共用同一个 profile 判定，所以手机上点「启用 / 停用」
  本会试图往那个不存在的多层目录里写 `package.json` —— 用户只会看到又一次失败。

### 兼容性（用户明确要求的那条）

- **字段一个没加、没删、没改语义**。`tests/plugin-inventory.spec.ts` 里那条字段
  白名单测试（精确断言 `inventory` 只有 7 个键、每个 item 只有 11 个键）**原样通过** ——
  这是刻意的：老版 App 收到的 JSON 结构与 2.3.3 完全一致，只是 `profile` 从路径变成
  名字。纯字符串，界面显示只会更正确。
- **web 版行为不变**：名字形式的四条来源归一化后仍是原值。
- **不新增 reason 枚举值**：新增值会让老 App 掉进 `else` 分支显示
  「服务器暂时无法提供插件清单（…）」，比现在更模糊。宁可不加。

### 测了

新增 8 条用例（`resolveProfileName` 5 条 + `readPluginInventory` 2 条 +
`togglePlugin` 1 条），其中一条直接拿桌面版启动形式做端到端复现：

```ts
await readPluginInventory({
  env: { DSH_HOME: dshHome },
  argv: ['node', '/usr/local/nodejs/bin/dsh', '--profile', profileDir],
})
// 修复前必然 available:false + MANIFEST_UNREADABLE（而磁盘上文件好好的）
```

`pnpm typecheck` 通过 · `pnpm test` **30 个测试文件 / 220 个用例全绿**。

## v2.3.3 · 「插件」页：详情增强 + 手机上直接启停

用户要求「结合官方的插件特点和功能增加对应功能」，选定 A（管理写操作）+ B（详情增强）。

### 先摸清官方那套是怎么运作的

`dsh plugin <任何东西>` 会**原样转发给 pnpm**。实测踩过一次：本想查
`dsh plugin enable --help`，pnpm 直接进了安装流程（打出 `Packages: +4 -85`）——
它在**动依赖树**。所幸 `package.json` 与 `node_modules`（310 个包）都没被改动，
但这条教训决定了后面所有设计。

翻内核源码确认了真正的机制（`profile-boot` 模块注释）：

> stack its patch layers (**bundle layers in `dsh.profile.bundles` order** …)

也就是说 **`dsh.profile.bundles` 数组就是加载清单，而且顺序即加载顺序**。
启用 = 加一个名字，停用 = 删一个名字 —— **完全不必碰依赖**（包还在 `node_modules` 里，
随时能再启用，不用重新下载）。这条路比走 pnpm 精准得多，风险也小得多。

顺带一个实测发现：本机 profile 有 15 个第三方插件，其中 **3 个装了但没在 bundles 里**
（`@liustack/modlens`、`dsh-hyperframes`、`dsh-remotion`）—— 旧版页面虽然能算出
这个状态，但那正是它读不出清单时最该展示的东西。

### B：详情增强

每个插件多带四样信息（都限制在固定几项，**不转发 manifest 原文**）：

| 字段 | 用途 |
| --- | --- |
| `description` | 手机上只有一串 `@scope/name@1.2.3` 时，用户没法判断「这个能不能停用」，描述是主要依据 |
| `homepage` | 从 `homepage` / `repository`（字符串或对象两种写法）里取，剥掉 `git+` 前缀与 `.git` 后缀 —— 否则点开是 git 协议地址，浏览器打不开 |
| `updateAvailable` / `latestVersion` | 有没有新版本 |
| `toggleable` | 能不能在手机上启停（官方包恒为 false） |

**`updateAvailable` 是三态不是布尔**：`null` 表示「没查/查不到」。压成 `false` 会让界面
在离线时理直气壮地说「已是最新」—— 那是谎话，比什么都不说更糟。

版本检查**默认关闭**，要 `?checkUpdates=1` 显式开：每个包一次 registry 请求，
十几个包会让清单从毫秒级变成好几秒，而用户点进这页十次里九次只想看「装了啥、哪个没启用」。
开启时也只查**确实装在 profile 里**的第三方包（官方包用户装不了、缺失包连本地版本都没有），
并发限 6、超时 5 秒、失败即 null 不重试。

### A：启停写操作（`PATCH /settings/plugins`）

请求 `{ name, loaded }`，需要 `settings.write` 权限。**只改 bundles 数组**。三道安全阀：

1. **拒绝改官方包**（`@deepseek-ai/`）：它们随 DSH 运行时安装、不由 profile 管理，
   改 bundles 也加载不出来，只会把清单搞成与实际不符。
2. **写前必备份**：`package.json.bak-<时间戳>` 落在同目录。profile 的 package.json
   一旦写坏，**dsh 下次起不来**，而用户此刻在手机上、够不着电脑 —— 备份是唯一退路。
3. **先写临时文件再 rename**：同分区 rename 是原子的。直接写原文件的话，写到一半
   断电/被杀会留下残缺 JSON，后果同上。

另外两条边界：

- **幂等不产生垃圾**：本来就是目标状态时不动文件、不写备份 —— 重复点不该在磁盘上
  堆一串备份。
- **启用一个没装的包会被拒**（`PLUGIN_NOT_INSTALLED`）：那会得到一个「声明加载却找不到」
  的条目，而用户看到的现象是「插件没了」，说不清哪一步错了。这种情况该走**安装**流程，
  不该在启停入口放过去。

**必须重启才生效**：bundles 只在启动时读一次。响应里固定带 `restartRequired: true`，
由界面明确告诉用户 —— 别让人以为点了没反应。

### 测了什么

- `togglePlugin` 新增 8 条用例：启用追加、停用只摘名字（**不碰依赖声明、不打乱其余顺序**）、
  写前有备份且内容正确、幂等不堆备份、拒官方包、拒未安装、拒畸形包名
  （`../evil` / `a b` / 空 / `x/y/z` —— 包名会参与拼路径，脏输入不该走到 `path.join`）、
  profile 判不出时报 `PROFILE_UNKNOWN` 而不是猜。
- 既有的**字段白名单测试**如期失败了一次（它专门防「顺手把整个 manifest 塞进去」），
  按新字段同步登记，边界意图不变。
- `pnpm check` 全绿：**30 文件 / 212 用例**（上轮 204，+8）。
- OpenAPI 补登了 `/settings/plugins` 的 GET 与 PATCH 及三个 schema ——
  顺带发现这个端点**此前根本没进 OpenAPI**（旧遗漏）。
  中途 YAML 报过一次 `mapping values are not allowed here`：行内 description 里
  写 `restartRequired: true` 的冒号被当成键值分隔，加引号解决。
- **待真机确认**：重启 dsh 后启停一个插件、看是否要重启才生效、备份文件是否落地。

## v2.3.2 · 修「插件」页判定不出 profile（`dsh web` 这种启动形式被漏掉）

用户反馈（手机端「插件」页）：

> 服务器判定不出当前使用的插件档案，暂时读不到插件清单。请确认 DSH 启动时带有 `--profile` 参数。

**但 profile 就在那儿** —— 插件装在 `~/.dsh/profiles/web/`，加载正常，只有这个页面读不出来。

### 根因：漏了一种启动形式

`resolveProfileName()` 此前只认三种来源：`DSH_PROFILE` 环境变量、
`--profile=<name>`、`--profile <name>`。而用户实际的启动命令是：

```
argv = ["node", "/usr/local/nodejs/bin/dsh", "web"]     ← 没有 --profile
环境变量 = 无 DSH_PROFILE
```

于是返回 null，页面老实报「判定不出」。

**但内核的启动器文档写得很清楚**（`@deepseek-ai/dsh/args` 模块注释）：

> `dsh <name>` **abbreviates** `dsh --profile <name>`；`dsh web` boots the web
> profile (**same as: `dsh --profile web`**)

所以 `dsh web` 与 `dsh --profile web` 完全等价，只是 profile 名被写成了子命令。
**这不是「用户没带参数」，是插件漏了一条启动形式** —— 而 `dsh web` 恰恰是大多数
人用的写法（文档示例里第一个就是它）。

### 修法

在原有三条来源之后补第四条：**子命令简写**。判据照抄内核启动器的解析规则 ——
跳过所有选项，第一个非选项 token 就是子命令：

- 跳过 `--flag value` 时**要连取值一起跳**（`dsh --port 3080 web` 里的 `3080`
  不是子命令，只是 `--port` 的值；不跳它就会去读一个叫 "3080" 的目录）；
- `--flag=value` 自带取值，只跳一个 token；
- `plugin` 子命令**单独排除**：`dsh plugin add xxx` 管理依赖、不启动任何 profile，
  把它当 profile 名会去读不存在的目录 —— 比返回 null 更糟（null 至少老实报错）。

另外补了一条**明确不猜**的边界：写了 `--profile` 但取值非法（`--profile --port 3080`）
时**直接返回 null**，不再退回子命令简写。用户明确写了 `--profile` 只是写错了，
这时候猜「大概是想用 web 吧」是在替用户做决定，而猜错的后果是读到另一个 profile 的
清单 —— 比老实报错难排查得多。

### 测了什么

`resolveProfileName` 新增 6 条用例（该 describe 现共 12 条），其中直接复刻出问题机器
的真实 argv：

```
['node', '/usr/local/nodejs/bin/dsh', 'web']      → 'web'
['node', 'dsh', '--port', '3080', 'web']          → 'web'    （跳过选项与取值）
['node', 'dsh', '--patch=a.yml', 'web']           → 'web'
['node', 'dsh', 'plugin', 'add', 'foo']           → null
['node', 'dsh', '--profile', 'tui', 'web']        → 'tui'    （显式旗标优先）
```

`pnpm check` 全绿。**待重启 dsh 后在真机确认那个页面能列出插件。**

## v2.3.1 · 修「加载更早消息」点了没反应（2026-10-13 发布）

手机端会话里点「加载更早消息」，界面纹丝不动。一行修复，但根因值得记下来。

### 根因：`history()` 从来没有分页过

`GET /chat/sessions/:id/messages` 的实现（`src/host/dsh-0.2-bridge.ts`）是**只用 `follow()`
的开场帧**取历史的：拿到第一帧 `snapshot` 就把流 abort 掉，返回 `snapshot.records`。

问题在于它**把 `beforeSeq` 参数整个忽略了** —— 客户端传不传、传什么值，返回的都是同一窗
（最近 N 条）。于是客户端把「更早的记录」和「已有的记录」一合并，`distinctBy { seq }` 一
过滤，结果就是**什么都没多出来**：按钮点了像没反应。

### 修法：走内核 `page()`

`SessionPageRequest` 需要 `throughSeq`，而它的文档写得很明白 —— 必须**取自对应的
`follow()` 开场帧**，硬编码一个（比如 `-1`）会返回 HTTP 200 + 空页，是一种「不报错的
静默失败」。所以现在的分支是：

- **不带 `beforeSeq`**：照旧走 `follow()` 开场帧（行为不变）；
- **带 `beforeSeq`**：先取开场帧的 `cursor` 当 `throughSeq`，再调
  `host.sessionController.page({ address, throughSeq: snapshot.cursor, beforeSeq, maxMessages })`，
  返回 `page.records`。

`SessionControllerLike` 接口相应补上 `page()` 声明。

### 真机效果（实测）

同一个会话：

```
第一页            → 261 事件，seq 104~364，hasMore: true
带 beforeSeq=104  → 104 事件，seq 0~103，  hasMore: false
```

修复前两次返回的都是 104~364 那一窗；修复后第二次真正取回了 0~103 的更早记录。

### 升级须知

插件是进程内加载的，替换文件后**必须重启 dsh 进程**新代码才生效。

---

## v2.3.0 · 设置面板重做为折叠卡片；识图路径并入；默认根与设备清理（2026-10-12 发布）

本轮把几件事一次做完，用户视角的变化按下面顺序排：

### 1. 设置面板换成了 Vision Router 的折叠卡片样式

删掉了顶部的分区导航栏，七张卡片**平铺**、各自折叠、可多张同时展开（此前一次只显示一张，
用户得先点导航再点卡片头，两步才走一步）。配色从自成一派的灰底青边改挂 DSH 原生
`--dsw-alias-*` 令牌，深色模式因此自动跟随，不必另写一套。

顺带清掉 44% 的死样式：文件工作区那套 UI（文件树、编辑器、对话框）在 2.2.0 就搬走了，
JSX 里一个引用都没有，样式表从 12.6 KB 降到 6.2 KB。

### 2. 识图路径（原 dsh-image-paths 0.3.1 并入）

纯文本模型收到图片时，图片落盘到**会话工作目录**下的 `.dsh-images/`，消息里只留路径给
识图工具读；WebUI 里则用官方附件渲染把图画出来给人看。目录名可在设置里改（单段目录名，
1-64 字符），「当前默认」与「兜底目录」只读展示。

### 3. 根目录默认项：DSH 工作区

DSH 当前的工作区会作为**默认根**自动登记 —— 不可删除，但可正常访问（手机照常浏览）。
路径每台机器不同，所以由插件每次启动自动取，不让用户手填。你自己加过的目录不受影响，
仍可自行增删。

### 4. 设备：撤销即删除 + 权限中文化

撤销一台设备现在是**真的从数据库删除**，不再是打个标记留着一串灰字（本机实测曾堆到
32 条历史探针）。授权行随之清除，审计记录保留。

权限码不再露 `chat.read` 这种英文协议码，中文界面显示「读聊天」、英文界面显示
`Read chat`。

### 5. 远程访问：权限可以在配对前勾选

**新增的权限是在「远程访问」里勾选的**：勾什么，生成的配对码就带什么；APP 输入配对码后
这些权限随设备一起生效。此前这里写死全量，勾了也不生效。

配置文本（`DSH1:` 那串）刻意**不跟随勾选**，仍固定最小权限（不含删文件、改设置）——
它是发给别人扫的。

### 数据库变更（升级须知）

- `roots` 表新增 `builtin` 列；`roots.real_path` 的 UNIQUE 约束**已移除**（默认根与你自己
  加的同目录根是两条独立记录，前者不可删、后者可删）。
- 启动时会清理历史遗留的「标记式」撤销设备。已装机器的授权根与配对**不受影响**，
  令牌继续有效，不需要重新扫码。

升级前建议备份 `DSH_HOME/dsh-workspace/`。

---

## 2026-10-12 · 远程访问的权限勾选恢复可用（配对前选权）

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。

### 诉求（用户原话）

「远程访问中的权限都选不上了，点了不自动打勾」，
补充：「正是没设备，才在这里生成访问码，选权限，APP 输入码后，权限就自动带上了。」

最后这句点醒了我 —— 这排勾选框是**配对前的选权界面**，不是展示。我把它读成了
「展示会授予什么权限」，还加了 `readOnly` 把它彻底锁死。

同一条链路上，三个版本各错一次，全都栽在同一个盲点：

| 版本 | 写法 | 错在哪 |
| --- | --- | --- |
| 初版 | `checked readOnly` | 七个框全勾，点不动 |
| 上一版 | `checked={deviceScopes.includes(scope)}`，`deviceScopes = devices[0]?.scopes ?? []` | **只有没设备时才会走到这一步**，没设备 → 空数组 → 七框全灰。用户唯一需要它的时刻，正好被弄坏 |
| 现在 | 可交互 state `grantedScopes`，默认全选 | 值随配对请求一起发出去 |

用户点不出来不是巧合，是这两版错误的必然结果。

### 改了什么

- 加 `grantedScopes` state（`useState<DeviceScope[]>`，默认全选，与既有行为一致）和
  `toggleScope`；勾选框去掉 `readOnly`，接上 `onChange`。
- `enableRemote(...)` 与 `createPairing(...)` 不再写死 `[...DEVICE_SCOPES]`，改传
  `grantedScopes` —— 服务端本来就支持（`validateScopes` 校验后透传），只是客户端没送。
- 一个都没勾时**禁用**两个按钮，并给一句说明：`validateScopes([])` 服务端不报错，
  但一台零权限的设备连聊天都读不了，不如在源头拦住。
- 文案改成按场景给三种：有设备 / 没设备 / 一项都没勾。前两版那套「只读展示、改请去设备」
  的说明是错的前提上写的，一并换掉。

### 刻意保留的一处最小权限

配置文本（`DSH1:` 那串）**不跟随勾选**，仍走服务端的 `DEFAULT_CONFIG_SCOPES`
（不含 `files.delete`、`settings.write`）。理由是它是**发给别人扫**的，最小权限更稳；
要完整权限就用配对码。这点在按钮旁加了说明 —— 否则用户会以为「我勾了删除怎么没生效」。

### 验证

`tests/scope-picker.spec.ts` 七条，服务端 + UI 源码契约两头都钉：

- 服务端：子集如实落库、单元素与空集合不炸、未知码（如 `file.read`）报错而非静默忽略；
- UI 源码契约（vitest 没配 jsdom，改为查源码）：勾选框**不得**带 `readOnly`、
  `checked` **不得**来自 `devices[0].scopes`、`enableRemote`/`createPairing` **必须**传
  `grantedScopes` 而非 `DEVICE_SCOPES`。

这三条分别对应上面三个版本各自的错法，已反向验证：把 `grantedScopes` 改回
`[...DEVICE_SCOPES]`，只有最后那条变红。

顺带修了 `tests/purge-drill.spec.ts` 的一次假绿：它断言「真实库里必须还有脏数据」，
可上一轮重启时清理**真的跑成功了**，于是它开始红 —— 那是**前提被自己的成果推翻**，
不是回归。改成在副本里自造三条历史标记设备，`device.purge` 的断言也从「恰一条」
放宽到「至少一条」（真实副本里已经有一条了）。

pnpm check 全绿（30 文件 198 用例）。

---

## 2026-10-12 · 设备：撤销即删除；权限码中文化

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。
> **生产库已备份**：`workspace.sqlite.bak-before-device-purge-20261012`。

### 诉求（用户原话）

「设备中 是『已撤销』的可以不显示，也自动从数据库中删除，授权的权限，中文状态下显示中文，
英文显示英文。」

三件事：① 撤销的设备不显示；② 顺手从库里真删；③ 权限码别再露英文。

### 先量了现状：32 条全是已撤销的

```
devices 总数: 32    已撤销: 32    活跃: 0
 - V2080A | revoked: 是 | scopes: [chat.read, chat.write, …]
 - img-probe | revoked: 是 | scopes: [chat.read]
 - e2e-probe | revoked: 是 | scopes: [chat.read, chat.write, …]
 - ICL-AL10 | revoked: 是 | …
```

界面上那一长串灰字就是这么来的 —— 全是历史测试探针和早已弃用的旧手机，没有一个是还在用的。
用户早就看腻了才提的，不是无理取闹。

### 撤销 = 删除，不是打标记

原先 `revokeDevice` 是 `UPDATE … SET revoked_at`，行留着。改成 `DELETE`：

- `device_roots` 是 `ON DELETE CASCADE`，授权行自动清；
- `audit.actor_id` 是**普通字符串不是外键** —— 所以「谁在什么时候撤了谁」这段留痕
  一条不少。删掉的是设备，不是历史；
- `authenticate` 仍保留 `revoked_at IS NULL` 作兜底，万一别处留下标记行，它们依然登不进来。
  两层保险不冲突。

顺序上「先写审计再删」，更符合「记录发生了什么」的直觉。

### 历史 32 条：`purgeRevokedDevices()`

启动时调一次，幂等（没有就返回 0）。**不走 `revokeDevice`**，否则会把「系统清理」记成
管理员逐个撤销，审计失真；它只写一条汇总 `device.purge`。失败只 warn 不拦启动 ——
清理历史数据不该拦住插件起来。

`listDevices()` 也加了 `WHERE revoked_at IS NULL`：撤销已经删行了，再过滤一次是兜住
别处可能留下的标记行，它们不该出现在界面上。

### 权限码中文化

七个码换成人话：`chat.read` → 「读聊天」/「Read chat」，`files.delete` → 「删文件」/
「Delete files」。界面里原来有三处直接渲染裸码（远程访问的只读展示、设备行的权限摘要、
权限编辑的勾选），全部接上 `scopeLabel(locale, scope)`。

`scopeLabel` 用**显式查表**而不是模板拼 —— 白屏那次就是模板拼错键名导致的，
`translate` 查不到会静默降级露出键名（界面上冒出一行 `scopeChatread`）。未知码（老库里
可能有已废弃权限）直接显示原值：宁可难看也不要空白。空权限显示「没有任何权限」。

### 验证

7 条单测（删除而非标记 / 级联但审计留存 / 重复撤销仍 404 / 清理历史 / 权限双语 /
未知码兜底 / 不露键名）+ `tests/purge-drill.spec.ts` 拿**生产库真实副本**演练：
32 条全删、授权行级联、审计一条不少、只写一条 `device.purge`。

顺带修了 `tests/migration-drill.spec.ts`：它拿生产库副本做迁移演练，但生产库**在功能落地
时就已经迁移过一次**，「迁移前带 UNIQUE」这个前提早不成立了 —— 第一版演练就是这么假绿的。
改成用 `rewindRootsSchema()` 把副本**倒回**未迁移状态，演练才真的在测迁移。
**演练的前提会被现实悄悄改掉，发现断言一开始就注定时，要怀疑的是前提而不是代码。**

pnpm check 全绿（29 文件 191 用例）。

---

## 2026-10-12 · 根目录自动带一个「DSH 工作区」默认项（不可删、可访问）

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。
> **生产库已备份**：`~/.dsh/dsh-workspace/workspace.sqlite.bak-before-builtin-20261012`。

### 诉求（用户原话）

「根目录可否让默认为当前 DSH 的工作目录吗（不可更改但要显示，但是每个人的可能不一样），
除默认以为，用户可以自行增加。」

两处口径开工前确认过：默认项取 `workspaceRegistry.list()` 的**第一个**工作区（用户明确
「只显示第一个」）；它**当作真正的授权根**——手机端照常浏览，但界面上不能删。

### 为什么必须自动登记，而不是让用户手填

工作区路径**每台机器都不一样**。本机实测（`~/.dsh/storages/workspace.json`）：

```json
"7252d879-…": { "path": "/media/wangke/OFFICE/workspace", "title": "workspace" }
```

DSH 用的是系统文档目录派生的 `<Documents>/deepseek-harness/default-workspace`（见
`@deepseek-ai/dsh-api-workspace-controller/lib/types/default-directory.js`）。手填等于让
用户去猜一个他本来就不该知道的路径。**所以插件每次启动自动登记一次**，靠 `real_path`
的 UNIQUE 约束保证幂等。

### 三条设计取舍

**1. 它就是一条普通的根，不是另起一套特例。** 除了「不能删」，配对、`files.*` 授权、
回收站、写盘全走现成逻辑。少一套需要同步维护的规则，也就不会出现「手机能看见但插件说不认」
这种分裂。

**2. 删除的闸门在数据库层，不在界面。** `removeRoot()` 里判 `builtin` 抛 `ROOT_BUILTIN`。
界面不给按钮只是 UX；API 可能被别处直接调到，闸门必须落在**所有路径都绕不过去**的地方。

**3. 不劫持用户已有的配置。** 本机生产库里已经有一条 `workspace` 根（`builtin=0`，是用户
自己加的）。迁移演练确认：加列后它**原样保留、仍可删除**。`ensureBuiltinRoot` 遇到已存在
的同路径就什么都不做——升级成内置会让「我自己加的根」突然不能删，那是对用户配置的破坏。

### 加列而不是改表

```sql
-- SQLite 的 ADD COLUMN 不认 IF NOT EXISTS，重复执行直接报错
PRAGMA table_info(roots) → 没有 builtin 才 ALTER TABLE roots ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0
```

不能写进 `CREATE TABLE`：已经装过的机器上那张表早就存在，`IF NOT EXISTS` 会整块跳过，
新列永远加不上。这是加列而不是改表的典型理由。

`listRoots()` 的排序加了 `builtin DESC`，让默认项排在第一条——否则用户得自己找哪条是默认。

### 验证

除了 6 条单测（幂等 / 不可删 / 可配对可访问 / 不劫持用户配置 / 排第一 / 迁移可重跑），
另加一条**读本机真实 `workspace.json`** 的集成测试：整套逻辑依赖「注册表第一个工作区就是
当前工作目录」这个前提，前提错了单测照样全绿，真机上就是设��里冒出一条指向别处的根 ——
而根目录配错的后果是手机能看见不该看见的东西。测试写进临时副本库，绝不碰生产库。

迁移已在生产库副本上演练：现有那条 `workspace` 根原样保留、`builtin=0`。

### 第二轮返工：界面上根本不会出现「不可删除」

用户再问：「设置中能让看到刚弄的这个默认目录，且是不可删除状态吗？」

**查生产库才发现首版是个死功能。** 库里早就有一条指向同一目录的根：

```
roots: [{ label: "workspace", real: "/media/wangke/OFFICE/workspace", builtin: 0 }]
审计:  2026/10/8 21:04:06 | root.add | {"label":"workspace"}     ← 用户自己手动加的
```

路径和 DSH 工作区**完全一样**。于是首版那个「尊重用户已有配置」的分支每次启动都命中它、
什么都不做 → **永远没有 `builtin = 1` 的行** → 界面靠 `root.builtin === true` 判断，
用户看到的还是一条普通根、有删除按钮。功能写了，测试也绿，就是不生效。

根子在于我把「尊重用户选择」理解错了层级。用户要的是「**这条要不可删**」，不是
「**这条不能变**」——把这两件事混为一谈，功能就自动失效了。

用户拍板：**另起一条内置的，原来那条保持可删**。

### 去掉 UNIQUE：只能重建表

两条根指向同一目录，而 `roots.real_path` 上有 UNIQUE，第二条根本插不进去。
SQLite 没有 `ALTER TABLE … DROP CONSTRAINT`，只能**重建表**（`dropRootsUniqueConstraint()`）：

- `PRAGMA foreign_keys=OFF` —— `device_roots.root_id` 引用 `roots(id)`，而重建要 DROP
  被引用的那张表，开着外键会直接失败；
- 全程事务，`roots_migrated` 建成、数据搬完、**最后**才 DROP 老表改名，中途失败整体回滚；
- 搬数据用**显式列名**而不是 `SELECT *` —— 老库可能还没有 `builtin` 列（两种迁移顺序
  都可能出现），按列名搬才不会在某一台机器上错位；
- 幂等靠查 `sqlite_master` 里还有没有 UNIQUE，而不是「跑过一次」。

`addRoot` 加了 `allowDuplicate`：默认仍按 `real_path` 去重（用户手加目录时不该冒出两条），
只有 `ensureBuiltinRoot` 绕开它。幂等改由「已存在 `builtin = 1` 的同路径就返回」保证。

### 验证：拿生产库的真实副本演练

重建表有真实数据风险，单测用的是自己造的临时库，跑不出问题。为此加
`tests/migration-drill.spec.ts`：直接复制 `~/.dsh/dsh-workspace/workspace.sqlite`（连
`-wal`/`-shm`）到工作区副本上跑，断言根、设备、授权一条不少，UNIQUE 真的没了，再开一次不得报错。

演练时踩了一个自己挖的坑：第一版用 `new WorkspaceDatabase(...)` 取「迁移前」的 schema ——
可它的构造函数里就调了 `migrate()`，取到的已经是迁移后的结构，那条断言等于什么都没验。
必须绕过这个类，用裸 `DatabaseSync` 直接读文件。**断言「迁移前」时，不能用会触发迁移的东西去取样。**

演练结果：✅ 两条全过（`drill1` 验完整性、`drill2` 验并存后同路径两条且恰有一条 `builtin`）。

生产库备份：`workspace.sqlite.bak-before-unique-drop-20261012`。

pnpm check 全绿（27 文件 183 用例）。

---

### 「不会要求重新扫码吧」——问得对，答案分两半

用户紧接着问：「插件每次启动自动登记一次，不会要求我重新生产远程访问的码吧？」

**不会。** 启动时那次登记只碰 `roots` 表（外加写一条审计），`devices` / `pairings` /
`device_roots` 一行没动。令牌照样有效，`authenticate(token)` 照样认。已用测试钉死：

```
✓ keeps an already paired device authenticated across plugin restarts
✓ does not silently grant the new root to already paired devices
```

第一条连续登记三次（模拟多次重启）后断言 `authenticate(token)` 仍有效、设备 id 与授权
一条没少、老根仍可删 —— 这是「会不会被要求重新扫码」的直接答案。

**但第二件事必须说清楚：新根不会自动授权给已配对的手机。** `device_roots` 是
**配对那一刻的快照**：`exchangePairing` 把 `rootIds` 逐条写进 `device_roots`，之后
新增的根不会自己长出授权行。`authorizedRoots()` 里 `principal.rootIds === 'all'` 只对
**回环管理面**成立，设备面走的是过滤。

这是安全侧的合理默认（不给等于不给），但用户一定会撞上：「设置里明明有这个目录，
手机里就是看不到」。所以根目录卡片底部常驻一句提示，指路到「设备」去勾授权 ——
不能等用户自己撞墙才发现。

pnpm check 全绿（24 文件 176 用例 + docs:check + build）。

---

## 2026-10-12 · 设置面板换成 Vision Router 的折叠卡片样式

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）。

### 诉求（用户原话）

「把插件 `dsh-remote-bridge` 的设置样式改为 Vision Router 插件的设置样式。」

开工前确认过范围：用户选的是**只改卡片外壳，内部控件保持现状** + 深色模式跟随 + 独立页同步。
独立页那句其实是空条款 —— `src/standalone/` 早已不存在，`/dsh-workspace` 只剩文件 API，
UI 只有设置页内联这一处。共用 `PhoneSettingsBody` / `AdminPanel` / `styles.ts` 改一次即两处一致。

### 改了什么

**1. 外壳换成 `vr-card` 模型。** 照搬 `dsh-vision-router` 的 `daw-card` 三件套：

| 元素 | 作用 |
| --- | --- |
| `daw-card` / `daw-card-open` | 圆角 12px 外壳，展开时换底色 |
| `daw-card-header` | `aria-expanded` 按钮：标题（15px/600）+ 描述（13px/tertiary）+ 旋转箭头 |
| `daw-card-body` | 展开体，顶部一条 `--dsw-alias-border-l2` 分隔线 |

七个分区（根目录 / 远程访问 / 设备 / 识图 / 回收站 / 审计 / App 下载）各自一张卡。
原来每节顶上的内联 `<h3>` 删掉了 —— 标题已经进了卡片头，留着就是同一句话说两遍。

**2. 配色令牌换成 DSH 原生。** `--daw-*` 全部改挂 `--dsw-alias-*`，深浅色因此自动跟随，
不需要写两套。

### 踩到的坑：Vision Router 自己有两个假令牌

扒 VR 的编译产物当蓝本时发现它引了 `--dsw-alias-label-error` 和 `--dsw-alias-label-warning`，
**这两个在 DSH 里根本不存在** —— 全仓搜索 0 处定义。它靠 `var(--a,var(--b,#fallback))`
的兜底链活着，所以从不报错，只是错误色悄悄退回了灰色。

DSH 里真实存在的是 `--dsw-alias-state-error-primary`（→ `static-red-400/600`）和
`state-success-primary`。所以没有照抄，而是用了真名，并加了两条测试守住它：

- `styles.spec.ts`：**卡片规则里不许出现任何硬编码十六进制色值**。写死 `#fff`/`#dfe4e8`
  会让深色模式下变成一块白斑 —— 这正是换令牌要消灭的东西。
- `i18n.spec.ts`：七条卡片描述键**双语全量断言**。抽查挡不住「漏了第 6 条」，
  且缺英文时 `translate` 会退回中文原文，英文界面直接露中文。

### 折叠与切分区的交互

折叠是「当前这张卡」的状态。切分区时 `useEffect` 把 `collapsed` 复位为展开 ——
否则「收起远程访问 → 切到设备 → 切回来发现是空的」很费解。

### 二次返工：对照真机截图发现「只换了壳」

用户拿真机截图和 Vision Router 并排一比，说「区别有点大」。截图说明问题不在细节，在**结构**：

| | 首版（错） | 现在（对） |
| --- | --- | --- |
| 顶部导航栏 | 有，七个分区标签横排 | **删掉**，卡片头自己就是入口 |
| 卡片数量 | 一次只渲染一张 | **七张全部平铺**，想开哪张开哪张 |
| 展开关系 | 单选互斥 | **可多张同时展开** |
| 卡片图标 | 无 | 有（复用原导航栏的 `tabIcon`） |

Vision Router 自己的提示词就写着「多张卡可以同时保持展开」——我首版连这个前提都读漏了，
把「折叠卡片」当成了「带导航的分页」。用户点一下导航、再点一下卡片头才走一步，
两次点击干一件事，这就是差别大的真正来源。

**展开态从 `boolean` 改成 `Set<AdminTab>`**，多张同时展开是自然结果，不需要额外互斥逻辑。
`initialOpen` 决定进页面先展开哪一张（默认第一张），之后完全由用户控制。

**数据加载跟着改口径**：原来只在「切到某个分区」时拉它的数据，现在按「这张卡**展开**了没有」拉。
无条件全拉等于打开设置页就打七个请求，其中五个用户根本不会点开。

### 顺带修的两件事

**1. 控件皮肤没跟上。** 用户上轮选的是「只改外壳」，但截图里青底白字按钮配中性灰卡片，
两套皮肤并排，一看就不是同一个产品。这次把设置页里**实际渲染到**的控件也换成令牌：
输入框（8px 圆角 + 令牌描边）、主按钮（改中性底而非品牌色实心）、配对码块、警告条、
状态药丸、表单标签、勾选项。

**2. 清掉 44% 的死样式。** 文件工作区那套 UI（`.daw-tree` / `.daw-editor` / `.daw-dialog` /
`.daw-token` / `.daw-modal-small` …）在 2.0.4 就搬走了，3.0 起 `/dsh-workspace` 只剩文件 API，
**JSX 里一个引用都没有**。留着不只是占地方：深色模式改造时每个选择器都得重新判断
「它还在用吗」，误改就直接弄坏看不见的页面。样式表从 12.6 KB 降到 6.2 KB。

清理脚本栽过一次，值得一提：第一版用 `css.replace(/\{[^{}]*\}/g, ...)` 想清空规则，
结果它把 `installWorkspaceStyles` 的**函数体也当成 CSS 规则删掉了**，TS2391 当场报错。
第二版先把模板字符串的边界切出来，只在切好的片段里操作。**CSS 清洗脚本必须先隔离
模板字符串**，否则正则分不清 CSS 和 TypeScript。

另外第一版还有个隐蔽误伤：`.daw-icon,.daw-command{...}` 是**逗号合并规则**，
按「选择器含死类名」判定会整条删掉，连在用的 `.daw-command` 一起陪葬。
教训：删规则要按**选择器列表**逐个判断，不能整条按字符串匹配。

---

### 首版白屏事故（已修）

首次装上去重启，**整个设置面板一片空白**。三层原因叠一块，一层比一层难看。

**1. 键名拼错。** `tabDescKey()` 里写的是模板 `` `${tab}Desc` `` → 产出 `rootsDesc`，
而字典里定义的是 `rootsTabDesc`。**七个分区错六个**（只有 `app-download` 侥幸对了，它走显式
分支）。错的那个键不在字典里，`translate` 立刻炸。

**2. `translate` 遇缺键就抛异常。** 它是 `dictionaries[locale][key].replace(...)`，而它跑在
React 渲染路径上 —— 一个不存在的键 = 整个设置面板白屏。缺一行描述，把七张卡里的全部设置
一起搭进去，代价和收益完全不成比例。

**3. 最难看的一层：我用 `as MessageKey` 把警报器按掉了。** 那个断言让 TypeScript 闭嘴，
所以「键名拼错」这条错误类型检查抓不到；我加的测试又只验证「我手写的七条键有文案」，
压根没验证**代码里真正用的**是不是那七条。于是 `pnpm check` 全绿、166 个用例全绿，
然后白屏。绿得理直气壮，红得毫无预警。

修法分两层：

- **改对**：`tabDescKey` 从模板拼接改成显式查表 `TAB_DESC_KEYS`，七个键一眼可查，
  以后加分区漏了也会被 TypeScript 点名（`Record<AdminTab, MessageKey>` 强制穷举）。
- **改脆**：`translate` 缺键不再抛异常，降级成「回退另一种语言 → 再回退成键名」并在控制台
  留痕。最坏情况是某一行露出 `rootsTabDesc` 字面量，一眼看出该补哪条，而不是白屏。

**能抓住它的测试**（已反向验证：把键改回 `rootsDesc`，只有新测试变红，旧的全绿）：

```
FAIL every card description key the UI actually asks for exists in both dictionaries
AssertionError: roots → rootsDesc 缺中文: expected 'rootsDesc' not to be 'rootsDesc'
```

这条测试从 workspace.tsx **源码里抠出映射表**再逐条对双语字典验证 —— 抠源码而不是 import
组件，是因为 vitest 没配 jsdom，而这张表是纯数据。

教训：**键名靠模板拼出来时，别用类型断言糊过去**，那正是最后一道防线。

---

## 2026-10-12 · 并入 image-paths：交接图片在 WebUI 里显示出来，设置里加「识图路径」

> **待真机验证**：已构建、已同步实装目录，**需重启 dsh + 刷新页面**。
> **未发版、未推送**：版本号仍是 2.2.4（bump 等用户发话）；本文案按 v2.2.5 的内容准备。

### 诉求（用户原话）

「把 `dsh-image-paths-0.3.1` 的功能加到我们写的插件 `dsh-remote-bridge` 上，在设置里加上
识图的路径设置及当前默认（不能改）。」

两处口径开工前确认过：识图路径指**图片交接目录**（`会话工作目录/.dsh-images`，默认值
`.dsh-images`）；「不能改」指**「当前默认」那一栏只读**，路径本身可自定义。

### 并进来的两半（原 dsh-image-paths 0.3.1）

| 半边 | 原来长在哪 | 现在长在哪 |
| --- | --- | --- |
| 宿主只读路由 | `/plugin/image-paths/raw?path=…&cwd=…` | `/plugin/dsh-remote-bridge/raw?sessionId=…&name=…` |
| 浏览器图集 | `client.js` 的 `turnTail` 座位 + Conversation Definition | `src/client/handoff.tsx`，同一个座位 |

**功能等价，参数更紧**：原来的路由由客户端给 `path` + `cwd`，服务端再校验「真实路径落在
cwd 内」。现在请求里只有**会话 + 裸文件名**，目录由宿主按会话工作目录推出 —— 和写盘用的是
同一个 `sessionWorkspaceDir()`，客户端连「读哪个目录」都递不进来。一句话：
**写在哪、从哪读，永远是同一套解析**。

判据仍然是「只认交接句式」：行首标记（`🖼️ 图片 N` / `🖼️ Image N`）**在用户消息里**，
行内 `已存到 / 已保存到 / saved to` 后面那个图片地址才被取出。助手正文、上下文注入、
工具输出、文档示例里到处引用 `.dsh-images/…`，一律不碰；`[Image: source: …]` 机器行
与上面那行指的是同一个文件，不再出第二张图。

### 设置里新增「识图」一节（第 4 个分区）

导航栏：根目录 / 远程访问 / 设备 / **识图** / 回收站 / 审计 / App 下载。

- **识图路径（目录名）** —— 可改，存 `settings` 表（键 `image_handoff_subdir`）。校验只收
  **单段**目录名（1-64 字符，字母/数字/点/下划线/连字符；`.`、`..`、含分隔符一律拒，
  返回 `IMAGE_SUBDIR_INVALID`）。允许点开头 —— 默认值自己就是点目录。
- **当前默认（不能改）** —— 只读栏，展示出厂字面量 `.dsh-images`。它是契约：历史交接消息、
  识图工具、手机端都按它写过路径，所以**当前值怎么改，这一栏都不动**。
- **兜底目录（只读）** —— 解析不出会话工作目录（冷会话 / 目录不在任何授权根下）时的落点，
  展示的是交接实际会用的那个目录（生产路径由 `index.ts` 传入，界面与落盘同源）。

改完**立即生效**，不必重启：交接写盘与只读图片路由都通过 getter 现读设置。为此
`createDsh02ApiProxy` 的 `handoffRoots` 也一并改成「数组或 getter」—— 顺带修掉一个既有偏差：
授权根原来是 `apply` 期间的一张快照，新加的根要等重启才参与交接。

### 无 token 路由凭什么安全

浏览器不会给 `<img>` 加 Authorization 头，所以这条路由进不了版本化 REST 的鉴权通道。
四道闸与原插件一致，另加一条更严的：

1. `Host` 必须是回环（DNS 重绑定防护）；跨站请求（`Sec-Fetch-Site`）一律 403；
2. 文件名必须是 `^[0-9a-f]{64}\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$` —— 目录穿越、
   绝对路径、随便一个 `shot.png` 连查询都不会发生（读图实现**根本不被调用**）；
3. 目录由宿主按会话推出（客户端递不进来）；
4. 字节自证：扩展名声明必须与魔术字节一致，体积上限 32 MiB，空文件当「没有」；
5. 取不到一律 404 且**不区分**「会话不存在」与「文件不存在」—— 区分它等于泄漏哪些会话存在。

### 与独立 image-paths 插件不能同时开

两个插件都会把自己的图集挂在同一个 Turn 尾座位上，同一张图会**画两遍**；路由不同名
（`/plugin/image-paths/raw` 与 `/plugin/dsh-remote-bridge/raw`），互不覆盖、只是重复。
正确做法是**停用独立插件那一行**（`cordis.patch.yml` 里删掉，或从 profile bundles 里移除）。
本次同步实装目录**没有**动 profile 配置 —— 这一步是用户的开关，见文末「待办」。

### 验证

- `pnpm typecheck` 通过。
- `pnpm test` **22 文件 / 163 用例全绿**（+35）：新增 `tests/image-handoff.spec.ts`
  （设置校验与坏值修复、格式自证、同源判据、路由的 200/400/403/404/405/413/415、格式错配、
  超大与空文件、`/manage/image` 读写与非法值）与 `tests/client-handoff.spec.ts`
  （中英与旧文案的句式解析、只认用户消息、噪声不解析、去重与 8 张上限、URL 只带裸文件名）；
  `dsh-0.2-bridge.spec.ts` 新增「识图路径改完，写与读一起跟着走」；`i18n.spec.ts` 补新标签
  与「只读」措辞。
- `pnpm build` 通过（host 200.5 kB / client 680 kB）；`lib/` 已同步到
  `~/.dsh/profiles/web/node_modules/dsh-remote-bridge/`，**含 client.cjs** —— 上一轮只同步了
  host 产物，而这次客户端也变了，漏了它就等于「服务端会取图、界面不会画图」。
- **真机核验待做**：重启 dsh → 刷新 WebUI → 往纯文本模型会话发一张图，应看到「图 + 路径」
  两样都有；设置页「识图」一节应显示当前值 `.dsh-images` 与只读的「当前默认」。

## 2026-10-11 · 交接文案改成人话，并按客户端界面语言分流

> 已发布 **v2.2.4**（npm，`latest`），并双推 GitHub / Gitee。需重启 dsh 生效。

### 为什么改

用户对交接那条消息的反馈是「把提示改为能看懂的」。旧文案第一行写的是
「当前模型不支持图片输入，已保存到工作目录 …；请先用读图工具打开下面那行的绝对路径，
看清内容再回答」—— 这是**写给机器看的祈使句**，却挂在用户眼前：术语（「图片输入」「绝对路径」）
加指代（「下面那行」），双重劝退。

### 现在长什么样

第一行改成两句人话，仍然留在同一行内（客户端按行首标记**整行**摘除，多一行会露在手机上）：

- 中文：`🖼️ 图片 1「shot.png」（当前模型看不到图，已存到 .dsh-images/xxx.png；要看图，请用识图工具打开下面那行的路径）`
- 英文：`🖼️ Image 1 "shot.png" (this model can't see images, saved to .dsh-images/xxx.png; to view it, open the path below with an image-reading tool)`

第二行 `[Image: source: <绝对路径>]` 是机器契约，跨语言不变。

### 语言从哪来

HTTP `Accept-Language` 一路带下来：`router`（读头）→ `chat.prompt` → `apiProxy.prompt` → 图片交接。
`locale` 是**我们自己加的字段**，调内核前会被摘掉 —— 内核的 prompt 入参是严格形状，
多一个字段就可能被拒（这条有测试钉着）。

判不出来就退回中文（既有口径，不猜）。识别规则：按客户端排的优先级取第一个认识的 `zh*` / `en*`。

**要真正跟随英文界面，客户端得把语言带出来**：`dsh-companion` 已在 `DshClient.authenticated()`
统一加了 `Accept-Language`（取自 App 的语言设置）。**这一项要等下次出包 + 安装才生效**；
在那之前手机端发图仍是中文文案（插件、WebUI 侧不受影响）。

### 验证

`pnpm typecheck` 通过 · `pnpm test` 20 文件 / **128 用例全绿**（+2）：
新增「speaks the client interface language, and never leaks our field to the kernel」
（英文文案 + `locale` 不出现在内核入参里），以及 `handoffLocaleOf` 的取值规则。
`dsh-companion` 侧 `./gradlew :app:compileDebugKotlin` 通过（仅编译，未出包）。

> 编译要显式指定 JDK：这台机器的 `java` 不在 PATH 上，得给
> `JAVA_HOME=/media/wangke/OFFICE/workspace/android-toolchain/jdk17`。
> 另外**不要用 `./gradlew … | tail` 判断成败** —— 管道会把退出码替换成 `tail` 的 0，
> 第一次就因为这样把「JAVA_HOME 未设置、根本没编译」误读成了「编译通过」。

## 2026-10-11 · 交接文本追加动作指令：只递路径，模型不一定去读（发布 v2.2.3）

> 真机实测后的补丁。已 publish 到 npmjs，`latest` tag = 2.2.3。DSH 下次自动更新或手动 reinstall 即可拿到。

### 为什么加

重启后交接链路已经通了（20:47:43 图正常落到工作区 `.dsh-images/`，路径也进了消息），
但真机上出现新现象：用户发「看图，不操作」+ 图，那一轮的模型**并没有去读那张图** ——
它先去加载界面技能，图放着没看，用户看到的是「你啥都不显示」。

结论：**只递路径是「可以读」，不等于「被要求读」**，所以要在交接文本里明确要求。

### 怎么加（以及为什么不新增一行）

指令塞进原有的第一行，**不另起一行**：

```
🖼️ 图片 1「274938.jpg」（当前模型不支持图片输入，已保存到工作目录 .dsh-images/xxx.jpg；请先用读图工具打开下面那行的绝对路径，看清内容再回答）
[Image: source: /绝对路径/.dsh-images/xxx.jpg]
```

理由：客户端（dsh-companion）摘除交接行是按**行首标记**（`🖼️ 图片 ` 与 `[Image: source:`）
整行摘掉的，不看括号里的字。所以把指令塞进原行，**手机端不必跟着出包**；
若新增一行，那一行会被当成正文显示在手机上。

### 验证

`pnpm typecheck` 通过 · `pnpm test` 20 文件 / 126 用例全绿 ·
新增断言两条：指令存在、且交接文本恰好两行（防回归）。
`pnpm build` 后已同步到实装目录（sha256 与仓库产物一致）。
**v2.2.3 已 publish 到 npmjs（latest tag），DSH 下次自动更新即可拿到。**

## 2026-10-11 · 修「刚切到纯文本模型就发图，图片仍被内核拒收」

> **真机报障 → 定位 → 修复**：已构建并同步实装目录，**需重启 dsh 生效**。未发版、未推送。

### 现象（用户真机截图原话）

```
DSH_SESSION/ATTACHMENT_INVALID: Model "agnes-2.5-flash" does not support image input.
```

用户把会话切到 `agnes-2.5-flash`（纯文本）后发图，仍被内核拒收 —— 图片交接没有触发。

### 核数据的过程（不靠猜）

1. 先排除「插件版本旧」：dsh 进程 19:47:32 启动，**晚于**插件实装 19:44:31 ✓
2. 再看有没有落盘：`.dsh-images/` 里只有 19:48 / 19:50 两张老图，**这次没有新文件**
   → 交接确实没跑。
3. 回放会话事件（`session-8c2fc46f`）：20:37:20 切到 agnes-2.5-flash，20:38:31 切回
   deepseek-flash，20:39:03 才发出那条带 image 部件的消息 —— 失败发生在两次切换**之间**。
4. 对照内核源码看两侧口径：
   - 内核拒收用 `agents.selectionFor(agent).current`（`pending` 优先）；
   - 本插件用 `projections().values.modelSelection`。

### 根因：读错了投影的字段名

内核投影对外给的是 **wire 视图**：

```js
// dsh-api-session-controller/lib/index.js
view: (state) => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed })
```

`pending` 只存在于**内部 state**；`dsh-session-projection` 组装对外值时是
`values[key] = wire.viewSchema.parse(wire.view(state))`（第 259 行），
所以对外**只有 `lastUsed` 与 `next`**，没有 `pending`。

插件两处都写了 `selection?.pending ?? selection?.lastUsed`：
`pending` 恒为 `undefined` → 一路退回 **`lastUsed` = 上一次真正跑过的模型**。
用户刚切模型、还没用它跑过一轮时，拿到的是旧模型 → 判定「旧模型支持图片、不用插手」
→ 图片原样交给内核 → 内核按**真实当前模型**拒收。

这也解释了为什么 19:48 那次能成功：当时会话一直在用同一个模型，`lastUsed` 恰好等于当前值。

### 改了什么

- `dsh-0.2-bridge.ts` 两处（`currentModelSelection` 与 `sessions.models` 的 `current`）
  由 `pending ?? lastUsed ?? catalog.default` 改为 **`next ?? lastUsed ?? catalog.default`**
  （保留 `lastUsed` 兜底：老内核的 wire 视图没有 `next`）。
- 顺带修好一个同源偏差：客户端「当前模型」此前也读到 `lastUsed`，
  切完模型要等它真跑过一轮才更新。

### 测试为什么没拦住，以及怎么补的

原测试桩照**内部 state** 写 `{ lastUsed, pending }` —— 正是实现读错的那个名字，
于是「桩与实现同错」、一路全绿。改法：

- 所有投影桩改成真实 wire 形状 `{ lastUsed, next }`；
- 新增「切换后立刻发图」回归用例：`lastUsed` 是**支持图片的旧模型**、`next` 是
  **纯文本新模型**，且 `resolveModelInfo` 桩**不再无视参数** —— 读错字段就会拿到
  「支持图片」的结论而不交接，用例立刻失败；
- 新增「老内核没有 `next` 时退回 `lastUsed`」用例。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **20 文件 / 126 用例全绿** ·
`pnpm build` 后产物里两处都是 `selection?.next ?? selection?.lastUsed`（`pending` 残留 0 处），
已同步到 `~/.dsh/profiles/web/node_modules/dsh-remote-bridge/lib/`（sha256 与仓库产物一致）。
**真机复现待做：需要重启 dsh 进程。**

## 2026-10-11 · 纯文本模型也能发图：图片交接（零插件依赖）

> **待真机验证**：已同步实装目录，需重启 dsh 生效。**未发版、未推送。**

### 诉求

用户原话：「模型不支持图片，图片就发不出去……我装的有图片识别插件，如何能让我发出去，
让插件去识别，**不要从入口阻拦**。」以及关键约束：
「你判定了插件，是不是我以后必须装这个插件，装其他插件又不行了」——
明确拒绝把手机端绑死在任何一个具体识图插件上。

### 谁在拦

是**内核**，不是 App 也不是本插件：`dsh-api-session-controller` 的 prompt 准入里，
内容只要含 `type:'image'` 部件，就调 `ctx.llm.resolveModelInfo()` 查模型元数据，
`inputModalities` 已声明且不含 `image` 时抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
内核给「视觉插件」**没有**预留接缝（grep 过，没有 batch-attachments 之类的服务钩子）。

桌面 WebUI 里 modlens 自带一个「浏览器半边」：确认当前模型只支持文本时，把粘贴的图
POST 到它的 `/modlens/paste` 落成临时文件，输入框收到的是**路径文本**，于是消息里
没有 image 部件，准入自然不触发。手机端是另一个客户端，拿不到这个浏览器半边。

### 做法：把缺的那半步做在本插件里，但不引用任何插件

- **判定**用内核自己的 `ctx.llm.resolveModelInfo()`（`LlmLike` 补了这个方法）——
  与内核拒收时查的是**同一份元数据**，结论逐字一致；模型选择按
  `projections().values.modelSelection`（pending > lastUsed > 目录默认）取。
- **动作**只做一件通用的事：图片解码落文件、消息里给路径，
  **任何按路径读图的工具都能接手**，不出现任何插件名。
- 三条保守原则，宁可退回原样：元数据缺失（`undefined`）不动、模型声明了 image 不动、
  落盘失败不动（try/catch 包住整个交接）。拿不准就走原路，与内核「未声明模态不拒」一致。
- 总开关 `createDsh02ApiProxy(host, { imageHandoff: false })`，默认开。

### 落地位置与消息形态（按真机反馈改过一轮）

第一版把文件写进 DSH 私有目录、消息里只有一条 `<image …path>` 裸标签，
真机验证后用户提了两点：① 应落到**工作目录**而不是 DSH_HOME；② 裸路径只适合机器读，
不符合人类阅读习惯。改成：

- **落点优先会话工作目录**：用 `sessionController.list()` 找会话 `cwd`（冷会话也有，
  不依赖 live agent），与注入的授权根（`handoffRoots`，由 index.ts 从数据库给）匹配出
  真实路径，写到 `<工作目录>/.dsh-images/<sha256>.<ext>`（目录 0700、文件 0600、
  内容寻址去重）。匹配不到根/解析不出工作目录时，才退回 `<dataDir>/image-handoff`
  这个 DSH 目录兜底——无论如何不能让发消息失败。
- **一条 image 部件换成两行文本**，同一处信息伺候两类读者：
  - 给人看：`🖼️ 图片 N「原名」（当前模型不支持图片输入，已保存到工作目录 .dsh-images/xxx.jpg）`；
  - 给机器看：`[Image: source: <绝对路径>]`——这是识图技能明确列出的触发形状之一
    （带图片扩展名的绝对路径同样触发），换任何读图工具都认，不绑插件。

### 取舍说明

- 纯文本模型下，这条消息在历史里是**文件说明文本而不是图片缩略图**——桌面 WebUI 的
  「paste-to-path」本来也是这个样子；模型本身支持图片时仍走原生 image 部件，缩略图不受影响。
- 没走「file 附件」那条路：内核把 file 部件也只存成一个**没有路径的引用**，
  agent 未必拿得到可读路径，不牢靠。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **20 文件 / 124 用例全绿**（7 个交接用例：
工作目录落地+人话消息、匹配不到根退回兜底、视觉模型→原样、元数据缺失→原样、
纯文本消息不查元数据、同图去重、可关闭）。已构建并同步实装目录。
**第一版（裸标签 + DSH 目录）真机跑通过识图；改后的工作目录版待重启验证。**

## 2026-10-11 · v2.2.4（建议）修「历史图片永远显示不出来」：走内核 sessionController.attachment

> **✅ 真机验证通过**（2026-10-11 18:51）：用户确认历史图片与刚发图片都显示了。
> 诊断日志铁证：`sessionController.attachment ✓ 139215 bytes · image/jpeg`、
> `✓ 211964 bytes · image/webp`，0 失败。诊断代码与 `.attachment-diag.log` 已清理。
> **未发版、未推送**：等用户发话再走 `pnpm check` + publish。
> 版本号建议 v2.2.4（当前 package.json 仍是 2.2.2，bump 留到发版时做）。

### 这一节纠正了我自己的两次误判

排查这个 bug 我走过两段弯路，都是因为**没先看真进程的诊断日志**，光从源码推：

1. 第一次：以为附件存储没数据（`profile bundles` 缺附件服务）→ 实测 35/35 个 id 全部命中磁盘，错的。
2. 第二次：以为是**缺四项元数据**（客户端没把 `mediaType`/`bytes`/`width`/`height` 传给 `ctx.attachments.readImage`，会被内核完整性校验 `ATTACHMENT_CORRUPT`）→ 从源码看这个判断成立，于是改客户端把四项带上来。
3. **真因**（重启后读 `.attachment-diag.log` 才看到）：真进程里 **`ctx.attachments` 是 `MISSING`** ——
   这条 profile 根本没有把附件存储挂成可注入服务（`dsh-attachment-local` 只是个库）。
   我在 vitest 里看到的 `OK` 全是测试桩噪音（mock host 当然有 attachments），不是真进程。

教训记牢：**测试桩不是运行时，能拿到日志就别从源码猜。**

### 正路：让内核自己取，插件不碰 ctx.attachments

内核主机端本来就有方法 `SessionController.attachment({sessionId, attachmentId})`
（`dsh-api-session-controller/lib/index.js`，客户端契约里叫 `readAttachment`）。
它内部一次做完三件事：

1. `readSessionState(sessionId)` —— 确认该会话确实引用了这张图（`referencedImage`）；
2. 调 `ctx.attachments.readImage(ref)` —— **ref 是它自己从会话事件里取的真实引用**；
3. 用真实 ref 做完整性校验，返回 `{ attachment, data }`（`data` 是 **base64 字符串**）。

我们绕开它自己调 `ctx.attachments`，既拿不到注入属性、又得自己复刻这三件事 ——
完整性校验正是先前 `ATTACHMENT_CORRUPT` 的来源。

### 改了什么

- `dsh-0.2-bridge.ts`：`readAttachment` 改为调 `host.sessionController.attachment({sessionId, attachmentId})`，
  并把返回的 base64 **解码成 Uint8Array**；`SessionControllerLike` 补 `attachment()` 声明。
  不再读 `ctx.attachments`（`optionalService(host,'attachments')` 只剩诊断观测用）。
- `chat-adapter.ts`：`readAttachment(principal, sessionId, attachmentId)` —— **sessionId 必需**
  （内核要靠它读会话事件、定位真实 ref），并保留会话归属校验；撤掉上一轮的 `ref` 参数。
- `router.ts`：附件端点改为从 query 取 `sessionId`（缺失即 400 `BODY_INVALID`），
  撤掉 `attachmentRefFromQuery()` 和 mediaType/bytes/width/height 四项 —— 真实 ref 内核手里本来就有。
- 测试重写：`dsh-0.2-bridge.spec.ts` 断言「调 sessionController.attachment、**不调** ctx.attachments、
  base64 正确解码、内核报错原样透传」；`attachment-api.spec.ts` 改为钉 sessionId 转发与缺 sessionId 返回 400。
- 一次性诊断写 `.attachment-diag.log`（**不依赖 logger**：dsh 是前台进程，logger 走 stdout
  到用户终端、不落盘，`/proc/<pid>/fd/1 -> /dev/pts/0`，实测读不到）。定位完成后这段应删。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **20 个文件 / 117 用例全绿** ·
`pnpm docs:check` 通过 · `pnpm build` 通过，且已同步到实装目录。
**图片能否显示待真机验证**（需重启 dsh + 装新版 App v2.2.24）。

### 客户端配套（详见 dsh-companion 的 CHANGELOG-DEV）

`DshClient.readAttachment(sessionId, attachmentId)` 把 sessionId 拼进 query；
`HarnessViewModel.loadAttachmentImage` 用当前 `selectedSessionId` 调用，不在任何会话时直接返回。
撤掉了上一轮的 `referenceOf()` 与四项元数据透传（内核不需要）。

## 2026-10-11 · v2.2.3 把 `turn/end` 的失败原因送出去：新增 `chat.turn.failed` 帧

> **未发版、未推送**：等用户真机测试通过后再走 `pnpm check` + publish。
> 版本号建议 v2.2.3（当前 package.json 仍是 2.2.2， bump 留到发版时做）。

### 为什么

用户真机报的 bug：**模型限流（429）之后，手机端一直在傻傻地等。**

抓到的原样报文：

```
本轮运行失败429: {"code":"","message":"您已达到免费用户的 API 速率限制。升级 Token Plan
即可解锁更高限额，继续不间断使用 API。 (request id: 20261011054136674823028JzjiUYGm)","type":"AgnesAI_error"}
```

### 根因（三处断点，缺一处就还是"傻等"）

1. **内核**把失败写在 `turn/end` 的 `data.reason` 里：`reason.kind === 'error'` 时
   错误详情在 `reason.error = {message, code}`。权威判据见
   `dsh-client-ui-chat/lib/client.js` 的 `turn-error.js`（`failureFrom` / `match`）。
2. **插件** `normalizeDshEvent` 的 `turn/end` 分支只转 `type`，把 `reason` **整段丢掉** ——
   于是限流、配额用尽、密钥失效这些终局失败，在客户端眼里与「正常跑完」一模一样。
3. **客户端**只认 `chat.turn.end`，且历史里 `turn/end` 落进 `else -> emptyList()`。

也就是说，那句话从来没到过手机。用户看到的是「转圈」，而真相是「早就失败了」。

### 改了什么

- `chat-adapter.ts`：`turn/end` 命中失败判据时，**额外**发一帧 `chat.turn.failed`
  （id 为 `<rpcId>:failed`），`data.failure = {message, code, stopped?}`。
  正常收尾仍然只发 `chat.turn.end` —— 一个失败只有一帧，客户端不会收到两个信号。
- 新增并导出纯函数 `turnFailureOf(event)`，判据与内核 `turn-error.js` **逐条对齐**：
  只认 `reason.kind === 'error'` 与「登出导致的 aborted」，**不能多也不能少**。
- `docs/api/asyncapi.yaml`：新增 `ChatTurnFailed` schema，并把该帧加进事件类型示例。
- `tests/chat-adapter.spec.ts`：新增一个用例，用**用户报文原样**钉住 429 那一条，
  外加登出停止、AUTH 空 message、以及四种不该报失败的收尾（含 `max-tokens` 与老帧）。

### 三个刻意的不做

1. **不翻译 message。** 服务端那句话本身就是中文，且本地化是客户端的职责
   （与官方 `failureMessage()` 的划分一致）。插件只做搬运。
2. **`max-tokens` 不当失败。** 那是「回答被截断，已有输出保留」，官方渲染成黄色警示。
   报成失败会让用户以为白跑了一轮。
3. **AUTH 的 message 不补。** 内核 `displayFailure` 把它抹成空串，客户端用本地化文案
   「API 密钥无效」顶上。插件补一个字，就两头不一致了。

### 验证

`pnpm typecheck` 通过 · `pnpm test` **19 个文件 / 114 用例全绿**（新增 1 个用例）·
`pnpm docs:check` 通过。

**✅ 真机验证通过**（2026-10-11）：用户重启 dsh + 装 App v2.2.24 后，
429 限流被如实显示在客户端上。

### ⚠️ 踩到的坑：改了 lib/ 并不等于改了跑着的插件

这是本轮**真被绊了一跤**的地方，值得单列：

1. `lib/index.js` 是 tsdown 的产物，只在 `pnpm build` / `prepack` 时重建 ——
   改 `src/` 之后**必须** `pnpm check` 才落到 lib/；
2. 就算仓库里的 lib/ 重建好了，**DSH 加载的是另一个副本**：
   `~/.dsh/profiles/web/node_modules/dsh-remote-bridge/lib/`。
   实测那个目录里的版本号是 2.2.1、`chat.turn.failed` 计数为 0 ——
   仓库却是 2.2.2 且已含新帧。**两边 package.json 只差版本号**，说明是打包/拷贝过去的实体副本，
   没有任何链接关系；
3. 插件是**进程内加载**的：实测 dsh 进程启动于 13:12，而插件目录 13:21 才被写入 ——
   不重启，跑的就是旧代码。

所以完整动作是三步，缺一步就是"App 变了但没反应"：

```bash
pnpm check                                                  # ① 重建 lib/
cp lib/*.js lib/*.d.ts ~/.dsh/profiles/web/node_modules/dsh-remote-bridge/lib/   # ② 同步到实装目录
# ③ 重启 dsh —— 用户操作，重启会掐掉正在跑的这个会话
```

> 备份留在 `.local-backup/web-profile-2.2.1/lib/`（插件仓库内，不入版本库）。
>
> 更稳的做法是给实装目录建符号链接指向仓库的 lib/，从此不再有"两份"这个问题 ——
> **本轮没做，等发版时一并考虑**。

（`docs/project/CHANGELOG-DEV.md` 里 `pnpm build` 不查类型那条旧教训依然成立。）

## 2026-10-11 · v2.2.2 接住 `user-questions/request`：手机端可显示并回答提问

### 为什么

内核的 `ask_user_question` 有两条路：带 `timeout` 的走 `askTimed`（超时后进投影变成
`continued`，可迟到补交），这条路早就通了；**不带 `timeout` 的走 `ask()`，唯一入口是
host 钩子 `user-questions/request`**，此前完全没接。

实测 15 个真实调用样本，参数键**清一色只有 `questions`**（没有一个带 timeout）——
也就是说绝大多数提问走的是那条没接的路。

### 改了什么

- 新增 `QuestionBridge` 接住钩子；**先委托再竞速**：进入即 `next()` 把卡片交给官方
  WebUI（电脑端照旧能答），同时留一份给手机端，先答者胜。这样不必抢注册顺序。
  形状不认识 / 已中止 / 表满一律整条委托，绝不让 agent 拿不到答案。
- 新增两个端点（已写入 OpenAPI）：`GET /chat/sessions/{id}/questions`、
  `POST /chat/sessions/{id}/questions/{callId}/answer`。
- 新增三个 WS 帧：`userQuestions/requested | answered | dismissed`。

### 踩到的坑（详见 RETRO-question-card.md）

1. **`callId` 只在 `wait` 里，而 `wait` 只有 `askTimed` 才加。** 最初的判据「拿不到
   `wait.callId` 就整条委托」等于**把 plan 模式整条挡在门外** —— 那种 request 直接
   交给官方界面，于是**电脑端有卡片、手机端一帧收不到**。两个现象同一个原因。
   现改为缺失时自造 `bridge-<uuid>`。
2. **`pnpm build` 不查类型。** 清临时诊断时删了构造器参数却漏改调用处，build 一路绿灯，
   是 `npm publish --dry-run` 的 `prepack → tsc --noEmit` 才抓到。**直接 publish 会失败。**

### 验证

`pnpm check` 全绿：tsc --noEmit · 19 个测试文件 / 113 用例 · docs:check · build。
**问答卡片经真机端到端验证通过**（内核提问 → 钩子 → 插件推帧 → App 渲染 → 作答 → 答案回到内核）。

## 2026-10-09 · v2.2.1 README 增加 npm 安装方式

### 为什么

插件在 2.2.0 之后已经发布到 npm（`dsh-remote-bridge`，官方源 + npmmirror 都有），
但 README 只列了 GitHub / Gitee 两个 Release tarball 的装法 —— 最省事的那条路没写出来。

### 改了什么

README 中英两份的安装段从两种变成三种，并把 **npm 包名放在首位**：

```
dsh plugin --profile web add dsh-remote-bridge                                  # 推荐
dsh plugin --profile web add dsh-remote-bridge --registry https://registry.npmmirror.com
```

推荐它是因为装的是**预构建产物**，pnpm 不会要求构建授权 —— 这也是 DSH 插件清单
（awesome-dsh-plugin）指南的推荐做法。项目信息一节补了 npm 链接。

### 一件先验证再写的事

记不清 `dsh plugin add` 是否接受 `--registry`（印象里有两种相反的说法），所以实测两次：

- 该子命令的 `--help` 输出的其实是 **`pnpm add` 的帮助**，其中明确列有
  `--registry <url>  The registry to use for the installation` —— 它就是转发给 pnpm 的；
- 用 `--registry https://registry.invalid.example` 做证伪：pnpm 明确去访问该域名并以
  `ENOTFOUND` 失败；去掉该参数则照常成功。说明这个 flag 真的生效，不是被静默忽略。

### 顺带

发版流程第 1 步改为**用 `npm pack` 产出 Release 产物**（见
[RELEASE.md](./RELEASE.md)）：2.2.0 那次用的是 `pnpm pack`，产物与 npm 上那份哈希对不上
（文件清单一致、内容一致，只差 npm 改写的 package.json 元数据），对账时容易误判。

## 2026-10-09 · v2.2.0 删除独立页，包体 1.72 MB → 0.25 MB

### 为什么删

`/dsh-workspace` 独立页（文件树 + CodeMirror 编辑器）自 2.0.4 起就已经不在桌面设置里，
只剩它自己那一套入口。删它的依据不是「代码不好看」，而是**能力已经有人做过了**：
手机 App 的文件页原生覆盖同一套操作（列目录、上传下载、重命名、移入回收站），走的是同一组
REST 端点；桌面上这个页面没有人用。留着它，等于同时维护两份文件管理界面，
并为其中没人用的一份付 7 倍体积。

### 删了什么

- `src/standalone/`（独立页入口）与 `assets/workspace.html`
- `src/client/editor.tsx`（CodeMirror 6 封装）
- `workspace.tsx` 里的 `WorkspaceApp`、`DirectoryNode`、`CommandDialog`、`AdminOverlay`
- `scripts/test-server.ts`
- 8 个 `@codemirror/*` 与 `@lezer/highlight` 依赖

发布包因此从 **1.72 MB 降到 0.25 MB**（`artifacts/dsh-remote-bridge-2.2.0.tgz`，
264,167 字节，SHA-256 `6c3301f8a2110a63daf5c51865e2f2bec9e6cb893740694b79aa8afd7db899b5`）。

### 保留了什么（这条比删除本身重要）

**删的是页面，不是接口**：

- `/dsh-workspace-api` 代理前缀原样保留 —— 已发布的 App 把它写死了，删掉等于让所有在用的手机失联；
- `/roots`、`/roots/{rootId}/entries`、`/roots/{rootId}/content`、`/roots/resolve`、`/trash`
  等 REST 文件端点一个没动，**手机 App 的文件功能完全不受影响**；
- 设置面板六个分区（根目录 / 远程访问 / 设备 / 回收站 / 审计 / App 下载）一个未减。

所以这次是**减界面，不是减能力**。代价也要说清楚：桌面端从此没有文件管理界面，
在电脑上动文件只剩两条路 —— 在会话里让 agent 用工具读写，或者自己开终端。
`Playwright` 配置里那句「插件唯一能打开的网页」也随之失效，这一层现在只测面板计算样式。

### 为什么顺手关掉 source map

`tsdown` 改 `sourcemap: false`。映射本身约 5 MB，而插件发的是**预构建 bundle**、
包内并不含原始 TypeScript 源码 —— 拿不到源码的映射对排障没有价值，只白占体积。
这一次体积和可调试性不冲突：删掉它两头都更好。

### 验证

`pnpm check` 全绿：`tsc --noEmit`、**19 个测试文件 / 113 个用例**、
`docs:check`（9 份项目文档、38 项任务、6 份 ADR 与 API/SDK 版本一致性）、两个 entry 构建完成；
另有 **3 个浏览器层用例**（Playwright 用真实浏览器量「手机设置」面板的计算样式）。

## 2026-10-09 · v2.1.3 回收站页补来路说明

### 为什么

用户反馈**「回收站 我一直没找到用途」**。这句话指向的不是缺功能，是**功能在但没用**：
桌面面板自 2.0.4 起已不含文件树，从这里根本删不掉任何文件，于是列表永远是空的 ——
一个空页面当然没人知道它是干什么的。

所以这一版没有加任何能力，只在页首补了说明：只列出来自手机 App 或独立页
`/dsh-workspace` 的删除记录；文件先来这里而非直接消失，可恢复，永久清理也在此发起。

把「为什么这里是空的」写出来，比再加一个按钮有用。

## 2026-10-09 · v2.1.2 修隐形按钮 + 导航改横排

### 真因：白字白底

用户反馈**「授权根目录后面的添加按钮看不见」**、**「竖排不好看，改横排」**。

看不见的按钮不是样式没写，是**变量没解析**：所有 `--daw-*` 自定义属性定义在
`.daw-root` 上，而 2.1.1 把设置改成内联渲染之后，那一节**没有 `.daw-root` 祖先**。
于是 `var(--daw-accent)` 解析失败 → `.daw-command.primary` 的 `background` 落成透明，
而 `color` 仍是 `#fff` —— **白字画在白底上**。

同一个 bug 其实也解释了 2.1.1 之前那个「看不见的按钮」：不是两个 bug，是同一个。

修法两条：变量块选择器从 `.daw-root` 扩成 `.daw-root,.daw-settings-section`；
导航在 `.daw-settings-section` 作用域下改横排（flex 横排、底部边框、选中态由左侧
竖条改底部横条）。

### 因果验证

不靠「看起来好了」收工：用 Playwright 取**计算样式**确认 `background` 真的不再是
`rgba(0, 0, 0, 0)`，并新增 `tests/styles.spec.ts` 守住这条结构不变量 ——
否则下一次有人改选择器，同样的白字白底会再来一遍，而且症状是「按钮不见了」，
没人会联想到祖先缺一个 class。

## 2026-10-09 · v2.1.1 设置页内联渲染（修一个自己犯的设计错误）

### 2.1.0 的入口是错的

2.1.0 把设置页那一节做成了**启动器**：一句说明 + 一个按钮，真正的设置在按钮后面的
模态框里。用户点进去只看到一句话，反馈**「其他的可以设置的东西那去了」** ——
他把这一节当成设置本身，而它只是个门把手。

抽出 `PhoneSettingsBody`（导航栏 + 内容区，无对话框外壳），设置页**内联**渲染。

### 随之删掉的死代码

内联之后这些都没有存在理由了，留着就是第二套入口：
`GlobalOverlay`、`dsh-remote-bridge:open-panel` 事件、`openSection()`、
`shell.overlay` 注册、`WorkspacePanel`、`openPanel` 文案键。
`AdminOverlay` 保留 —— 独立页 `/dsh-workspace` 仍在用。

## 2026-10-09 · v2.1.0 入口搬进 DSH 设置 + App 下载页

### 用户的三条要求

把「工作区设置」移到 DSH 设置里「手机访问」下面、改名为「手机设置」、二维码单独一页。

### 入口：删掉侧栏按钮，改注册 settings.section

原先的侧栏齿轮按钮（`sidebar.footer.action`）已**删除**，改为注册 `settings.section`，
`id: dsh-remote-bridge`、`order: 2` —— 紧跟 dsh-pocket-relay 的「📱 手机访问」
（它 `order: 1`）。同一件事有侧栏图标和设置页两个起点，是「哪个是真的」的成本，
现在远程访问、配对与客户端下载都收在设置页一处。

### 改名，以及一个刻意不改的地方

面板标题「工作区设置」→「手机设置」。但**独立页 `/dsh-workspace` 自己的齿轮保留
「工作区设置」**：那里确实就是文件工作区，两个概念不该共用一个词。

### 二维码指向列表页，不是具体文件

两个二维码指向 GitHub / Gitee 的 **dsh-companion Releases 列表页**，刻意不指向
`/releases/download/<tag>/<file>` —— 否则每发一个新版都要重做二维码，而这份资产是
**提交进仓库**的，漏更新就等于给用户一个过期入口。

### 资产双份，各有各的理由

- `assets/app-qr-{github,gitee}.svg` —— 插件界面用，以 data URL 内联，
  浏览器端零依赖、零网络请求；
- `.png` —— README 用（Gitee 的 Markdown 可能不渲染 SVG）。

生成脚本 `scripts/generate-app-qr.mjs`（`pnpm qr:app`），并用**独立解码器**交叉验证
（编码 qrcode、解码 jsqr）：自己编自己解不算验证，换一条链路才算。
新增 `tests/app-qr.spec.ts` 解**提交进仓库的资产本身**，防止手改或漂移。

## 2026-10-09 · v2.0.4 改名 dsh-remote-bridge + 宿主注入容错（补记）

> 这条是**补记**：2.0.4 当时直接发了 Release，没进开发日志。
> 结果 CHANGELOG 从 2.0.0 直接跳到 2.1.0，读的人会以为中间没有版本 —— 而 2.0.4 是
> 改名那一版，对下游影响最大的恰恰是它。

### 改了什么

- **改名**：`dsh-workspace` → `dsh-remote-bridge`。旧名字比内容窄 —— 插件实际承担的是
  「把 DSH 内核的私有 remote 协议翻译成版本化 REST，供手机端远程访问这台机器」
  外加一个设置中心，而「workspace」只是其中一页。
  改名只动「安装时叫什么、bundle 叫什么」，**四处对外契约刻意不变**：
  REST 前缀 `/dsh-workspace-api`（已发布 App 写死了）、独立页 `/dsh-workspace`、
  浏览器存储键 `dsh-workspace-device-token`、状态目录 `dshHomePath('dsh-workspace')`。
  改名不该顺带把已装机器上的授权根和回收站清空。
- **宿主注入容错**：某些 DSH 构建不提供 `ctx.attachments` / `ctx.fileUploads`。
  原先插件在回调里直接读这两个注入属性，缺失时抛
  `cannot get property "..." without inject`，**整个插件激活失败**（2.0.1 就是这么坏的）。
  改为用 `optionalService()` 容错解析并闭包捕获：插件照常激活，
  只有真正用到该能力的接口返回 `ATTACHMENT_STORE_UNAVAILABLE` / `FILE_UPLOADS_UNAVAILABLE`。
- **桌面端收敛为纯设置面板**：入口图标由文件夹换成齿轮，只渲染五行设置；
  目录树、编辑器与文件操作移出桌面面板，保留在独立页 `/dsh-workspace`；
  会话视图中的「文件」标签页不再注册。

### 为什么值得补记

2.0.1 的教训是「一个缺失的服务能让整个插件起不来」，2.0.4 把这条修掉并写成容错边界；
而改名是一次不可逆的对外变更。两件事都该在日志里留下痕迹。

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
