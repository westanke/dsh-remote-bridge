#!/usr/bin/env bash
# 发布到 npm：门禁 → 发布 → 回读校验。
#
# ## 为什么需要这个脚本（2026-10-19 踩到）
#
# 1. **`prepack` 曾内嵌 `pnpm`**：`npm publish` 会先跑 prepack，而本机 pnpm 的 SQLite store
#    打不开（`unable to open database file`）。错误信息只报「pnpm 打不开库」，与发布毫无关联，
#    于是整条发布链断在一个看起来无关的地方。现已在 package.json 里改成 `npm run` 链。
#
# 2. **本地 npm 10.9.9 不支持 staged 发布**，用它 publish 会报
#    `E409 Cannot publish over previously staged version "<ver>"`；换 npm@12 再发又变成
#    `You cannot publish over the previously published versions`。两次报错方向相反，
#    都指向「这个版本状态不明」——而真相是：**第一次其实已经发出去了，只是 registry
#    的 CDN 要几分钟才可见**。所以本脚本发布后**主动轮询 registry**，不靠人肉刷新。
#
# 3. 账号的 token 是 bypass-2FA 型，npm 官方已限制它只能走「暂存发布」，
#    因此用 npm@12 是必需项，不是偏好。
#
# 用法：
#   bash scripts/publish-npm.sh            # 门禁 + 发布 + 轮询确认
#   SKIP_CHECK=1 bash scripts/publish-npm.sh   # 跳过门禁（已在别处跑过）

set -euo pipefail
cd "$(dirname "$0")/.."

VER=$(node -p "require('./package.json').version")
PKG=$(node -p "require('./package.json').name")
say() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✅ %s\033[0m\n' "$*"; }
bad() { printf '\033[31m  ❌ %s\033[0m\n' "$*"; }

say "包：$PKG  版本：$VER"

# 已发布就早退：重复发布只会得到 E409 / 「previously published」两种相反的误导性报错。
if curl -sf --max-time 30 "https://registry.npmjs.org/${PKG}/${VER}" >/dev/null 2>&1; then
  ok "registry 上已经有 ${PKG}@${VER}，无需再发"
  exit 0
fi

if [ "${SKIP_CHECK:-0}" != "1" ]; then
  say "门禁：npm run check …"
  npm run check
  ok "门禁通过"
fi

# 用 npm@12：本地 npm 对 staged 发布支持不完整，会给出与事实相反的报错。
say "发布（npm@12，走 staged 流程）…"
set +e
npx --yes npm@12 publish 2>&1 | tee /dev/stderr | grep -qE "previously published|E409|E403"
PUB_RC=${PIPESTATUS[0]}
set -e

# 无论 publish 的退出码如何，都以 registry 的**实际状态**为准：
# 上面两种报错都可能发生在「其实已经发布成功」之后。
say "回读 registry（CDN 通常要几分钟，最多等 8 分钟）…"
for i in $(seq 1 32); do
  if curl -sf --max-time 20 "https://registry.npmjs.org/${PKG}/${VER}" >/dev/null 2>&1; then
    SHA=$(curl -s --max-time 20 "https://registry.npmjs.org/${PKG}/${VER}" \
          | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).dist.shasum" 2>/dev/null || echo "?")
    ok "已发布：https://www.npmjs.com/package/${PKG}/v/${VER}"
    ok "shasum: $SHA"
    say ""
    say "镜像 registry.npmmirror.com 通常再晚几分钟到几十分钟，属正常。"
    exit 0
  fi
  sleep 15
done

bad "等了 8 分钟 registry 仍查不到 ${VER}（publish 退出码 $PUB_RC）"
say "排查顺序：① npm whoami 是否仍是发布者；② 版本号是否已被占用（npm view $PKG versions）；"
say "③ 账号是否被要求走 staged 发布（npm@12 stage list $PKG）。"
exit 1
