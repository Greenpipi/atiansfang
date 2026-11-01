var Purchase = (function(){
  /* 进货单：录单 → 库存累加 → 进价历史 → 建议价联动；删除可回滚库存。
     ⚠ 库存严格按「药名 + 单位」匹配：同一味药的 g 和 kg 是两条独立库存。 */
  var S={orders:[], cur:null, sub:'list', search:'', log:[], del:null, pending:null, missing:[]};
  function load(){
    /* 进货单 / 进价历史只从 Supabase 加载（见 ensure） */
    S.orders=[]; S.log=[];
  }
  /* 进货单写库由 SUPA.savePurchase / SUPA.addCostLog 完成，不再保存本地副本 */
  function saveLS(){}
  function saveLogLS(){}
  function fmt2(x){ x=parseFloat(x)||0; return x.toFixed(2); }
  function round2(x){ return Math.round((parseFloat(x)||0)*100)/100; }
  function autoNo(month){ return 'PF-'+(month||monthNow()); }
  function today(){ var d=new Date(); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
  function monthNow(){ return today().slice(0,7); }
  function monthOf(o){
    var m=String((o&&o.no)||'').match(/^PF-(\d{4}-\d{2})$/);
    if(m) return m[1];
    var dt=String((o&&o.dt)||'');
    return dt?dt.slice(0,7):'';
  }
  function findByMonth(m){
    for(var i=0;i<S.orders.length;i++){ if(monthOf(S.orders[i])===m) return S.orders[i]; }
    return null;
  }
  function monthLabel(m){
    var p=String(m||'').split('-');
    return p[0]?(p[0]+'年'+(p[1]||'')+'月'):String(m||'');
  }
  function wasStocked(no){
    var nm=String(no||'');
    if(!nm) return false;
    for(var i=0;i<S.log.length;i++){ if(String(S.log[i].purchase_no||'')===nm) return true; }
    return false;
  }
  function itemDt(it){
    var dt=String((it&&it.dt)||'').slice(0,10);
    return dt || (String(S.cur&&S.cur.month||monthNow())+'-01');
  }
  /* 本月按「进货日期」拆分小订单 */
  function batchesOf(o){
    if(!o) return [];
    var map={}, order=[];
    (o.items||[]).forEach(function(it){
      var dt=String(it.dt||'').slice(0,10) || (String(o.month||monthOf(o)||monthNow())+'-01');
      if(!map[dt]){ map[dt]=[]; order.push(dt); }
      map[dt].push(it);
    });
    order.sort();
    return order.map(function(dt){ return {dt:dt, items:map[dt]}; });
  }
  function batches(){ return batchesOf(S.cur); }
  function upsert(arr,rec){ for(var k=0;k<arr.length;k++){ if(arr[k].no===rec.no){ arr[k]=rec; return arr; } } arr.push(rec); return arr; }
  function findByNo(no){ for(var i=0;i<S.orders.length;i++){ if(S.orders[i].no===no) return S.orders[i]; } return null; }
  function findDrug(name){
    name=String(name==null?'':name).trim();
    if(!name) return null;
    for(var i=0;i<drugsList.length;i++){ if(drugsList[i].n===name) return drugsList[i]; }
    return null;
  }
  function hasUnit(d, unit){
    if(!d) return false;
    if(String(d.u||'g')===String(unit)) return true;
    var un=d.un||[];
    for(var i=0;i<un.length;i++){ if(String(un[i].unit)===String(unit)) return true; }
    return false;
  }
  function ensure(){
    load();
    renderList();
    if(!SUPA.on) return Promise.resolve();
    return Promise.all([
      SUPA.loadPurchases().catch(function(){ return []; }),
      SUPA.loadAllCostLogs().catch(function(){ return []; })
    ]).then(function(res){
      S.orders=(res&&res[0])||[];
      S.log=(res&&res[1])||[];
      renderList();
    });
  }
  function setSearch(v){ S.search=(v||''); renderList(); }
  function showSub(sub){
    S.sub=sub;
    var bs=document.querySelectorAll('#purchaseRoot .wp-sub');
    for(var i=0;i<bs.length;i++){ bs[i].classList.toggle('on', bs[i].getAttribute('data-sub')===sub); }
    var l=$('purSubList'), e=$('purSubEdit');
    if(l) l.style.display = sub==='list'?'':'none';
    if(e) e.classList.toggle('on', sub==='edit');
    if(sub==='list') renderList();
  }
  function newOrder(){
    var m=monthNow();
    var ex=findByMonth(m);
    if(ex){ editOrder(ex.no); return; }
    S.cur={no:autoNo(m), month:m, dt:m+'-01', supplier:'', items:[], note:'', total:0};
    S.cur.items.push({dt:today(), name:'',qty:'',unit:'g',cost:'',amount:0});
    renderEdit(); showSub('edit');
  }
  function editOrder(no){
    var o=findByNo(no); if(!o) return;
    var cp=JSON.parse(JSON.stringify(o));
    cp.month=monthOf(cp);
    cp.items=(cp.items||[]).map(function(it){
      var x=JSON.parse(JSON.stringify(it));
      x.dt=String(x.dt||'').slice(0,10) || (cp.month+'-01');
      x.amount=(parseFloat(x.qty)||0)*(parseFloat(x.cost)||0);
      return x;
    });
    if(!cp.items.length) cp.items.push({dt:cp.month+'-01', name:'',qty:'',unit:'g',cost:'',amount:0});
    cp._origNo=o.no;
    S.cur=cp;
    renderEdit(); showSub('edit');
  }
  function recalc(){
    var total=0;
    S.cur.items.forEach(function(it){ var q=parseFloat(it.qty)||0, c=parseFloat(it.cost)||0; it.amount=q*c; total+=it.amount; });
    var byDt={};
    S.cur.items.forEach(function(it){ var k=itemDt(it); byDt[k]=round2((byDt[k]||0)+(it.amount||0)); });
    var nodes=document.querySelectorAll('#purBlocks .pur-bat-total');
    for(var i=0;i<nodes.length;i++){
      var d=nodes[i].getAttribute('data-dt');
      nodes[i].textContent='¥'+fmt2(byDt[d]||0);
    }
    var t=$('purTotal'); if(t) t.textContent='¥'+fmt2(total);
    var bc=$('purBatchCnt'); if(bc) bc.textContent=String(batches().length);
    var ic=$('purItemCnt'); if(ic){ var n=0; S.cur.items.forEach(function(it){ if(String(it.name||'').trim()) n++; }); ic.textContent=String(n); }
    return total;
  }
  function fillDrugList(){
    var dl=$('purchaseDrugList'); if(!dl) return;
    dl.innerHTML=drugsList.map(function(d){ return '<option value="'+esc(d.n)+'">'; }).join('');
  }
  /* ---------- 加工品（炒 / 炙 / 焦…）找它的生品 ----------
     生品与加工品在药物库是两条独立记录（山药 / 炒山药），进价各自保存、互不影响。
     这里只负责认出「炒山药」→「山药」，好让用户一键把生品最近进价带过来改。 */
  var PROC_RE=/^(麸炒|土炒|砂炒|清炒|酒炒|醋炒|炒|炙|焦|醋|盐|酒|蜜|姜|煅|制|熟|蒸)(.+)$/;
  function baseOf(name){
    var nm=String(name||'').trim();
    if(!nm) return null;
    var m=nm.match(PROC_RE);
    if(!m) return null;
    var base=String(m[2]||'').replace(/^[（(\[【].*$/,'').trim();
    if(!base || base===nm) return null;
    var d=findDrug(base);
    if(!d) return null;
    return {name:base, d:d};
  }
  function addItemAfter(dt,i){
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
  function renderFoot(){
    var f=$('purFoot'); if(!f) return;
    var stocked=wasStocked(S.cur.no);
    f.innerHTML='<div class="wp-totals">'
      +'<div class="wp-line"><span>小订单（按进货日期）</span><b id="purBatchCnt">0</b></div>'
      +'<div class="wp-line"><span>药材品种</span><b id="purItemCnt">0</b></div>'
      +'<div class="wp-line wp-grand"><span>本月进货合计</span><b id="purTotal">¥0.00</b></div>'
      +'</div>'
      +'<div class="wp-foot-actions"><span class="wp-sub">'
      +(stocked?'本月已入库；再次入库会先扣回旧库存，再按当前单据重记。':'录完点「入库」写入库存与进货价。')
      +'</span><span class="spacer"></span>'
      +'<button class="btn" type="button" onclick="Purchase.showSub(\'list\')">返回</button>'
      +'<button class="btn pri" type="button" onclick="Purchase.saveOrder()">入库</button></div>';
    recalc();
  }
  function stockOf(d, unit){
    if(!d) return 0;
    if(String(d.u||'g')===String(unit) && (d.st!==''&&d.st!=null)) return parseFloat(d.st)||0;
    var un=d.un||[];
    for(var i=0;i<un.length;i++){ if(String(un[i].unit)===String(unit)) return parseFloat(un[i].stock)||0; }
    return 0;
  }
  function renderEdit(){
    var mo=$('purMonth'); if(mo) mo.value=S.cur.month||monthNow();
    var nv=$('purNoView'); if(nv) nv.value=S.cur.no||'';
    var st=$('purStatus'); if(st) st.value=wasStocked(S.cur.no)?'已入库':'未入库';
    var t=$('purTitle'); if(t) t.textContent=monthLabel(S.cur.month);
    var n=$('purNo'); if(n) n.textContent=S.cur.no||'';
    if(!S.cur.items||!S.cur.items.length){
      S.cur.items=[{dt:(S.cur.month||monthNow())+'-01', name:'',qty:'',unit:'g',cost:'',amount:0}];
    }
    renderBlocks(); renderFoot(); fillDrugList();
    var msg=$('purMsg'); if(msg) msg.textContent='';
  }
  function addItem(dt){
    if(!S.cur) return;
    var use=String(dt||'').slice(0,10);
    /* 加进已有小订单时，默认沿用该小订单里最后一味的单位 */
    var unit='g';
    S.cur.items.forEach(function(it){ if(use && itemDt(it)===use && it.unit) unit=it.unit; });
    S.cur.items.push({dt:use||(S.cur.month||monthNow())+'-01', name:'',qty:'',unit:unit,cost:'',amount:0});
    renderBlocks(); renderFoot();
  }
  function delItem(i){
    if(!S.cur) return;
    S.cur.items.splice(i,1);
    renderBlocks(); renderFoot();
  }
  /* 本月内找一个还没用过的小订单日期 */
  function nextBatchDate(){
    var m=S.cur.month||monthNow();
    var used=batches().map(function(b){ return b.dt; });
    var cand=today().slice(0,7)===m?today():m+'-01';
    var y=parseInt(m.slice(0,4),10), mm=parseInt(m.slice(5,7),10);
    var last=new Date(y,mm,0).getDate();
    for(var k=0;k<last;k++){
      if(used.indexOf(cand)<0) return cand;
      var n=new Date(cand+'T00:00:00');
      n.setDate(n.getDate()+1);
      cand=m+'-'+pad2(n.getDate());
    }
    return cand;
  }
  function addBatch(){
    if(!S.cur) return;
    S.cur.items.push({dt:nextBatchDate(), name:'',qty:'',unit:'g',cost:'',amount:0});
    renderBlocks(); renderFoot();
  }
  function delBatch(dt){
    if(!S.cur) return;
    var d=String(dt||'').slice(0,10);
    S.cur.items=S.cur.items.filter(function(it){ return itemDt(it)!==d; });
    renderBlocks(); renderFoot();
  }
  function setBatchDate(inp){
    if(!S.cur||!inp) return;
    var old=String(inp.getAttribute('data-dt')||'').slice(0,10);
    var v=String(inp.value||'').slice(0,10);
    var m=S.cur.month||monthNow();
    if(!v || v.slice(0,7)!==m){
      toastErr('小订单日期要在本月（'+monthLabel(m)+'）内');
      renderBlocks(); renderFoot(); return;
    }
    S.cur.items.forEach(function(it){ if(itemDt(it)===old) it.dt=v; });
    renderBlocks(); renderFoot();
  }
  function setMonth(v){
    if(!S.cur) return;
    v=String(v||'').slice(0,7);
    if(!v || v===S.cur.month){ renderEdit(); return; }
    var ex=findByMonth(v);
    if(ex && ex.no!==S.cur.no){
      S.cur=null;
      toast('该月已有进货单，已切换到 '+monthLabel(v));
      editOrder(ex.no); return;
    }
    var y=parseInt(v.slice(0,4),10), mm=parseInt(v.slice(5,7),10);
    var last=new Date(y,mm,0).getDate();
    var prev=S.cur.month;
    S.cur.items.forEach(function(it){
      var dd=parseInt(itemDt(it).slice(8,10),10)||1;
      if(dd>last) dd=last;
      it.dt=v+'-'+pad2(dd);
    });
    S.cur.month=v; S.cur.no=autoNo(v); S.cur.dt=v+'-01';
    if(prev!==v) toast('已改为 '+monthLabel(v)+'，单号 '+S.cur.no);
    renderEdit();
  }

  /* ---------- 保存 ---------- */
  function missingUnits(items){
    var out=[];
    items.forEach(function(it){
      var d=findDrug(it.name);
      if(!d) out.push({name:it.name, unit:it.unit, why:'药品库中还没有这味药'});
      else if(!hasUnit(d, it.unit)) out.push({name:it.name, unit:it.unit, why:'该药没有「'+it.unit+'」这个单位'});
    });
    return out;
  }
  function saveOrder(){
    if(!S.cur) return;
    var mo=$('purMonth'); if(mo && mo.value) S.cur.month=String(mo.value).slice(0,7);
    S.cur.no=autoNo(S.cur.month); S.cur.dt=S.cur.month+'-01';
    S.cur.supplier=''; S.cur.note='';
    S.cur.items=S.cur.items.filter(function(it){ return String(it.name||'').trim(); });
    var bad=[];
    S.cur.items.forEach(function(it){ if(!(parseFloat(it.qty)>0)||!(parseFloat(it.cost)>=0)) bad.push(it.name); });
    var m=$('purMsg'); if(m) m.textContent='';
    if(!S.cur.items.length){ if(m) m.textContent='请至少录入一味药材'; return; }
    if(bad.length){ if(m) m.textContent='有行的数量/单价没填好：'+bad.join('、'); return; }
    /* 严格按「药名 + 单位」匹配库存：库里没有就先问一句，绝不偷偷建药 */
    var miss=missingUnits(S.cur.items);
    if(miss.length){
      S.missing=miss; S.pending=S.cur;
      var ul=$('purNewList');
      if(ul) ul.innerHTML=miss.map(function(x){ return '<li>'+esc(x.name)+'（<b>'+esc(x.unit)+'</b>）— '+esc(x.why)+'</li>'; }).join('');
      openM('purNewModal');
      return;
    }
    commitSave();
  }
  function commitSave(){
    if(!S.cur) return;
    recalc();
    S.cur.total=0; S.cur.items.forEach(function(it){ S.cur.total+=it.amount; });
    /* 重复入库：先把旧单造成的库存与进价流水撤回，再按新内容重记，否则库存会翻倍 */
    var prev=findByNo(S.cur.no);
    if(prev && wasStocked(prev.no)) undoStock(prev);
    /* 改过月份：把旧月份那张单撤掉（否则同一个月会同时存在两张单、库存也会重复累加） */
    var orig=S.cur._origNo;
    if(orig && orig!==S.cur.no){
      var old=findByNo(orig);
      if(old){
        if(wasStocked(old.no)) undoStock(old);
        S.orders=S.orders.filter(function(x){ return x.no!==orig; });
        if(SUPA.on){ try{ SUPA.q('purchases?no=eq.'+encodeURIComponent(orig),{method:'DELETE'}).catch(function(){}); }catch(e){} }
      }
    }
    delete S.cur._origNo;
    S.orders=upsert(S.orders, S.cur); saveLS();
    S.cur.items.forEach(function(it){
      applyStock(it.name, it.unit, parseFloat(it.qty), parseFloat(it.cost), itemDt(it), '', S.cur.no);
    });
    var no=S.cur.no, label=monthLabel(S.cur.month);
    if(SUPA.on){
      var rec={no:no, dt:S.cur.month+'-01', supplier:'',
        items:S.cur.items.map(function(it){ return {name:it.name,qty:parseFloat(it.qty),unit:it.unit,cost:parseFloat(it.cost),amount:it.amount,dt:itemDt(it)}; }),
        total:S.cur.total, note:''};
      SUPA.savePurchase(rec).catch(function(e){ toastErr('进货单云端保存失败：'+e.message); });
    }
    toast(label+'进货单已入库，库存与进货价已更新');
    S.cur=null; showSub('list');
    try{ if(typeof renderDrugTable==='function') renderDrugTable(); }catch(e){}
  }
  /* 库存写云端失败：本机已改，云端没改 → 必须让人知道（只提示一次，别刷屏） */
  var _stockWarned=false;
  function warnStockCloud(e){
    console.warn('库存云端写入失败:', (e&&e.message)||e);
    if(_stockWarned) return;
    _stockWarned=true;
    try{ toastErr('库存已写本机，但云端同步失败：'+((e&&e.message)||'网络错误')+'（刷新后可能丢）'); }catch(e2){}
  }

  /* 库存写入（药名 + 单位）：只改这一条规格，不动同一味药的其它规格。
     ⚠ 生成（生品）与加工品（炒山药）在药物库是两条独立记录，
       所以「各进各的价」天然互不影响，不需要额外隔离。 */
  function applyStock(name, unit, qty, cost, dt, supplier, pno){
    var d=findDrug(name);
    if(!d){
      d={n:name, u:unit, c:'', tc:'', py:genPinyin(name), dw:'', cat:'中药', bp:String(cost), p:'', st:'0', dp:'', og:'', al:[], un:[]};
      drugsList.push(d);
    }
    if(!Array.isArray(d.un)) d.un=[];
    var isMain=(String(unit)===String(d.u));
    var uu=null, i;
    for(i=0;i<d.un.length;i++){ if(String(d.un[i].unit)===String(unit)){ uu=d.un[i]; break; } }
    if(!uu){ uu={unit:unit, stock:0, cost:cost, retail:'', daily:'', wp:'', sg:''}; d.un.push(uu); }
    uu.stock=round2((parseFloat(uu.stock)||0)+qty);
    if(isMain){
      d.st=String(round2((parseFloat(d.st)||0)+qty));
      uu.stock=d.st;                       /* 镜像与主字段保持一致 */
      /* 进货价变了才重算建议价（用户 2026-10-30 规则）；没变就保留原快照 */
      var prevCost=parseFloat(d.bp), newCost=parseFloat(cost);
      var changed=!(isFinite(prevCost)&&isFinite(newCost)&&Math.abs(prevCost-newCost)<1e-9);
      var hasSnap=!!(d.rates&&isFinite(parseFloat(d.rates.sg)));
      if(changed || !hasSnap) dmSetSuggest(d, cost);
      d.bp=String(cost); uu.cost=cost;
    }else{
      /* 子规格：进货价变了 → 批发价按同一倍率联动、建议价重算快照（和主规格同一套规则） */
      var prevC=parseFloat(uu.cost), newC=parseFloat(cost);
      var chg=!(isFinite(prevC)&&isFinite(newC)&&Math.abs(prevC-newC)<1e-9);
      uu.cost=cost;
      if(chg || uu.wp==null || uu.wp===''){
        var rr=dmWpRate(d);
        if(isFinite(rr) && isFinite(newC)){ uu.wp=String(Math.round(newC*rr*1000)/1000); uu.sg=String(Math.round(newC*rr*100)/100); }
      }
    }
    saveDrugsLS();
    if(SUPA.on){ try{ SUPA.q('drugs?on_conflict=name',{method:'POST',body:dmRowOfFull(d)}).catch(warnStockCloud); }catch(e){} }
    /* 进价历史：每次进货都留一条（时间 / 价格 / 来源=进货单） */
    var clog={drug:name, dt:dt, qty:qty, unit:unit, cost:cost, supplier:supplier, purchase_no:pno, src:'进货单'};
    S.log.push(clog); saveLogLS();
    if(SUPA.on){ try{ SUPA.addCostLog(clog).catch(function(){}); }catch(e){} }
  }
  /* 撤回一张单造成的库存与进价流水（改单重存 / 删除时用） */
  function undoStock(o){
    if(!o) return;
    (o.items||[]).forEach(function(it){ changeStock(it.name, it.unit, -parseFloat(it.qty)); });
    var kept=[];
    for(var i=0;i<S.log.length;i++){ if(String(S.log[i].purchase_no||'')!==String(o.no||'')) kept.push(S.log[i]); }
    S.log=kept; saveLogLS();
    if(SUPA.on){
      try{ SUPA.q('drug_cost_log?purchase_no=eq.'+encodeURIComponent(o.no||''),{method:'DELETE'}).catch(function(){}); }catch(e){}
    }
  }
  function changeStock(name, unit, delta){
    var d=findDrug(name); if(!d) return;
    if(!Array.isArray(d.un)) d.un=[];
    var isMain=(String(unit)===String(d.u));
    var uu=null, i;
    for(i=0;i<d.un.length;i++){ if(String(d.un[i].unit)===String(unit)){ uu=d.un[i]; break; } }
    if(!uu){
      if(!isMain) return;                 /* 没这个规格，也没库存可扣 */
      uu={unit:unit, stock:(d.st==null?'':d.st), cost:(d.bp==null?'':d.bp), retail:'', daily:'', wp:'', sg:''};
      d.un.push(uu);
    }
    var st=(parseFloat(uu.stock)||0)+delta;
    if(st<0) st=0;                       /* 库存不出现负数 */
    uu.stock=round2(st);
    if(isMain){
      var s2=(parseFloat(d.st)||0)+delta;
      d.st=String(round2(s2<0?0:s2));
      uu.stock=d.st;
    }
    saveDrugsLS();
    if(SUPA.on){ try{ SUPA.q('drugs?on_conflict=name',{method:'POST',body:dmRowOfFull(d)}).catch(warnStockCloud); }catch(e){} }
  }

  /* ---------- 删单（可回滚库存） ---------- */
  function openM(id){ var m=$(id); if(m) m.classList.add('on'); }
  function closeM(id){ var m=$(id); if(m) m.classList.remove('on'); }
  function delOrder(no, ev){
    if(ev && ev.stopPropagation) ev.stopPropagation();
    var o=no?findByNo(no):(S.cur?findByNo(S.cur.no):null);
    if(!o) return;
    S.del=o;
    var bs=batchesOf(o);
    var t=$('purDelText');
    if(t) t.textContent=monthLabel(monthOf(o))+'（'+o.no+'）共 '+bs.length+' 个小订单、'+((o.items||[]).length)+' 项，合计 ¥'+fmt2(o.total||0)+'。';
    var dh=document.getElementById('purDelHead');
    if(dh) dh.textContent=wasStocked(o.no)?'本月进货单已入库，删除时是否同时扣回对应库存？':'本月进货单还没入库，删除不会影响库存。';
    var ul=$('purDelList');
    if(ul) ul.innerHTML=(o.items||[]).map(function(it){
      return '<li>'+esc(it.name)+' <b>'+esc(String(it.qty))+' '+esc(it.unit)+'</b>'+(it.dt?' <span class="pur-hint">'+esc(String(it.dt).slice(5))+'</span>':'')+'</li>';
    }).join('');
    openM('purDelModal');
  }
  function closeDel(){ closeM('purDelModal'); S.del=null; }
  function doDel(withStock){
    var o=S.del; if(!o) return;
    var stocked=wasStocked(o.no);
    if(withStock && stocked) undoStock(o);
    S.orders=S.orders.filter(function(x){ return x.no!==o.no; }); saveLS();
    if(SUPA.on){
      try{ SUPA.q('purchases?no=eq.'+encodeURIComponent(o.no),{method:'DELETE'}).catch(function(){}); }catch(e){}
      if(stocked && !withStock){
        /* 只删单据、不扣库存时，进价流水也一并删掉，避免留下来源已不存在的记录 */
        try{ SUPA.q('drug_cost_log?purchase_no=eq.'+encodeURIComponent(o.no),{method:'DELETE'}).catch(function(){}); }catch(e){}
      }
    }
    if(S.cur && S.cur.no===o.no) S.cur=null;
    closeM('purDelModal'); S.del=null;
    showSub('list');
    try{ if(typeof renderDrugTable==='function') renderDrugTable(); }catch(e){}
    toast('已删除 '+monthLabel(monthOf(o))+(withStock&&stocked?'，库存已扣回':'，库存未变动'));
  }
  /* ---------- 自动建药确认 ---------- */
  function closeNewDrug(){
    closeM('purNewModal');
    var m=$('purMsg');
    if(m) m.textContent='已取消保存：请先在「药物管理」里建好这些药材，再回来录单。';
    S.pending=null; S.missing=[];
  }
  function confirmNewDrug(){
    var pend=S.pending; if(!pend) return;
    var miss=S.missing.slice();
    closeM('purNewModal');
    miss.forEach(function(x){
      if(findDrug(x.name)) return;
      var it=null, i;
      for(i=0;i<pend.items.length;i++){ if(String(pend.items[i].name).trim()===x.name){ it=pend.items[i]; break; } }
      var cost=it?(parseFloat(it.cost)||0):0;
      var d={n:x.name, u:x.unit, c:'', tc:'', py:genPinyin(x.name), dw:'', cat:'中药',
             bp:String(cost), p:'', st:'0', dp:'', og:'', al:[], un:[]};
      drugsList.push(d);
      if(SUPA.on){ try{ SUPA.q('drugs?on_conflict=name',{method:'POST',body:dmRowOfFull(d)}).catch(warnStockCloud); }catch(e){} }
    });
    saveDrugsLS();
    S.missing=[]; S.pending=null;
    commitSave();
  }

  /* ---------- 最近一次进货价（药物管理页「建议价」用） ---------- */
  function latestCost(name){
    var nm=String(name||'').trim(); if(!nm) return null;
    var log=S.log||[];
    var best=null, bl='';
    for(var i=0;i<log.length;i++){
      var r=log[i]; if(!r) continue;
      if(String(r.drug||'').trim()!==nm) continue;
      var c=parseFloat(r.cost); if(!isFinite(c)) continue;
      var k=String(r.dt||'')+'|'+String(i);
      if(best===null || k>bl){ best=c; bl=k; }
    }
    return best;
  }

  /* ---------- 列表（按月，一张月度大订单一张卡） ---------- */
  function renderList(){
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
  return { ensure:ensure, showSub:showSub, newOrder:newOrder, editOrder:editOrder, addItem:addItem, addItemAfter:addItemAfter, delItem:delItem,
    addBatch:addBatch, delBatch:delBatch, setBatchDate:setBatchDate, setMonth:setMonth,
    saveOrder:saveOrder, setSearch:setSearch, delOrder:delOrder, closeDel:closeDel, doDel:doDel,
    closeNewDrug:closeNewDrug, confirmNewDrug:confirmNewDrug, latestCost:latestCost, _state:S };
})();