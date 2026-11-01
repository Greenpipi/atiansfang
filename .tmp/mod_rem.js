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
  function autoNo(){
    var y=new Date().getFullYear(), pre='PF-'+y+'-', max=0;
    S.orders.forEach(function(o){ if(o.no&&o.no.indexOf(pre)===0){ var n=parseInt(o.no.slice(pre.length),10); if(n>max) max=n; } });
    return pre+('000'+(max+1)).slice(-4);
  }
  function today(){ var d=new Date(); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
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
    if(l) l.style.display = sub==='list'?'block':'none';
    if(e) e.style.display = sub==='edit'?'block':'none';
    if(sub==='list') renderList();
  }
  function newOrder(){
    S.cur={no:autoNo(), dt:today(), supplier:'', items:[{name:'',qty:'',unit:'g',cost:'',amount:0}], note:'', total:0};
    renderEdit(); showSub('edit');
  }
  function editOrder(no){
    var o=findByNo(no); if(!o) return;
    S.cur=JSON.parse(JSON.stringify(o));
    renderEdit(); showSub('edit');
  }
  function recalc(){
    var total=0; S.cur.items.forEach(function(it){ var q=parseFloat(it.qty)||0, c=parseFloat(it.cost)||0; it.amount=q*c; total+=it.amount; });
    var t=$('purTotal'); if(t) t.textContent=fmt2(total);
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
  function renderItems(){
    var tb=$('purItems'); if(!tb) return;
    tb.innerHTML=S.cur.items.map(function(it,i){
      var d=findDrug(it.name);
      /* 单位候选 = 常用单位 + 这味药已有的规格单位（避免有「袋」却选不到，保存时被拦） */
      var us=['g','kg','斤','个','条','盒','罐','包','瓶'];
      if(d){
        var mu=String(d.u||'g');
        if(us.indexOf(mu)<0) us.push(mu);
        (d.un||[]).forEach(function(x){ var u=String((x||{}).unit||''); if(u && us.indexOf(u)<0) us.push(u); });
      }
      var cur=String(it.unit||'g');
      if(us.indexOf(cur)<0) us.push(cur);
      var opts=us.map(function(u){
        return '<option'+(u===cur?' selected':'')+'>'+u+'</option>'; }).join('');
      var hint='';
      if(it.name){
        if(!d) hint='<div class="pur-hint">药品库无此药</div>';
        else if(!hasUnit(d,it.unit)) hint='<div class="pur-hint">无「'+esc(it.unit)+'」单位</div>';
        else hint='<div class="pur-hint ok">现有库存 '+esc(String(stockOf(d,it.unit)))+' '+esc(it.unit)+'</div>';
      }
      /* 炒制类：进货单价旁边给一个「带入生品进价」，点了就填最近一次生品的价，还能再手改 */
      var prod='', bb=baseOf(it.name);
      if(bb){
        var lc=latestCost(bb.name);
        if(lc!=null){
          prod='<button type="button" class="pur-prod" data-i="'+i+'" data-cost="'+esc(String(lc))+
               '" title="把最近一次「'+esc(bb.name)+'」的进货价（'+fmt2(lc)+'）填进来">带入生品进价</button>';
        }
      }
      return '<tr data-i="'+i+'">'
        +'<td><input data-ddlist="purchaseDrugList" class="pur-name" value="'+esc(it.name||'')+'" placeholder="药名">'+hint+'</td>'
        +'<td><input class="pur-qty num" value="'+esc(it.qty||'')+'" placeholder="数量" style="width:100%"></td>'
        +'<td><select class="pur-unit">'+opts+'</select></td>'
        +'<td><input class="pur-cost num" value="'+esc(it.cost||'')+'" placeholder="单价" style="width:100%">'+prod+'</td>'
        +'<td class="num pur-amt">'+fmt2(it.amount||0)+'</td>'
        +'<td><button type="button" class="mini" onclick="Purchase.delItem('+i+')">删</button></td>'
        +'</tr>';
    }).join('');
    var rows=tb.querySelectorAll('tr');
    for(var r=0;r<rows.length;r++){
      (function(tr){
        var i=+tr.getAttribute('data-i');
        var name=tr.querySelector('.pur-name'), qty=tr.querySelector('.pur-qty'), unit=tr.querySelector('.pur-unit'), cost=tr.querySelector('.pur-cost');
        function upd(){
          var it=S.cur.items[i]; it.name=name.value; it.qty=qty.value; it.unit=unit.value; it.cost=cost.value;
          recalc();
          /* 金额单元格跟着改（原来只更新合计，行内金额要等重绘才对） */
          var amtTd=tr.querySelector('.pur-amt');
          if(amtTd) amtTd.textContent=fmt2(it.amount||0);
        }
        name.oninput=function(){ upd(); };
        name.onchange=function(){ upd(); renderItems(); };
        unit.onchange=function(){ upd(); renderItems(); };
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
      })(rows[r]);
    }
  }
  function stockOf(d, unit){
    if(!d) return 0;
    if(String(d.u||'g')===String(unit) && (d.st!==''&&d.st!=null)) return parseFloat(d.st)||0;
    var un=d.un||[];
    for(var i=0;i<un.length;i++){ if(String(un[i].unit)===String(unit)) return parseFloat(un[i].stock)||0; }
    return 0;
  }
  function renderEdit(){
    $('purNo').value=S.cur.no||''; $('purDt').value=S.cur.dt||today();
    $('purSupplier').value=S.cur.supplier||'';
    var nt=$('purNote'); if(nt) nt.value=S.cur.note||'';
    if(!S.cur.items||!S.cur.items.length) S.cur.items=[{name:'',qty:'',unit:'g',cost:'',amount:0}];
    renderItems(); fillDrugList(); recalc();
    var m=$('purMsg'); if(m) m.textContent='';
  }
  function addItem(){ S.cur.items.push({name:'',qty:'',unit:'g',cost:'',amount:0}); renderItems(); }
  function delItem(i){
    S.cur.items.splice(i,1);
    if(!S.cur.items.length) S.cur.items.push({name:'',qty:'',unit:'g',cost:'',amount:0});
    renderItems();
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
    S.cur.no=$('purNo').value.trim()||autoNo();
    S.cur.dt=$('purDt').value||today();
    S.cur.supplier=$('purSupplier').value.trim();
    var nt=$('purNote'); S.cur.note=nt?nt.value.trim():'';
    S.cur.items=S.cur.items.filter(function(it){ return (it.name||'').trim(); });
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
    recalc();
    S.cur.total=0; S.cur.items.forEach(function(it){ S.cur.total+=it.amount; });
    /* 改单重存：先把旧单造成的库存与进价流水撤回，再按新内容重记，否则库存会翻倍 */
    var prev=findByNo(S.cur.no);
    if(prev) undoStock(prev);
    S.orders=upsert(S.orders, S.cur); saveLS();
    S.cur.items.forEach(function(it){
      applyStock(it.name, it.unit, parseFloat(it.qty), parseFloat(it.cost), S.cur.dt, S.cur.supplier, S.cur.no);
    });
    if(SUPA.on){
      var rec={no:S.cur.no, dt:S.cur.dt, supplier:S.cur.supplier,
        items:S.cur.items.map(function(it){ return {name:it.name,qty:parseFloat(it.qty),unit:it.unit,cost:parseFloat(it.cost),amount:it.amount}; }),
        total:S.cur.total, note:S.cur.note||''};
      SUPA.savePurchase(rec).catch(function(e){ toastErr('进货单云端保存失败：'+e.message); });
    }
    var no=S.cur.no;
    toast('进货单 '+no+' 已保存，库存已更新');
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
    var o=findByNo(no); if(!o) return;
    S.del=o;
    var t=$('purDelText');
    if(t) t.textContent='进货单 '+o.no+'（'+(o.dt||'')+'）共 '+((o.items||[]).length)+' 项，合计 ¥'+fmt2(o.total||0)+'。';
    var ul=$('purDelList');
    if(ul) ul.innerHTML=(o.items||[]).map(function(it){
      return '<li>'+esc(it.name)+' <b>-'+esc(String(it.qty))+' '+esc(it.unit)+'</b></li>';
    }).join('');
    openM('purDelModal');
  }
  function closeDel(){ closeM('purDelModal'); S.del=null; }
  function doDel(withStock){
    var o=S.del; if(!o) return;
    if(withStock) undoStock(o);
    S.orders=S.orders.filter(function(x){ return x.no!==o.no; }); saveLS();
    if(SUPA.on){ try{ SUPA.q('purchases?no=eq.'+encodeURIComponent(o.no),{method:'DELETE'}).catch(function(){}); }catch(e){} }
    closeM('purDelModal'); S.del=null;
    renderList();
    try{ if(typeof renderDrugTable==='function') renderDrugTable(); }catch(e){}
    toast('已删除 '+o.no+(withStock?'，库存已扣回':'，库存未变动'));
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

  /* ---------- 列表 ---------- */
  function renderList(){
    var box=$('purList'); if(!box) return;
    var list=S.orders.slice().sort(function(a,b){ return (b.dt||'')<(a.dt||'')?-1:1; });
    var f=(S.search||'').toLowerCase();
    if(f) list=list.filter(function(o){ return (o.no+o.supplier+(o.dt||'')+(o.note||'')).toLowerCase().indexOf(f)>=0; });
    if(!list.length){ box.innerHTML='<div class="wp-empty">还没有进货单，点右上「新建 / 录单」开始。</div>'; return; }
    box.innerHTML=list.map(function(o){
      var its=o.items||[], cnt=its.length, total=(o.total||0);
      var names=its.slice(0,6).map(function(it){ return esc(it.name); }).join('、');
      return '<div class="wp-card" data-no="'+esc(o.no)+'">'
        +'<div class="wp-card-h"><b>'+esc(o.no)+'</b><span class="wp-card-sub">'+esc(o.dt||'')+' · 供应商：'+(esc(o.supplier)||'—')+'</span>'
        +'<span class="spacer"></span><span class="wp-card-amt">¥'+fmt2(total)+'</span></div>'
        +'<div class="wp-card-meta">'+cnt+' 项'+(names?(' · '+names+(cnt>6?'…':'')):'')+'</div>'
        +(o.note?('<div class="wp-card-meta">备注：'+esc(o.note)+'</div>'):'')
        +'<div class="wp-card-meta"><a href="javascript:;" onclick="Purchase.editOrder(\''+esc(o.no)+'\')">查看 / 修改</a>'
        +' · <a href="javascript:;" class="pur-del" onclick="Purchase.delOrder(\''+esc(o.no)+'\',event)">删除</a></div>'
        +'</div>';
    }).join('');
  }
  return { ensure:ensure, showSub:showSub, newOrder:newOrder, editOrder:editOrder, addItem:addItem, delItem:delItem,
    saveOrder:saveOrder, setSearch:setSearch, delOrder:delOrder, closeDel:closeDel, doDel:doDel,
    closeNewDrug:closeNewDrug, confirmNewDrug:confirmNewDrug, latestCost:latestCost, _state:S };
})();