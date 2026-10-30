#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阿田药方打印 · 部署到 GitHub Pages
通过 GitHub Git Data API 推送（本机 git 走代理会被拦，故用 curl API）。
用法：
    python3 deploy_github.py
Token 来源（任选其一）：
    1) 环境变量  GH_TOKEN=ghp_xxx
    2) 本目录文件  .github_token  （仅一行，放 PAT）
"""
import os
import sys
import json
import base64
import subprocess

REPO = "Greenpipi/atiansfang"
API = f"https://api.github.com/repos/{REPO}"
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "site")


def get_token():
    t = os.environ.get("GH_TOKEN")
    if t:
        return t.strip()
    p = os.path.join(HERE, ".github_token")
    if os.path.exists(p):
        return open(p, "r", encoding="utf-8").read().strip()
    sys.exit("缺少 GitHub Token：请设置环境变量 GH_TOKEN，或在脚本目录放 .github_token 文件（仅一行 PAT）。")


def api(method, path, data=None):
    token = get_token()
    cmd = ["curl", "-sS", "-X", method, f"{API}{path}",
           "-H", f"Authorization: Bearer {token}",
           "-H", "Accept: application/vnd.github+json"]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", "@-"]
        r = subprocess.run(cmd, input=json.dumps(data), capture_output=True, text=True)
    else:
        r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"curl failed: {r.stderr}")
    out = r.stdout.strip()
    if not out:
        return None
    try:
        j = json.loads(out)
    except Exception:
        sys.exit(f"bad json from {path}: {out[:300]}")
    # GitHub 业务错误
    if isinstance(j, dict) and "message" in j and "documentation_url" in j:
        # Pages 已开启会报冲突，属正常，可忽略
        if "Pages" in j.get("message", "") or j.get("status") in (409,):
            return j
        sys.exit(f"github api error on {path}: {j['message']}")
    return j


def main():
    if not os.path.isdir(SITE):
        sys.exit(f"找不到 site/ 目录：{SITE}，请先运行 build_portable.py 生成。")

    print("== 读取 main 分支 ==")
    main_sha = api("GET", "/git/refs/heads/main")["object"]["sha"]
    base_tree = api("GET", f"/git/commits/{main_sha}")["tree"]["sha"]
    existing = {e["path"]: e["sha"] for e in api("GET", f"/git/trees/{base_tree}?recursive=1")["tree"]}
    print("仓库现有文件：", list(existing.keys()))

    uploads = {
        "index.html": os.path.join(SITE, "index.html"),
        "favicon.png": os.path.join(SITE, "favicon.png"),
        "icon-512.png": os.path.join(SITE, "icon-512.png"),
        "apple-touch-icon.png": os.path.join(SITE, "apple-touch-icon.png"),
        ".nojekyll": None,
    }
    # 源码也一起推：否则线上被改、仓库源码还是旧的，另一台机器 pull 下来会把改动盖掉
    # （2026-10-30 踩过：新药物详情是从旧 rx_local.html 改的，把打印模板整块覆盖没了）
    SRCS = ["rx_local.html", "build_portable.py", "deploy_github.py", "publish.sh",
            "supa_client.js", "drugs_data.js"]
    for name in SRCS:
        fp = os.path.join(HERE, name)
        if os.path.exists(fp) and os.path.getsize(fp) < 2 * 1024 * 1024:
            uploads[name] = fp
    entries = []
    if "README.md" in existing:
        entries.append({"path": "README.md", "mode": "100644", "type": "blob", "sha": existing["README.md"]})

    for path, fp in uploads.items():
        if fp:
            raw = open(fp, "rb").read()
            b64 = base64.b64encode(raw).decode()
            print(f"  blob {path} ({len(raw)} bytes)")
        else:
            b64 = ""
            print(f"  blob {path} (empty)")
        blob = api("POST", "/git/blobs", {"content": b64, "encoding": "base64"})
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})

    print("== 组装 tree ==")
    new_tree = api("POST", "/git/trees", {"base_tree": base_tree, "tree": entries})["sha"]
    print("== 提交 ==")
    new_commit = api("POST", "/git/commits",
                     {"message": "deploy 阿田药方打印", "tree": new_tree, "parents": [main_sha]})["sha"]
    print("== 更新 main ==")
    api("PATCH", "/git/refs/heads/main", {"sha": new_commit})
    print("== 已推送 ==")

    print("== 确保 Pages 已开启 ==")
    res = api("POST", "/pages", {"source": {"branch": "main", "path": "/"}})
    print("Pages：", res.get("html_url") if isinstance(res, dict) else res)

    print()
    print("线上链接： https://greenpipi.github.io/atiansfang/")
    print("提醒：浏览器强制刷新（Ctrl+F5）清掉旧缓存。")


if __name__ == "__main__":
    main()
