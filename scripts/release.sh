#!/usr/bin/env bash
# 一键发版：门禁 → 打包 → tag → 双推 → 两站 Release → npm 发布 → 全渠道回读。
#
# ## 为什么要有这个脚本
#
# 用户 2026-10-19 定的规矩：**git 与 npm 必须一起发，缺一不可**，且**打包一律用 npm**
# （不用 pnpm——两者产物哈希不同，无法与 npm 上那份对账）。
#
# 而 v2.4.2 那次，我做完「双推 + 两站 Release」就以为发完了，**漏了 npm**，
# 是用户追问「NPM包发了吗」才补的。同类问题还发生过一次（v2.4.0 时 `npm view` 查不到
# 刚发的版本，误判成失败，其实是 registry CDN 延迟）。
#
# 两次教训指向同一件事：**发版是七件事的清单，不是「记得的那几件」**。
# 所以把它做成脚本，让「漏一步」在结构上不可能发生。
#
# ## 幂等
#
# 每一步都先看「远端是不是已经好了」：tag 存在就跳过、Release 存在就跳过、
# 附件已在就跳过、npm 版本已发布就跳过。**可以反复重跑**，中途失败修完再跑即可。
#
# 用法：
#   bash scripts/release.sh                 # 全自动
#   DRY_RUN=1 bash scripts/release.sh       # 只打印计划，不动任何远端
#   SKIP_CHECK=1 bash scripts/release.sh    # 跳过门禁（已在别处跑过）
#   SKIP_NPM=1 bash scripts/release.sh      # 仅本地排障用：明确跳过 npm（不推荐）

set -euo pipefail
cd "$(dirname "$0")/.."

PKG=$(node -p "require('./package.json').version && require('./package.json').name")
VER=$(node -p "require('./package.json').version")
TSVER=$(sed -n "s/.*PLUGIN_VERSION = '\(.*\)'.*/\1/p" src/shared/version.ts)
TAG="v${VER}"
DRY_RUN=${DRY_RUN:-0}

say() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✅ %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m  ⚠️ %s\033[0m\n' "$*"; }
bad() { printf '\033[31m  ❌ %s\033[0m\n' "$*"; }
run() { if [ "$DRY_RUN" = "1" ]; then say "  [dry] $*"; else "$@"; fi; }

say "═══ 发版 $PKG@$VER（tag $TAG）═══"
say ""

# ── 0. 前置检查 ────────────────────────────────────────────────────
say "0) 前置检查"
[ "$VER" = "$TSVER" ] || { bad "package.json=$VER 与 version.ts=$TSVER 不一致"; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  bad "工作区有未提交改动 —— 先提交再发版（发版提交必须是可复现的那个状态）"
  git status --short | head -10
  exit 1
fi
ok "版本号两处一致、工作区干净"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
ok "分支 $BRANCH，HEAD $(git rev-parse --short HEAD)"

# 远端与凭据（Gitee/AtomGit 的 API token 存在 ~/.git-credentials 里）
GT=$(grep -m1 "gitee.com" ~/.git-credentials 2>/dev/null | sed 's|https://[^:]*:||; s|@gitee.com||' || true)
AT=$(grep -m1 "atomgit.com" ~/.git-credentials 2>/dev/null | sed 's|https://[^:]*:||; s|@atomgit.com||' || true)
[ -n "$GT" ] && ok "Gitee token 就绪" || warn "没有 Gitee token，Release 步骤会跳过"
[ -n "$AT" ] && ok "AtomGit token 就绪" || warn "没有 AtomGit token，Release 步骤会跳过"
say ""

# ── 1. 门禁 ────────────────────────────────────────────────────────
if [ "${SKIP_CHECK:-0}" != "1" ]; then
  say "1) 门禁 npm run check（typecheck / test / docs:check / build）"
  run npm run check
  ok "门禁通过"
else
  say "1) 门禁 —— 已按 SKIP_CHECK=1 跳过"
fi
say ""

# ── 2. 打包（一律 npm）─────────────────────────────────────────────
say "2) 打包（npm pack，产出带 v 与不带 v 两份 + SHA256SUMS）"
SKIP_CHECK=1 run bash scripts/pack-release.sh
TGZ="artifacts/dsh-remote-bridge-${VER}.tgz"
TGZ_V="artifacts/dsh-remote-bridge-v${VER}.tgz"
[ "$DRY_RUN" = "1" ] || { [ -f "$TGZ" ] && ok "产物 $(stat -c%s "$TGZ") 字节" || { bad "打包没产出 $TGZ"; exit 1; }; }
say ""

# ── 3. 打 tag ──────────────────────────────────────────────────────
say "3) 打 tag $TAG"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  ok "本地已有 $TAG，跳过"
else
  run git tag -a "$TAG" -m "${PKG} ${VER}"
  ok "已创建 $TAG"
fi
say ""

# ── 4. git 双推（分支 + tag）──────────────────────────────────────
# 复用 scripts/push-all.sh（与姊妹仓 dsh-companion 同一套），**不**在这里重写一遍推送逻辑：
# 两处各写一份必然分叉（姊妹仓就出过「分支与 tag if/else 互斥，导致只推了一半」的 bug）。
#
# 拓扑：Gitee 主站 + AtomGit 备站；GitHub 是从站，由 .github/workflows/mirror-sync.yml
# 从 Gitee 自动同步（本机到 github.com:443 长期被阻断，不手工推）。
#
# tag 的推法与 push-all.sh 的默认一致：**只推指向 HEAD 的 tag**。本脚本在第 3 步
# 刚打完 tag，那正是指向 HEAD 的，所以推得上去；历史 tag 不重推（远端已有同名 tag 时
# 逐个判断跳过，不会像 `git push --tags` 那样因任意一个旧 tag 冲突而整条被拒）。
say "4) git 双推（Gitee 主站 + AtomGit 备站）"
if [ "$DRY_RUN" = "1" ]; then
  say "  [dry] bash scripts/push-all.sh"
else
  if bash scripts/push-all.sh; then
    ok "主备两站已推（分支 + 指向 HEAD 的 tag）"
  else
    bad "push-all.sh 报告推送失败 —— 继续走 Release，但代码可能没全部推上去"
  fi
fi
say ""

# ── 5. 两站 Release + 附件 ────────────────────────────────────────
say "5) 两站 Release + 附件"
BODY_FILE="docs/project/.release-body-${VER}.md"
if [ ! -f "$BODY_FILE" ]; then
  warn "没有 $BODY_FILE —— Release 正文将用 CHANGELOG 顶部"
  BODY_FILE=""
fi

gitee_release() {
  [ -z "$GT" ] && { warn "无 Gitee token，跳过"; return 0; }
  local repo="westanke/dsh-remote-bridge"
  local id
  id=$(curl -s "https://gitee.com/api/v5/repos/$repo/releases/tags/$TAG?access_token=$GT" \
       | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id||'')}catch{console.log('')}})")
  if [ -z "$id" ]; then
    say "  创建 Gitee Release $TAG…"
    [ "$DRY_RUN" = "1" ] && return 0
    local body
    body=$( [ -n "$BODY_FILE" ] && cat "$BODY_FILE" || sed -n '/^## /,$p' docs/project/CHANGELOG-DEV.md | head -60 )
    # ⚠️ access_token 必须放 **form 字段**，不能放 query（`?access_token=`）——
    # 2026-10-20 实测：query 形式一律返回 40001「登录失效，无权限访问该资源」，
    # 而 token 本身有效（GET /api/v5/user 返回 200）、git push 也正常 —— 极易误判成
    # 「权限失效」。附件 attach_files 一直是 form 形式，所以只有建 Release 这一步踩过。
    #
    # 用 -F "body=<文件" 让 curl 直接读文件，避免大段正文过 shell 引号。
    if [ -n "$BODY_FILE" ]; then
      id=$(curl -s -X POST "https://gitee.com/api/v5/repos/$repo/releases" \
           -F "access_token=$GT" -F "tag_name=$TAG" -F "target_commitish=main" \
           -F "name=$VER" -F "prerelease=false" -F "body=<$BODY_FILE" \
           | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id||'')}catch{console.log('')}})")
    else
      id=$(curl -s -X POST "https://gitee.com/api/v5/repos/$repo/releases" \
           -F "access_token=$GT" -F "tag_name=$TAG" -F "target_commitish=main" \
           -F "name=$VER" -F "prerelease=false" -F "body=$body" \
           | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id||'')}catch{console.log('')}})")
    fi
    [ -n "$id" ] && ok "Gitee Release 已建（id $id）" || { bad "Gitee Release 建失败"; return 1; }
  else
    ok "Gitee Release 已存在（id $id），跳过创建"
  fi
  # 附件：两个 tgz + SHA256SUMS，名字已在就跳过
  local have
  have=$(curl -s "https://gitee.com/api/v5/repos/$repo/releases/$id?access_token=$GT" \
        | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).assets||[]).map(a=>a.name).join(' '))}catch{console.log('')}})")
  for f in "$TGZ" "$TGZ_V" artifacts/SHA256SUMS.txt; do
    [ -f "$f" ] || continue
    local base; base=$(basename "$f")
    if echo " $have " | grep -q " $base "; then
      ok "Gitee 已有 $base"
    else
      [ "$DRY_RUN" = "1" ] && { say "  [dry] 上传 $base"; continue; }
      curl -s -X POST "https://gitee.com/api/v5/repos/$repo/releases/$id/attach_files" \
        -F "access_token=$GT" -F "file=@$f" >/dev/null
      ok "Gitee 已传 $base"
    fi
  done
}

