#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI 专用（.github/workflows/mirror-sync.yml）：
把 Gitee 上的 Release（正文 + 发布资产）幂等回填到 GitHub。

设计：
- 源固定为 Gitee（Release 的权威来源）；AtomGit 只镜像代码，不承担 Release。
- 只搬运三类资产：APK / SHA256SUMS.txt / RELEASE_NOTES_*.md。
  .zip / .tar.gz 不搬——GitHub 对每个 tag 自动生成源码包，且本仓库 Release 的
  源码包内容与主源一致（同 tag 同 commit）。
- 幂等：Release 已存在则只补缺的资产；资产已同名存在则跳过。可安全反复跑。
- 单个 Release/资产失败不中止全局，最后以退出码汇总。

环境变量：
  GH_TOKEN / GITHUB_TOKEN  必需（优先 GH_TOKEN），GITHUB_TOKEN secret（contents: write）
  GITHUB_REPOSITORY        必需，owner/repo（runner 自动注入）
  DRY_RUN=1                只打印不写
"""
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

GITEE_REPO = "westanke/dsh-remote-bridge"
ALLOWED_SUFFIX = (".tgz", ".txt", ".md")
MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024  # GitHub 单文件上限 2 GiB

TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
REPO = os.environ.get("GITHUB_REPOSITORY", "")
DRY_RUN = os.environ.get("DRY_RUN") == "1"

if not TOKEN or not REPO:
    sys.exit("需要 GITHUB_TOKEN 与 GITHUB_REPOSITORY")


def http(method, url, body=None, headers=None, raw=False):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", "token " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "dsh-mirror-sync")
    data = None
    if body is not None:
        if raw:
            data = body
        else:
            data = json.dumps(body).encode("utf-8")
            req.add_header("Content-Type", "application/json")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    if data is not None:
        req.data = data
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw_resp = resp.read()
    if raw:
        return raw_resp
    return json.loads(raw_resp.decode("utf-8")) if raw_resp else {}


def gitee_releases():
    out, page = [], 1
    while True:
        url = ("https://gitee.com/api/v5/repos/%s/releases?per_page=100&page=%d"
               % (GITEE_REPO, page))
        with urllib.request.urlopen(url, timeout=60) as resp:
            batch = json.loads(resp.read().decode("utf-8"))
        if not batch:
            break
        out.extend(batch)
        page += 1
    return out


def gh_release_by_tag(tag):
    url = "https://api.github.com/repos/%s/releases/tags/%s" % (
        REPO, urllib.parse.quote(tag, safe=""))
    try:
        return http("GET", url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def wanted_assets(release):
    result = []
    for a in release.get("assets", []):
        name = a.get("name", "")
        url = a.get("browser_download_url", "")
        if url and name.lower().endswith(ALLOWED_SUFFIX):
            result.append((name, url))
    return result


def ascii_asset_name(name):
    """GitHub uploads 不支持非 ASCII 资产名（实测百分号编码的中文被整段丢弃、
    raw UTF-8 报 400、也不读 Content-Disposition）。Gitee 侧保留中文名，
    GitHub 侧把非 ASCII 字符连同多余连字符清掉：
    DSH伴侣-companion-v2.2.41.apk -> DSH-companion-v2.2.41.apk"""
    import re
    ascii_only = name.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[-\s]+", "-", ascii_only).strip("-")


def broken_variants(target):
    """同一文件被错误上传后在 GitHub 留下的残缺名（历史坑自愈用）。

    实测规律：GitHub uploads 吃掉非 ASCII 字符后，会把原连字符渲染成「点-连字符」
    孤立序列。正确名 DSH-companion-v2.2.41.apk 的残缺形态为
    DSH.-companion-v2.2.41.apk（首段的 '-' 变 '.-'）。返回候选残缺名集合。"""
    import re
    base, dot, ext = target.rpartition(".")
    if not dot:
        return set()
    variants = set()
    # 每个 '-' 位置插入一个前导点，覆盖服务端可能的任意落点
    for m in re.finditer(r"-", base):
        variants.add(base[:m.start()] + ".-" + base[m.start() + 1:] + "." + ext)
    return variants


def main():
    failures = 0
    releases = gitee_releases()
    print("Gitee 共 %d 个 Release" % len(releases))

    with tempfile.TemporaryDirectory(prefix="gitee-asset-") as tmp:
        for rel in releases:
            tag, name, body = rel["tag_name"], rel.get("name") or rel["tag_name"], rel.get("body") or ""
            prerelease = bool(rel.get("prerelease"))
            try:
                gh = gh_release_by_tag(tag)
                if gh is None:
                    print("＋ 创建 Release %s" % tag)
                    if not DRY_RUN:
                        gh = http("POST",
                                  "https://api.github.com/repos/%s/releases" % REPO,
                                  {"tag_name": tag, "name": name, "body": body,
                                   "draft": False, "prerelease": prerelease})
                    else:
                        gh = {"id": 0, "assets": []}
                else:
                    print("＝ Release %s 已存在（id=%s）" % (tag, gh["id"]))

                gh_assets = gh.get("assets", [])
                existing = {a["name"]: a for a in gh_assets}
                for asset_name, dl_url in wanted_assets(rel):
                    target_name = ascii_asset_name(asset_name)
                    if target_name in existing:
                        print("    · 资产已存在：%s" % target_name)
                        continue
                    # 自愈：删掉中文被吃后留下的残缺名资产（如 DSH.-companion-...）
                    for bad in broken_variants(target_name):
                        if bad in existing:
                            print("    🧹 删除残缺名资产：%s → %s" % (bad, target_name))
                            if not DRY_RUN:
                                http("DELETE",
                                     "https://api.github.com/repos/%s/releases/assets/%s"
                                     % (REPO, existing[bad]["id"]))
                    print("    ↓ 下载：%s" % asset_name)
                    with urllib.request.urlopen(dl_url, timeout=300) as dl:
                        blob = dl.read()
                    if len(blob) > MAX_ASSET_BYTES:
                        print("    ::warning::超过 2GiB，跳过：%s" % asset_name)
                        continue
                    if not DRY_RUN:
                        dest = os.path.join(tmp, target_name)
                        with open(dest, "wb") as f:
                            f.write(blob)
                        with open(dest, "rb") as f:
                            payload = f.read()
                        # name 必须全 ASCII（见 ascii_asset_name 注释），故 quote 后仍全 ASCII
                        up = ("https://uploads.github.com/repos/%s/releases/%s/assets?name=%s"
                              % (REPO, gh["id"], urllib.parse.quote(target_name)))
                        http("POST", up, body=payload, raw=True,
                             headers={"Content-Type": "application/octet-stream"})
                    shown = target_name if target_name != asset_name else asset_name
                    print("    ↑ 已上传：%s（%d 字节）%s"
                          % (shown, len(blob),
                             "" if shown == asset_name else "（Gitee 原名：%s）" % asset_name))
            except Exception as e:  # 单个失败不拖垮其余
                failures += 1
                print("::error::%s 同步失败：%r" % (tag, e))

    if failures:
        sys.exit("有 %d 个 Release 同步失败" % failures)
    print("✅ Release 回填完成（DRY_RUN=%s）" % DRY_RUN)


if __name__ == "__main__":
    main()
