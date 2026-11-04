# -*- coding: utf-8 -*-
"""进货单详情页 / 列表页 复用【药方打印】皮肤与表单结构"""
import io, re

P = '/workspace/rx_local.html'
src = io.open(P, encoding='utf-8').read()

# ---------- 1. 打印页皮肤扩展到进货单页 ----------
a = src.index('<style id="skinA-print">')
b = src.index('</style>', a)
skin = src[a:b]
n_before = skin.count('.page[data-page="print"] .wplan')
skin2 = skin.replace('.page[data-page="print"] .wplan',
                      ':is(.page[data-page="print"],.page[data-page="purchase"]) .wplan')
assert skin2.count('is(.page[data-page') == n_before, (skin2.count('is(.page'), n_before)
src = src[:a] + skin2 + src[b:]
print('皮肤选择器替换', n_before)

# ---------- 2. 替换 renderBlocks ----------
old_start = src.index('  function renderBlocks(){\n    var box=$(\'purBlocks\')')
old_end = src.index('  function renderFoot(){', old_start)
new_blocks = r'''  function addItemAfter(dt,i){
    if(!S.cur) return;
    var idx=(typeof i==='number'&&i>=0)?i:S.cur.items.length-1;
    var it=S.cur.items[idx]||{};
    S.cur.items.splice(idx+1,0,{dt:String(dt||itemDt(it)).slice(0,10), name:'', qty:'', unit:String(it.unit||'g'), cost:'', amount:0});
    renderBlocks(); renderFoot();
  }
  /* 单位候选：这味药已有的规格单位 + 常用单位（进货价按 kg 计，所以 kg 必须可选） */
  function unitOptsFor(it,d){
    var us=[], def=['g','kg','斤','个','条','盒','罐','包','瓶'];
    if(d){
      var mu=String(d.u||'g');
      if(mu && us.indexOf(mu)<0) us.push(mu);
      (d.un||[]).forEach(function(x){ var u=String((x||{}).unit||''); if(u && us.indexOf(u)<0) us.push(u); });
    }
    def.forEach(function(u){ if(us.indexOf(u)<0) us.push(u); });
    var cur=String(it.unit||'g');
    if(us.indexOf(cur)<0) us.unshift(cur);
    return us;
  }
  /* 表格结构 / 字段顺序 / 类名与【药方打印】订单详情一致 */
  function renderBlocks(){
    var box=$('purBlocks'); if(!box) return;
    var bs=batches();
    if(!bs.length){
      box.innerHTML='<div class="wp-empty">还没有小订单。点下方「+ 添加小订单（按进货日期）」开始录单。</div>';
      return;
    }
    box.innerHTML=bs.map(function(b,bi){
      var sum=0;
      b.items.forEach(function(it){ sum+=(parseFloat(it.qty)||0)*(parseFloat(it.cost)||0); });
      var rows=b.items.map(function(it){
        var i=S.cur.items.indexOf(it);
        var d=findDrug(it.name), cur=String(it.unit||'g');
        var tag='';
        if(it.name){
          if(!d) tag='<span class="wp-std pur-bad">库里无此药</span>';
          else if(!hasUnit(d,cur)) tag='<span class="wp-std pur-bad">无「'+esc(cur)+'」单位</span>';
          else tag='<span class="wp-std">库存 '+esc(String(stockOf(d,cur)))+'</span>';
        }
        var prod='', bb=baseOf(it.name);
        if(bb){
          var lc=latestCost(bb.name);
          if(lc!=null) prod='<button type="button" class="pur-prod" data-cost="'+esc(String(lc))+'" title="把最近一次「'+esc(bb.name)+'」的进货价（'+fmt2(lc)+'）填进来">生品价 '+fmt2(lc)+'</button>';
        }
        var tags=(tag||prod)?'<span class="wp-nm-tags">'+tag+prod+'</span>':'';
        var cls='wp-nm-wrap no-detail'+((tag||prod)?' has-std':'');
        var uOpts=unitOptsFor(it,d);
        return '<tr data-i="'+i+'">'
          +'<td class="wp-plus-td"><button class="wp-plus" type="button" title="在下方新增一行" onmousedown="return false" onclick="Purchase.addItemAfter(\''+esc(b.dt)+'\','+i+')"><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><line x1="6" y1="1.5" x2="6" y2="10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="1.5" y1="6" x2="10.5" y2="6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></td>'
          +'<td><div class="'+cls+'"><input class="wp-nm" list="purchaseDrugList" value="'+esc(it.name||'')+'" placeholder="药名 / 拼音" autocomplete="off">'+tags+'</div></td>'
          +'<td><div class="wp-qty-cell"><input class="num wp-qty" inputmode="decimal" value="'+esc(it.qty||'')+'" placeholder="数量"><input class="wp-unit-in" data-ddoptions="'+esc(JSON.stringify(uOpts))+'" value="'+esc(cur)+'" title="单位"></div></td>'
          +'<td style="text-align:center"><input class="num wp-price" inputmode="decimal" value="'+esc(it.cost||'')+'" placeholder="元/kg"></td>'
          +'<td class="wp-amt">'+fmt2(it.amount||0)+'</td>'
          +'<td class="wp-rm-td"><input class="wp-rm-in" placeholder="备注（选填）"></td>'
          +'<td class="row-act"><button type="button" class="btn danger sm" onclick="Purchase.delItem('+i+')">删除</button></td>'
          +'</tr>';
      }).join('');
      return '<div class="wp-block">'
        +'<div class="wp-block-head">'
          +'<input class="wp-block-title" readonly value="小订单 '+(bi+1)+'" title="按进货日期自动拆分">'
          +'<label class="wp-bi">进货日期 <input class="bi-in cal-input" type="text" readonly data-cal-mode="day" data-dt="'+esc(b.dt)+'" data-date="'+esc(b.dt)+'" value="'+esc(b.dt)+'" placeholder="选择日期" onchange="Purchase.setBatchDate(this)"></label>'
          +'<span class="wp-sub wp-sub-sum">本单合计 <b class="pur-bat-total" data-dt="'+esc(b.dt)+'">¥'+fmt2(sum)+'</b></span>'
          +'<span class="spacer"></span>'
          +'<button type="button" class="btn danger sm" onclick="Purchase.delBatch(\''+esc(b.dt)+'\')">删除小订单</button>'
        +'</div>'
        +'<div class="wp-block-tools">'
          +'<button type="button" class="btn sm" onclick="Purchase.addItem(\''+esc(b.dt)+'\')">+ 增加一味药</button>'
          +'<button type="button" class="btn sm" onclick="Purchase.addBatch()">+ 再加一个小订单</button>'
        +'</div>'
        +'<div class="wp-tbl-wrap"><table class="wp-tbl">'
          +'<colgroup><col class="c-plus"><col style="width:29%"><col style="width:172px"><col style="width:104px"><col style="width:104px"><col><col class="c-act"></colgroup>'
          +'<thead><tr><th></th><th>药名 / 耗材名</th><th>数量 · 单位</th><th style="text-align:center">进货单价</th><th style="text-align:right">金额</th><th>备注</th><th></th></tr></thead>'
          +'<tbody>'+rows+'</tbody></table></div>'
        +'</div>';
    }).join('');
    var trs=box.querySelectorAll('tr[data-i]');
    for(var r=0;r<trs.length;r++){
      (function(tr){
        var i=+tr.getAttribute('data-i');
        var name=tr.querySelector('.wp-nm'), qty=tr.querySelector('.wp-qty'), unit=tr.querySelector('.wp-unit-in'), cost=tr.querySelector('.wp-price');
        function upd(){
          var it=S.cur.items[i]; if(!it) return;
          it.name=name.value; it.qty=qty.value; it.unit=unit.value; it.cost=cost.value;
          recalc();
          var amtTd=tr.querySelector('.wp-amt');
          if(amtTd) amtTd.textContent=fmt2(it.amount||0);
        }
        name.oninput=upd;
        name.onchange=function(){ upd(); renderBlocks(); };
        unit.onchange=function(){ upd(); renderBlocks(); };
        qty.oninput=upd; cost.oninput=upd;
        var prod=tr.querySelector('.pur-prod');
        if(prod){ prod.onclick=function(e){
          e.preventDefault();
          var v=parseFloat(prod.getAttribute('data-cost'));
          if(!isFinite(v)) return;
          cost.value=String(v); cost.dispatchEvent(new Event('input'));
          try{ cost.focus(); }catch(e2){}
          toast('已带入生品进价 '+fmt2(v)+'，可直接改');
        }; }
      })(trs[r]);
    }
    recalc();
  }
'''
src = src[:old_start] + new_blocks + src[old_end:]
print('renderBlocks 已替换')

