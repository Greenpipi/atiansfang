# 阿田药方打印

纯前端单文件中药处方 / 打印工具，云端同步走 Supabase。

## 仓库内容（用于编辑 / 构建）
- `rx_local.html` —— 主源码（界面、WPlan 模块等），日常改这个
- `build_portable.py` —— 构建：把 `rx_local.html` + `drugs_data.js` + `history_data.js` 内联打包成单文件
- `drugs_data.js` —— 药价目录（1039 味）
- `history_data.js` —— 历史处方（5650 条，构建时内联，约 2.8MB）
- `supa_client.js` —— Supabase 客户端
- `favicon/` —— 图标源文件（构建时内嵌进页面）
- `favicon.png` / `icon-512.png` / `apple-touch-icon.png` —— 站点图标
- `publish.sh` —— 一键发布（构建 → 部署）
- `deploy_github.py` —— 部署到 GitHub Pages（GitHub API 推送 `site/`）

## 本地构建
    python3 build_portable.py
生成 `index.html`（静态根文档）。

## 发布到线上
    bash publish.sh
部署需要 GitHub Token（二选一）：
    1) 环境变量：GH_TOKEN=ghp_xxx bash publish.sh
    2) 脚本目录放 `.github_token`（仅一行 PAT）
线上地址：https://greenpipi.github.io/atiansfang/

## 跨设备协作（Windows 工作室 <-> Mac 家用）
同一仓库，改完 push、另一台 pull 即可。
Mac 首次：
    git clone https://github.com/Greenpipi/atiansfang.git
    cd atiansfang
    # 改 rx_local.html ...
    python3 build_portable.py
    bash publish.sh
注意：本仓库用 GitHub API 部署（非 git push），clone 下来没有 `site/` 与构建产物，需本地构建。
