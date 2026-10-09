# 发版与发布流程

本文档记录**怎么发一版**，以及每一次实际发版中学到的教训。状态类事实见 [STATUS.md](STATUS.md)，
变更记录见 [CHANGELOG-DEV.md](CHANGELOG-DEV.md)。

## 0. 前置

- 工作区干净、`pnpm check` 全绿（含 `docs:check`），浏览器层 `pnpm test:e2e` 通过。
- 想清楚这一版是 **minor 还是 major**：动到对外 API 或契约就是 major；只删网页入口、不动
  API 与存储契约的，算 minor。
- 版本号落在这些地方，**一处都不能漏**（`docs:check` 会抓版本一致性）：

| 位置 | 说明 |
| --- | --- |
| `package.json` 的 `version` | 唯一真源 |
| `src/shared/version.ts` 的 `PLUGIN_VERSION` | 界面与 `/healthz` 显示 |
| `docs/api/openapi.yaml` | `info.version` 与 `pluginVersion` 的 `const` |
| `docs/api/asyncapi.yaml` | `info.version` |
| `kotlin-sdk/build.gradle.kts` | 客户端 SDK 版本 |
| `tests/http-api.spec.ts` | `/healthz` 的版本断言 |

- 在 `CHANGELOG-DEV.md` 顶部按既有格式加一段（日期 · 版本 + 标题）。**写清为什么**，
  不是只列改了哪几个文件。
- README 中英两份的徽章、版本警告、安装命令、当前版本、构建基线同步。

## 1. 产出正式产物：用 `npm pack`，不要用 `pnpm pack`

这是**发过一版之后才明白的一条**，代价是两个哈希对不上。

插件既发到 GitHub/Gitee Release，也发到 npm。两个渠道各自打包，而 `pnpm pack` 与 `npm pack`
是**两个打包器**，产物不同：

| | `pnpm pack` | `npm publish` 产出的 |
| --- | --- | --- |
| 文件清单 | 22 个 | 22 个（完全一致） |
| 除 `package.json` 外的每个文件 | 逐字节相同 | 逐字节相同 |
| `packageManager` 字段 | 被剥掉 | 保留 |
| `prepack` 脚本 | 保留 | 移除 |
| 键顺序 | 不同 | 不同 |

2.2.0 实测：Release 产物 265,426 字节 `66914e58…`，npm 上的 260,347 字节 `130d126c…` ——
**内容等价但哈希不同**。这本身不是错误（是打包器的差），但它让「同一版本两个产物」这件事
无法用哈希对账，也让人怀疑内容是否真的一致。

所以：

```sh
npm pack                       # 产出 dsh-remote-bridge-<version>.tgz
mv dsh-remote-bridge-*.tgz artifacts/
sha256sum artifacts/dsh-remote-bridge-*.tgz
```

用同一个打包器，Release 产物与 npm 上那份就是同一串字节，哈希可以直接对账。

先把 `prepack`（= `pnpm check`）跑完再打包：`npm pack` 会自己触发它。

## 2. 发布到 npm

```sh
npm whoami                     # 确认登录态
npm publish --access public    # package.json 已配 publishConfig.access: public
```

**两条硬性事实**（都实测过）：

1. **发布必须有第二因素。** 账号没开 2FA 也会被拒：
   `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required`。
   两条路：给账号开 TOTP（`npm publish --otp=<六位码>`），或用带 **Bypass 2FA** 的
   Granular Access Token。
   ⚠️ npm 已公告这类 token 的豁免在收口：**账号变更 2026-08 结束，直接发布 2027-01 结束**。
   长期方案是给账号开真 2FA，token 只做兜底。
2. **新包的首次发布要走暂存审核。** 第一次 `npm publish` 之后 registry 上出现的是一个
   `0.0.0-stage` 占位包，`npm view` 只会看到它 —— 真版本 `0.0.0-stage` 之外的条目要等审核通过
   （实测约 3 分钟）。这不是发错了：npm 页面会写
   *"An operational version to replace this has been submitted for review and is awaiting a staged release."*
   审核期间 `npm stage publish` 会报 `409 Cannot stage previously published version` —— 同样正常。
   npm 11+ 才有 `npm stage list/approve/reject`；本机 npm 10 没有，必要时用
   `npx npm@12 stage list`。

### 国内镜像

`registry.npmmirror.com` 是官方源的镜像，**不要往它发布**（它另有「非官方包」通道，代价是
只有把源指向它的机器能装、无备份、CI 直接失败）。发到官方源后：

```sh
curl -X PUT https://registry.npmmirror.com/-/package/<name>/syncs   # 手动催一次，201 {ok:true}
npm view <name> version --registry=https://registry.npmmirror.com   # 验证
```

自动同步通常几分钟内完成；手动催一次更快。**注意：催的时候官方源必须已经有那个版本**，
否则催的是一次带旧缓存的同步。

## 3. 双站 Release

`main` 先推 Gitee，再用 `gh-mirror-rest.py` 镜像到 GitHub（本机 `github.com:443` 不通，
`api.github.com` 通）。然后打 tag、两站各建 Release，附件是第 1 步的产物 + `SHA256SUMS.txt`。

**双站链接规则**（全局规矩）：安装命令、Release 下载这类**必须带主机名**的地址一律两份并列，
不能只写 GitHub —— 同一个 README 由两站共用，写死一处另一处就指错。仓库内文件用相对链接。

**`latest/download/` 会腐烂**：它只在请求时解析 `latest`，**文件名是照字面取的**。若资产名带版本号，
该链接提交当天有效、下次发版即 404。要么资产名不带版本，要么钉住 tag。

## 4. 发完必须实测

不要只看状态码，也不要用本机能否访问当作判定：

- **本机连不上 github.com 是常态**（`curl` 返回 `000`），这不代表链接坏了。
  GitHub 侧用 API 验证资产存在且大小正确：
  `gh api repos/<owner>/<repo>/releases/tags/<tag> --jq '.assets[] | "\(.name) \(.size)"'`
- Gitee 侧直接下载并**回读哈希**，与本地比：

  ```sh
  curl -sL <download-url> -o artifacts/verify.tgz && sha256sum artifacts/verify.tgz
  ```

  本轮就因为「只看到 HTTP 200 就收工」差点漏掉打包器差异。
- 最后把产物装回本机 profile，确认 `dsh plugin list` 里是新版本，并提醒**重启 DSH**
  （插件进程内加载，不重启不生效；浏览器还可能缓存旧的 client bundle，要强刷）。

## 5. 平台侧元数据（不在 git 里）

这些 `git push` 改不到，必须另外设置，而且**改名/删功能后最容易漏**：

| 项 | 位置 | 漏了会怎样 |
| --- | --- | --- |
| 仓库描述 | GitHub + Gitee 各自一处 | 描述与代码不符；对外投稿会被打回 |
| 默认分支 | 两站各自一处 | 指向旧分支时，首页渲染的是旧内容 |
| Topics | GitHub | 对外清单（如 awesome 列表）会校验 `dsh-plugin` |
| npm 的 `description`/`keywords` | `package.json` | npm 页面第一眼就是它，最显眼也最容易过期 |

**改名会丢 topic**：仓库改名后 GitHub 的 topics 可能不再出现在查询结果里，改完名顺手复查一次。
