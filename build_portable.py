"""构建静态站点根文档 index.html。

数据不再内联：药价、历史处方等业务数据一律从 Supabase 读取。
本脚本只把 rx_local.html 统一标题/防缓存头后写成 index.html。
用法：python3 build_portable.py
"""
import io, os, re

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'rx_local.html')
INDEX = os.path.join(BASE, 'index.html')

html = io.open(SRC, encoding='utf-8').read()

# 防缓存：避免浏览器/CDN 拿旧的 index.html
NOCACHE = ('<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">\n'
           '<meta http-equiv="Pragma" content="no-cache">\n'
           '<meta http-equiv="Expires" content="0">\n')
if 'http-equiv="Cache-Control"' not in html:
    html = html.replace('<head>', '<head>\n' + NOCACHE, 1)

# 标题：强制统一为「阿田药方打印」
html = re.sub(r'<title>.*?</title>', '<title>阿田药方打印</title>', html, count=1)
html = html.replace('药方单子打印系统 ·便携版（单文件·零 token）', '阿田药方打印')
html = html.replace('药方单子打印系统 · 离线版（零 token）', '阿田药方打印')
html = html.replace('药方单子打印系统 · 离线版', '阿田药方打印')

io.open(INDEX, 'w', encoding='utf-8').write(html)

print('已生成 index.html（%.2f MB）' % (os.path.getsize(INDEX) / 1024 / 1024))
print('数据来源：Supabase（不再内联 drugs_data.js / history_data.js）')
