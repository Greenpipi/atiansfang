# 阿田药方打印

纯前端中药处方 / 打印工具。**所有业务数据只存 Supabase，不写浏览器本地存储。**

## 数据准则
- 药方、客户、药价、库存、地址、常用备注、进货单、打印订单等全部从 Supabase 读写。
- 云端没有数据时页面显示为空，不回退到 `drugs_data.js` / `history_data.js` 内置数据。
- 本机浏览器只保留防缓存等技术标记；业务键会在升级时一次性迁移上云后删除。

## 仓库内容
- `rx_local.html` —— 主源码，日常改这个
- `build_portable.py` —— 构建：把 `rx_local.html` 写成 `index.html`
- `index.html` —— 构建产物 / GitHub Pages 根文档
- `drugs_data.js` / `history_data.js` —— 历史归档文件，**页面已不再加载**
- `supa_client.js` —— 早期独立 Supabase 客户端备份（页面内置了新版，不参与运行）
- `favicon/`、`favicon.png`、`icon-512.png`、`apple-touch-icon.png` —— 站点图标
- `publish.sh` / `deploy_github.py` —— 旧发布脚本（当前以 git push 为准）

## 本地构建
    python3 build_portable.py

## 发布到线上
    git add .
    git commit -m "更新说明"
    git push
线上地址：https://greenpipi.github.io/atiansfang/

每次上线后请用 `?_rv=时间戳` 打开一次强制刷新，例如：
    https://greenpipi.github.io/atiansfang/?_rv=20261031

## 跨设备协作
同一仓库，改完 push、另一台 pull 即可。