# ---------- 3. 替换 renderList ----------
ls = src.index('  function renderList(){', src.index('var Purchase = (function(){'))
le = src.index('  return { ensure:ensure', ls)
new_list = r'''  function renderList(){
    var box=$('purList'); if(!box) return;
    var list=S.orders.slice().sort(function(a,b){ return monthOf(a)<monthOf(b)?1:-1; });
    var f=(S.search||'').toLowerCase();
    if(f){
      list=list.filter(function(o){
        var st=wasStocked(o.no)?'已入库':'未入库';
        return (monthLabel(monthOf(o))+o.no+st).toLowerCase().indexOf(f)>=0;
      });
    }
    var cnt=$('purListCount'); if(cnt) cnt.textContent=list.length?('共 '+list.length+' 个月'):'';
    if(!list.length){ box.innerHTML='<div class="wp-list-empty">还没有进货单，点右上「新建 / 录单」开始。</div>'; return; }
    box.innerHTML=list.map(function(o){
      var its=(o.items||[]).filter(function(it){ return String(it.name||'').trim(); });
      var bs=batchesOf(o), stocked=wasStocked(o.no);
      var names=its.slice(0,4).map(function(it){ return esc(it.name); }).join('、')+(its.length>4?' 等':'');
      return '<div class="wp-plan-row" data-no="'+esc(o.no)+'" onclick="Purchase.editOrder(\''+esc(o.no)+'\')">'
        +'<div><div class="wp-plan-name">'+esc(monthLabel(monthOf(o)))+'</div>'
        +'<div class="wp-plan-sub">'+esc(o.no)+' · '+bs.length+' 个小订单 · '+its.length+' 味药'+(its.length?(' · '+names):'')+'</div></div>'
        +'<div class="wp-plan-num">'+bs.length+' 单</div>'
        +'<div class="wp-plan-amt">¥'+fmt2(o.total||0)+'</div>'
        +'<div class="wp-plan-act"><span class="wp-tag'+(stocked?'':' pur-undone')+'">'+(stocked?'已入库':'未入库')+'</span></div>'
        +'</div>';
    }).join('');
  }
'''
src = src[:ls] + new_list + src[le:]
print('renderList 已替换')

