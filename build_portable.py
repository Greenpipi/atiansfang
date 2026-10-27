"""把 rx_local.html + drugs_data.js + history_data.js 合并成单个便携 HTML。
用法：python build_portable.py
产物：rx_portable.html（数据已内嵌，单独拷走即可用）"""
import re, os, io, hashlib

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'rx_local.html')
DRUGS = os.path.join(BASE, 'drugs_data.js')
HIST = os.path.join(BASE, 'history_data.js')
OUT = os.path.join(BASE, 'rx_portable.html')

html = io.open(SRC, encoding='utf-8').read()
drugs = io.open(DRUGS, encoding='utf-8').read()
hist = io.open(HIST, encoding='utf-8').read()

# 去掉两个外链 script，换成内联
tag_pair = '<script src="drugs_data.js"></script>\n<script src="history_data.js"></script>'
if tag_pair not in html:
    # 容错：允许中间有空白差异
    pat = re.compile(r'<script\s+src="drugs_data\.js"\s*></script>\s*<script\s+src="history_data\.js"\s*></script>')
    m = pat.search(html)
    if not m:
        raise SystemExit('未找到 drugs_data.js / history_data.js 的 script 引用，模板可能已改动')
    tag_span = m.group(0)
else:
    tag_span = tag_pair

inline = '<script>\n' + drugs + '\n</script>\n<script>\n' + hist + '\n</script>'
html = html.replace(tag_span, inline)

# ---- favicon 内嵌 ----
# 单文件版要能双击使用，图标必须内嵌成 data URI，否则离线时没有图标。
# 只内嵌 32/180/192 三个尺寸；192 有 43KB base64，只在<link> 里出现一次。
import base64
FAV = os.path.join(BASE, 'favicon')
def fav_data(name):
    p = os.path.join(FAV, name)
    if not os.path.exists(p):
        return ''
    return 'data:image/png;base64,' + base64.b64encode(
        open(p, 'rb').read()).decode('ascii')
for token, fname in (('ICON32', 'icon-32.png'),
                     ('ICON192', 'icon-192.png'),
                     ('ICON180', 'icon-180.png')):
    d = fav_data(fname)
    if d:
        html = html.replace(token, d)
    else:
        print('  ! 缺少 favicon/%s，图标链接将失效' % fname)

# 防缓存：避免浏览器/CDN 拿旧的 index.html（曾导致打开链接看到旧残页）
NOCACHE = ('<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">\n'
           '<meta http-equiv="Pragma" content="no-cache">\n'
           '<meta http-equiv="Expires" content="0">\n')
if 'http-equiv="Cache-Control"' not in html:
    html = html.replace('<head>', '<head>\n' + NOCACHE, 1)

# 标题：强制统一为「阿田药方打印」，不加任何后缀/括号/说明（用户要求）
html = re.sub(r'<title>.*?</title>', '<title>阿田药方打印</title>', html, count=1)
# 兜底：清掉品牌区/注释里可能残留的旧标题文案
html = html.replace('药方单子打印系统 ·便携版（单文件·零 token）', '阿田药方打印')
html = html.replace('药方单子打印系统 · 离线版（零 token）', '阿田药方打印')
html = html.replace('药方单子打印系统 · 离线版', '阿田药方打印')

# ---- 版本戳：解决「浏览器/CDN 缓存旧页面」----
# meta no-cache 对 CDN 无效（2026-10-06 实测：用户拿到旧页面，药价全0、历史处方空白）。
# 做法：内容哈希当版本号写进页面；启动时与 localStorage 记录比对，
# 不一致就强制 reload 一次并带 _rv=<版本>，这是全新 URL，必然绕过 CDN 缓存。
# ⚠️ 必须插在 <meta charset> 之后：CDN 不回 charset，浏览器只嗅探前 1024 字节，
# charset 被挤到后面会回退系统默认编码、页面前段中文乱码。
BUILD_ID = hashlib.md5(html.encode('utf-8')).hexdigest()[:10]
STAMP = (
    '<script>\n'
    '(function(){\n'
    '  var V=%r;\n'
    '  try{\n'
    '    var old=localStorage.getItem("rx_build_ver");\n'
    '    if(old && old!==V && !sessionStorage.getItem("rx_reloaded")){\n'
    '      sessionStorage.setItem("rx_reloaded","1");\n'
    '      var u=new URL(location.href); u.searchParams.set("_rv",V);'
    ' location.replace(u.toString()); return;\n'
    '    }\n'
    '    localStorage.setItem("rx_build_ver",V);\n'
    '  }catch(e){}\n'
    '})();\n'
    '</script>\n' % BUILD_ID
)
m_charset = re.search(r'<meta\s+charset=["\']?utf-8["\']?\s*/?>', html, re.I)
if m_charset:
    html = html[:m_charset.end()] + '\n' + STAMP + html[m_charset.end():]
else:
    html = html.replace('<head>', '<head>\n' + STAMP, 1)

io.open(OUT, 'w', encoding='utf-8').write(html)

# 同时把完整应用写成 index.html，作为静态站点根文档（避免打开链接只看到旧残页）
INDEX = os.path.join(BASE, 'index.html')
io.open(INDEX, 'w', encoding='utf-8').write(html)

size = os.path.getsize(OUT)
n_drug = len(re.findall(r'"n":', drugs))
n_hist = len(re.findall(r'"no":', hist))
print('已生成单文件便携版：rx_portable.html')
print('大小：%.2f MB' % (size / 1024 / 1024))
print('内嵌药价目录 %d 条，历史处方 %d 条' % (n_drug, n_hist))
print('原始三件套：rx_local.html + drugs_data.js + history_data.js')
print('同时已写入 index.html（静态根文档，打开链接即为完整应用）')
print('现在只需拷 rx_portable.html 一个文件到 Mac 即可使用')
