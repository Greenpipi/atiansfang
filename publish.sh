#!/bin/bash
# =====================================================================
#  阿田药方打印 · 一键发布（跨平台：Windows / macOS）
#
#  作用：把最新代码构建并部署到 GitHub Pages（Greenpipi/atiansfang）。
#  用法：改完 rx_local.html 后执行
#        bash publish.sh
#
#  ⚠️ 关键点（跨设备必读）：
#    - 脚本自动定位自身所在目录，不再写死 Windows 路径
#    - Python 用环境变量 $PY，未设置则回退到 python3（macOS 自带）
#    - 部署走 deploy_github.py（GitHub API），本机 git 走代理会被拦，故不用 git push
#  线上链接固定为 https://greenpipi.github.io/atiansfang/
# =====================================================================
set -e

# 定位脚本目录（跨平台，避免写死 /e/Workbuddy/...）
cd "$(dirname "$0")"

# Python：优先用环境变量，否则用系统 python3
PY="${PY:-python3}"

echo "[1/3] 构建单文件…"
"$PY" build_portable.py

echo "[2/3] 同步到发布目录 site/…"
mkdir -p site
cp index.html site/index.html
cp favicon.png          site/favicon.png
cp icon-512.png         site/icon-512.png
cp apple-touch-icon.png site/apple-touch-icon.png

echo "      site/index.html = $(wc -c < site/index.html) 字节"

# 备份（不参与发布，放在 site/ 外；已 gitignore）
STAMP=$(date +%Y%m%d_%H%M)
mkdir -p _backup
cp index.html "_backup/index_${STAMP}_发布.html"
cp rx_local.html "_backup/rx_local_${STAMP}_发布.html"

echo "[3/3] 部署到 GitHub Pages（Greenpipi/atiansfang）…"
"$PY" deploy_github.py
echo
echo "完成。线上链接："
echo "  https://greenpipi.github.io/atiansfang/"
echo
echo "提醒：浏览器强制刷新（Ctrl+F5 / Cmd+Shift+R）清掉旧缓存；Token 见 deploy_github.py 顶部说明。"