# -*- coding: utf-8 -*-
"""以远端最新版为基座，重新装回进货单（月度大订单）模块，并对齐【订单详情】新控件：
折叠箭头 wp-fold、圆形减号 wp-minus、摘要文案、块体 wp-block-body"""
import io, re

REMOTE = '.tmp/remote_rx.html'
MYSEC = '.tmp/sec_mine.html'
MYMOD = '.tmp/mod_mine.js'
OUT = '/workspace/rx_local.html'

base = io.open(REMOTE, encoding='utf-8').read()
sec = io.open(MYSEC, encoding='utf-8').read()
mod = io.open(MYMOD, encoding='utf-8').read()

# ---------- 1. 页面段 ----------
i = base.find('id="purchaseRoot"')
j = base.rfind('<section', 0, i)
k = base.find('</section>', i) + len('</section>')
base = base[:j] + sec + base[k:]
print('页面段已替换')

# ---------- 2. 模块对齐新控件 ----------
mod = mod.replace(
    "var S={orders:[], cur:null, sub:'list', search:'', log:[], del:null, pending:null, missing:[]};",
    "var S={orders:[], cur:null, sub:'list', search:'', log:[], del:null, pending:null, missing:[], fold:{}};", 1)

mod = mod.replace(
    "  function batches(){ return batchesOf(S.cur); }",
    "  function batches(){ return batchesOf(S.cur); }\n"
    "  function isFolded(dt){ return !!S.fold[String(dt)]; }\n"
    "  function toggleFold(dt){ dt=String(dt); S.fold[dt]=!S.fold[dt]; renderBlocks(); }", 1)

# 块头：折叠箭头 + 标题 + 日期 + 摘要（与药方详情同排版）
old_head = """      return '<div class="wp-block">'
        +'<div class="wp-block-head">'
          +'<input class="wp-block-title" readonly value="小订单 '+(bi+1)+'" title="按进货日期自动拆分">'
"""
new_head = """      return '<div class="wp-block'+(isFolded(b.dt)?' folded':'')+'">'
        +'<div class="wp-block-head">'
          +'<button class="wp-fold" type="button" title="折叠 / 展开该小订单" onclick="Purchase.toggleFold(\\''+esc(b.dt)+'\\')"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 4.2 L6 8 L9.8 4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'
          +'<input class="wp-block-title" readonly value="小订单 '+(bi+1)+'" title="按进货日期自动拆分">'
"""
assert old_head in mod
mod = mod.replace(old_head, new_head, 1)

old_sum = """+'<span class="wp-sub wp-sub-sum">本单合计 <b class="pur-bat-total" data-dt="'+esc(b.dt)+'">¥'+fmt2(sum)+'</b></span>'"""
new_sum = """+'<span class="wp-sub wp-sub-sum">合计 <b class="pur-bat-total" data-dt="'+esc(b.dt)+'">¥'+fmt2(sum)+'</b> · '+b.items.length+' 味</span>'"""
assert old_sum in mod
mod = mod.replace(old_sum, new_sum, 1)

# 工具条 + 表格包进 wp-block-body，折叠时一起收起
mod = mod.replace("""        +'<div class="wp-block-tools">'""",
                  """        +'<div class="wp-block-body">'
        +'<div class="wp-block-tools">'""", 1)
mod = mod.replace("""          +'<tbody>'+rows+'</tbody></table></div>'
        +'</div>';""",
                  """          +'<tbody>'+rows+'</tbody></table></div>'
        +'</div>'
        +'</div>';""", 1)

# 行内删除：与药方详情一致的圆形减号
old_del = """+'<td class="row-act"><button type="button" class="btn danger sm" onclick="Purchase.delItem('+i+')">删除</button></td>'"""
new_del = """+'<td class="row-act"><button class="wp-minus" type="button" title="删除这一行" onclick="Purchase.delItem('+i+')"><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></td>'"""
assert old_del in mod
mod = mod.replace(old_del, new_del, 1)

mod = mod.replace("addBatch:addBatch, delBatch:delBatch, setBatchDate:setBatchDate,",
                  "addBatch:addBatch, delBatch:delBatch, setBatchDate:setBatchDate, toggleFold:toggleFold,", 1)

# ---------- 3. 换回模块 ----------
mi = base.find('var Purchase = (function(){')
mj = base.find('\n})();', mi) + len('\n})();')
base = base[:mi] + mod + base[mj:]
print('模块已替换')

# ---------- 4. 打印页皮肤扩展到进货单 ----------
a = base.index('<style id="skinA-print">')
b = base.index('</style>', a)
skin = base[a:b]
cnt = skin.count('.page[data-page="print"] .wplan')
skin = skin.replace('.page[data-page="print"] .wplan',
                    ':is(.page[data-page="print"],.page[data-page="purchase"]) .wplan')
base = base[:a] + skin + base[b:]
print('皮肤选择器替换', cnt)

io.open(OUT, 'w', encoding='utf-8').write(base)
print('rx_local.html 已重建', len(base))