# ---------- 4. 导出 addItemAfter ----------
src = src.replace('  return { ensure:ensure, showSub:showSub, newOrder:newOrder, editOrder:editOrder, addItem:addItem, delItem:delItem,',
                  '  return { ensure:ensure, showSub:showSub, newOrder:newOrder, editOrder:editOrder, addItem:addItem, addItemAfter:addItemAfter, delItem:delItem,')

# ---------- 5. 进货单页补丁 CSS ----------
marker = '          .pur-msg{color:#c0392b;font-size:12px;margin-top:6px;min-height:14px}\n'
patch = marker + '''          /* ---- 沿用【药方打印】皮肤后的局部补丁（只作用于进货单） ---- */
          #purchaseRoot .wp-nm-wrap.has-std .wp-nm{ padding-right:162px; }
          #purchaseRoot .wp-nm-tags{ right:12px; max-width:calc(100% - 24px); }
          #purchaseRoot .wp-nm-tags .pur-prod{ pointer-events:auto; }
          #purchaseRoot .pur-prod{
            height:20px!important; min-height:0!important; padding:0 6px!important; margin:0!important;
            font-size:11px!important; font-weight:600!important; line-height:18px!important;
            color:#0B6E4D!important; background:#E7F7EF!important;
            border:1px solid #CFEADF!important; border-radius:5px!important; cursor:pointer; white-space:nowrap;
          }
          #purchaseRoot .pur-prod:hover{ background:#D8F0E2!important; }
          #purchaseRoot .wp-std.pur-bad{ background:#FBEDEB!important; color:#D25B4E!important; max-width:none!important; }
          #purchaseRoot .wp-block-title{ min-width:112px; cursor:default; }
          #purchaseRoot .wp-block-title:focus{ box-shadow:none!important; border-color:#D6E3DC!important; }
          #purchaseRoot .wp-plan-act .wp-tag{ font-weight:600; }
          #purchaseRoot .wp-plan-act .wp-tag.pur-undone{ background:#FCF4E4!important; border-color:#EEDDBB!important; color:#C08A2E!important; }
'''
assert marker in src
src = src.replace(marker, patch, 1)

io.open(P, 'w', encoding='utf-8').write(src)
print('写入完成')
