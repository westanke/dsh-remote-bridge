#!/usr/bin/env bash
# 整理三个推送远端的命名与地址（幂等，可反复跑）。
#
# 目标约定：
#   origin   -> GitHub    https://github.com/westanke/dsh-remote-bridge.git
#   gitee    -> Gitee     https://gitee.com/westanke/dsh-remote-bridge.git          （主）
#   atomgit  -> AtomGit   https://atomgit.com/westanke163/dsh-remote-bridge.git        （备）
#
# 渠道拓扑（2026-10-20 起，与姊妹仓 dsh-companion 对齐）：Gitee 为主、AtomGit 为备，
# GitHub 为从站，GitHub 端不手工推送，由 .github/workflows/mirror-sync.yml
# 定时从 Gitee 自动同步。
#
# 2026-10-25：删除了 `upstream`（原 `Hakunm/dsh-workspace`）。原作者早已停止更新，
# 那个远端从建仓起就没有再 fetch 过，留着只是让 `git remote -v` 多一行噪音。
# 代码血缘与 AGPL 归属仍在 `AGENTS.md` §1 与 README 里写明，删的是 git 远端、不是署名。
#
# 用法：bash scripts/setup-remotes.sh
set -uo pipefail

GITHUB_URL="https://github.com/westanke/dsh-remote-bridge.git"
GITEE_URL="https://gitee.com/westanke/dsh-remote-bridge.git"
ATOMGIT_URL="https://atomgit.com/westanke163/dsh-remote-bridge.git"

say() { printf '%s\n' "$*"; }
ok()  { printf '  ✅ %s\n' "$*"; }
bad() { printf '  ❌ %s\n' "$*"; }

set_remote() {
  local name="$1" url="$2"
  if git remote get-url "$name" >/dev/null 2>&1; then
    local cur; cur="$(git remote get-url "$name")"
    if [ "$cur" = "$url" ]; then
      say "  $name 已就位：$url"
    else
      git remote set-url "$name" "$url" && ok "$name 改为：$url（原：$cur）"
    fi
  else
    git remote add "$name" "$url" && ok "新增 $name：$url"
  fi
}

say "整理三远端命名…"
say ""
set_remote origin  "$GITHUB_URL"
set_remote gitee   "$GITEE_URL"
set_remote atomgit "$ATOMGIT_URL"

say ""
say "当前远端："
git remote -v | awk '!seen[$1]++ {print "  " $1 "\t" $2}'
say ""
ok "三远端命名已统一（origin=GitHub 从站 / gitee=Gitee 主站 / atomgit=AtomGit 备站）"