atomgit_release() {
  [ -z "$AT" ] && { warn "无 AtomGit token，跳过"; return 0; }
  local repo="westanke163/dsh-workspace"
  local cur
  cur=$(curl -s -H "Authorization: Bearer $AT" \
        "https://atomgit.com/api/v5/repos/$repo/releases?per_page=1" \
        | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const d=JSON.parse(s);console.log((d[0]||{}).tag_name||'')}catch{console.log('')}})")
  if [ "$cur" = "$TAG" ]; then
    ok "AtomGit Release 已存在（$TAG），跳过"
  else
    [ "$DRY_RUN" = "1" ] && { say "  [dry] 创建 AtomGit Release $TAG"; return 0; }
    local payload
    payload=$(TAG="$TAG" VER="$VER" BODY_FILE="$BODY_FILE" node -e '
      const fs=require("fs");
      const body = process.env.BODY_FILE && fs.existsSync(process.env.BODY_FILE)
        ? fs.readFileSync(process.env.BODY_FILE,"utf8")
        : fs.readFileSync("docs/project/CHANGELOG-DEV.md","utf8").split(/^## /m).slice(1,3).map(x=>"## "+x).join("");
      process.stdout.write(JSON.stringify({tag_name:process.env.TAG,name:process.env.VER,body,target_commitish:"main"}));
    ')
    curl -s -X POST "https://atomgit.com/api/v5/repos/$repo/releases" \
      -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "$payload" >/dev/null
    ok "AtomGit Release 已建"
  fi
  # AtomGit 没有附件上传 API（attach_files / assets / upload 全 404），
  # Release 正文里的下载链接指向 Gitee，够用。这里只提示，不算失败。
  warn "AtomGit 不支持附件上传（API 不存在），产物以 Gitee 为准"
}

gitee_release
atomgit_release
say ""

# ── 6. npm 发布（与 git 同批，缺一不可）──────────────────────────
if [ "${SKIP_NPM:-0}" = "1" ]; then
  warn "6) npm 发布 —— 已按 SKIP_NPM=1 跳过（仅本地排障，正常发版绝不能跳）"
else
  say "6) npm 发布（与 git 同批）"
  run bash scripts/publish-npm.sh
fi
say ""

# ── 7. 全渠道回读 ─────────────────────────────────────────────────
say "7) 全渠道回读"
if [ "$DRY_RUN" = "1" ]; then
  say "  [dry] 跳过回读"
  exit 0
fi

rc=0
if curl -sf --max-time 30 "https://registry.npmjs.org/${PKG}/${VER}" >/dev/null; then
  ok "npm: ${PKG}@${VER} 可读"
else
  bad "npm: registry 查不到 ${VER}"; rc=1
fi

code=$(curl -sL -o /dev/null -w '%{http_code}' --max-time 90 \
  "https://gitee.com/westanke/dsh-remote-bridge/releases/download/${TAG}/dsh-remote-bridge-v${VER}.tgz")
[ "$code" = "200" ] && ok "Gitee: 带 v 的 tgz 可下（200）" || { bad "Gitee: 带 v 的 tgz 返回 $code"; rc=1; }
code=$(curl -sL -o /dev/null -w '%{http_code}' --max-time 90 \
  "https://gitee.com/westanke/dsh-remote-bridge/releases/download/${TAG}/dsh-remote-bridge-${VER}.tgz")
[ "$code" = "200" ] && ok "Gitee: 不带 v 的 tgz 可下（200）" || { bad "Gitee: 不带 v 的 tgz 返回 $code"; rc=1; }

for r in gitee atomgit; do
  if [ -n "$(git ls-remote --tags "$r" "refs/tags/$TAG" 2>/dev/null)" ]; then
    ok "$r: tag $TAG 已就位"
  else
    bad "$r: tag $TAG 缺失"; rc=1
  fi
done

say ""
if [ "$rc" -eq 0 ]; then
  ok "═══ 发版完成：git（双站 + tag + Release）+ npm 全部就位 ═══"
  say "npmmirror 镜像通常再滞后几分钟到几十分钟，属正常。"
else
  bad "═══ 有渠道未就位，见上方 ❌ ═══"
fi
exit "$rc"
