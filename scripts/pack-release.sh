#!/usr/bin/env bash
# 打包发布产物：门禁 → pack → 重命名成带 v → 写 SHA-256。
#
# 为什么需要它（2026-10-19 踩到）：`npm pack` 产出的是
# `dsh-remote-bridge-<ver>.tgz`（**没有 v 前缀**），而 README 里两条安装命令写的是
# `dsh-remote-bridge-v<ver>.tgz`（带 v）。两个名字从 v2.2.x 起就对不上，
# 于是 README 的下载链接**长期 404** —— 只是没人点过。
#
# 本脚本把「产物名」这件事收成一处：产出**两种名字各一份**，上传时两份都传，
# 文档怎么写都能下。同时把 SHA-256 写进 artifacts/SHA256SUMS.txt。
#
# 用法：
#   bash scripts/pack-release.sh            # 门禁 + 打包
#   SKIP_CHECK=1 bash scripts/pack-release.sh   # 跳过门禁（已在别处跑过）

set -euo pipefail
cd "$(dirname "$0")/.."

VER=$(node -p "require('./package.json').version")
TSVER=$(sed -n "s/.*PLUGIN_VERSION = '\(.*\)'.*/\1/p" src/shared/version.ts)
say() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✅ %s\033[0m\n' "$*"; }
bad() { printf '\033[31m  ❌ %s\033[0m\n' "$*"; }

say "版本：package.json=$VER  version.ts=$TSVER"
[ "$VER" = "$TSVER" ] || { bad "两处版本号不一致，先修再打包"; exit 1; }

if [ "${SKIP_CHECK:-0}" != "1" ]; then
  say "门禁：npm run check（typecheck / test / docs:check / build）…"
  npm run check
  ok "门禁通过"
fi

mkdir -p artifacts
say "打包（--ignore-scripts：prepack 会重跑一遍 check，这里已经跑过）…"
rm -f "artifacts/dsh-remote-bridge-${VER}.tgz" "artifacts/dsh-remote-bridge-v${VER}.tgz"
npm pack --ignore-scripts --pack-destination artifacts >/dev/null

BARE="artifacts/dsh-remote-bridge-${VER}.tgz"
DASHED="artifacts/dsh-remote-bridge-v${VER}.tgz"
[ -f "$BARE" ] || { bad "没找到 $BARE"; exit 1; }
cp "$BARE" "$DASHED"
ok "产物：$BARE 与 $DASHED（同一份内容，两个名字）"

SIZE=$(stat -c%s "$BARE")
SHA=$(sha256sum "$BARE" | cut -d' ' -f1)
{
  echo "# dsh-remote-bridge 产物校验（v${VER}）"
  echo "# 两个文件名指向同一份字节；npm 包名安装与 Release 直链都能对上。"
  echo "$SHA  dsh-remote-bridge-${VER}.tgz"
  echo "$SHA  dsh-remote-bridge-v${VER}.tgz"
} > artifacts/SHA256SUMS.txt

say ""
ok "体积 $SIZE 字节"
ok "SHA-256 $SHA"
say ""
say "下一步：把 artifacts/ 下两个 tgz + SHA256SUMS.txt 都传进两个站点的 Release，"
say "并复验两个下载 URL 都是 200（见 docs/project/RELEASE.md）。"
