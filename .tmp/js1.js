
/* =========================================================
   阿田药方打印
   数据源：数据库.dat（商品 2500 味 + 档案 5644 张处方）
   流程：粘贴/输入药名 → 保 存(必填姓名) → 自动划价 → 填其他费用 → 发 药
   计价：单价 = 元/克（大枣等按元/个）
        单剂药费 = Σ(单价×数量)
        合计 = 单剂药费×剂数 + 加工费用 + 物品费用 + 代煎费 + 跑腿费
   ========================================================= */
var LS_SET='rx_set_v3', LS_HISTEDIT='rx_hist_edit_v1';
/* =====================================================================
   ☁ 云端存储层（唯一数据源：Supabase）
   ---------------------------------------------------------------------
   业务数据不再写浏览器 RX_STORE / sessionStorage / IndexedDB。
   这里提供一套同步 API（getItem / setItem / removeItem），启动时从
   Supabase 的 guests 表读取 KV 数据到内存，写入时按 key 防抖 upsert。
   页面读取的是「云端数据的内存副本」，云端才是唯一事实来源。
   ===================================================================== */
var RX_STORE=(function(){
  var mem={}, timers={}, PREFIX='__kv__';
  function has(k){ return Object.prototype.hasOwnProperty.call(mem,k); }
  function getItem(k){
    k=String(k);
    return has(k)?mem[k]:null;
  }
  function setItem(k,v){
    k=String(k); v=(v==null?'':String(v));
    mem[k]=v;
    schedule(k,false);
  }
  function removeItem(k){
    k=String(k);
    if(has(k)) delete mem[k];
    schedule(k,true);
  }
  function clear(){
    for(var k in mem){ if(has(k)){ delete mem[k]; schedule(k,true); } }
  }
  function keys(){ var out=[]; for(var k in mem){ if(has(k)) out.push(k); } return out; }
  function schedule(k,del){
    if(typeof SUPA==='undefined' || !SUPA.on) return;
    if(timers[k]) clearTimeout(timers[k]);
    timers[k]=setTimeout(function(){ timers[k]=null; push(k,del); }, 600);
  }
  function push(k,del){
    if(typeof SUPA==='undefined' || !SUPA.on) return;
    var nm=PREFIX+k;
    if(del){
      SUPA.q('guests?name=eq.'+encodeURIComponent(nm),{method:'DELETE'})
        .catch(function(e){ console.warn('云端删除失败:',k, e&&e.message); });
      return;
    }
    if(!has(k)) return;
    SUPA.q('guests?on_conflict=name',{method:'POST',body:{name:nm,prices:{v:mem[k]}}})
      .catch(function(e){ console.warn('云端保存失败:',k, e&&e.message); });
  }
  /* 启动时一次性把云端 KV 载入内存；失败则内存保持空（页面就显示为空，绝不读本地） */
  function load(){
    if(typeof SUPA==='undefined') return Promise.reject(new Error('SUPA 未定义'));
    return SUPA.qAll('guests?select=name,prices').then(function(rows){
      mem={};
      (rows||[]).forEach(function(r){
        var nm=String((r&&r.name)||'');
        if(nm.indexOf(PREFIX)!==0) return;
        var k=nm.slice(PREFIX.length), p=(r&&r.prices)||{};
        if(typeof p.v==='string') mem[k]=p.v;
        else if(p.v!=null) mem[k]=JSON.stringify(p.v);
      });
      return keys().length;
    });
  }
  return { getItem:getItem, setItem:setItem, removeItem:removeItem, clear:clear,
           keys:keys, load:load, push:push, PREFIX:PREFIX,
           _mem:function(){ return mem; } };
})();
/* ---------------- 已删除处方「墓碑」（2026-10-14）----------------
   删除后把编号记进云端墓碑表，之后本机合并、补推、云端拉取
   一律跳过墓碑编号 —— 删了就是删了，不会复活。 */
var LS_DEL='rx_deleted_v3';
function delTomb(){ try{ var o=JSON.parse(RX_STORE.getItem(LS_DEL)||'{}'); return (o&&typeof o==='object')?o:{}; }catch(e){ return {}; } }
function isDelNo(no){ return !!delTomb()[no]; }
function markDelNo(no){ if(!no) return; var m=delTomb(); m[no]=Date.now(); RX_STORE.setItem(LS_DEL, JSON.stringify(m)); }
/* 内置数据文件（drugs_data.js / history_data.js）不再加载：
   一切以 Supabase 为准，云端没有就显示为空。 */
var HISTORY_ORIG=[];

var SAVED=[];            // 本机保存的处方
var HIST_EDIT={};        // 书剑历史处方的就地修改（key=rxKey），保存时覆盖原记录而不新建
var drugsList=[];        // 药品目录
var items=[];            // 处方笺格子（可能含空项），与 .cell 一一对应
var priced=false;        // 是否已划价
var curRec=null;         // 当前处方已保存的记录
var curIsHist=false;     // 当前处方是否是在编辑「书剑历史处方」（就地覆盖，不新建）
var curSrcRx=null;       // 从左侧载入的历史处方来源（用于「复制处方」）
var selAll=false;        // 整个药方是否已全选（Ctrl+A 后按 Delete 清空）
var pickMode=false;      // 单个删除的点选模式
var rngStart=-1, rngEnd=-1, rngDragging=false;   // 框选范围（格子下标）
var dupMerged=-1;       // 最近一次因重名被合并到的格子索引（-1 表示无）
var SET={};
var selDrugRow=-1, dmCurTab='中药', dmFilter='';

/* ---------------- 基础工具 ---------------- */
function $(id){return document.getElementById(id);}
function n(v){var x=parseFloat(v);return isFinite(x)?x:0;}
function money(v){return (Math.round(n(v)*100)/100).toFixed(2);}
function e3(v){return (Math.round(n(v)*1000)/1000).toFixed(3);}

/* ★ 金额/重量数字按内容自适应宽度（2026-10-08 用户要求「5374.6 被截断、要能显示到 10000.00」）

   根因（computed 实测，1600×900）：
     .rxmoney 容器 498px，两侧都有富余，却依然截断 —— 因为 #fPerDose 是<INPUT>，
     input 无法靠 CSS 自适应，历史上被写死 width:5.5ch（=50.9px，max-width:7ch）。
     实测「5374.60」需 59.8px、「10000.00」需 69px > 50.9px → 尾部数字被 input 裁掉。
     （截图里显示成5374.6，丢的就是最后一位 0。）
     合计.fTotal 是 span，天然自适应，实测 10000.00 不截断 —— 本次一并加下限保护。

   做法：用离屏 canvas 按 input 的**真实字体**量出文字像素宽，再写进 el.style.width。
     ·内联 style 优先级高于 CSS 的非!important 声明，两者不打架；
     · 下限 5.5ch（约 51px，够放「22.00」），上限 22ch（约 205px，够放 12 位金额）；
     · 复用同一个 ctx，避免每次重绘新建 canvas。 */
var _fitCtx=null;
function fitMoneyInputs(){
  var el=$('fPerDose'); if(!el) return;
  try{
    var cs=getComputedStyle(el);
    if(!_fitCtx) _fitCtx=document.createElement('canvas').getContext('2d');
    _fitCtx.font=cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;
    /* +3px：给光标留位，避免最后一个数字贴着边框（text 宽度不含 caret） */
    var need=_fitCtx.measureText(el.value||'0.00').width+3;
    var min=parseFloat(cs.minWidth)||0, max=parseFloat(cs.maxWidth)||0;
    var w=Math.max(need,min);
    if(max>0) w=Math.min(w,max);
    el.style.width=Math.ceil(w)+'px';
  }catch(e){}
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
/* ⚠️ 不能用 String.prototype.padStart（ES2017）——旧版 Safari/Mac 上不存在，
   会让today() 抛错返回 undefined，日期框变空，
   再点「上一天/下一天」就会跳到 2022/2023（2026-10-07 用户在 Mac 上遇到）。 */
function pad2(x){ x=String(x); return x.length>=2?x:('0'+x); }
/* 左侧补零到指定长度（不用 padStart，兼容旧版 Safari） */
function pad2x(x, n){ x=String(x); while(x.length<n) x='0'+x; return x; }
function today(){
  var d=new Date();
  return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
}
function nowHM(){var d=new Date();return pad2(d.getHours())+':'+pad2(d.getMinutes());}
/* 通知浮层（2026-10-25 重构 + 样式优化）：左下角堆叠、5 秒自动淡出、可手动关闭。
   toast(m)          普通通知 → 绿字
   toast(m,'err')    警告/出错 → 红字（简写 toastErr(m)） */
var TOAST_TTL=5000;
function toast(m,type){
  var wrap=$('toastWrap'); if(!wrap) return;
  var el=document.createElement('div'); el.className='tst'+(type==='err'?' err':'');
  var tx=document.createElement('span'); tx.className='tst-tx'; tx.textContent=m;
  var x=document.createElement('button'); x.type='button'; x.className='tst-x';
  x.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
  x.title='关闭'; x.setAttribute('aria-label','关闭通知');
  el.appendChild(tx); el.appendChild(x);
  wrap.insertBefore(el, wrap.firstChild);          /* 最新的一条显示在最上面 */
  /* 堆叠防溢出：条数太多会堆出屏幕顶部——
     最新的几条（含它的 ×）被顶到视口外，用户看得见点不着（2026-10-25 实测 6 条时 × 在 y=-42）。
     底边固定在 bottom:16px，向上长；超过可用高度就 oldest-first 摘掉，
     保证最新的一条永远完整可见、关闭图标永远可点。 */
  try{
    var maxH=Math.max(96,(window.innerHeight||900)-16-12);
    while(wrap.children.length>1 && wrap.offsetHeight>maxH){
      var last=wrap.lastElementChild; if(!last) break;
      wrap.removeChild(last);
    }
  }catch(e){}
  requestAnimationFrame(function(){ el.classList.add('in'); });
  var timer=setTimeout(dismiss, TOAST_TTL);
  x.onclick=dismiss;
  function dismiss(){
    clearTimeout(timer);
    if(el._closing) return; el._closing=true;
    el.classList.add('out');
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 260);
  }
}
/* 警告/出错类通知（红字）：与 toast 同行为，仅配色不同 */
function toastErr(m){ toast(m,'err'); }

/* ---------------- 备注常用词（可增删） ---------------- */
var NOTE_KEY='rx_notes_v1';
var ADDR_KEY='rx_addr_v1';        /* 姓名 → [{a:地址, p:跑腿价, e:闪送价}]，存 Supabase addresses 表 */
var ADDR_MAP={};                  /* 云端 addresses 表的内存副本 */
var NOTE_LIST=[];                 /* 云端 notes 表的内存副本 */

/* 自动本地备份已移除：数据统一存 Supabase 云端，不再写本机备份文件。
   保留 autoBackup() 空函数，避免核心保存路径（处方/药价/设置）调用报错。 */
function autoBackup(){}
function loadAddrs(){ return ADDR_MAP; }
function saveAddrMap(m){ ADDR_MAP=(m&&typeof m==='object')?m:{}; }
function addrsOf(name){
  var m=loadAddrs(), k=String(name||'').trim();
  if(!k) return [];
  var a=m[k];
  return Array.isArray(a)?a:[];
}
function addAddr(name,addr,pt,ex){
  var k=String(name||'').trim(), a=String(addr||'').trim();
  if(!k||!a) return false;
  var m=loadAddrs();
  if(!Array.isArray(m[k])) m[k]=[];
  /* 同一地址只更新价格，不重复添加 */
  for(var i=0;i<m[k].length;i++){
    if(m[k][i].a===a){
      m[k][i].p=(pt!=null&&pt!=='')?String(pt):(m[k][i].p||'');
      m[k][i].e=(ex!=null&&ex!=='')?String(ex):(m[k][i].e||'');
      saveAddrMap(m); supaPushAddr(k, m[k]); return true;
    }
  }
  m[k].unshift({a:a,p:(pt!=null&&pt!=='')?String(pt):'',e:(ex!=null&&ex!=='')?String(ex):''});
  saveAddrMap(m);
  supaPushAddr(k, m[k]);   /* → 云端 addresses 表 */
  return true;
}
function delAddr(name,addr){
  var k=String(name||'').trim(), m=loadAddrs();
  if(!Array.isArray(m[k])) return false;
  m[k]=m[k].filter(function(x){ return x.a!==addr; });
  if(!m[k].length) delete m[k];
  saveAddrMap(m);
  supaDelAddrRow(k, addr);   /* → 云端同步删除 */
  return true;
}
/* 改地址文字：保持原位置；若改成与已有条目同名则合并（不产生重复地址） */
function renameAddr(name,oldA,newA){
  var k=String(name||'').trim(), o=String(oldA||'').trim(), nn=String(newA||'').trim();
  if(!k||!nn||nn===o) return false;
  var m=loadAddrs(); if(!Array.isArray(m[k])) return false;
  var hit=null;
  for(var i=0;i<m[k].length;i++){ if(m[k][i].a===o){ hit=m[k][i]; break; } }
  if(!hit) return false;
  var res=[];
  for(var j=0;j<m[k].length;j++){
    var x=m[k][j];
    if(x===hit){ x.a=nn; res.push(x); continue; }
    if(x.a===nn) continue;      /* 与已有条目重名 → 合并掉旧的重复项 */
    res.push(x);
  }
  m[k]=res; saveAddrMap(m);
  supaDelAddrRow(k, o);        /* 旧地址从云端删掉 */
  supaPushAddr(k, res);        /* 新地址上云 */
  return true;
}
/* 配送地址 / 常用备注 → 云端数据库（2026-10-07 16:00 上云）
   ⚠ 策略与处方一致：**云端失败绝不阻塞本机操作**（用户照常能用），
      只用 supaWarn 提示「已存本机，未上云」，绝不默默丢数据。 */
function supaPushAddr(k, list){
  if(!SUPA.on||!k) return;
  /* 🔴 与处方同一条铁律（IRON_RULES 第十条）：空值绝不覆盖云端 */
  if(!list||!list.length){ console.warn('⛔ 地址列表为空，跳过上传:', k); return; }
  SUPA.saveAddr(k, list).catch(function(e){ console.warn('地址上云失败:', e.message); supaSaveFail('地址：'+e.message); });
}
function supaPushNotes(list){
  if(!SUPA.on) return;
  if(!list||!list.length){ console.warn('⛔ 备注列表为空，跳过上传'); return; }
  SUPA.saveNotes(list).catch(function(e){ console.warn('备注上云失败:', e.message); supaSaveFail('备注：'+e.message); });
}
function supaDelAddrRow(name, addr){
  if(!SUPA.on||!name||!addr) return;
  SUPA.delAddr(name, addr).catch(function(e){ console.warn('地址删除同步失败:', e.message); });
}
function supaDelNoteRow(text){
  if(!SUPA.on||!text) return;
  SUPA.delNote(text).catch(function(e){ console.warn('备注删除同步失败:', e.message); });
}
/* ---------- 地址 / 常用备注：只从云端加载 ----------
   两者分别以 Supabase addresses / notes 表为唯一来源，本地不再保留副本。 */
function rxMergeAddrs(cloud){
  /* addresses 表是唯一来源；云端没有就是空。 */
  ADDR_MAP=(cloud&&typeof cloud==='object')?cloud:{};
  if(typeof renderAddrMenu==='function') renderAddrMenu();
  return ADDR_MAP;
}
function rxMergeNotes(cloud){
  /* notes 表是唯一来源；云端没有就是空，不再返回内置默认备注。 */
  var seen={}, merged=[];
  (Array.isArray(cloud)?cloud:[]).forEach(function(t){
    t=String(t==null?'':t).trim();
    if(t&&!seen[t]){ seen[t]=1; merged.push(t); }
  });
  NOTE_LIST=merged;
  if(typeof renderNoteMenu==='function') renderNoteMenu();
  return merged;
}
var NOTE_DEF=[];   /* 内置默认备注已移除：云端没有就显示为空 */
function loadNotes(){ return NOTE_LIST.slice(); }
function saveNotes(a){ NOTE_LIST=Array.isArray(a)?a.slice():[]; }
function renderNoteMenu(){
  var box=$('noteMenu'); if(!box) return;
  var list=loadNotes();
  if(!list.length){
    box.innerHTML='<div class="nhead"><b>常用备注</b><button type="button" class="nadd" data-add="1">+ 新增</button></div>'
      +'<div class="nempty">（还没有常用备注，点「+ 新增」把当前输入框内容加进来）</div>';
    return;
  }
  var h='<div class="nhead"><b>常用备注（可删除）</b><button type="button" class="nadd" data-add="1">+ 新增</button></div>';
  for(var i=0;i<list.length;i++){
    h+='<div class="nrow"><span class="ntxt" data-pick="'+esc(list[i])+'">'+esc(list[i])+'</span>'
      +'<button type="button" class="ndel" data-del="'+i+'" title="删除这条">✕</button></div>';
  }
  box.innerHTML=h;
}
function noteMenuToggle(force){
  var box=$('noteMenu'); if(!box) return;
  var open=(box.style.display==='block');
  var want=(typeof force==='boolean')?force:!open;
  if(want){ renderNoteMenu(); box.style.display='block'; noteMenuFlip(box); }
  else{ box.style.display='none'; noteMenuGoHome(); }
}
/* 下拉方向自适应（2026-10-07 用户报「被下方计算区遮挡严重」）。
   真凶不是 z-index：.sheetwrap/.pbody/.panel.center 全是 overflow:hidden，
   .rxgrid 自己还 overflow-y:auto —— 下拉无论向上还是向下都必然被某层裁掉
   （实测默认向下时 8 行里有 6 行看不见，被 .cbar 按钮区盖住）。
   正解：和药名联想框（#acBox）一样，改用 **fixed 挂到视口**，
   完全脱离所有 overflow 裁剪，再按空间自动选向上/向下。 */
/* 下拉定位（2026-10-07 13:14 用户要求：absolute + 固定高度 + 内部滚动 + 宽度对齐输入框）
   ⚠ 为什么把菜单搬到 body 下再用 absolute：
   .panel.center / .pbody / .sheetwrap 三层都是 overflow:hidden，菜单留在
   .notewrap 里时 position:absolute 必被裁（实测 8 行里 6 行看不见）。
   body 下没有任何 overflow 祖先，absolute 成立且不被裁。
   事件全绑在 #noteMenu 元素本身，搬走不失效；收起时搬回 .notewrap。
   ⚠ 宽度对齐「输入框」而不是整个 .notewrap（.notewrap 里还有 ▾ 按钮，
   直接用 wrap 宽会比输入框宽出按钮那截）。 */
var NOTE_HOME=null;                 /* 记住原父节点，收起时搬回去 */
function noteMenuFlip(box){
  if(!box) return;
  var wrapEl=box.parentNode;
  /* 宽度基准：输入框 #fNote（没有就退到 .notewrap） */
  var anchor=$('fNote')||wrapEl;
  if(!NOTE_HOME) NOTE_HOME=wrapEl;
  if(box.parentNode!==document.body) document.body.appendChild(box);

  var a=anchor.getBoundingClientRect();
  var w=Math.round(a.width);
  var M=8;
  var HMAX=240;                                 /* 用户要求：固定最大高度 */
  var below=window.innerHeight-a.bottom-M;
  var above=a.top-M;
  /* 方向：下方够放满 240 就向下，否则向上。
     输入框在处方笺底部，向上通常空间更充裕（药名区那侧）。 */
  var goDown=(below>=HMAX||below>=above);
  var room=goDown?below:above;
  var maxH=Math.max(120, Math.min(HMAX, room));

  var cs=getComputedStyle(box);
  var padL=parseFloat(cs.paddingLeft)||0, padR=parseFloat(cs.paddingRight)||0;
  var brd=(parseFloat(cs.borderLeftWidth)||0)+(parseFloat(cs.borderRightWidth)||0);
  box.style.position='absolute';
  box.style.margin='0';
  box.style.right='auto';
  box.style.bottom='auto';
  /* 宽度与输入框**外框**完全一致（box-sizing:border-box 时，
     菜单的 padding+border 也占在这 315px 里，所以不能再额外加宽） */
  box.style.boxSizing='border-box';
  box.style.width=Math.max(220, w)+'px';
  box.style.maxHeight=maxH+'px';
  if(goDown){
    box.style.top=Math.round(a.bottom+window.scrollY)+'px';
  }else{
    box.style.top='auto';
    box.style.bottom=Math.round(window.innerHeight-a.top+window.scrollY)+'px';
  }
  var left=a.left+window.scrollX;
  if(left+box.offsetWidth>window.innerWidth-M){
    left=Math.max(M, window.innerWidth-box.offsetWidth-M);
  }
  box.style.left=Math.round(left)+'px';
  /* 宽度不该超出输入框太宽：视口不够时才收窄 */
  var maxW=Math.max(220, window.innerWidth-M*2);
  if(parseFloat(box.style.width)>maxW) box.style.width=maxW+'px';
}
function noteMenuGoHome(){
  if(!NOTE_HOME) return;
  var box=$('noteMenu'); if(!box) return;
  if(box.parentNode!==NOTE_HOME) NOTE_HOME.appendChild(box);
  box.style.position=''; box.style.top=''; box.style.left='';
  box.style.right=''; box.style.bottom=''; box.style.width='';
  box.style.maxHeight=''; box.style.boxSizing=''; box.style.margin='';
}

/* ---------------- 配送地址（姓名联动 · 隐私 · 不打印） ---------------- */
/* 勾选「跑腿费」或「闪送费」→ 出现整块地址区：上面一行新增地址，下面常显该姓名用过的地址清单。
   清单每行：改地址 / 改跑腿价 / 改闪送价 / 使用 / 复制 / 删除，全部即时存本机。
   注意：这里是常显整块，不是绝对定位下拉（下拉曾因锚点过窄被压成竖条，用户已反馈）。 */
var ADDR_OPEN=false;   /* 地址区默认折叠，点「展开」才铺开 */
function addrShow(){
  var row=$('addrRow');
  if(!row) return;
  var on=$('cbPaotui')&&($('cbPaotui').checked||$('cbExpress').checked||$('cbKuaidi').checked);
  row.style.display=on?'':'none';
  if(!on) return;
  /* 展开状态下换人/换方 → 立刻重画该姓名的地址清单，避免显示上一个人的地址 */
  if(ADDR_OPEN) renderAddrMenu(); else addrSummary();
}
/* 折叠时的一行摘要：当前地址 + 该姓名已存几条
   ⚠ 2026-10-08 修：原来每次都用 s.innerHTML=... 整体重建，
   而 recalc() 里也会调 addrSummary()（改费用时），
   于是「鼠标按下 → 抬起」之间摘要行被重建，<a id="addrReuse"> 被销毁，
   click 事件落在已脱离文档的旧节点上 → 复制按钮偶尔点了没反应。
   现在改成**只更新已有节点的文本，不重建结构**。 */
function addrSummary(){
  var s=$('addrSum'); if(!s) return;
  var cur=$('fAddr')?$('fAddr').value.trim():'';
  var list=$('fName').value.trim()?addrsOf($('fName').value.trim()):[];
  var text='', addr='';
  if(cur){ text=cur; addr=cur; }
  else if(list.length){ text=list[0].a||''; addr=text; }
  if(!addr){
    if(!s.querySelector('.atx')){
      s.textContent='';
      var e0=document.createElement('span'); e0.className='atx'; s.appendChild(e0);
    }
    s.querySelector('.atx').textContent='未填写，点「展开」新增';
    /* 复制按钮与条数提示都要清掉 —— 否则换人后残留上一条地址的「复制」和条数 */
    var dead=s.querySelector('.areuse'); if(dead&&dead.parentNode) dead.parentNode.removeChild(dead);
    var dt=s.querySelector('.dim'); if(dt&&dt.parentNode) dt.parentNode.removeChild(dt);
    return;
  }
  /* 结构固定为：<span class="atx">地址</span> + <a class="areuse">复制</a>（+ 可选条数）*/
  var atx=s.querySelector('.atx');
  if(!atx){ s.textContent=''; atx=document.createElement('span'); atx.className='atx'; s.appendChild(atx); }
  atx.textContent=text;
  var a=s.querySelector('.areuse');
  if(!a){
    /* 插在 atx 之后、条数提示之前 */
    a=document.createElement('a');
    a.className='areuse'; a.id='addrReuse'; a.href='javascript:void(0)';
    atx.parentNode.insertBefore(a, atx.nextSibling);
  }
  a.textContent='复制';
  bindAddrReuse(addr);
  /* 条数提示（只在有多条且没填地址时出现）*/
  var tip=s.querySelector('.dim');
  var want=(!cur&&list.length>1)?('（共 '+list.length+' 条，点「展开」选择）'):'';
  if(want){
    if(!tip){ tip=document.createElement('span'); tip.className='dim'; a.parentNode.insertBefore(tip,a.nextSibling); }
    tip.textContent=want;
  }else if(tip&&tip.parentNode){ tip.parentNode.removeChild(tip); }
}
/* 摘要行上的「复制」（2026-10-08 用户要求）：
   按钮文字由「复用」改为「复制」，功能也只做一件事 —— 把这条地址文本复制到剪贴板，
   不再触发 useAddr()（填地址 + 勾跑腿费 + 带入跑腿价）那套逻辑。
   要「填入并计跑腿费」请点「展开」里的「使用跑腿 / 使用闪送」，两个入口互不干扰。 */
function bindAddrReuse(addr){
  var a=$('addrReuse'); if(!a||!addr) return;
  a.onclick=function(e){ e.preventDefault(); copyAddr(addr, true); };
}
function addrFold(force){
  var b=$('addrBody'), t=$('addrFold');
  if(!b) return;
  var open=(typeof force==='boolean')?force:(b.style.display!=='block');
  ADDR_OPEN=open;
  b.style.display=open?'block':'none';
  if(t) t.textContent=open?'收起 ▴':'展开 ▾';
  if(open) renderAddrMenu(); else addrSummary();
}
function renderAddrMenu(){
  var box=$('addrMenu'); if(!box) return;
  var nm=$('fName').value.trim();
  if(!nm){
    box.innerHTML='<div class="nempty">（先填写姓名，这里就会列出该姓名用过的所有地址）</div>';
    return;
  }
  var list=addrsOf(nm);
  var h='<div class="ahead"><b>'+esc(nm)+' 用过的地址</b>'
      +'<span class="cnt">共 '+list.length+' 条（地址、跑腿价、闪送价改完自动保存；快递费请在上面手填）</span></div>';
  if(!list.length){
    h+='<div class="nempty">（还没有保存过地址：在上面填好地址和跑腿/闪送价，点「新增」即可）</div>';
  }else{
    for(var i=0;i<list.length;i++){
      h+='<div class="arow" data-i="'+i+'">'
        +'<input class="aedit" data-edit="'+i+'" value="'+esc(list[i].a)+'" title="可直接修改地址文字，改完自动保存">'
        +'<span class="aprice">'
          +'<span>跑腿</span><input type="number" min="0" step="0.01" data-pt="'+i+'" value="'+esc(list[i].p||'')+'" placeholder="元">'
          +'<span>闪送</span><input type="number" min="0" step="0.01" data-ex="'+i+'" value="'+esc(list[i].e||'')+'" placeholder="元">'
        +'</span>'
        +'<button type="button" class="ause" data-pick="'+esc(list[i].a)+'" data-kind="pt" title="只勾跑腿费、填入这条的跑腿价（会取消闪送/快递）">使用跑腿</button>'
        +'<button type="button" class="ause" data-pick="'+esc(list[i].a)+'" data-kind="ex" title="只勾闪送费、填入这条的闪送价（会取消跑腿/快递）">使用闪送</button>'
        +'<button type="button" class="acopy" data-copy="'+esc(list[i].a)+'" title="复制地址文本">复制地址</button>'
        +'<button type="button" class="ndel" data-del="'+i+'" title="删除这个地址">✕</button>'
        +'</div>';
    }
  }
  box.innerHTML=h;
}
/* 选用地址：kind='pt' 只套跑腿、kind='ex' 只套闪送 —— 跑腿/闪送/快递三者互斥，只能选一个
   （快递费没有专属价，勾快递时直接在上方手填金额即可） */
function useAddr(a,kind){
  $('fAddr').value=a;
  var nm=$('fName').value.trim();
  var hit=addrsOf(nm).filter(function(x){ return x.a===a; })[0];
  if(hit&&kind==='pt'){
    if(hit.p==null||hit.p===''){ toastErr('这条地址还没填跑腿价，请先在左边清单里填上'); return; }
    $('cbPaotui').checked=true;   $('fPaotui').value=n(hit.p);
    $('cbExpress').checked=false; $('cbKuaidi').checked=false;
    recalc();
    toast('已填入地址，只勾跑腿费 '+money(n(hit.p))+' 元');
    return;
  }
  if(hit&&kind==='ex'){
    if(hit.e==null||hit.e===''){ toastErr('这条地址还没填闪送价，请先在左边清单里填上'); return; }
    $('cbExpress').checked=true;  $('fExpress').value=n(hit.e);
    $('cbPaotui').checked=false;  $('cbKuaidi').checked=false;
    recalc();
    toast('已填入地址，只勾闪送费 '+money(n(hit.e))+' 元');
    return;
  }
  toast('已填入地址');
}
function copyAddr(a, brief){
  var txt=String(a||'').trim();
  if(!txt){ toastErr('地址为空'); return; }
  /* brief=true（摘要行的「复制」按钮）→ 只给一句轻提示，不把长地址顶出来 */
  function ok(){ toast(brief?'已复制':('地址已复制：'+txt)); }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(ok,function(){ fallbackCopy(txt, brief); });
  }else fallbackCopy(txt, brief);
}
function fallbackCopy(txt, brief){
  try{
    var ta=document.createElement('textarea');
    ta.value=txt; ta.style.position='fixed'; ta.style.left='-9999px';
    document.body.appendChild(ta); ta.select();
    var okd=document.execCommand&&document.execCommand('copy');
    document.body.removeChild(ta);
    toast(okd?(brief?'已复制':('地址已复制：'+txt)):('复制失败，请手动选中地址文字复制'));
  }catch(e){ toastErr('复制失败，请手动选中地址文字复制'); }
}

/* ---------------- 药品匹配 ---------------- */
var _idx=null;
/* 药名别名表：仅收录「药价目录里查不到、但历史处方确实在用」的写法。
   审计要求：① 目标药必须在目录中存在且有单价；② 不得重映射目录中已有药（会破坏正确匹配）。
   数据来源：对 5643 张历史处方全量扫描得出（缺价 1601 次 → 修复后 207 次）。
   注意：沙参/法半夏/姜半夏/生地/丹皮/熟地/山萸肉/龟板 目录均有货有价，故一律不做映射。 */
var ALIAS={
  /* —— 高频通用名 —— */
  '甘草':'生甘草',          /* 305次 */
  '白术':'生白术',          /* 283次 */
  /* —— 附子类（目录"制附子 0.11"经截图核对确认）—— */
  '熟附子':'制附子',        /* 36次  */
  '熟附子[另包]':'制附子',
  '熟附子[另包]':'制附子',
  '蒸附子':'制附子',        /* 45次  */
  '蒸附子[先煎]':'制附子',
  '蒸附子[先煎]':'制附子',
  '炒附子':'制附子',
  '制附片':'炮附子[先煎]',  /* 与 user 记忆一致 */
  '炮附片':'炮附子[先煎]',
  /* —— 错别字 / 异体字（目标药均已核实存在于目录且有单价）—— */
  /* 桑葚：目录中无"桑椹"药，故不映射（无处可指），保持缺价由人工补录 */
  '旋复花':'旋覆花',        /* 23次，目录作"旋覆花" 0.10 */
  '银花':'金银花',
  '二花':'金银花',
  '川仲':'川牛膝',
  '风荷贵':'凤凰衣',
  '全瓜萎':'全瓜蒌',
  '瓜萎':'瓜蒌',
  '黄苓':'黄芩',
  '厚补':'厚朴',
  '姜厚补':'厚朴',
  '莱服子':'炒莱菔子',
  '莱菔子':'炒莱菔子',
  '炒栀子':'炒山栀子',
  '栀子':'山栀子',
  '炙批把叶':'炙枇杷叶',
  '紫苑':'紫菀',
  '胆南星':'制南星',
  '元胡':'延胡索',
  '玄胡':'延胡索'
};
function normName(s){
  s=String(s||'')
    .replace(/[（(]/g,'(').replace(/[）)]/g,')')
    .replace(/[【\[]/g,'[').replace(/[】\]]/g,']')
    .replace(/\s+/g,'').trim();
  return s;
}
/* 归一化查药名：先剥脚注 [先煎]/[另包]（兼容旧的花括号写法），再查别名，最后原样 */
function normKey(s){
  var raw=normName(s);
  var bare=raw.replace(/\[[^\[\]]*\]/g,'').replace(/\{[^{}]*\}/g,'').replace(/[\[\]]/g,'');
  if(ALIAS[bare]) return ALIAS[bare];
  if(ALIAS[raw]) return ALIAS[raw];
  return raw;
}
function buildIndex(){
  _idx={};
  for(var i=0;i<drugsList.length;i++){
    var d=drugsList[i]; if(!d||!d.n) continue;
    var k=normKey(d.n); if(k) _idx[k]=d;
    var bare=normName(d.n).replace(/\[[^\[\]]*\]/g,'').replace(/\{[^{}]*\}/g,'').replace(/[\[\]]/g,'');
    if(bare && !_idx[bare]) _idx[bare]=d;
  }
  /* 别名 → 正名药 */
  for(var a in ALIAS){ var t=_idx[ALIAS[a]]; if(t && !_idx[a]) _idx[a]=t; }
}
function findDrug(name){
  if(!name) return null;
  var key=normKey(name);
  if(_idx && _idx[key]) return _idx[key];
  var bare=normName(name).replace(/\[[^\[\]]*\]/g,'').replace(/\{[^{}]*\}/g,'').replace(/[\[\]()]/g,'');
  if(_idx && _idx[bare]) return _idx[bare];
  var core=key.replace(/[\[\](){}]/g,'');
  if(_idx && _idx[core]) return _idx[core];
  var best=null, bl=0;
  for(var i=0;i<drugsList.length;i++){
    var kk=normName(drugsList[i].n).replace(/[\[\](){}]/g,'');
    if(!kk) continue;
    if(core.indexOf(kk)>=0 || kk.indexOf(core)>=0){
      if(kk.length>bl){ bl=kk.length; best=drugsList[i]; }
    }
  }
  return best;
}
/* 找出该药名的**全部**候选条目（同名多条：不同单位 / 不同进价，逐一列出供选择）
   例：红枣 → g 0.030 与 个 0.020；罗汉果 → g 0.100 与 个 2.500 */
function findDrugAll(name){
  var out=[], seen={};
  if(!name) return out;
  var key=normKey(name);
  var bare=normName(name).replace(/\[[^\[\]]*\]/g,'').replace(/\{[^{}]*\}/g,'').replace(/[\[\]()]/g,'');
  var core=key.replace(/[\[\](){}]/g,'');
  function push(d){ if(!d) return; var k=d.n+'|'+d.u+'|'+d.p; if(seen[k]) return; seen[k]=1; out.push(d); }
  if(_idx){
    push(_idx[key]); push(_idx[bare]); push(_idx[core]);
    /* 别名/去尾缀登记的同名条目也一并取出 */
    var bareK=String(bare||core);
    for(var kk in _idx){
      var kk2=String(kk).replace(/[\[\](){}]/g,'');
      if(kk2===bareK) push(_idx[kk]);
    }
  }
  for(var i=0;i<drugsList.length;i++){
    var d=drugsList[i];
    if((d.cat||'')!=='中药') continue;
    var dn=normName(d.n).replace(/\[[^\[\]]*\]/g,'').replace(/[\[\](){}]/g,'');
    if(dn===bareK || dn===core || dn===key || core.indexOf(dn)>=0) push(d);
  }
  return out;
}
/* 别名 → 正名（药物管理里每味药的「别名」字段 d.al）：
   导入 Excel 时若写的名字对上某味药的别名，就换成那味药的正名参与计价与打印。
   例：麻黄 → 艾草黄。对不上就原样返回，不猜。 */
function drugNameByAlias(nm){
  var raw=String(nm==null?'':nm).trim();
  if(!raw) return raw;
  /* 拆出尾缀（[先煎] / [另包]），别名只比主体，尾缀照旧保留 */
  var m=raw.match(/^([^\[\]{}]*)([\[\{][\s\S]*)?$/);
  var base=(m&&m[1]?m[1]:raw).trim(), sfx=(m&&m[2])?m[2]:'';
  if(!base) return raw;
  var key=normName(base), i, j;
  /* 目录里本来就有这味药（正名精确相同）→ 别拿别名去改它 */
  for(i=0;i<drugsList.length;i++){
    var dn=drugsList[i];
    if(dn&&dn.n&&normName(dn.n)===key) return raw;
  }
  for(i=0;i<drugsList.length;i++){
    var d=drugsList[i]; if(!d||!d.n) continue;
    var al=Array.isArray(d.al)?d.al:[];
    for(j=0;j<al.length;j++){
      var a=String(al[j]||'').trim();
      if(a && normName(a)===key) return d.n+sfx;
    }
  }
  return raw;
}
/* =========================================================
   常用煎服法后缀库（2026-10-30）
   · 药库里**不建**「阿胶[烊化]」这种条目，保持药库纯净；
   · 候选里的后缀变体**只按这味药的历史使用记录生成**（见下方「后缀使用记忆」），
     不再按药性给所有药硬塞后缀；
   · 每格右侧还有下拉框，不用盲打也能选；选过的会自动进记忆。
   ========================================================= */
/* 常用后缀的默认清单（首次使用 / 用户清空后的兜底）。
   2026-10-30 起真正生效的清单存在 rx_sfx_v1，由【设置 → 后缀管理】维护，
   这里只是出厂默认值。 */
var SFX_DEFAULT=['先煎','后下','包煎','另煎','烊化','冲服','研粉冲服','煎汤代水','打碎','另包'];
var LS_SFX='rx_sfx_v1';
var SFX_ITEMS=[];          /* [{n:'先煎',py:'xj'}] —— 带编码，编码用于助记码（ajfp + yh） */
var SFX_LIB=[];            /* 只取名字，历史代码直接遍历它 */
/* 后缀 → 拼音首字母（拼在药名助记码后面，ajfp + 烊化(yh) = ajfpyh） */
var SFX_PY={'先':'x','煎':'j','后':'h','下':'x','包':'b','另':'l','烊':'y','化':'h',
            '冲':'c','服':'f','研':'y','粉':'f','汤':'t','代':'d','水':'s','打':'d','碎':'s',
            '泡':'p','炖':'d','焗':'j','调':'t','含':'h','嚼':'j','温':'w','冷':'l',
            '饭':'f','前':'q','睡':'s','觉':'j','外':'w','用':'y','洗':'x','熏':'x',
            '汁':'z','榨':'z','末':'m','茶':'c','饮':'y','兑':'d','入':'r','蒸':'z'};
/* 只按字表拼（不看用户覆盖）—— 设置里填了编码才用用户那份 */
function pyByChar(s){
  var out='', t=String(s||'').trim();
  for(var j=0;j<t.length;j++){ var p=SFX_PY[t[j]]; if(!p) return ''; out+=p; }
  return out;
}
function pyOfSfx(s){
  var t=String(s||'').trim();
  /* 用户自定义过编码的，以设置为准 */
  for(var i=0;i<SFX_ITEMS.length;i++){
    if(SFX_ITEMS[i] && SFX_ITEMS[i].n===t && SFX_ITEMS[i].py) return SFX_ITEMS[i].py;
  }
  return pyByChar(t);
}
function sfxApply(list){
  SFX_ITEMS=list.slice();
  SFX_LIB.length=0;
  for(var i=0;i<SFX_ITEMS.length;i++) SFX_LIB.push(SFX_ITEMS[i].n);
}
function sfxLoad(){
  var raw=null;
  try{ raw=JSON.parse(RX_STORE.getItem(LS_SFX)||'null'); }catch(e){ raw=null; }
  var arr=[], seen={};
  if(raw && raw.length){
    for(var i=0;i<raw.length;i++){
      var x=raw[i];
      var n=String((typeof x==='string')?x:((x&&x.n)||'')).trim();
      if(!n || seen[n]) continue;
      seen[n]=1;
      var py=String((x&&typeof x==='object'&&x.py)||'').trim().toLowerCase();
      arr.push({n:n, py:py||pyByChar(n)||''});
    }
  }
  /* 云端没有后缀时就是空列表，不再用内置默认值兜底 */
  sfxApply(arr);
}
function sfxSave(list){
  var out=[], seen={};
  for(var i=0;i<(list||[]).length;i++){
    var n=String(list[i].n||'').trim();
    if(!n || seen[n]) continue;
    seen[n]=1;
    var py=String(list[i].py||'').trim().toLowerCase();
    out.push({n:n, py:py||pyByChar(n)||''});
  }
  sfxApply(out);
  RX_STORE.setItem(LS_SFX, JSON.stringify(out));
  return out;
}
/* sfxLoad() 在 init() 里调用（此时云端 KV 已载入内存） */
/* =========================================================
   后缀「使用记忆」（2026-10-30 第八轮）
   用户要求：不要再按药性给每味药无脑塞「先煎 / 后下」，只有**这味药真的用过**
   的后缀才出现在备选里（好蘄 → 好蘄[打碎]、好蘄[先煎]）。
   · 数据来源 = 处方本身（云端 prescriptions 表的 items / 本机 SAVED 的 m 字段），
     不新增表、不新增列；每次保存后自动重算，换设备也跟着处方一起同步；
   · 每味药只留「用过次数最多的前 3 个」后缀，数据不会无限膨胀；
   · 只认「设置 → 后缀管理」里还在的后缀：用户删掉的后缀，历史用过也不再冒出来。
   ========================================================= */
var SFXMEM={}, SFXMEM_TOPN=3, _sfxMemSig='';
/* 处方 m 形如「砂仁[后下] 10g     人参 5g」→ 抓「药名 + 后缀」 */
var RE_SFXMEM=/([\u4e00-\u9fa5A-Za-z0-9（）\.]{1,12})\s*[\[［]\s*([^\]］]{1,8}?)\s*[\]］]/g;
function sfxMemKey(nm){
  var sp=splitSfx(String(nm||''));
  return String(sp.nm||nm||'').trim();
}
/* 只留前 SFXMEM_TOPN 名（次数降序，同次数按名字稳定排序） */
function sfxMemPrune(o){
  var arr=[], k;
  for(k in o) if(o[k]>0) arr.push([k,o[k]]);
  arr.sort(function(a,b){ return b[1]-a[1] || (a[0]<b[0]?-1:1); });
  var out={};
  for(var i=0;i<arr.length && i<SFXMEM_TOPN;i++) out[arr[i][0]]=arr[i][1];
  return out;
}
function sfxMemSig(){
  var h=(typeof HISTORY_ORIG!=='undefined'&&HISTORY_ORIG)||[];
  var s=(typeof SAVED!=='undefined'&&SAVED)||[];
  function fp(a){
    if(!a.length) return '';
    var f=a[0]||{}, l=a[a.length-1]||{};
    return String(f.no||f.n||'')+'~'+String(l.no||l.n||'');
  }
  return h.length+'/'+fp(h)+'|'+s.length+'/'+fp(s)+'|'+SFX_LIB.join(',');
}
function sfxMemRebuild(){
  var mem={}, src=[], i;
  if(typeof HISTORY_ORIG!=='undefined'&&HISTORY_ORIG) for(i=0;i<HISTORY_ORIG.length;i++) src.push(HISTORY_ORIG[i]);
  if(typeof SAVED!=='undefined'&&SAVED) for(i=0;i<SAVED.length;i++) src.push(SAVED[i]);
  for(i=0;i<src.length;i++){
    var s=String((src[i]&&src[i].m)||'');
    if(s.indexOf('[')<0 && s.indexOf('［')<0) continue;   /* 大多数处方没有后缀，直接跳过 */
    var mm; RE_SFXMEM.lastIndex=0;
    while((mm=RE_SFXMEM.exec(s))!==null){
      var nm=String(mm[1]||'').replace(/^[0-9.]+/,'').trim();
      var sf=String(mm[2]||'').trim();
      if(!nm||!sf) continue;
      if(SFX_LIB.indexOf(sf)<0) continue;
      var o=mem[nm]||(mem[nm]={});
      o[sf]=(o[sf]||0)+1;
    }
  }
  var out={};
  for(var k in mem) out[k]=sfxMemPrune(mem[k]);
  SFXMEM=out; _sfxMemSig=sfxMemSig();
  return out;
}
function sfxMemEnsure(){
  if(!_sfxMemSig || _sfxMemSig!==sfxMemSig()) sfxMemRebuild();
}
function sfxMemInvalidate(){ _sfxMemSig=''; }
/* 这味药用过的后缀（次数降序，最多 3 个）；从没用过 → 空数组（备选里就只有基础名） */
function sfxMemFor(nm){
  var key=sfxMemKey(nm);
  if(!key) return [];
  sfxMemEnsure();
  var o=SFXMEM[key];
  if(!o) return [];
  var arr=[];
  for(var s in o) arr.push([s,o[s]]);
  arr.sort(function(a,b){ return b[1]-a[1] || (a[0]<b[0]?-1:1); });
  return arr.map(function(x){ return x[0]; });
}
/* 手动在格尾下拉里选了一个「这味药没用过」的后缀 → 立刻进记忆（保存后由处方本身固化） */
function sfxMemAdd(nm, sfx, inc){
  var key=sfxMemKey(nm), s=String(sfx||'').trim();
  if(!key || !s || SFX_LIB.indexOf(s)<0) return false;
  sfxMemEnsure();
  var o=SFXMEM[key]||(SFXMEM[key]={});
  o[s]=(o[s]||0)+(inc==null?1:inc);
  SFXMEM[key]=sfxMemPrune(o);
  return true;
}
/* 药库里没有、但历史上用过的药名（用户自定义名，如「好蘄」）：
   按前缀 / 包含匹配给出候选，价格未知（显示 —），由用户自己填。 */
function sfxMemNames(q, limit){
  var s=String(q||'').trim();
  if(!s) return [];
  sfxMemEnsure();
  var pre=[], mid=[], k;
  for(k in SFXMEM){
    if(!SFXMEM[k]) continue;
    if(k.indexOf(s)===0) pre.push(k);
    else if(k.indexOf(s)>=0) mid.push(k);
  }
  var arr=pre.concat(mid).slice(0, limit||5);
  return arr.map(function(x){ return { n:x, u:'g', p:null, c:'', py:'', __memonly:1 }; });
}
/* 药名自动提示：按目录顺序过滤（基础命中，不含后缀变体）
   ★ 一药多规格：主规格之后紧跟该药的其它规格（盒 / 个 / 瓶…），
     这样药物管理里新加的规格不用做任何同步，下次打单立刻能选到。 */
function acSearchBase(q){
  q=String(q||'').trim();
  if(!q) return [];
  var ql=q.toLowerCase(), out=[], seen={};
  function push(d){
    if(!d) return;
    var k=d.n+'|'+d.u+'|'+d.p;
    if(seen[k]) return; seen[k]=1; out.push(d);
    /* 该药的子规格（s≥1），一行一条，带各自的单位 / 零售价 / 常用量 */
    var sp=(typeof dmSpecsOf==='function')?dmSpecsOf(d):[];
    for(var j=1;j<sp.length;j++){
      var x=sp[j]; if(!x || !x.unit) continue;
      var k2=d.n+'|'+x.unit+'|'+x.p;
      if(seen[k2]) continue; seen[k2]=1;
      out.push({ n:d.n, u:x.unit, p:x.p, c:x.amt, py:d.py, cat:d.cat,
                 al:d.al, og:d.og, __spec:1 });
    }
  }
  /* 精确/前缀命中优先：把同名不同单位、不同价格的条目全部列出，让用户按需选 */
  var first=[], mid=[];
  for(var i=0;i<drugsList.length;i++){
    var d=drugsList[i], nm=String(d.n||'');
    if(!nm) continue;
    if((d.cat||'')!=='中药') continue;               /* 只提示中药（处方只开饮片） */
    if(hasDoseInName(nm)) continue;                  /* 跳过「山药10g」这类带剂量尾巴的脏数据 */
    var hit = nm.indexOf(q)>=0 || String(d.py||'').toLowerCase().indexOf(ql)>=0;
    if(!hit) continue;
    (nm.indexOf(q)===0 ? first : mid).push(d);
  }
  first.concat(mid).forEach(push);
  return out.slice(0,30);
}
/* 候选 = 基础命中 + **历史用过的**后缀变体（不再按药性硬塞）。
   · 正常输入（ajfp）：主名在前；前 3 条若这味药有后缀记忆，各补上记忆里的后缀变体；
   · 只打了后缀码（ajfpyh）：识别结尾的 yh，把记忆里对得上的后缀排到最前。
   从未用过后缀的药（如甘草）→ 只出现基础名，不会冒出「先煎 / 后下」。 */
function acSearch(q){
  var base=acSearchBase(q), onlyVar=false, wantPy='', z, i;
  if(!base.length){
    var qs=String(q||'');
    for(z=0;z<SFX_LIB.length;z++){
      var pz=pyOfSfx(SFX_LIB[z]);
      if(!pz || qs.length<=pz.length) continue;
      if(qs.toLowerCase().slice(-pz.length)!==pz) continue;
      var b2=acSearchBase(qs.slice(0,qs.length-pz.length));
      if(b2.length){ base=b2; onlyVar=true; wantPy=pz; break; }
    }
  }
  /* 药库里查不到（用户自定义名，如「好蘄」）→ 退回按历史记忆里的药名给候选 */
  if(!base.length) base=sfxMemNames(q, 5);
  if(!base.length) return base;
  var out=[], seen={}, vn=0;
  function pushVar(d){
    var ss=sfxMemFor(d.n);            /* 只取这味药历史上用过的后缀（最多 3 个） */
    if(!ss.length) return;
    if(wantPy){
      /* 打了后缀码 → 对得上的排前面（其余仍列在后面，方便直接改选） */
      ss=ss.slice().sort(function(a,b){ return (pyOfSfx(b)===wantPy?1:0)-(pyOfSfx(a)===wantPy?1:0); });
    }
    for(var j=0;j<ss.length;j++){
      if(vn>=8) return;
      var nn=d.n+'['+ss[j]+']';
      if(seen['S|'+nn]) continue;
      seen['S|'+nn]=1; vn++;
      out.push({n:nn, u:d.u, p:d.p, c:d.c, py:String(d.py||'')+pyOfSfx(ss[j]),
                __sfx:1, base:d.n, sfx:ss[j]});
    }
  }
  for(i=0;i<base.length && out.length<30;i++){
    var d=base[i];
    /* 药库里还残留「阿胶福牌[烊化]」这类独立后缀条目：统一转成「主名 + 后缀胶囊」的形态，
       与下面动态生成的变体同名去重，列表里只出现一次（药库干净时走不到这里）。 */
    if(!d.__sfx && /[\[［{][^\]］}]+[\]］}]\s*$/.test(String(d.n||''))){
      var sp0=splitSfx(d.n);
      d={ n:d.n, base:sp0.nm, sfx:sfxText(sp0.sfx), u:d.u, p:d.p, c:d.c, py:d.py, __sfx:1 };
    }
    /* 去重：后缀条目按全名，主条目按「药名 + 单位」——
       同一味药的 g / 盒 / 个 是不同选项，不能互相吞掉 */
    var dk=d.__sfx ? ('S|'+d.n) : ('M|'+String(d.n)+'|'+String(d.u||''));
    if(seen[dk]) continue;
    seen[dk]=1;
    if(onlyVar){ if(!d.__spec && !d.__sfx) pushVar(d); out.push(d); }   /* 按后缀码搜：带后缀的排前面 */
    else { out.push(d); if(i<3 && !d.__spec && !d.__sfx) pushVar(d); }  /* 普通搜：主名在前 */
  }
  return out.slice(0,30);
}

/* ---------------- 药方文本解析 / 生成 ---------------- */
var UNIT_RE='g|克|kg|KG|斤|个|片|粒|袋|盒|支|瓶|ml|ML|丸|贴|包|条|把';
var DOSE_RE=new RegExp('^(\\d+(?:\\.\\d+)?)('+UNIT_RE+')?$');
var GLUE_RE=new RegExp('^(.*[^\\d.])(\\d+(?:\\.\\d+)?)('+UNIT_RE+')?$');
function normUnit(u){
  u=String(u||'').trim().toLowerCase();
  if(!u) return 'g';                 /* 无单位默认按 g */
  if(u==='克'||u==='g'||u==='ｇ') return 'g';
  if(u==='kg'||u==='千克'||u==='公斤'||u==='㎏') return 'kg';   /* kg/Kg/KG 与 千克/公斤 统一 */
  if(u==='ml'||u==='毫升') return 'ml';
  return u;                         /* 个/条/盒/斤 等非重量单位原样保留 */
}
/* CSV 导入可识别的单位（normUnit 归一后）。不在此表 → 视为「未识别到单位」，须提示用户。 */
var KNOWN_UNITS={ g:1,kg:1,斤:1,ml:1,个:1,条:1,盒:1,包:1,瓶:1,片:1,罐:1,袋:1,支:1,粒:1,贴:1,把:1,丸:1,只:1,对:1,张:1,卷:1,块:1,束:1 };
function mkItem(name,qty,unit,zibei){
  /* du=选定的计价单位；dp=该单位对应的单价（选哪个候选就用哪个单位的价格） */
  return {name:String(name||'').trim(),qty:qty||0,unit:unit||'',zibei:!!zibei,price:null,nm0:null,zibeiTxt:'',du:'',dp:null};
}
function parseItems(txt){
  var out=[];
  if(!txt) return out;
  var toks=String(txt).replace(/[\r\n]+/g,' ').split(/[\s,，、;；]+/).filter(Boolean);
  var i=0;
  while(i<toks.length){
    var t=toks[i];
    if(DOSE_RE.test(t)){ i++; continue; }
    var m=(i+1<toks.length)?toks[i+1].match(DOSE_RE):null;
    if(m){ out.push(mkItem(t,parseFloat(m[1]),normUnit(m[2]))); i+=2; continue; }
    if(/自备$/.test(t)){ out.push(mkItem(t.replace(/自备$/,''),0,'',true)); i++; continue; }
    var sm=t.match(GLUE_RE);
    if(sm && sm[1]){ out.push(mkItem(sm[1],parseFloat(sm[2]),normUnit(sm[3]))); i++; continue; }
    out.push(mkItem(t,0,'',true));
    i++;
  }
  return out.filter(function(x){return x.name;});
}
function doseText(it){
  if(!it||!it.name) return '';
  if(it.zibei) return '自备';
  if(!it.qty) return '';
  return (+it.qty)+(it.unit||'g');
}
function itemText(it){ return doseText(it)?(it.name+' '+doseText(it)):it.name; }

/* ---------------- 处方笺格子 ---------------- */
function filledItems(){
  var out=[];
  for(var i=0;i<items.length;i++) if(items[i]&&items[i].name) out.push(items[i]);
  return out;
}
function filledCount(){ return filledItems().length; }
function cellCount(size){ return Math.max(12, Math.ceil((size+1)/3)*3+3); }
function firstEmptyIndex(){
  for(var i=0;i<items.length;i++) if(!items[i]||!items[i].name) return i;
  return items.length;
}
function padCells(){
  var need=cellCount(filledCount());
  while(items.length<need) items.push(mkItem('',0,'',false));
  if(items.length>need) items.length=need;
  return need;
}
/* 拆出 [后下]/[先煎]/[另包] 之类尾缀（书剑软件用方括号） */
/* 拆出 [后下]/[先煎]/[另包] 之类尾缀（书剑软件用方括号） */
function splitSfx(name){
  var s=String(name||''), m=s.match(/^(.*?)\s*[\[［]([^\]］]*)[\]］]\s*$/);
  if(m) return {nm:m[1], sfx:'['+m[2]+']'};
  /* 兼容旧数据里可能残留的花括号 */
  var m2=s.match(/^(.*?)\s*\{([^{}]*)\}\s*$/);
  if(m2) return {nm:m2[1], sfx:'['+m2[2]+']'};
  return {nm:s, sfx:''};
}
/* ---- 煎煮标签显示文本：去掉外层方括号（2026-10-07 用户要求）----
   ⚠ 只在**渲染时**剥括号，**绝不动 it.name 里的数据**：
   it.name 存的是「制附子[先煎]」，药名匹配、别名表、剂量正则
   （DOSE_SUFFIX_RE）、normalize 全部依赖带括号的原格式。
   之前 readCell 里就有 `it.name = base + sfxTxt` 把括号写回去的逻辑，
   一旦在这里改数据就会反复被覆写、还会打断自动划价的查药。
   所以：数据保留 [先煎]，显示层用 sfxText() 输出「先煎」。 */
function sfxText(sfx){
  return String(sfx||'').replace(/^[\[［]\s*/,'').replace(/\s*[\]］]\s*$/,'');
}
/* ---- 打印图专用：保留或补上方括号（2026-10-07 用户要求）----
   屏幕界面用 sfxText() 去括号（先前确认的需求，不要改），
   **打印图/小票用本函数输出「[先煎]」「[后下]」这种带方括号的形式**。
   药名本身若已带括号则原样保留（宽度一致），没带才补上，
   全角/半角方括号统一成半角，套上 CSS 不换行。*/
function sfxTextBr(sfx){
  var raw=String(sfx||'').trim();
  if(!raw) return '';
  var inner=raw.replace(/^[\[［{]\s*/,'').replace(/\s*[\]］}]\s*$/,'').trim();
  if(!inner) return '';
  return '['+inner+']';
}
/* 把处方笺字体设置应用到屏幕上的实时预览（.rxs#rxSheet） */
/* 姓名/日期固定 12px（不受「处方字号」影响，也不可自定义） */
var RX_HEAD_FS='12px', RX_HEAD_FW='700';
function applySheetFont(){
  var box=$('rxSheet'); if(!box) return;
  var FS=rxFontPx(), FW=rxFontWeight(), LH=rxLineHeight();
  box.style.fontSize=FS+'px';
  box.style.lineHeight=LH;
  box.style.fontWeight=FW;
  /* 姓名 / 日期：固定 12 号、加粗 */
  var hd=box.querySelectorAll('.rxhead .lbl,.rxhead b,.rxhead input');
  for(var i=0;i<hd.length;i++){
    hd[i].style.fontSize=RX_HEAD_FS;
    hd[i].style.lineHeight='1.6';
    hd[i].style.fontWeight=RX_HEAD_FW;
  }
  /* 药名 / 克数 / 尾缀：跟随设置 */
  var cs=box.querySelectorAll('.cell .nm,.cell .ds,.cell .sfx');
  for(var j=0;j<cs.length;j++){
    cs[j].style.fontSize=FS+'px';
    cs[j].style.lineHeight=LH;
    cs[j].style.fontWeight=FW;
  }
}
/* renderSheet 正在重建格子的标志：innerHTML 替换旧格子会同步触发旧输入框的
   blur/focusout，此时若让 focusout 处理器 readCell，读到的是旧格子的残值，
   会把刚载入的药味从 items 里清掉（2026-10-21 刘一衡 大枣[斤] 凭空消失实测）。 */
var RX_SHEET_BUILDING=false;
function renderSheet(){
  /* 先置标志再动 DOM：innerHTML 替换旧格子时会在赋值语句内部同步触发
     旧输入框的 blur/focusout，标志必须在事件发生前就已就位 */
  RX_SHEET_BUILDING=true;
  var g=$('sGrid'), h='', allEmpty=(filledCount()===0);
  for(var i=0;i<items.length;i++){
    var it=items[i]||mkItem('',0,'',false);
    var sp=splitSfx(it.name);
    /* 尾缀语义类别：让 [先煎]/[后下]/[另包] 上不同色标签（纯视觉，值不变） */
    var sk=sfxKind(sp.sfx);
    /* 空药名行加 .empty：CSS 据此把这一格的输入框完全透明（用户要求隐藏空白药品行） */
    var isEmpty=(!sp.nm && !doseText(it) && !sp.sfx);
    h+='<div class="cell'+(it.zibei?' zibei':'')+(isEmpty?' empty':'')+(sk?'" data-sfx-kind="'+sk:'')+'" data-i="'+i+'">'
      +cellHTML(i, sp.nm, doseText(it), sfxText(sp.sfx), false,
                (allEmpty&&i===0?'在此粘贴药方，或输入药名':''))
      +'</div>';
  }
  g.innerHTML=h;
  if(typeof closeSfxPick==='function') closeSfxPick();   /* 重建前先收起后缀浮层，免得挂在新格子上 */
  rxFitCols();
  applySheetFont();
  if(typeof rcptHint==='function') rcptHint();
  fitAllCells();
  /* 格子已重建：框选/点选高亮失效，重置状态避免错位 */
  if(typeof clearRngMark==='function'){ rngStart=-1; rngEnd=-1; }
  if(typeof setPickMode==='function'&&pickMode){ /* 保留点选模式但清高亮 */ }
  if($('sheetStat')) $('sheetStat').textContent=priced?('共 '+filledCount()+' 味'):'';
  recalc();
  RX_SHEET_BUILDING=false;
  return g;
}
/* 药名按内容宽度（中文算2、英文数字算1，单位 em），最少 5 字，不再截断；克数同样自适应 */
function fitCell(k){
  var c=cellEl(k); if(!c) return;
  var nm=c.querySelector('.nm'), ds=c.querySelector('.ds');
  if(!nm||!ds) return;
  nm.style.width=''; ds.style.width='';
  var nv=nm.value||'';
  if(nv){
    var w=0;
    for(var i=0;i<nv.length;i++) w += (/[\u4e00-\u9fa5\uff00-\uffef]/.test(nv[i]))?2:1;
    nm.style.width=Math.max(5,w*0.55+0.6)+'em';   /* 最少 5 字宽 */
  }
  var dv=ds.value||'';
  if(dv) ds.style.width=Math.max(2.4,dv.length*0.6+0.5)+'em';
}
function fitAllCells(){
  for(var i=0;i<items.length;i++) fitCell(i);
}
/* ---- 响应式列数：按处方区实际可用宽度决定 3 / 2 / 1 列，保证药名+克数完整可见 ----
   窗口缩小或拖动分栏时自动重排；一行三味是「宽屏默认」，窄屏自动降为两列/一列 */
var RX_MIN_COL=176;     /* 单列至少要放得下 5 字药名 + 克数 + 后缀胶囊 + 两侧按钮（2026-10-30：150 太挤，胶囊会顶到隔壁） */
function rxFitCols(){
  var g=$('sGrid'); if(!g) return;
  var w=g.clientWidth||0;
  if(!w) return;
  var n=Math.max(1,Math.min(3,Math.floor((w+10)/(RX_MIN_COL+10))));
  if(g.getAttribute('data-cols')!==String(n)) g.setAttribute('data-cols',String(n));
  g.style.gridTemplateColumns='repeat('+n+',minmax(0,1fr))';
  fitAllCells();
}
/* ================= 可拖拽四栏 =================
   三根 .vsplit 分别调 left / pl / right 的宽度，center 用 flex:1 自动填满。
   · 用 mousedown/mousemove/mouseup + rAF 节流，拖动跟手；
   · 每栏有 minWidth，拖不塌；center 也留了 360px 下限；
   · 宽度存 RX_STORE（rx_cols_v1），下次打开恢复；
   · 窗口变窄时若总宽超出可用空间，等比回缩三栏，保证不撑破布局。
   不改任何业务逻辑，纯布局。 */
/* 三栏的可拖下限。与 CSS 里 .main>.panel.* 的 min-width 保持一致，
   两处必须一样，否则拖到 200 后 flex-shrink 又把它收回去，行为自相矛盾。 */
var VS_MIN = { left:200, pl:280, right:280, center:560 };
var VS_DEF = { left:272, pl:330, right:330 };
var VS_KEY = 'rx_cols_v1';
var VS_MAX = 1200;         /* 单栏上限：RX_STORE 被写坏时不至于把别的栏挤没 */
/* center 是处方笺，实测 3 列网格在 560px 时每格 190px（药名+克数+脚注都不挤）；
   240px 时每格只剩 70px、#rxSheet 内层被裁 188px，药名剂量全叠一起。
   所以 560px 是硬地板：视口不够就让三栏先让，绝不压 center。 */
var VS_WC_FLOOR = 560;
var VS_WC_PREF  = 560;

function vsMain(){ return document.querySelector('.main'); }

function vsRead(){
  var o = null;
  try{ o = JSON.parse(RX_STORE.getItem(VS_KEY)||'null'); }catch(e){ o=null; }
  if(!o || typeof o!=='object') o = {};
  var w = { left:o.left, pl:o.pl, right:o.right };
  for(var k in VS_DEF){
    var v = w[k];
    /* 脏数据（字符串、负数、超大值）一律回落到默认值，不进内存 */
    w[k] = (typeof v==='number' && isFinite(v) && v>=VS_MIN[k] && v<=VS_MAX)
         ? Math.round(v) : VS_DEF[k];
  }
  return w;
}
function vsWrite(w){
  try{ RX_STORE.setItem(VS_KEY, JSON.stringify(w)); }catch(e){}
}
function vsApply(w){
  var m = vsMain(); if(!m) return;
  m.style.setProperty('--wl',  w.left+'px');
  m.style.setProperty('--wpl', w.pl+'px');
  m.style.setProperty('--wr',  w.right+'px');
}
/* 视口的横向空间（扣掉 .main 的 padding 和 3 根分隔条）。
   宽度基准取滚动层 .mainScroll（它 flex:1 1 0，clientWidth 就是视口宽）；
   没有 wrapper 时退回 body。绝不用 m.clientWidth —— 四栏 flex:0 1 会把
   .main 自己撑到内容宽，拿它算会自我循环。 */
function vsAvail(){
  var m = vsMain(); if(!m) return 0;
  var box = m.parentNode;
  if(!(box && box.classList && box.classList.contains('mainScroll'))) box = document.body;
  var cs = getComputedStyle(m);
  var w = box.clientWidth - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0);
  var splits = m.querySelectorAll('.vsplit');
  var sw = 0;
  for(var i=0;i<splits.length;i++) sw += splits[i].offsetWidth;
  return w - sw;
}
/* 分配规则（纯函数，不改用户意图值 w）：
     1. 三栏用用户设定的绝对 px（各自夹在 min/max 之间）；
     2. center = 视口剩余空间，下限 VS_WC_FLOOR(560)；
     3. 剩余不足 560 时：先压三栏超出各自 min 的部分来补 center；
        三栏都到 min 仍不够 —— 交给 CSS 的 flex-shrink 收三栏（min-width 兜底），
        center 保持 560 绝不退让（处方笺被压比窗口横向溢出更糟）。
     窗口拉大后 center 自动回到剩余空间，三栏宽度原样回来。 */
function vsFit(w){
  var m = vsMain(); if(!m) return w;
  var a = { left:w.left, pl:w.pl, right:w.right };
  if(a.left  < VS_MIN.left)  a.left  = VS_MIN.left;
  if(a.pl    < VS_MIN.pl)    a.pl    = VS_MIN.pl;
  if(a.right < VS_MIN.right) a.right = VS_MIN.right;
  if(a.left  > VS_MAX) a.left  = VS_MAX;
  if(a.pl    > VS_MAX) a.pl    = VS_MAX;
  if(a.right > VS_MAX) a.right = VS_MAX;

  var avail = vsAvail();
  var minSum = VS_MIN.left + VS_MIN.pl + VS_MIN.right;
  var wc = avail - a.left - a.pl - a.right;

  if(wc < VS_WC_FLOOR){
    /* 视口不够：先把三栏压到各自下限，给 center 腾出地板宽度。
       2026-10-27：左侧加了 208px 导航后，可用宽从 1386 掉到 1178，
       原条件 `avail - 560 >= 760` 不成立 → 整个压缩分支被跳过，
       三栏仍保持 272/330/330，.main 被 min-width:max-content 撑到 1582px、
       横向滚动 350px。这与本函数注释「视口不够就让三栏先让，绝不压 center」矛盾。
       现在改成：压缩**总是执行**，只是系数不同 —— 宽裕时 k 让 center 刚好够地板
       （与原逻辑一致），紧张时 k 钳到 0 → 三栏压到 VS_MIN、center 仍保 560 地板。
       RX_STORE 里的用户栏宽不变（vsFit 只写 CSS 变量，不写存储）。 */
    var room = avail - VS_WC_FLOOR;
    var over = { l:a.left-VS_MIN.left, p:a.pl-VS_MIN.pl, r:a.right-VS_MIN.right };
    var oSum = over.l + over.p + over.r;
    var cur  = a.left + a.pl + a.right;
    if(oSum > 0 && cur > room){
      var k = (room - minSum) / oSum;
      if(k < 0) k = 0; if(k > 1) k = 1;
      a.left  = Math.round(VS_MIN.left  + over.l*k);
      a.pl    = Math.round(VS_MIN.pl    + over.p*k);
      a.right = Math.round(VS_MIN.right + over.r*k);
    }
    wc = avail - a.left - a.pl - a.right;
  }
  if(wc < VS_WC_FLOOR) wc = VS_WC_FLOOR;
  m.style.setProperty('--wc', wc+'px');
  m.style.setProperty('--wl',  a.left+'px');
  m.style.setProperty('--wpl', a.pl+'px');
  m.style.setProperty('--wr',  a.right+'px');
  /* .mainScroll 的 flex/width 一律不动 —— 实测 JS 改它的 flex 会脱离
     「flex:1 拿高度」，纵向直接塌成内容高（main 662 → 14316px）。
     横向溢出交给 .main 的 min-width:max-content + wrapper 的 overflow-x:auto。 */
  /* 视口比「三栏 min + center 地板 + 分隔条」还窄时（<~1362px），再压 center 就真挤坏了，
     这时让 .main 出横向滚动条。写一个 --vs-overflow 标记给 CSS 用。 */
  var floorTotal = VS_MIN.left + VS_MIN.pl + VS_MIN.right + VS_WC_FLOOR;
  m.classList.toggle('vsNarrow', avail < floorTotal);
  return a;
}
function vsBind(){
  var m = vsMain(); if(!m) return;
  var w = vsRead();
  vsApply(w);
  vsFit(w);

  var cur = null;      /* 当前拖的哪一根 */
  var startX = 0, startW = 0, pending = 0, raf = 0;

  function flush(){
    raf = 0;
    if(!cur) return;
    var v = startW + pending;
    if(v < VS_MIN[cur]) v = VS_MIN[cur];
    if(v > VS_MAX) v = VS_MAX;
    /* 别把 center 挤没了：可用宽度不够就停 */
    var others = 0;
    if(cur!=='left') others += w.left;
    if(cur!=='pl')   others += w.pl;
    if(cur!=='right')others += w.right;
    var maxW = vsAvail() - others - VS_WC_PREF;
    if(v > maxW) v = Math.max(VS_MIN[cur], maxW);
    w[cur] = Math.round(v);
    vsFit(w);
  }
  function onMove(e){
    if(!cur) return;
    pending = e.clientX - startX;
    if(!raf) raf = requestAnimationFrame(flush);
  }
  function onUp(){
    if(!cur) return;
    /* 最后一帧 rAF 可能还没跑就松手了 —— 先同步补一次，否则会丢掉尾巴那几像素 */
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
    flush();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    var el = m.querySelector('.vsplit[data-vs="'+cur+'"]');
    if(el) el.classList.remove('dragging');
    document.body.classList.remove('vsDragging');
    cur = null; pending = 0;
    vsWrite(w);
  }

  var splits = m.querySelectorAll('.vsplit');
  for(var i=0;i<splits.length;i++){
    (function(el){
      var key = el.getAttribute('data-vs');
      el.addEventListener('mousedown', function(e){
        if(e.button !== 0) return;
        e.preventDefault();
        cur = key; startX = e.clientX; startW = w[key]; pending = 0;
        el.classList.add('dragging');
        document.body.classList.add('vsDragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      /* 双击恢复默认宽度 */
      el.addEventListener('dblclick', function(){
        w = { left:VS_DEF.left, pl:VS_DEF.pl, right:VS_DEF.right };
        vsFit(w); vsWrite(w);
        toast('已恢复默认栏宽');
      });
    })(splits[i]);
  }

  /* 窗口尺寸变化时只重排，不改 RX_STORE ——
     用户拖出来的宽度是宝贵的，窗口临时变小不该被永久压缩掉。
     窗口变大时宽度自动就回来了（vsFit 是纯函数，且存的是绝对 px 不是比例）。 */
  var rt = 0;
  window.addEventListener('resize', function(){
    clearTimeout(rt);
    rt = setTimeout(function(){ vsFit(w); }, 120);
  });
}

function rxWatchResize(){
  if(typeof ResizeObserver==='function'){
    var g=$('sGrid'); if(!g) return;
    new ResizeObserver(function(){ rxFitCols(); }).observe(g);
  }
  window.addEventListener('resize',function(){ rxFitCols(); });
}
/* ---- 整个药方全选 / 一键清空 ---- */
function selectAllCells(){
  var L=filledCount();
  if(!L){ toastErr('处方笺是空的'); return; }
  selAll=true;
  var nodes=$('sGrid').querySelectorAll('.cell');
  for(var i=0;i<nodes.length;i++) nodes[i].classList.toggle('allsel',!!(items[i]&&items[i].name));
  var first=cellEl(0);
  if(first){ try{ first.querySelector('.nm').focus(); first.querySelector('.nm').setSelectionRange(0,first.querySelector('.nm').value.length); }catch(e){} }
  toast('已全选 '+L+' 味　按 Delete 键清空整个药方（点任意格可取消）');
}
function clearAllCells(){
  if(!selAll) return;
  if(!confirm('确定清空整个药方的 '+filledCount()+' 味药吗？\n\n姓名、日期、剂数会保留。')){ return; }
  selAll=false;
  items=[]; priced=false;
  padCells();
  $('fPerDose').value=''; $('fProcess').value=''; $('fGoods').value='';
  $('fDaijian').value=''; $('fPaotui').value=''; $('fExpress').value=''; $('fKuaidi').value='';
  $('cbProcess').checked=false; $('cbDaijian').checked=false;
  $('cbPaotui').checked=false; $('cbExpress').checked=false; $('cbGoods').checked=false; $('cbKuaidi').checked=false;
  renderSheet(); renderPriceList();
  clearSelMark();
  toast('已清空整个药方');
}
function cellEl(k){ return $('sGrid').querySelector('.cell[data-i="'+k+'"]'); }
/* 找同名的其它格子（去重用）
   比较时忽略空格与括号全半角差异，但【保留 {尾缀}】：
   「丹皮」与「丹皮[另包]」在药价目录里是两条独立药（各有单价），不算重名 */
function dupNameIndex(name,k){
  var key=dupKey(name);
  if(!key) return -1;
  for(var i=0;i<items.length;i++){
    if(i===k) continue;
    var it=items[i];
    if(!it||!it.name) continue;
    var k2=dupKey(it.name);
    if(k2 && k2===key) return i;
  }
  return -1;
}
function dupKey(s){
  return String(s||'').replace(/\s+/g,'').replace(/（/g,'(').replace(/）/g,')');
}
function readCell(k){
  var cell=cellEl(k); if(!cell) return null;
  var nmIn=cell.querySelector('.nm'), dsIn=cell.querySelector('.ds'), sxIn=cell.querySelector('.sfx');
  if(!nmIn||!dsIn) return null;
  var nm=nmIn.value.trim(), ds=dsIn.value.trim();
  /* 尾缀并回药名（保证 findDrug/计价/保存都能匹配到目录正名）。
     ⚠ 界面 .sfx 显示的是**去括号**版（「先煎」），直接拼回 it.name 会把
     「制附子[先煎]」写成「制附子先煎」——括号在数据层就没了，
     打印图/小票再想输出「[先煎]」也拿不到（2026-10-07 实测）。
     所以这里统一用 sfxTextBr() 补回方括号：界面显示不变，数据层保住格式。 */
  var sfx=sxIn?sfxTextBr(sxIn.textContent):'';
  /* 药名为空时，克数与尾缀一并清掉——否则会留下「[另包] 删不掉」这类残渣，
     且 items[k].name 仍会残留尾缀，导致计价与保存出错 */
  if(!nm){
    if(dsIn.value) dsIn.value='';
    sfx='';
    if(sxIn && sxIn.textContent) sxIn.textContent='';
  }
  var full=nm+(sfx?sfx:'');
  var it=items[k]||mkItem('',0,'',false);
  if(full!==it.name){ it.price=null; it.nm0=null; it.du=''; it.dp=null; }
  it.name=full;
  if(!full){ it.qty=0; it.unit=''; it.zibei=false; }
  else if(ds===''||ds==='自备'){ it.qty=0; it.unit=''; it.zibei=(ds==='自备'); }
  else{
    var m=ds.match(DOSE_RE);
    if(m){ it.qty=parseFloat(m[1]); it.unit=normUnit(m[2]); it.zibei=false; }
  }
  items[k]=it;
  cell.classList.toggle('zibei',!!it.zibei);
  /* 药名里自带剂量尾巴（源数据脏数据，如「山药10g」）→ 尾巴并入克数，杜绝「1袋」这类怪单位 */
  if(it.name && !it.zibei){
    var dm=String(it.name).match(DOSE_SUFFIX_RE);
    if(dm){
      var sp2=splitSfx(String(it.name));
      var base=sp2.nm, sfxTxt=sp2.sfx;
      it.name=base.trim()+sfxTxt;
      if(ds===''){
        it.qty=parseFloat(dm[1]); it.unit=normUnit(dm[2]); it.zibei=false;
        dsIn.value=doseText(it);
      }
      if(sxIn) sxIn.textContent=sfxTxt;
      nmIn.value=base.trim();
      fitCell(k);
    }
  }
  /* 重名保护：同一张处方不允许出现两个相同药名（自动合并剂量） */
  if(it.name && !it.zibei){
    var d2=dupNameIndex(it.name,k);
    if(d2>=0){
      var tgt=items[d2];
      if(tgt && !tgt.zibei && n(it.qty)){
        tgt.qty=n(tgt.qty)+n(it.qty);
        var tc=cellEl(d2);
        if(tc){ var tds=tc.querySelector('.ds'); if(tds) tds.value=doseText(tgt); }
      }
      items[k]=mkItem('',0,'',false);
      nmIn.value=''; dsIn.value=''; if(sxIn) sxIn.textContent='';
      cell.classList.remove('zibei');
      dupMerged=d2;
      return items[k];
    }
  }
  fitCell(k);
  return it;
}
function readAllCells(){ for(var i=0;i<items.length;i++) readCell(i); }

/* ---------------- 计价 ---------------- */
/* 单位换算系数：目录条目单位 → 格子计价单位。统一只在这里算，绝不多算。
   kg↔g 一律 ÷1000 / ×1000；斤↔g 为 500；个/条/盒等按「选定候选」匹配，不换算。
   （2026-10-25 用户要求核对换算路径：目录现存单位只有 g/个/条/斤/盒，没有 kg，
     但万一以后录进 kg 的价，这里保证只换算一次，不会出现差 1000 倍。） */
/* 单位换算系数：把「目录条目单位」的价换算成「格子计价单位」的价。
   ⚠ 方向：1斤 = 500g → 元/斤 ÷ 500 = 元/g（0.002）；元/g × 500 = 元/斤。
   2026-10-25 实测事故：斤的两个系数曾写反（斤→g 写成 500），
   导致 15 元/斤的大枣被算成 7500 元/g。kg 方向一直是对的，别照抄错的。 */
function unitCoef(from,to){
  var f=String(from||'g').toLowerCase(), t=String(to||'g').toLowerCase();
  if(f===t) return 1;
  if(f==='kg'&&t==='g') return 0.001;      /* 1kg=1000g：元/kg ÷1000 = 元/g */
  if(f==='g'&&t==='kg') return 1000;       /* 元/g ×1000 = 元/kg */
  if(f==='斤'&&t==='g') return 0.002;      /* 元/斤 ÷500 = 元/g */
  if(f==='g'&&t==='斤') return 500;        /* 元/g ×500 = 元/斤 */
  return 1;
}
/* 计价单位：用户显式选定的候选单位(du)优先，其次剂量框里的单位(unit)，最后 g */
function priceUnit(it){ return String((it&&(it.du||it.unit))||'g'); }
/* 子规格（盒 / 个 / 瓶…）不占顶层条目，价格挂在药物的 units 里。
   这里把「药名 + 单位」摊成一条可计价的虚拟条目，让划价能认出「1 盒 = 400 元」。 */
function specEntryOf(name, want){
  var w=String(want||'').toLowerCase();
  if(!w) return null;
  var all=findDrugAll(name);
  for(var i=0;i<all.length;i++){
    var sp=(typeof dmSpecsOf==='function')?dmSpecsOf(all[i]):[];
    for(var j=1;j<sp.length;j++){
      var x=sp[j];
      if(String(x.unit||'').toLowerCase()!==w) continue;
      return { n:all[i].n, u:x.unit, p:x.p, c:x.amt, cat:all[i].cat, py:all[i].py, __sub:1 };
    }
  }
  return null;
}
/* 选中这味药应该用目录里**哪一条**（autoPrice 与 priceOf 共用，保证两边口径一致）：
   ① 计价单位(du→unit→g)精确匹配；①' 命中「一药多规格」里的子规格；② 没有匹配 → g 条目优先；
   ③ 再没有 → 用户选定的候选 / 同名第一条。 */
function pickDrugEntry(it){
  if(!it||!it.name) return null;
  var want=priceUnit(it).toLowerCase(), all=findDrugAll(it.name), d=null;
  for(var k=0;k<all.length;k++){
    if(String(all[k].u||'g').toLowerCase()===want){ d=all[k]; break; }
  }
  if(!d && want!=='g'){
    var sub=specEntryOf(it.name, want);
    if(sub) return sub;
  }
  if(!d){
    for(var k2=0;k2<all.length;k2++){
      if(String(all[k2].u||'g').toLowerCase()==='g'){ d=all[k2]; break; }
    }
  }
  if(!d) d=lockedDrug(it)||findDrug(it.name);
  return d;
}
function priceOf(it){
  if(!it||it.zibei||!it.name) return null;
  if(it.price!=null && it.price!=='') return n(it.price);
  /* 选定了具体单位/价格（来自候选）→ 直接用它的价 */
  if(it.dp!=null && it.dp!=='') return n(it.dp);
  var d=pickDrugEntry(it);
  if(!d) return null;
  if(d.p==null || d.p==='') return null;   /* 目录里这一味没售价 → 真的没价 */
  return n(d.p)*unitCoef(d.u, priceUnit(it));   /* 换算只在这里做一次 */
}
/* 该格锁定的候选是「哪一条」（同名前可能有 g 0.13 / 个 0.02 两条）。
   ⚠ 2026-10-07 16:55 用户报「药物管理改了价，自动划价还用旧价」——
   根因：it.dp 存的是**选药那一瞬间的价格快照**，
   autoPrice 见 dp 有值就 continue，于是改价后永远刷不出来。
   现在 dp 只当「用户选定了这条/这个单位」的标记，价格一律现查目录。 */
function lockedDrug(it){
  if(!it||!it.name) return null;
  var all=findDrugAll(it.name);
  if(!all.length) return null;
  /* 优先找单位匹配的那条；找不到就取第一条（用户没选单位的情况） */
  if(it.du){
    for(var i=0;i<all.length;i++){
      if(String(all[i].u||'g')===String(it.du)) return all[i];
    }
  }
  return all[0];
}
/* 自动划价（2026-10-25 按用户规格重写）。
   铁律：**每一味都重新查药品目录当前库价，无条件覆盖**方子里原有的单价——
   不管是上次划价的结果、载入处方时带回来的旧价、还是在清单里手改过的价，
   划完必须严格等于目录价。绝不再拿 it.price 当"已锁定的价"跳过，
   否则第二次划价会和第一次不一样（用户 2026-10-25 实测报的 bug）。

   取数顺序（每味药）：
     ① 按计价单位(du→unit→g)在目录同名条目里找**单位匹配**的那条；
     ② 找不到就 g 条目优先，再退到同名第一条；
     ③ 库价 × 单位换算系数(kg↔g ÷1000，只算一次) = 最终单价。
   加成倍率不在这里出现：倍率只在药物管理录入进价时算一次并存成售价(p)，
   划价直接读售价，绝不二次乘倍率。

   日志：每次划价把每味药的 库价/目录单位/换算系数/最终单价 打进 console，
   并存一份在 window.__lastPriceLog，复现"哪味药算错"时直接看。 */
function autoPrice(){
  var miss=[], log=[];
  for(var i=0;i<items.length;i++){
    var it=items[i]; if(!it||!it.name) continue;
    if(it.zibei){ it.price=0; it.nm0=it.name; continue; }
    /* ① 选中目录条目（单位匹配优先，g 优先，再候选/同名第一条） */
    var want=priceUnit(it).toLowerCase(), d=pickDrugEntry(it);
    var raw=(d&&d.p!=null&&d.p!=='')?n(d.p):null;
    var coef=1, fin=null;
    if(raw!=null){ coef=unitCoef(d&&d.u, want); fin=raw*coef; }
    log.push({药名:it.name, 数量:(it.qty||'')+(it.unit||''), 匹配条目:(d&&d.n)||'(未匹配)',
              目录单位:(d&&d.u)||'', 库价:raw, 换算系数:coef, 倍率:1, 最终单价:fin,
              状态:(fin==null?'无价':(coef!==1?'已换算':'=库价'))});
    if(fin!=null){
      it.price=fin; it.nm0=it.name; it.__manual=false;
      it.dp=fin; it.du=(d&&d.u)||it.du||'g';   /* dp 只当候选标记，值始终跟目录走 */
    } else {
      /* ⚠️ 不能写成 it.price=0（2026-10-07 踩过）：「查不到价」≠「价是 0」，
         写成 0 会让清单显示 0.000，看不出这味药还没配价。null 才会显示灰色「无价」。 */
      it.price=null; it.dp=null; it.nm0=it.name; miss.push(it.name);
    }
  }
  /* 划价日志：哪味药、原始库价、换算系数、倍率、最终价，一眼定位算错的步骤 */
  try{
    window.__lastPriceLog=log;
    if(log.length){
      console.log('%c[自动划价] '+log.length+' 味 · '+new Date().toLocaleString('zh-CN')+
                  ' · 数据源=药品目录实时库价','color:#0a7a6d;font-weight:bold');
      console.table(log);
    }
  }catch(e){}
  return miss;
}
function perDoseFee(){
  var s=0, L=filledItems();
  for(var i=0;i<L.length;i++){ var it=L[i]; if(it.zibei) continue; var p=priceOf(it); if(p==null) continue; s+=p*n(it.qty); }
  return s;
}
function perDoseWeight(){
  var w=0, L=filledItems();
  for(var i=0;i<L.length;i++){
    var it=L[i]; if(it.zibei) continue;
    var u=String(it.unit||'').toLowerCase();
    if(u==='g'||u==='') w+=n(it.qty); else if(u==='kg') w+=n(it.qty)*1000; else if(u==='斤') w+=n(it.qty)*500;   /* 1斤=500g */
  }
  return w;
}
function curJishu(){ return Math.max(1,Math.round(n($('fJishu').value)||1)); }
function daijianFee(){ return $('cbDaijian').checked?n($('fDaijian').value):0; }
function paotuiFee(){ return $('cbPaotui').checked?n($('fPaotui').value):0; }
/* 加工费用 / 物品费用：勾选后才计入合计（未勾选视为 0，与代煎费、跑腿费同一套逻辑） */
function processFee(){ return $('cbProcess').checked?n($('fProcess').value):0; }
function goodsFee(){ return $('cbGoods').checked?n($('fGoods').value):0; }
function expressFee(){ return $('cbExpress').checked?n($('fExpress').value):0; }
/* 快递费：顺丰/邮政等，地址通用但没有专属价，一律手动填 */
function kuaidiFee(){ return $('cbKuaidi').checked?n($('fKuaidi').value):0; }
function curTotal(){
  return n($('fPerDose').value)*curJishu()+processFee()+goodsFee()+daijianFee()+paotuiFee()+expressFee()+kuaidiFee();
}
function recalc(){
  var j=curJishu(), w=perDoseWeight();
  $('fTotal').textContent=money(curTotal());
  $('wPerDose').textContent=Math.round(w);
  $('wTotal').textContent=Math.round(w*j);
  /* 金额数字按内容调宽（2026-10-08：input 宽度写死会截断「5374.60」「10000.00」） */
  fitMoneyInputs();
  /* 单剂药费为空时藏掉「元」字（2026-07 用户要求显示为「XX元」） */
  try{
    var mz=document.querySelector('.rxmoney');
    if(mz) mz.classList.toggle('noPerDose', !$('fPerDose').value.trim());
  }catch(e){}
  $('prWrap').style.display=$('cbProcess').checked?'':'none';
  $('djWrap').style.display=$('cbDaijian').checked?'':'none';
  $('ptWrap').style.display=$('cbPaotui').checked?'':'none';
  $('exWrap').style.display=$('cbExpress').checked?'':'none';
  $('kdWrap').style.display=$('cbKuaidi').checked?'':'none';
  $('gdWrap').style.display=$('cbGoods').checked?'':'none';
  /* 勾选中的费用项置顶 */
  var _fx=[['cbProcess',0],['cbDaijian',1],['cbPaotui',2],['cbExpress',3],['cbKuaidi',4],['cbGoods',5]];
  for(var _i=0;_i<_fx.length;_i++){ var _b=$(_fx[_i][0]), _d=_b&&_b.closest('.fx'); if(_d) _d.classList.toggle('on',!!_b.checked); }
  /* 配送地址行：勾选「跑腿费 / 闪送费 / 快递费」任一即出现（隐私信息，不打印） */
  if(typeof addrShow==='function') addrShow();
  if(priced) renderPriceList();
  syncRecordSoon();
}

/* ---------------- 价格清单 ---------------- */
function renderPriceList(){
  if(!priced){
    $('plBody').innerHTML='<tr><td colspan="5" style="padding:12px;color:#999">（点下方「自动划价」，此处显示药品列表与价格）</td></tr>';
    $('plCount').textContent='中药共 0 味'; $('plWeight').textContent='0'; $('plTotal').textContent='0.00';
    $('plState').textContent='待自动划价';
    return;
  }
  var h='', cnt=0, wt=0, tot=0, L=filledItems();
  for(var k=0;k<L.length;k++){
    var it=L[k], i=items.indexOf(it), d=findDrug(it.name);
    var p=it.zibei?0:priceOf(it);
    var amt=it.zibei?0:(p==null?0:p*n(it.qty));
    if(!it.zibei){
      cnt++;
      var u=String(it.unit||'').toLowerCase();
      if(u==='g'||u==='') wt+=n(it.qty); else if(u==='kg') wt+=n(it.qty)*1000; else if(u==='斤') wt+=n(it.qty)*500;   /* 1斤=500g */
    }
    tot+=amt;
    /* 无价的药：单价与金额都显示灰色「无价」，让用户一眼看出是哪几味没配价
       （2026-10-07 16:55 用户要求。原来是空白，看不出是没价还是渲染漏了）。
       自备药不算无价 —— 它本来就不计价，金额栏也空着。 */
    var noPrice=(!it.zibei && p==null);
    h+='<tr data-i="'+i+'"><td style="text-align:left"><span>'+esc(it.name)+(it.zibei?'（自备）':'')+'</span></td>'
      +'<td class="num"><span>'+(it.zibei?'':(+it.qty))+'</span></td>'
      +'<td><span>'+esc(it.zibei?'':(it.unit||''))+'</span></td>'
      +'<td class="num'+(it.zibei?'':' pcode')+(noPrice?' noprice':'')+'"'+(it.zibei?'':' data-edit="1"')+'><span>'
        +(it.zibei?'':(p==null?'无价':e3(p)))+'</span></td>'
      +'<td class="num'+(noPrice?' noprice':'')+'"><span>'
        +(it.zibei?'':(p==null?'—':e3(amt)))+'</span></td>'
      +'</tr>';
  }
  $('plBody').innerHTML=h||'<tr><td colspan="5" style="padding:12px;color:#999">处方为空</td></tr>';
  $('plCount').textContent='中药共 '+cnt+' 味';
  $('plWeight').textContent=Math.round(wt);
  $('plTotal').textContent=money(tot);
  var noCnt=L.filter(function(x){ return !x.zibei && priceOf(x)==null; }).length;
  $('plState').textContent = noCnt ? ('已划价 · '+noCnt+' 味无价') : '已划价 · 单价可改';
}
function plStartEdit(td,tr){
  if(td.querySelector('input')) return;
  var i=+tr.getAttribute('data-i'), it=items[i];
  if(!it||it.zibei||!it.name) return;
  var v=(it.price==null?priceOf(it):it.price); v=(v==null?0:v);
  td.innerHTML='<input value="'+(+v)+'">';
  var inp=td.querySelector('input');
  inp.focus(); inp.select();
  var done=function(){
    var oldP=it.price;
    if(inp.value===''){ it.price=null; } else { it.price=n(inp.value); }
    it.nm0=it.name;
    /* 🔖 标记「这格单价是用户亲手改的」（2026-10-07 16:55）。
       药物管理改目录价后要重划当前处方，靠这个标记区分：
       目录价来源 → 重划时刷新；用户手改的 → 保留不动。
       没有这个标记，重划会把用户手改的单价一起冲掉。 */
    it.__manual=(inp.value!=='');
    /* ⚠ 2026-10-25：手改价不再写进医生专属价库。用户明确要求"自动划价无条件
       按库价覆盖，结果必须=库价"——存成专属价也不会被套用，只会造成
       "改了却没生效"的错觉。手改仅对当前处方临时生效，点自动划价即回到库价。 */
    /* 先重画清单拿新的行金额合计，再回填单剂药费 → 清单合计与处方合计永远一致
       （用户可能在「单剂药费」框里手改过金额，清单为准） */
    renderPriceList();
    var s=priceListStats();
    $('fPerDose').value=money(s.tot);
    recalc();
  };
  inp.addEventListener('blur',done);
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){ e.preventDefault(); inp.blur(); }
    if(e.key==='Escape'){ inp.value=''; inp.blur(); }
  });
}

/* ---------------- 保存 / 发药 ---------------- */
var syncT=null;
function collectRecord(no){
  readAllCells();
  var L=filledItems(), det=[], px=[];
  /* px：与 det 一一对应的单价表（用户在清单里改过的价）。
     重新打开这条处方时优先用它，保证「保存过就是保存后的样子」。 */
  for(var i=0;i<L.length;i++){
    det.push(itemText(L[i]));
    var p=L[i].zibei?null:priceOf(L[i]);
    px.push(p==null?'':String(p));
  }
  return {
    no:no, n:$('fName').value.trim(), s:$('fSex').value, a:$('fAge').value, t:$('fPhone').value,
    m:det.join('   '), px:px.join('|'), j:curJishu(),
    f:$('fPerDose').value?money(n($('fPerDose').value)):'',
    e:processFee()?money(processFee()):'',
    g:goodsFee()?money(goodsFee()):'',
    dj:daijianFee()?money(daijianFee()):'',
    pt:paotuiFee()?money(paotuiFee()):'',
    ex:expressFee()?money(expressFee()):'',
    kd:kuaidiFee()?money(kuaidiFee()):'',
    o:money(curTotal()),
    fw:String(Math.round(perDoseWeight())),
    w:String(Math.round(perDoseWeight()*curJishu())),
    dt:$('fDate').value||today(), tm:nowHM(),
    b:$('fNote').value, fy:'', c:'中医'
  };
}
/* ================= 客人管理（2026-10-30 重写） =================
   布局：左侧客户列表卡片 + 右侧客户详情卡片，两栏各自独立滚动。
   数据：客户档案 → Supabase doctors.prices（phone / addr / ctype 一并存）
        常用方  → 云端 doctors.prices.__gcommon（唯一数据源，不再落本机）
        历史订单 → 药方打印订单 rx_wplan_v1（只读汇总，可标记已结/未结） */
var GUESTS={};
var GUEST_CUR='';
var GST_CF=[];
var GST_CF_EDIT='';
/* 云端 doctors.prices.__gcommon 缓存：客户名 → 常用方数组 */
var GUEST_GC={};
/* 只有先成功拉过一次云端，编辑后才允许自动回写，避免拿本机残缺数据覆盖云端 */
var GST_CF_CLOUD_READY=false;

/* ---------- 客户档案数据层（沿用 doctors 表，prices jsonb 承载档案字段） ---------- */
function guestRowOf(g){
  /* prices 里还存着各味药的「重要客人价格」和倍率，写档案时必须保留 */
  var keep={}, o=(typeof DOCTORS!=='undefined'&&DOCTORS[g.name])||{};
  var src=o.price||{};
  for(var k in src){ if(Object.prototype.hasOwnProperty.call(src,k)) keep[k]=src[k]; }
  if(o.rates) keep.__rates=o.rates;
  keep.discount=g.discount||0;
  keep.note=g.note||'';
  keep.phone=g.phone||'';
  keep.addr=g.addr||'';
  keep.ctype=g.ctype||'散客';
  keep.pins=(g.pins||[]).slice(0,3);
  keep.stars=(g.stars||{});
  /* 常用方存在 prices.__gcommon；保存客户档案时原样带回，避免被清空。
     数据来源按优先级合并：云端 KV → GUEST_GC → 当前 GST_CF。 */
  var cf=gstCfForGuest(g.name);
  if(cf.length) keep.__gcommon=cf;
  return {name:g.name, prices:keep};
}
function guestFromRow(r){
  var p=(r&&r.prices)||{};
  return {name:r.name, discount:p.discount||0, note:p.note||'',
          phone:p.phone||'', addr:p.addr||'', ctype:p.ctype||'散客',
          pins:(p.pins||[]).slice(0,3), stars:(p.stars||{})};
}
function gstCacheSave(){ /* 客人档案的唯一来源是 doctors 表，不再缓存到本地 */ }
function guestSave(g){
  GUESTS[g.name]=g;
  if(!(window.SUPA && SUPA.on)) return Promise.resolve();
  var row=guestRowOf(g);
  /* 云端已有常用方、但本机还没拉到（网络失败/新设备）时，先取回来再写，
     避免保存客户档案把 prices.__gcommon 整段清空。 */
  var ready=Promise.resolve(row);
  if(!row.prices.__gcommon){
    ready=SUPA.q('doctors?select=prices&name=eq.'+encodeURIComponent(g.name)).then(function(rows){
      var p=(rows && rows[0] && rows[0].prices) || null;
      if(p && p.__gcommon) row.prices.__gcommon=p.__gcommon;
      return row;
    }).catch(function(){ return row; });
  }
  return ready.then(function(r){
    return SUPA.q('doctors?on_conflict=name',{method:'POST',body:r});
  }).catch(function(e){ toastErr('客户资料写库失败：'+e.message); });
}
function guestLoadAll(){
  /* 客人档案只从 Supabase doctors 表加载；云端没有就是空。 */
  if(!(window.SUPA && SUPA.on)) return Promise.resolve();
  return SUPA.q('doctors?select=name,prices').then(function(rows){
    GUESTS={};
    (rows||[]).forEach(function(r){ if(r && r.name) GUESTS[r.name]=guestFromRow(r); });
    /* 同一张表里 prices 还存着「药名 → 重要客人价格」，另外捞一份给 DOCTORS 用 */
    CLOUD_DOC_PRICES={}; CLOUD_DOC_RATES={};
    (rows||[]).forEach(function(r){
      var p=r.prices||{}, dp={}, has=false;
      for(var k in p){
        if(k==='discount'||k==='note'||k==='pins'||k==='stars'||k==='__rates'||
           k==='phone'||k==='addr'||k==='ctype'||k==='__gcommon') continue;
        if(p[k]==null || p[k]==='') continue;
        dp[k]=p[k]; has=true;
      }
      if(has) CLOUD_DOC_PRICES[r.name]=dp;
      if(p.__rates && typeof p.__rates==='object') CLOUD_DOC_RATES[r.name]=p.__rates;
    });
    /* 常用方：cloud KV（rx_gcommon_v1）+ doctors.prices.__gcommon 双云端来源。
       两者按 id 合并，取克数更全/更新时间较新的那份；任一来源被误清都不会丢数据。 */
    var cloudCf=[], anyCloud=false;
    try{
      var kv=JSON.parse(RX_STORE.getItem('rx_gcommon_v1')||'[]');
      if(Array.isArray(kv) && kv.length){ for(var ki=0;ki<kv.length;ki++){ if(kv[ki] && kv[ki].id) cloudCf.push(kv[ki]); } anyCloud=true; }
    }catch(e){}
    (rows||[]).forEach(function(r){
      var p=r.prices||{}, list=p.__gcommon;
      if(!Array.isArray(list) || !list.length) return;
      anyCloud=true;
      for(var i=0;i<list.length;i++){ if(list[i] && list[i].id) cloudCf.push(list[i]); }
    });
    if(anyCloud){
      function cfWeight(c){
        var w=0, its=(c&&c.items)||[];
        for(var x=0;x<its.length;x++){ if(its[x] && !its[x].zibei) w+=n(its[x].qty); }
        return w;
      }
      var byId={}, i2, c2;
      for(i2=0;i2<cloudCf.length;i2++){
        c2=cloudCf[i2];
        var old=byId[c2.id], wc=cfWeight(c2), wo=old?cfWeight(old):-1;
        if(!old || wc>wo || (wc===wo && String(c2.updatedAt||'')>String(old.updatedAt||''))) byId[c2.id]=c2;
      }
      GST_CF=Object.keys(byId).map(function(k){ return byId[k]; });
    }
    /* 用合并后的 GST_CF 重建 GUEST_GC，保证保存客户资料时 __gcommon 不会丢 */
    GUEST_GC={};
    for(var gi=0;gi<GST_CF.length;gi++){
      var gc=GST_CF[gi]; if(!gc || !gc.guest) continue;
      if(!GUEST_GC[gc.guest]) GUEST_GC[gc.guest]=[];
      GUEST_GC[gc.guest].push(gc);
    }
    GST_CF_CLOUD_READY=true;
    try{ purgeTestGuests(); }catch(e){}
  }).catch(function(e){ console.warn('客户资料拉取失败:',e.message); });
}
function guestDelete(name){
  delete GUESTS[name];
  if(!(window.SUPA && SUPA.on)) return Promise.resolve();
  return SUPA.q('doctors?name=eq.'+encodeURIComponent(name),{method:'DELETE'})
    .catch(function(e){ toastErr('删除失败：'+e.message); });
}

/* ---------- 常用方数据层 ---------- */
function gstLoadCf(){
  /* 云端 KV 备份（Supabase guests 表的 __kv__rx_gcommon_v1 行） */
  try{ var a=JSON.parse(RX_STORE.getItem('rx_gcommon_v1')||'[]'); GST_CF=Array.isArray(a)?a:[]; }catch(e){ GST_CF=[]; }
  /* KV 有数据说明云端可用，允许后续写回 doctors */
  if(GST_CF.length) GST_CF_CLOUD_READY=true;
}
function gstCfPersist(){
  /* 常用方双写：Supabase KV + doctors.prices.__gcommon，都是云端 */
  RX_STORE.setItem('rx_gcommon_v1', JSON.stringify(GST_CF));
  if(!(window.SUPA && SUPA.on)) return Promise.resolve(0);
  if(!GST_CF_CLOUD_READY) return Promise.resolve(0);
  return gstCfPushCloud().catch(function(e){ console.warn('常用方写库失败:',e.message); });
}
/* 常用方 → 云端 doctors.prices.__gcommon（按客户名分组，内置 guest 标签）。
   新增/编辑/删除后立即写库，不需要手动同步。 */
function gstCfPushCloud(){
  if(!(window.SUPA && SUPA.on)) return Promise.resolve(0);
  var groups={}, i;
  for(i=0;i<GST_CF.length;i++){
    var c=GST_CF[i];
    if(!c || !c.guest) continue;
    (groups[c.guest]=groups[c.guest]||[]).push(c);
  }
  /* 目标客人 = 当前有方的客人 ∪ 云端原本有方的客人。
     这样「删掉某位客人的最后一个常用方」时，会向 doctors 写入空数组把它清掉，
     不会因为旧数据残留而在下次加载时复活。 */
  var targets={}, nm;
  for(nm in groups){ if(Object.prototype.hasOwnProperty.call(groups,nm)) targets[nm]=1; }
  for(nm in GUEST_GC){ if(Object.prototype.hasOwnProperty.call(GUEST_GC,nm) && GUEST_GC[nm] && GUEST_GC[nm].length) targets[nm]=1; }
  var names=Object.keys(targets);
  if(!names.length) return Promise.resolve(0);
  return Promise.all(names.map(function(name){
    var list=groups[name]||[];
    GUEST_GC[name]=list.slice();
    return SUPA.saveGuestCommon(name, list);
  })).then(function(){ return names.length; });
}
/* 取某位客户的常用方：按优先级合并云端 KV、GUEST_GC、当前 GST_CF。
   任何一处有数据都不会因为保存客户/医生价格而被清空。 */
function gstCfForGuest(guest){
  guest=String(guest||'').trim();
  if(!guest) return [];
  var byId={}, order=[];
  function addList(list){
    if(!Array.isArray(list)) return;
    for(var i=0;i<list.length;i++){
      var c=list[i]; if(!c || !c.id) continue;
      if(!byId[c.id]) order.push(c.id);
      byId[c.id]=c;
    }
  }
  try{
    var kv=JSON.parse(RX_STORE.getItem('rx_gcommon_v1')||'[]');
    var kk=[];
    if(Array.isArray(kv)){ for(var z=0;z<kv.length;z++){ if(kv[z] && kv[z].guest===guest) kk.push(kv[z]); } }
    addList(kk);
  }catch(e){}
  if(typeof GUEST_GC!=='undefined' && GUEST_GC[guest]) addList(GUEST_GC[guest]);
  if(typeof GST_CF!=='undefined'){
    var cur=[];
    for(var j=0;j<GST_CF.length;j++){ if(GST_CF[j] && GST_CF[j].guest===guest) cur.push(GST_CF[j]); }
    addList(cur);
  }
  return order.map(function(id){ return byId[id]; });
}
function gstCfId(){ return 'CF'+Date.now().toString(36)+Math.random().toString(36).slice(2,5); }
function gstCfFor(guest){
  var out=[];
  for(var i=0;i<GST_CF.length;i++){ if(GST_CF[i] && GST_CF[i].guest===guest) out.push(GST_CF[i]); }
  out.sort(function(a,b){ return String(b.createdAt||'').localeCompare(String(a.createdAt||'')); });
  return out;
}
function gstCfFind(id){
  for(var i=0;i<GST_CF.length;i++){ if(GST_CF[i] && GST_CF[i].id===id) return GST_CF[i]; }
  return null;
}
function gstItemAmt(it){
  if(!it || it.zibei) return 0;
  return n(it.price)*n(it.qty);
}
function gstCfAmount(c){
  var per=0, its=(c&&c.items)||[];
  for(var i=0;i<its.length;i++) per+=gstItemAmt(its[i]);
  return per*(n(c&&c.doses)||1);
}
function gstItemsText(items){
  var out=[];
  for(var i=0;i<(items||[]).length;i++){
    var it=items[i];
    out.push(it.zibei ? (it.name+' 自备') : (it.name+' '+n(it.qty)+(it.unit||it.du||'g')));
  }
  return out.join('  ');
}
function gstPriceFor(guest, name, du){
  var dp=docPrice(guest, name);
  if(dp!=null) return dp;
  var all=findDrugAll(name)||[];
  var d=null, i;
  for(i=0;i<all.length;i++){ if(String(all[i].u||'g').toLowerCase()===String(du||'g').toLowerCase()){ d=all[i]; break; } }
  if(!d) d=all[0];
  if(!d || d.p==null || d.p==='') return null;
  return n(d.p)*unitCoef(String(d.u||'g'), du||'g');
}
function gstBuildItems(text, guest){
  var parsed=parseItems(text), out=[], i;
  for(i=0;i<parsed.length;i++){
    var p=parsed[i]; if(!p || !p.name) continue;
    if(p.zibei){ out.push({name:p.name,qty:0,unit:'',du:'',price:0,manual:false,zibei:true,sfx:'',rm:''}); continue; }
    var u=normUnit(p.unit||'g')||'g';
    var sp=splitSfx(p.name), nm=sp.nm;
    var all=findDrugAll(nm)||[], d=all[0]||null;
    var du=d?String(d.u||'g'):u;
    var q=n(p.qty);
    if(u!==du) q=q*unitCoef(du,u);
    out.push({name:nm,qty:q,unit:du,du:du,price:gstPriceFor(guest,nm,du),
              manual:false,zibei:false,sfx:sp.sfx,rm:''});
  }
  return out;
}

/* ---------- 药方打印订单（只读汇总 + 已结/未结标记） ---------- */
function gstOrdersRaw(){
  try{
    var raw=JSON.parse(RX_STORE.getItem('rx_wplan_v1')||'[]');
    if(Array.isArray(raw)) return raw;
    if(raw && Array.isArray(raw.orders)) return raw.orders;
  }catch(e){}
  return [];
}
function gstOrdersWrite(arr){
  RX_STORE.setItem('rx_wplan_v1', JSON.stringify(arr));
}
function gstIsPaid(o){ return !!(o && (o.paid==='1' || o.paid===true || o.paid==='paid')); }
function gstOrderAmount(o){
  var total=0, bs=(o&&o.blocks)||[], i, j;
  for(i=0;i<bs.length;i++){
    var b=bs[i], sub=0, its=(b&&b.items)||[];
    for(j=0;j<its.length;j++) sub+=gstItemAmt(its[j]);
    total += sub*(n(b&&b.doses)||1);
  }
  return total;
}
function gstOrderName(o){
  if(o && o.dish) return String(o.dish);
  var bs=(o&&o.blocks)||[];
  if(bs.length===1) return String(bs[0].title||'未命名药方');
  if(bs.length>1){
    var names=[];
    for(var i=0;i<bs.length;i++) names.push(String(bs[i].title||('药方'+(i+1))));
    return names.join('、');
  }
  return '未命名单';
}
function gstOrderDoses(o){
  if(o && o.doses!=null && n(o.doses)>0) return n(o.doses);
  var bs=(o&&o.blocks)||[];
  if(bs.length) return n(bs[0].doses)||1;
  return 1;
}
function gstFmtTime(s){
  if(!s) return '';
  var d=new Date(s);
  if(isNaN(d.getTime())) return String(s);
  function p2(x){ x=String(x); return x.length<2?'0'+x:x; }
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes());
}
function gstGuestOrders(guest){
  var all=gstOrdersRaw(), out=[];
  guest=String(guest||'').trim();
  for(var i=0;i<all.length;i++){
    if(String((all[i]&&all[i].guest)||'').trim()===guest) out.push(all[i]);
  }
  out.sort(function(a,b){
    var x=String((a.date||'')+' '+(a.createdAt||''));
    var y=String((b.date||'')+' '+(b.createdAt||''));
    return x>y?-1:1;
  });
  return out;
}

/* ---------- 日常处方（该客户名下的处方记录） ----------
   数据源两条腿：
   1) 本机处方（allRx：本机保存 SAVED + 书剑历史 HISTORY_ORIG）
   2) Supabase prescriptions 表，按姓名精确查（换设备也能看到同一客户的全部处方）
   表里没有独立的「客户表 / 客户ID」：处方用 name 字段就是客户/医生姓名，
   所以按姓名查是该表唯一可用的关联方式。 */
var GST_RX_CLOUD={};          /* 客户姓名 → 云端处方记录（页面记录格式） */
var GST_PRICE_LOGS={};         /* 客户姓名 → 云端专属药价改动记录 */
var GST_PRICE_LOGS_LOADING={};
/* 客户专属药价改动（price_logs.doctor = 客人姓名） */
function gstPriceLogsLoad(guest){
  guest=String(guest||'').trim();
  if(!guest || !(window.SUPA && SUPA.on)) return Promise.resolve(false);
  if(GST_PRICE_LOGS[guest]) return Promise.resolve(false);
  if(GST_PRICE_LOGS_LOADING[guest]) return GST_PRICE_LOGS_LOADING[guest];
  GST_PRICE_LOGS_LOADING[guest]=SUPA.q('price_logs?select=*&doctor=eq.'+encodeURIComponent(guest)+'&order=created_at.desc&limit=200')
    .then(function(rows){
      GST_PRICE_LOGS[guest]=(rows||[]);
      delete GST_PRICE_LOGS_LOADING[guest];
      return true;
    })
    .catch(function(e){
      delete GST_PRICE_LOGS_LOADING[guest];
      console.warn('客户药价改动拉取失败:', e.message);
      return false;
    });
  return GST_PRICE_LOGS_LOADING[guest];
}
function gstRxBelongsTo(r, guest){
  var nm=String((r&&r.n)||'').trim();
  if(!guest) return false;
  if(nm===guest) return true;
  /* 「李医生 张三」这类复合姓名也归到李医生 */
  return nm.indexOf(guest+' ')==0 || nm.indexOf(guest+'　')==0;
}
function gstCloudRxLoad(guest){
  guest=String(guest||'').trim();
  if(!guest || !(window.SUPA && SUPA.on)) return Promise.resolve(false);
  if(GST_RX_CLOUD[guest]) return Promise.resolve(false);
  return SUPA.qAll('prescriptions?select=*&name=ilike.*'+encodeURIComponent(guest)+'*&order=dt.desc')
    .then(function(rows){
      GST_RX_CLOUD[guest]=(rows||[]).map(supaRowToRec);
      return true;
    })
    .catch(function(e){
      console.warn('客户处方拉取失败:', e.message);
      return false;
    });
}
function gstGuestRx(guest){
  guest=String(guest||'').trim();
  var out=[], seen={};
  function add(r){
    if(!r) return;
    var k=String(r.no||'').trim();
    if(!k) k=String(r.dt||'')+'|'+String(r.tm||'')+'|'+String(r.m||'');
    if(seen[k]) return;
    seen[k]=1; out.push(r);
  }
  /* 只读云端：本机历史/本机暂存不再参与客户处方列表 */
  var cl=GST_RX_CLOUD[guest]||[];
  for(var j=0;j<cl.length;j++){ if(gstRxBelongsTo(cl[j], guest)) add(cl[j]); }
  out.sort(function(a,b){
    var x=String((a.dt||'')+' '+(a.tm||''));
    var y=String((b.dt||'')+' '+(b.tm||''));
    return x>y?-1:1;
  });
  return out;
}

/* ---------- 客人管理页面模块 ---------- */
var Guest=(function(){
  var _tab='feed', _search='', _month='';

  function ensure(){
    if(!$('gstList')) return;
    gstLoadCf();
    renderList();
    if(GUEST_CUR && GUESTS[GUEST_CUR]) renderDetail(true);
    guestLoadAll().then(function(){
      renderList();
      if(GUEST_CUR && GUESTS[GUEST_CUR]) renderDetail(false);
    });
  }
  function setSearch(v){
    _search=String(v||'').trim().toLowerCase();
    var box=$('gstSearch');
    if(box && box.parentNode) box.parentNode.classList.toggle('has-val', !!String(v||'').trim());
    renderList();
  }
  function clearSearch(){
    var box=$('gstSearch'); if(box){ box.value=''; if(box.parentNode) box.parentNode.classList.remove('has-val'); }
    _search=''; renderList(); if(box) box.focus();
  }
  function namesFiltered(){
    var kw=_search, out=[];
    for(var nm in GUESTS){
      if(!Object.prototype.hasOwnProperty.call(GUESTS,nm)) continue;
      var g=GUESTS[nm]||{};
      var hay=(nm+' '+(g.phone||'')+' '+(g.note||'')+' '+(g.ctype||'')).toLowerCase();
      if(!kw || hay.indexOf(kw)>=0) out.push(nm);
    }
    out.sort(function(a,b){ return a<b?-1:(a>b?1:0); });
    return out;
  }
  function debtOf(guest){
    var os=gstGuestOrders(guest), sum=0;
    for(var i=0;i<os.length;i++){ if(!gstIsPaid(os[i])) sum+=gstOrderAmount(os[i]); }
    return Math.round(sum*100)/100;
  }
  function renderList(){
    var box=$('gstList'); if(!box) return;
    var names=namesFiltered();
    if(!names.length){
      box.innerHTML='<div class="gst-empty-row">'+(_search?'没有匹配「'+esc(_search)+'」的客户':'还没有客户，点上方「+ 新增客户」开始')+'</div>';
      return;
    }
    var h='';
    for(var i=0;i<names.length;i++){
      var nm=names[i], g=GUESTS[nm]||{};
      var unpaid=debtOf(nm);
      var sub=g.phone?g.phone:(g.note?g.note:(g.ctype||'散客'));
      h+='<div class="gst-item'+(nm===GUEST_CUR?' on':'')+'" data-n="'+esc(nm)+'" onclick="Guest.pick(this.getAttribute(\'data-n\'))">'
        + '<span class="gst-ava">'+esc(String(nm).slice(0,1)||'?')+'</span>'
        + '<div class="gst-item-main"><b>'+esc(nm)+'</b><span>'+esc(sub)+'</span></div>'
        + '<span class="gst-debt'+(unpaid>0?'':' ok')+'">'+(unpaid>0?'未结 ¥'+money(unpaid):'已结清')+'</span>'
        + '</div>';
    }
    box.innerHTML=h;
  }
  function pick(name){
    if(!GUESTS[name]) return;
    GUEST_CUR=name; _tab='feed';
    renderList(); renderDetail(true);
    var body=$('gstDetail') && $('gstDetail').querySelector('.gst-detail-body');
    if(body) body.scrollTop=0;
  }
  function metaText(g){
    var os=gstGuestOrders(g.name), unpaid=0;
    for(var i=0;i<os.length;i++){ if(!gstIsPaid(os[i])) unpaid+=gstOrderAmount(os[i]); }
    return (g.ctype||'散客')+' · '+os.length+' 单 · 未结 ¥'+money(unpaid)+(g.phone?(' · '+g.phone):'');
  }
  function renderDetail(){
    var g=GUESTS[GUEST_CUR];
    var e=$('gstEmpty'), d=$('gstDetail');
    if(!g){
      if(e) e.style.display='flex';
      if(d) d.style.display='none';
      return;
    }
    if(e) e.style.display='none';
    if(d) d.style.display='flex';
    if($('gstName')) $('gstName').textContent=g.name;
    if($('gstMeta')) $('gstMeta').textContent=metaText(g);
    var panes={feed:'gstPaneFeed',common:'gstPaneCommon',daily:'gstPaneDaily',history:'gstPaneHistory'};
    for(var k in panes){ if($(panes[k])) $(panes[k]).style.display=(k===_tab?'':'none'); }
    var tabs=document.querySelectorAll('.gst-tab');
    for(var i=0;i<tabs.length;i++){ tabs[i].classList.toggle('on', tabs[i].getAttribute('data-t')===_tab); }
    if(_tab==='feed') renderFeed();
    if(_tab==='common') renderCommon();
    if(_tab==='daily') renderDaily();
    if(_tab==='history') renderHistory();
  }
  /* 再点一次当前按钮即回到默认的「最新动态」 */
  function tab(t){
    t=t||'feed';
    _tab=(_tab===t)?'feed':t;
    renderDetail(false);
    if(_tab==='daily' || _tab==='history'){
      var guest=GUEST_CUR;
      gstCloudRxLoad(guest).then(function(ok){
        if(ok && _tab===t && GUEST_CUR===guest) renderDetail(false);
      });
    }
  }
  /* ---------- 最新动态：订单 / 日常药方 / 药价改动 ---------- */
  function feedTs(v){
    if(!v) return 0;
    var s=String(v).trim();
    var t=Date.parse(s.indexOf('T')>=0?s:s.replace(' ','T'));
    if(isFinite(t)) return t;
    t=Date.parse(s);
    return isFinite(t)?t:0;
  }
  function renderFeed(){
    var box=$('gstFeedList'); if(!box) return;
    if(!GUEST_CUR){ box.innerHTML='<div class="gst-empty-row">请先选择客户</div>'; return; }
    var guest=GUEST_CUR, rows=[];
    /* 1) 药方打印订单 */
    var os=gstGuestOrders(guest);
    for(var i=0;i<os.length;i++){
      var o=os[i], paid=gstIsPaid(o);
      rows.push({ ts:feedTs(o.createdAt||o.date), tag:'order', label:'订单',
        title:'订单 · '+gstOrderName(o),
        sub:(o.no||'未编号')+' · '+gstOrderDoses(o)+' 付 · '+(paid?'已结':'未结'),
        amt:'¥'+money(gstOrderAmount(o)),
        time:gstFmtTime(o.createdAt||o.date) });
    }
    /* 2) 日常药方（云端 prescriptions） */
    var rx=gstGuestRx(guest);
    for(var j=0;j<rx.length;j++){
      var r=rx[j], a=statAmount(r);
      rows.push({ ts:feedTs((r.dt||'')+' '+(r.tm||'')), tag:'rx', label:'药方',
        title:'日常药方 · '+(r.no||'未编号'),
        sub:rxDrugText(r)+' · '+a.j+' 付 · '+(rxIsFayao(r)?'已发':'未发'),
        amt:'¥'+money(a.total),
        time:gstFmtTime((r.dt||'')+(r.tm?(' '+r.tm):'')) });
    }
    /* 3) 该客户的专属药价改动 */
    var pl=GST_PRICE_LOGS[guest]||[];
    for(var k=0;k<pl.length;k++){
      var p=pl[k];
      var f=(p.from_price==null||p.from_price==='')?'—':money(p.from_price);
      var tt=(p.to_price==null||p.to_price==='')?'—':money(p.to_price);
      rows.push({ ts:feedTs(p.created_at), tag:'price', label:'药价',
        title:'药价改动 · '+String(p.drug||''),
        sub:'专属价 ¥'+f+' → ¥'+tt,
        amt:'', time:gstFmtTime(p.created_at) });
    }
    rows.sort(function(a,b){ return b.ts-a.ts; });
    var shown=rows.slice(0,30);
    if($('gstFeedCount')) $('gstFeedCount').textContent='共 '+rows.length+' 条动态';
    if(!shown.length){
      box.innerHTML='<div class="gst-empty-row">该客户还没有订单、日常药方或药价改动</div>';
    }else{
      var h='';
      for(var s=0;s<shown.length;s++){
        var it=shown[s];
        h+='<div class="gst-feed-item">'
          +'<span class="gst-feed-tag '+it.tag+'">'+esc(it.label)+'</span>'
          +'<div class="gst-feed-main"><div class="gst-feed-title">'+esc(it.title)+'</div>'
          +'<div class="gst-feed-sub">'+esc(it.sub)+'</div></div>'
          +'<div class="gst-feed-right">'+(it.amt?('<span class="gst-feed-amt">'+esc(it.amt)+'</span>'):'')
          +'<span class="gst-feed-time">'+esc(it.time)+'</span></div>'
          +'</div>';
      }
      box.innerHTML=h;
    }
    /* 云端数据异步补齐后再重画一次（缓存命中后不会重复请求） */
    var g=guest;
    gstCloudRxLoad(g).then(function(ok){ if(ok && GUEST_CUR===g && _tab==='feed') renderFeed(); });
    gstPriceLogsLoad(g).then(function(ok){ if(ok && GUEST_CUR===g && _tab==='feed') renderFeed(); });
  }
  function refreshFeed(){
    var guest=GUEST_CUR; if(!guest) return;
    delete GST_RX_CLOUD[guest];
    delete GST_PRICE_LOGS[guest];
    delete GST_PRICE_LOGS_LOADING[guest];
    renderFeed();
    toast('已刷新最新动态');
  }
  function newCustomer(){
    if($('gstNewName')) $('gstNewName').value='';
    if($('gstNewPhone')) $('gstNewPhone').value='';
    if($('gstNewType')) $('gstNewType').value='散客';
    var m=$('gstNewModal'); if(m) m.classList.add('on');
    setTimeout(function(){ if($('gstNewName')) $('gstNewName').focus(); },50);
  }
  function createCustomer(){
    var nm=String($('gstNewName').value||'').trim();
    if(!nm){ toastErr('请填写客户姓名'); $('gstNewName').focus(); return; }
    if(GUESTS[nm]){ toastErr('客户「'+nm+'」已存在'); return; }
    var g={name:nm, phone:String($('gstNewPhone') ? $('gstNewPhone').value : '').trim(),
           ctype:$('gstNewType') ? ($('gstNewType').value||'散客') : '散客',
           addr:'', note:'', discount:0, pins:[], stars:{}};
    guestSave(g).then(function(){
      var m=$('gstNewModal'); if(m) m.classList.remove('on');
      GUEST_CUR=nm; _tab='feed';
      renderList(); renderDetail(true);
      toast('已新增客户「'+nm+'」');
    });
  }
  function renderCommon(){
    var box=$('gstCommonList'); if(!box) return;
    if(!GUEST_CUR){ box.innerHTML='<div class="gst-empty-row">请先选择客户</div>'; return; }
    var kw=String(($('gstCommonSearch')&&$('gstCommonSearch').value)||'').trim().toLowerCase();
    var list=gstCfFor(GUEST_CUR), shown=[];
    for(var i=0;i<list.length;i++){
      var c=list[i], hay=String(c.name||'').toLowerCase();
      var its=c.items||[];
      for(var j=0;j<its.length;j++) hay+=' '+String(its[j].name||'').toLowerCase();
      if(!kw || hay.indexOf(kw)>=0) shown.push(c);
    }
    if($('gstCommonCount')) $('gstCommonCount').textContent='共 '+shown.length+' 个常用方';
    if(!shown.length){
      box.innerHTML='<div class="gst-empty-row">'+(kw?'没有匹配的常用方':'还没有常用方，点「+ 新建常用方」保存一张')+'</div>';
      return;
    }
    var h='<table class="gst-tbl"><thead><tr><th>方名</th><th>付数</th><th>金额</th><th>创建时间</th><th style="text-align:right">操作</th></tr></thead><tbody>';
    for(var k=0;k<shown.length;k++){
      var cc=shown[k];
      h+='<tr>'
        +'<td class="nm">'+esc(cc.name||'未命名常用方')+'</td>'
        +'<td class="num">'+(n(cc.doses)||1)+' 付</td>'
        +'<td class="money">¥'+money(gstCfAmount(cc))+'</td>'
        +'<td>'+esc(cc.createdAt||'')+'</td>'
        +'<td class="gst-act">'
        +'<button type="button" onclick="Guest.previewCommon(\''+esc(cc.id)+'\')">预览</button>'
        +'<button type="button" class="pri" onclick="Guest.reuseCommon(\''+esc(cc.id)+'\')">一键复用</button>'
        +'<button type="button" onclick="Guest.editCommon(\''+esc(cc.id)+'\')">编辑</button>'
        +'<button type="button" class="danger" onclick="Guest.delCommon(\''+esc(cc.id)+'\')">删除</button>'
        +'</td></tr>';
    }
    h+='</tbody></table>';
    box.innerHTML=h;
  }
  /* ---------- 日常处方 ---------- */
  function rxIsFayao(r){ return String((r&&r.fy)||'').indexOf('发')>=0; }
  function rxDrugText(r){
    var s=String((r&&r.m)||'').replace(/\s+/g,' ').trim();
    return s.length>56 ? (s.slice(0,56)+'…') : (s||'—');
  }
  function renderDaily(){
    var box=$('gstDailyList'); if(!box) return;
    if(!GUEST_CUR){ box.innerHTML='<div class="gst-empty-row">请先选择客户</div>'; return; }
    var list=gstGuestRx(GUEST_CUR);
    if($('gstDailyCount')){
      $('gstDailyCount').textContent='共 '+list.length+' 张处方（云端）';
    }
    if(!list.length){
      box.innerHTML='<div class="gst-empty-row">该客户还没有处方记录</div>';
      return;
    }
    var h='<table class="gst-tbl"><thead><tr><th>日期</th><th>处方号</th><th>药味</th><th class="num">付数</th><th class="num">总金额</th><th style="text-align:right">状态</th></tr></thead><tbody>';
    for(var i=0;i<list.length;i++){
      var r=list[i], a=statAmount(r), fy=rxIsFayao(r);
      h+='<tr>'
        +'<td>'+esc(gstFmtTime((r.dt||'')+(r.tm?(' '+r.tm):''))) +'</td>'
        +'<td class="nm">'+esc(r.no||'未编号')+'</td>'
        +'<td>'+esc(rxDrugText(r))+'</td>'
        +'<td class="num">'+a.j+' 付</td>'
        +'<td class="money">¥'+money(a.total)+'</td>'
        +'<td style="text-align:right"><span class="gst-st plain '+(fy?'paid':'unpaid')+'">'+(fy?'已发':'未发')+'</span></td>'
        +'</tr>';
    }
    h+='</tbody></table>';
    box.innerHTML=h;
  }
  function refreshDaily(){
    var guest=GUEST_CUR;
    if(!guest) return;
    delete GST_RX_CLOUD[guest];
    renderDaily();
    gstCloudRxLoad(guest).then(function(ok){
      if(guest!==GUEST_CUR) return;
      if(ok) toast('已同步云端处方');
      renderDaily();
    });
  }
  function newCommon(){
    if(!GUEST_CUR){ toastErr('请先选择客户'); return; }
    GST_CF_EDIT='';
    if($('gstCfTitle')) $('gstCfTitle').textContent='新建常用方 · '+GUEST_CUR;
    if($('gstCfName')) $('gstCfName').value='';
    if($('gstCfDoses')) $('gstCfDoses').value=1;
    if($('gstCfItems')) $('gstCfItems').value='';
    var m=$('gstCfModal'); if(m) m.classList.add('on');
    setTimeout(function(){ if($('gstCfName')) $('gstCfName').focus(); },50);
  }
  function editCommon(id){
    var c=gstCfFind(id); if(!c) return;
    GST_CF_EDIT=id;
    if($('gstCfTitle')) $('gstCfTitle').textContent='编辑常用方 · '+GUEST_CUR;
    if($('gstCfName')) $('gstCfName').value=c.name||'';
    if($('gstCfDoses')) $('gstCfDoses').value=n(c.doses)||1;
    if($('gstCfItems')) $('gstCfItems').value=gstItemsText(c.items);
    var m=$('gstCfModal'); if(m) m.classList.add('on');
  }
  function saveCommon(){
    if(!GUEST_CUR){ toastErr('请先选择客户'); return; }
    var nm=String($('gstCfName').value||'').trim();
    if(!nm){ toastErr('请填写方名'); $('gstCfName').focus(); return; }
    var doses=Math.max(1, Math.round(n($('gstCfDoses') ? $('gstCfDoses').value : 1)||1));
    var items=gstBuildItems(String($('gstCfItems').value||''), GUEST_CUR);
    if(!items.length){ toastErr('药方内容没有识别到药材，请按「药名 克数」填写'); $('gstCfItems').focus(); return; }
    var now=nowStr();
    if(GST_CF_EDIT){
      var c=gstCfFind(GST_CF_EDIT);
      if(!c){ toastErr('常用方不存在'); return; }
      c.name=nm; c.doses=doses; c.items=items; c.updatedAt=now;
    }else{
      GST_CF.unshift({id:gstCfId(), guest:GUEST_CUR, name:nm, doses:doses, items:items, createdAt:now, updatedAt:now});
    }
    gstCfPersist();
    var m=$('gstCfModal'); if(m) m.classList.remove('on');
    renderCommon();
    toast(GST_CF_EDIT?'常用方已更新':'已保存常用方「'+nm+'」');
    GST_CF_EDIT='';
  }
  function previewCommon(id){
    var c=gstCfFind(id); if(!c){ toastErr('常用方不存在'); return; }
    var its=c.items||[], per=0, rows='';
    for(var i=0;i<its.length;i++){
      var it=its[i], amt=gstItemAmt(it); per+=amt;
      rows+='<tr><td>'+esc(it.name||'')+(it.sfx?' <span style="color:#b8860b">'+esc(it.sfx)+'</span>':'')+'</td>'
        +'<td class="num">'+((it.zibei)?'自备':n(it.qty))+'</td>'
        +'<td>'+((it.zibei)?'':esc(it.unit||it.du||'g'))+'</td>'
        +'<td class="num">'+((it.zibei)?'':money(it.price))+'</td>'
        +'<td class="num">'+((it.zibei)?'':money(amt))+'</td></tr>';
    }
    var doses=n(c.doses)||1;
    var h='<div style="font-size:13px;color:#444;margin-bottom:10px">'
      +'<b style="font-size:16px">'+esc(c.name||'')+'</b>'
      +'　<span style="color:#888">'+esc(c.guest||'')+' ｜ '+doses+' 付 ｜ 创建 '+esc(c.createdAt||'')+'</span></div>'
      +'<div style="border:1px solid #e5e6e8;border-radius:10px;max-height:60vh;overflow:auto">'
      +'<table class="gst-tbl"><thead><tr><th>药名</th><th>数量</th><th>单位</th><th>单价</th><th>金额</th></tr></thead><tbody>'
      +(rows||'<tr><td colspan="5">（无药材）</td></tr>')+'</tbody></table></div>'
      +'<div style="margin-top:12px;font-size:13px;color:#333">单付 <b>¥'+money(per)+'</b> × '+doses+' 付 = <b style="color:var(--pri-deep);font-size:16px">¥'+money(per*doses)+'</b></div>';
    if($('rxPreviewBody')) $('rxPreviewBody').innerHTML=h;
    var m=$('mRxPreview'); if(m) m.classList.add('on');
  }
  function gstPad3(x){ x=String(x); while(x.length<3) x='0'+x; return x; }
  function reuseCommon(id){
    var c=gstCfFind(id); if(!c){ toastErr('常用方不存在'); return; }
    var os=gstOrdersRaw(), date=today(), now=nowStr();
    var io={ id:'WP'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
             no:'WP-'+date.replace(/-/g,'')+'-'+gstPad3(os.length+1),
             guest:c.guest||'', dish:c.name||'', doses:n(c.doses)||1, date:date, fy:'',
             saveCommon:false, commonId:c.id||'', paid:'',
             blocks:[{ id:'B'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
                       title:c.name||'常用方', source:'common', fromRxNo:'', remark:'',
                       items:JSON.parse(JSON.stringify(c.items||[])), fy:'', doses:n(c.doses)||1 }],
             createdAt:now, updatedAt:now };
    os.unshift(io);
    gstOrdersWrite(os);
    if(typeof navGo==='function') navGo('print');
    try{ if(window.WPlan){ WPlan.ensure(); WPlan.selectOrder(io.id); } }catch(e){}
    toast('已带入常用方「'+(c.name||'')+'」，可直接修改并保存');
  }
  function delCommon(id){
    var c=gstCfFind(id); if(!c) return;
    if(!confirm('确定删除常用方「'+(c.name||'')+'」？')) return;
    GST_CF=GST_CF.filter(function(x){ return x.id!==id; });
    gstCfPersist(); renderCommon(); toast('已删除');
  }
  function filteredHistory(){
    var os=gstGuestOrders(GUEST_CUR);
    if(_month){
      var out=[];
      for(var i=0;i<os.length;i++){
        var s=String(os[i].date||os[i].createdAt||'');
        if(s.indexOf(_month)===0) out.push(os[i]);
      }
      return out;
    }
    return os;
  }
  function filteredRx(){
    var rx=gstGuestRx(GUEST_CUR);
    if(!_month) return rx;
    var out=[];
    for(var i=0;i<rx.length;i++){
      if(String((rx[i]&&rx[i].dt)||'').indexOf(_month)===0) out.push(rx[i]);
    }
    return out;
  }
  /* 历史订单 = 本机药方打印单 + 该客户未被打印单引用的处方（云端按姓名查回来的）。
     打印单的 blocks 里存了 fromRxNo：已被某张打印单用过的处方不再重复计一单。 */
  function historyRows(){
    var covered={}, all=gstOrdersRaw(), i, j, bs;
    for(i=0;i<all.length;i++){
      bs=(all[i]&&all[i].blocks)||[];
      for(j=0;j<bs.length;j++){ if(bs[j]&&bs[j].fromRxNo) covered[String(bs[j].fromRxNo)]=1; }
    }
    var rows=[], os=filteredHistory();
    for(i=0;i<os.length;i++) rows.push({kind:'order', dt:String(os[i].createdAt||os[i].date||''), o:os[i]});
    var rx=filteredRx();
    for(i=0;i<rx.length;i++){
      var r=rx[i];
      if(r && r.no && covered[String(r.no)]) continue;
      rows.push({kind:'rx', dt:String((r&&r.dt)||'')+((r&&r.tm)?(' '+r.tm):''), r:r});
    }
    rows.sort(function(a,b){ return a.dt>b.dt?-1:(a.dt<b.dt?1:0); });
    return rows;
  }
  function renderHistory(){
    var box=$('gstHistoryList'); if(!box) return;
    if(!GUEST_CUR){ box.innerHTML='<div class="gst-empty-row">请先选择客户</div>'; return; }
    var rows=historyRows();
    if($('gstHistCount')) $('gstHistCount').textContent='共 '+rows.length+' 单' + (_month?('（'+_month+'）'):'');
    var h='<table class="gst-tbl"><thead><tr><th>时间</th><th>单名</th><th class="num">付数</th><th class="num">总金额</th><th style="text-align:right">状态</th></tr></thead><tbody>';
    if(!rows.length){
      h+='<tr><td colspan="5" class="gst-empty-row">'+(_month?'该年月没有单据':'该客户还没有历史订单')+'</td></tr>';
    }
    for(var i=0;i<rows.length;i++){
      var row=rows[i];
      if(row.kind==='order'){
        var o=row.o, paid=gstIsPaid(o), key=o.id||o.no||'';
        h+='<tr>'
          +'<td>'+esc(gstFmtTime(o.createdAt||o.date))+'</td>'
          +'<td class="nm">'+esc(gstOrderName(o))+'</td>'
          +'<td class="num">'+gstOrderDoses(o)+' 付</td>'
          +'<td class="money">¥'+money(gstOrderAmount(o))+'</td>'
          +'<td style="text-align:right"><button type="button" class="gst-st '+(paid?'paid':'unpaid')+'" title="点击切换已结/未结" onclick="Guest.togglePaid(\''+esc(key)+'\')">'+(paid?'已结':'未结')+'</button></td>'
          +'</tr>';
      }else{
        var r=row.r, a=statAmount(r), fy=rxIsFayao(r);
        h+='<tr>'
          +'<td>'+esc(gstFmtTime(row.dt))+'</td>'
          +'<td class="nm">'+esc(r.no||'未编号')+'<span class="gst-ordtag">处方</span></td>'
          +'<td class="num">'+a.j+' 付</td>'
          +'<td class="money">¥'+money(a.total)+'</td>'
          +'<td style="text-align:right"><span class="gst-st plain '+(fy?'paid':'unpaid')+'">'+(fy?'已发':'未发')+'</span></td>'
          +'</tr>';
      }
    }
    h+='</tbody></table>';
    box.innerHTML=h;
  }
  function togglePaid(key){
    var os=gstOrdersRaw(), found=null;
    for(var i=0;i<os.length;i++){ if((os[i].id||os[i].no)===key){ found=os[i]; break; } }
    if(!found){ toastErr('找不到该单据'); return; }
    found.paid = gstIsPaid(found) ? '' : '1';
    found.updatedAt=nowStr();
    gstOrdersWrite(os);
    renderHistory(); renderList();
    if(GUEST_CUR && GUESTS[GUEST_CUR]){ if($('gstMeta')) $('gstMeta').textContent=metaText(GUESTS[GUEST_CUR]); }
    toast(gstIsPaid(found)?'已标记为已结':'已标记为未结');
  }
  function setMonth(v){ _month=String(v||''); renderHistory(); }
  function clearMonth(){
    _month=''; if($('gstMon')) $('gstMon').value=''; renderHistory();
  }
  function safeFile(s){ return String(s||'').replace(/[\\/:*?"<>|]/g,'_'); }
  function exportBill(){
    if(!GUEST_CUR){ toastErr('请先选择客户'); return; }
    var g=GUESTS[GUEST_CUR], rows=historyRows();
    if(!rows.length){ toastErr('没有可导出的单据'); return; }
    var total=0, unpaid=0, body='';
    for(var i=0;i<rows.length;i++){
      var row=rows[i], amt=0, name='', doses='', st='';
      if(row.kind==='order'){
        var o=row.o, paid=gstIsPaid(o);
        amt=gstOrderAmount(o); name=gstOrderName(o); doses=gstOrderDoses(o); st=paid?'已结':'未结';
        if(!paid) unpaid+=amt;
      }else{
        var r=row.r, a=statAmount(r);
        amt=a.total; name=(r.no||'未编号')+'（处方）'; doses=a.j; st=rxIsFayao(r)?'已发':'未发';
      }
      total+=amt;
      body+='<tr><td>'+(i+1)+'</td><td>'+esc(gstFmtTime(row.dt))+'</td>'
        +'<td>'+esc(name)+'</td><td>'+doses+'</td>'
        +'<td style="text-align:right">'+money(amt)+'</td><td>'+st+'</td></tr>';
    }
    var title=(_month?_month+' ':'')+(g.name||'')+' 历史账单';
    var html='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
      +'<head><meta charset="utf-8"><title>'+esc(title)+'</title>'
      +'<style>@page{size:A4;margin:18mm} body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#111;font-size:12pt}'
      +'h1{font-size:20pt;margin:0 0 6pt} .meta{color:#666;font-size:10.5pt;margin-bottom:14pt}'
      +'table{border-collapse:collapse;width:100%;font-size:10.5pt} th,td{border:1px solid #999;padding:6pt 8pt;text-align:left}'
      +'th{background:#f2f4f6} .tot{margin-top:14pt;font-size:12pt} .tot b{font-size:15pt}</style></head><body>'
      +'<h1>'+esc(title)+'</h1>'
      +'<div class="meta">客户：'+esc(g.name||'')+'　电话：'+esc(g.phone||'—')+'　类型：'+esc(g.ctype||'散客')
      +'　导出时间：'+esc(nowStr())+'</div>'
      +'<table><thead><tr><th style="width:40pt">序号</th><th>时间</th><th>单名</th><th style="width:52pt">付数</th><th style="width:86pt">总金额(元)</th><th style="width:52pt">状态</th></tr></thead><tbody>'
      +body+'</tbody></table>'
      +'<div class="tot">本页合计：<b>¥'+money(total)+'</b>　未结：¥'+money(unpaid)+'</div>'
      +'</body></html>';
    var blob=new Blob(['\ufeff'+html],{type:'application/msword'});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=safeFile((_month?_month+'_':'')+(g.name||'客户')+'_历史账单')+'.doc';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); },2000);
    toast('已导出 Word 账单');
  }

  return {
    ensure:ensure, setSearch:setSearch, clearSearch:clearSearch, pick:pick, tab:tab,
    refreshFeed:refreshFeed,
    newCustomer:newCustomer, createCustomer:createCustomer,
    renderCommon:renderCommon, newCommon:newCommon, editCommon:editCommon, saveCommon:saveCommon,
    previewCommon:previewCommon, reuseCommon:reuseCommon, delCommon:delCommon,
    renderDaily:renderDaily, refreshDaily:refreshDaily,
    renderHistory:renderHistory, setMonth:setMonth, clearMonth:clearMonth,
    exportBill:exportBill, togglePaid:togglePaid
  };
})();

/* 兼容旧入口（导航 / NAV_EXIST 仍可能调用） */
function openGuest(){ if(typeof navGo==='function') navGo('guest'); }


/* ================= 盈利统计（当日 / 当周 / 当月） =================
   只统计**已发药**的处方。
   金额来源：
   - 本机保存的单（SAVED）：自带金额字段（f 单剂药费 / o 合计），最准，直接用。
   - 书剑历史单（HISTORY + HIST_EDIT）：**只有药名和克数、没有金额**，
     按药价目录逐味实时算单剂药费，再 × 剂数 + 各项费用。 */
function statParseDet(m){
  var txt=String(m||'');
  if(!txt.trim()) return null;
  var parts=txt.split(/\s{2,}/).map(function(s){return s.trim();}).filter(function(s){return s;});
  var sum=0, miss=0;
  for(var i=0;i<parts.length;i++){
    var nm=parts[i], qty=0, unit='g';
    var m1=nm.match(/^(.*?)[\s]*(\d+(?:\.\d+)?)\s*(g|kg|ml|\u514b|\u4e2a|\u888b|\u652f|\u7247|\u4e38)?\s*$/i);
    if(m1){ nm=m1[1].trim(); qty=parseFloat(m1[2]); unit=normUnit(m1[3]||'g'); }
    if(!nm||!qty) continue;
    var d=findDrug(nm), p=d? n(d.p) : null;
    if(p==null){
      var all=findDrugAll(nm);
      for(var k=0;k<all.length;k++){ if(String(all[k].u||'g')===String(unit)){ p=n(all[k].p); break; } }
    }
    if(p==null){ miss++; continue; }
    sum+=p*qty;
  }
  return {per:Math.round(sum*100)/100, missing:miss};
}
/* 一张已发药处方的金额 */
function statAmount(r){
  var j=Math.max(1,Math.round(n(r.j)||1));
  var per;
  if(r.f!=null && String(r.f)!=='') per=n(r.f);
  else { var d=statParseDet(r.m); per=d?d.per:0; }
  var fee=0, ex=[];
  function add(k,label){ var v=n(r[k]); if(v){ fee+=v; ex.push(label+money(v)); } }
  add('e','\u52a0\u5de5'); add('dj','\u4ee3\u714e'); add('pt','\u8dd1\u817f');
  add('ex','\u95ea\u9001'); add('kd','\u5feb\u9012'); add('g','\u7269\u54c1');
  var total=(r.o!=null && String(r.o)!=='')? n(r.o) : (per*j+fee);
  return {j:j, per:Math.round(per*100)/100, fee:Math.round(fee*100)/100,
          ex:ex.join(' '), total:Math.round(total*100)/100,
          name:r.n||'', dt:r.dt||'', fy:r.fy||''};
}
/* 区间：0=当日 1=当周（周一起） 2=当月 */
function statRange(kind){
  var now=new Date(), y=now.getFullYear(), mo=now.getMonth(), d=now.getDate();
  function p2(x){ return (x<10?'0':'')+x; }
  var from,to,label;
  if(kind===0){ from=to=y+'-'+p2(mo+1)+'-'+p2(d); label='\u5f53\u65e5'; }
  else if(kind===1){
    var wd=(now.getDay()+6)%7, mon=new Date(y,mo,d-wd);
    from=mon.getFullYear()+'-'+p2(mon.getMonth()+1)+'-'+p2(mon.getDate());
    to=y+'-'+p2(mo+1)+'-'+p2(d); label='\u5f53\u5468';
  } else { from=y+'-'+p2(mo+1)+'-01'; to=y+'-'+p2(mo+1)+'-'+p2(d); label='\u5f53\u6708'; }
  return {from:from,to:to,label:label};
}
function statDo(kind){
  var rg=statRange(kind), list=allRx(), rows=[], total=0;
  for(var i=0;i<list.length;i++){
    var r=list[i], dt=String(r.dt||'');
    if(!dt || dt<rg.from || dt>rg.to) continue;
    if(String(r.fy||'').indexOf('\u53d1')<0) continue;   /* 只统计已发药 */
    var a=statAmount(r);
    rows.push(a); total+=a.total;
  }
  rows.sort(function(x,y){ return x.dt<y.dt?-1:(x.dt>y.dt?1:0); });
  return {from:rg.from,to:rg.to,label:rg.label,rows:rows,count:rows.length,
          total:Math.round(total*100)/100};
}
var STAT_KIND=0;
function statRender(){
  var r=statDo(STAT_KIND);
  var avg=r.count?Math.round(r.total/r.count*100)/100:0;
  var tabs='<div style="display:flex;gap:6px;margin-bottom:8px">'
    +['\u5f53\u65e5','\u5f53\u5468','\u5f53\u6708'].map(function(t,i){
        return '<button type="button" data-k="'+i+'" class="'+(STAT_KIND===i?'pri':'')+'" style="min-width:70px">'+t+'</button>';
      }).join('')
    +'</div>';
  var box='<div style="border:1px solid var(--pri-soft);background:#f2f8ff;border-radius:6px;padding:10px 12px;margin-bottom:10px">'
    +'<div style="font-size:12px;color:var(--n-5)">'+r.label+'总金额（元）</div>'
    +'<div style="font-size:28px;font-weight:700;color:var(--n-5);line-height:1.25">'+money(r.total)+'</div>'
    +'<div style="font-size:11px;color:#666;margin-top:2px">'+r.from+(r.from!==r.to?(' ~ '+r.to):'')
    +' ｜ 已发药 '+r.count+' 单 ｜ 客单 '+money(avg)+'</div></div>';
  $('stCards').innerHTML=tabs+box;

  var html='<table class="pltable" style="font-size:12px"><thead><tr>'
    +'<th style="width:92px">\u65e5\u671f</th><th style="width:110px">\u59d3\u540d</th>'
    +'<th style="width:50px">\u5242\u6570</th><th style="width:78px">\u5355\u5242\u836f\u8d39</th>'
    +'<th style="width:120px">\u5176\u4ed6\u8d39\u7528</th><th style="width:84px">\u5408\u8ba1</th>'
    +'</tr></thead><tbody>';
  if(!r.rows.length){
    html+='<tr><td colspan="6" style="text-align:center;color:#888;padding:16px">'+r.label+'\u6ca1\u6709\u5df2\u53d1\u836f\u7684\u5904\u65b9</td></tr>';
  } else {
    for(var i=0;i<r.rows.length;i++){
      var a=r.rows[i];
      html+='<tr><td>'+esc(a.dt)+'</td><td>'+esc(a.name)+'</td>'
        +'<td style="text-align:center">'+a.j+'</td>'
        +'<td style="text-align:center">'+money(a.per)+'</td>'
        +'<td style="font-size:11px">'+esc(a.ex||'\u2014')+'</td>'
        +'<td style="text-align:center;font-weight:700">'+money(a.total)+'</td></tr>';
    }
    html+='<tr style="background:#f0eee8;font-weight:700"><td colspan="5" style="text-align:right">\u5408\u8ba1</td>'
      +'<td style="text-align:center;font-weight:700">'+money(r.total)+'</td></tr>';
  }
  html+='</tbody></table>';
  $('stTableWrap').innerHTML=html;
  var bs=$('stCards').querySelectorAll('button[data-k]');
  for(var j=0;j<bs.length;j++){
    bs[j].onclick=(function(k){ return function(){ STAT_KIND=k; statRender(); }; })(parseInt(bs[j].getAttribute('data-k'),10));
  }
}
function openStat(){ STAT_KIND=0; statRender(); $('mStat').classList.add('on'); }

/* ================= 重要客人（专属药价 · 改价历史 · 处方统计） =================
   医生识别：**从姓名自动提取**。同一姓名第一次以医生身份保存后即建立档案，
   之后处方笺里再出现这个名字，就自动按该医生的专属价库计价。

   数据结构（RX_STORE: rx_doctors_v1，也参与云端加密同步）：
   {
     "陈医生": {
       n:"陈医生", at:"2026-10-05 12:00",     // 建档时间
       price:{ "白芍":0.15, "茯苓":0.08 },   // 专属价（元/克 或 元/单位）
       log:[ {t:"2026-10-05 12:30", d:"白芍", from:0.13, to:0.15, rx:"RX17...", who:"陈医生"} ]
     }
   }
   计价优先级：医生专属价 > 本单手改单价 > 药品目录价。 */

/* 从姓名里提取医生名。
   书剑历史数据的姓名栏是「医生名 病人名」（空格分隔），如「谢医生 李彩莲」；
   也可能整栏就是医生名（如「陆医生」）或普通病人名（如「张三」）。
   规则：取空格/逗号/顿号分隔的第一段，必须整体是「××医生」这类纯称谓才算医生，
   「梁医生结石方」「张医生亲戚」这类带后缀的噪音要排除。 */
function doctorFromName(name){
  var s=String(name||'').trim();
  if(!s) return '';
  var head=s.split(/[ ,，、\u3000]/)[0].trim();
  if(/^[一-龥]{1,3}(医生|医师|大夫|医士|郎中|教授|主任|院长)$/.test(head)) return head;
  if(/^[一-龥]{1,2}医$/.test(head)) return head;
  return '';
}
function looksLikeDoctor(name){ return !!doctorFromName(name); }
var LS_DOCTORS='rx_doctors_v1';

/* ================= Supabase 数据层 =================
   作用：让「历史处方」不再只是页面内置的只读数据，而是真正存在你自己的数据库里，
        在手机 / Mac / Windows 打开同一链接都能读到，并且**可以改、可以写回**。

   设计要点：
   - 纯 REST（fetch），不引任何第三方 SDK，单文件保持自包含。
   - 失败一律「降级到本地」：数据库连不上时页面照常能用，绝不让用户看到空白。
   - 写入用「按主键 upsert / update」，冲突时后写的覆盖先写的。 */
var SUPA={
  url:'https://ikrhpxbnnfqvotnquziy.supabase.co',
  key:'sb_publishable_22DqGTvSYu2QjtMq53fB4Q_QiF9wITb'
};
SUPA.on=true;          /* 连通后置 true */
SUPA.drugsPulled=false; /* 云端药价是否已拉回来；true 之后才允许整表上传（防止本机旧目录冲掉云端）*/
SUPA.hdr=function(){
  return {'apikey':SUPA.key,'Authorization':'Bearer '+SUPA.key,'Content-Type':'application/json'};
};
SUPA.q=function(path, opt){
  opt=opt||{};
  /* 带 on_conflict= 的 POST 必须加 Prefer: resolution=merge-duplicates，
     否则 PostgREST 按普通 INSERT 处理 → 已存在的行一律 409，
     药价/重要客人/处方的云端写入会静默失败（2026-10-07 实测 4 块药价全 409）。 */
  var hdrs=Object.assign(SUPA.hdr(), opt.headers||{});
  if((opt.method||'GET')==='POST' && path.indexOf('on_conflict=')>=0 && !hdrs['Prefer']){
    hdrs['Prefer']='resolution=merge-duplicates';
  }
  return fetch(SUPA.url+'/rest/v1/'+path, {
    method: opt.method||'GET',
    headers: hdrs,
    body: opt.body?JSON.stringify(opt.body):undefined
  }).then(function(r){
    if(!r.ok){
      /* 出错时把响应体一并带出来，否则只能看到 HTTP 400 这种没用的信息 */
      return r.text().then(function(t){
        throw new Error('HTTP '+r.status+' '+(t||r.statusText).slice(0,180));
      });
    }
    if(r.status===204) return null;
    return r.text().then(function(t){
      if(!t) return null;
      try{ return JSON.parse(t); }
      catch(e){ throw new Error('响应不是 JSON（HTTP '+r.status+'）：'+t.slice(0,180)); }
    });
  });
};
/* PostgREST 单次最多返回 1000 行，limit 给再大也没用（2026-10-06 实测：
   limit=6000 依旧只回 1000 条，Content-Range 0-999/*）。
   所以按 offset 循环翻页，直到返回不足一页为止。 */
SUPA.qAll=function(path, pageSize){
  pageSize=pageSize||1000;
  var sep=path.indexOf('?')>=0?'&':'?';
  var out=[], offset=0;
  function one(){
    var p=path+sep+'limit='+pageSize+'&offset='+offset;
    return SUPA.q(p).then(function(rows){
      if(!rows||!rows.length) return out;
      rows.forEach(function(r){ out.push(r); });
      if(rows.length<pageSize) return out;
      offset+=pageSize;
      if(offset>50000) return out;      /* 安全上限，别无限翻 */
      return one();
    });
  }
  return one();
};
/* 把数据库一行还原成页面内部那条记录（字段名与 RX_HISTORY_SRC 对齐） */
function supaRowToRec(r){
  var m='';
  if(Array.isArray(r.items)&&r.items.length){
    m=r.items.map(function(it){
      if(it.q==null) return String(it.n||'');
      var u=it.u||'g';
      return it.n+(u==='g'?(' '+it.q):(' '+it.q+u));
    }).join('     ');
  }
  var f=r.fee||{};
  return {
    n:r.name||'', s:r.sex||'', a:r.age||'', j:r.jishu||1, m:m, px:f.px||'',
    f:f.f||'', e:f.e||'', g:f.g||'', o:f.o||'', fw:f.fw||'', w:f.w||'', px:f.px||'',
    dj:f.dj||'', pt:f.pt||'', ex:f.ex||'', kd:f.kd||'',
    dt:r.dt||'', tm:r.tm||'', no:r.no||'', b:r.note||'', fy:r.fayao?'【发】':"",
    c:r.category||'中医', __supa:true
  };
}
/* 页面记录 → 数据库行 */
function supaRecToRow(rec, isHist){
  var items=splitItemsToJson(rec.m);
  return {
    no:rec.no, dt:rec.dt, tm:rec.tm||'', name:rec.n||'', sex:rec.s||'',
    age:rec.a||'', jishu:(parseInt(rec.j,10)||1), items:items,
    /* fee 里除金额外还存 px（每味药单价）与各项附加费，
       全部放 jsonb，不用改表结构 */
    fee:{f:rec.f||'',e:rec.e||'',g:rec.g||'',o:rec.o||'',fw:rec.fw||'',w:rec.w||'',
         dj:rec.dj||'',pt:rec.pt||'',ex:rec.ex||'',kd:rec.kd||'',px:rec.px||''},
    note:rec.b||'', fayao:!!rec.fy, category:rec.c||'中医', is_hist:!!isHist
  };
}
function splitItemsToJson(m){
  var out=[];
  if(!m) return out;
  var re=/([^\s]+)\s*(\d+(?:\.\d+)?)\s*(g|克|kg|KG|斤|ml|ML|个|片|袋|支|瓶)?|自备/g, mm;
  while((mm=re.exec(m))!==null){
    if(mm[1]==null){ out.push({n:'自备',q:null,u:null}); continue; }
    out.push({n:mm[1],q:parseFloat(mm[2]),u:mm[3]||'g'});
  }
  return out;
}
function joinItems(items){
  if(!Array.isArray(items)||!items.length) return '';
  return items.map(function(it){
    if(it.q==null) return String(it.n||'');
    var u=it.u||'g';
    return it.n+(u==='g'?(' '+it.q):(' '+it.q+u));
  }).join('     ');
}

/* ---------- 1. 拉取全部历史处方（唯一来源：Supabase，云端没有则为空） ---------- */
SUPA.loadHist=function(){
  return SUPA.qAll('prescriptions?select=*&is_hist=eq.true&order=dt.asc')
  .then(function(rows){
    HISTORY_ORIG=(rows||[]).map(supaRowToRec);
    SUPA.on=true;
    return HISTORY_ORIG.length;
  });
};
/* ---------- 3. 拉取药价目录 ---------- */
/* 药价「安全下限」：整表上传前，本机条数不得少于这个数的 40%。
   首次从云端加载成功后按真实条数校准（1039 味 → 下限约 415）。
   作用：用户点「清空药物」重建目录的中间态被拦下，云端不会被覆盖成空/少量。 */
var RX_DRUG_FLOOR=0;
function rxCalibDrugFloor(n){
  var c=Math.floor(n*0.4);
  if(c>RX_DRUG_FLOOR) RX_DRUG_FLOOR=c;   /* 只升不降，避免异常低值把门槛拉低 */
}
/* noSave=true：只读刷新（划价前实时拉库用）——换 drugsList + 重建索引，
   不写 RX_STORE、不触发整表 upsert、不写备份，纯读取零副作用。 */
/* ---------- 药名尾缀统一方括号（2026-10-28 用户要求）----------
   「XXX{备注}」→「XXX[备注]」；已经是 [备注] 或没有后缀的条目一律不动。
   书剑/历史数据本来就是方括号，程序里 splitSfx 也只认方括号，这里把旧名洗一遍，
   本机存储与云端老行都跟着转，避免同一味药出现「{}」「[]」两条。 */
function brkNormName(n){
  return String(n==null?'':n).replace(/\s*[\{｛]\s*([^\{\}｛｝]*?)\s*[\}｝]\s*$/,'[$1]');
}
function brkMigrateList(list){
  var pairs=[];
  if(!list||!list.length) return pairs;
  for(var i=0;i<list.length;i++){
    var d=list[i]; if(!d) continue;
    var o=String(d.n||''), v=brkNormName(o);
    if(v!==o){ d.n=v; pairs.push({o:o,n:v}); }
  }
  return pairs;
}
/* 云端清理：先确保新名那行写进去了，再删旧名那行；进货价历史按药名 PATCH 过去。
   云端不可达时直接放弃（下次加载会再触发一次），绝不删了旧的又没写成新的。 */
var _brkPending=[], _brkTimer=null;
function brkScheduleCleanup(pairs){
  if(!pairs||!pairs.length) return;
  _brkPending=_brkPending.concat(pairs);
  if(_brkTimer) clearTimeout(_brkTimer);
  _brkTimer=setTimeout(function(){
    if(typeof SUPA==='undefined' || !SUPA.on){ return; }
    var ps=_brkPending; _brkPending=[];
    var ups=[], seen={};
    for(var i=0;i<ps.length;i++){
      var p=ps[i]; if(!p.o||!p.n||p.o===p.n||seen[p.n]) continue;
      var d=null;
      for(var j=0;j<drugsList.length;j++){ if(drugsList[j] && drugsList[j].n===p.n){ d=drugsList[j]; break; } }
      if(!d) continue;
      seen[p.n]=1; ups.push({p:p,d:d});
    }
    if(!ups.length) return;
    SUPA.q('drugs?on_conflict=name',{method:'POST',body:ups.map(function(x){ return dmRowOfFull(x.d); })})
      .then(function(){
        ups.forEach(function(x){
          SUPA.q('drugs?name=eq.'+encodeURIComponent(x.p.o),{method:'DELETE'}).catch(function(){});
          SUPA.q('drug_cost_log?drug=eq.'+encodeURIComponent(x.p.o),{method:'PATCH',body:{drug:x.p.n}}).catch(function(){});
        });
      })
      .catch(function(e){ console.warn('旧药名云端清理跳过:',e&&e.message); });
  },8000);
}
SUPA.loadDrugs=function(noSave){
  return SUPA.qAll('drugs?select=*&order=name')
  .then(function(rows){
    rows=rows||[];
    rxCalibDrugFloor(rows.length);
    drugsList=rows.map(function(r){
      return {n:brkNormName(r.name),u:r.unit||'g',c:r.usage||'',tc:r.tccat||'',py:r.py||'',
              id:(r.id==null?'':String(r.id)),
              dw:'',cat:r.category||'中药',bp:r.cost==null?'':String(r.cost),
              p:r.price==null?'':String(r.price),st:'',
              dp:r.daily_price==null?'':String(r.daily_price),
              wp:(r.wp!=null)?String(r.wp):'',
              rates:(r.rates&&typeof r.rates==='object')?r.rates:null,
              og:r.origin||'', al:Array.isArray(r.aliases)?r.aliases:[],
              un:Array.isArray(r.units)?r.units:[]};
    });
    var brkPairs=brkMigrateList(drugsList);
    brkScheduleCleanup(brkPairs);
    /* 归一后可能出现同名两条（云端同时存着 X{备注} 和 X[备注]）：
       保留后出现的那条，空着的字段从另一条补过来，避免表格里出现两行一样的药。 */
    var _ord=[], _map={};
    for(var z=0;z<drugsList.length;z++){
      var it=drugsList[z]; if(!it||!it.n) continue;
      var prev=_map[it.n];
      if(prev){
        for(var f in prev){
          var v=it[f], pv=prev[f];
          var empty=(v===''||v==null||(Object.prototype.toString.call(v)==='[object Array]'&&!v.length));
          var hasP=(pv!==''&&pv!=null&&!(Object.prototype.toString.call(pv)==='[object Array]'&&!pv.length));
          if(empty&&hasP) it[f]=pv;
        }
        _ord[_ord.indexOf(prev)]=it; _map[it.n]=it;
      }else{ _map[it.n]=it; _ord.push(it); }
    }
    drugsList=_ord.filter(Boolean);
    /* 一药多规格：云端没有 stock 列，库存只存在 units jsonb 里 →
       主规格库存要从「同单位镜像」回读（dmNormalizeSpecs 里做），顺便清掉空/重复单位。 */
    for(var q2=0;q2<drugsList.length;q2++){ if(drugsList[q2]) dmNormalizeSpecs(drugsList[q2]); }
    buildIndex();
    /* 云端数据已经加载完 → 旧药名迁移队列作废；放闸允许后续整表上传。 */
    _brkPending=[]; if(_brkTimer){ clearTimeout(_brkTimer); _brkTimer=null; }
    SUPA.drugsPulled=true;
    return drugsList.length;
  });
};
/* ---------- 进货单 / 进货价历史 ---------- */
SUPA.loadPurchases=function(){
  return SUPA.q('purchases?select=*&order=dt.desc&limit=6000')
    .then(function(rows){ return rows||[]; });
};
SUPA.savePurchase=function(rec){
  return SUPA.q('purchases?on_conflict=no', {method:'POST', body:rec});
};
SUPA.loadCostLog=function(name){
  return SUPA.q('drug_cost_log?drug=eq.'+encodeURIComponent(name)+'&order=created_at.desc&limit=300')
    .then(function(rows){ return rows||[]; });
};
/* 进货价历史全量（进货单页启动时用）：云端唯一来源 */
SUPA.loadAllCostLogs=function(){
  return SUPA.qAll('drug_cost_log?select=*&order=created_at.desc')
    .then(function(rows){ return rows||[]; });
};
SUPA.addCostLog=function(row){
  return SUPA.q('drug_cost_log', {method:'POST', body:row});
};
/* ---------- 3. 拉取「我新录的处方」（is_hist=false）并成本机 SAVED ---------- */
/* 姓名+日期指纹：只用于「60 秒内连点保存」的防重复（见 saveRx）。
   ⚠️ 这个口径**只在这个场景用**，绝不能拿去做展示层的去重：
   同一人同一天开多张方子是正常业务（历史档案 5650 条里 199 条如此），
   一旦据此合并，第二张方子会被藏起来 —— 数据在库、界面看不到、改不了。
   展示层现在一律按处方编号取并集，见 SUPA.loadNew 的说明。 */
function rxDupKey(rec){
  try{
    return (rec.dt||'')+'|'+(rec.n||'');
  }catch(e){ return rec.no||''; }
}
/* ================= 一次性清理：助手验证测试数据（2026-10-07 16:50）=================
   助手做浏览器自动化验证时，用loadRx() 灌过一张名为「截图测试」的假处方，
   当时页面把它当新处方写进了**本机 RX_STORE 和云端数据库**。
   云端那条已手工 DELETE，但**各设备本机 RX_STORE（rx_saved_v3）里还留着**，
   用户刷新页面仍会看到它（数据先读本机、再与云端合并）。

   这里做一次性清理：命中测试编号/测试姓名就从本机 SAVED 与云端一起删掉。
   幂等——删过之后不会再命中，也不会碰任何真实处方。 */
var RX_TESTKEY='rx_purge_testdata_20261007';
function purgeTestData(){
  var TEST_NOS={TESTBRKT001:1, 'TESTBRKT-001':1};
  var TEST_NAMES={'截图测试':1};
  var hit=0;
  try{
    if(Array.isArray(SAVED)){
      var keep=SAVED.filter(function(r){
        var bad=(TEST_NOS[r.no]||TEST_NAMES[String(r.n||'').trim()]);
        if(bad){ hit++; return false; }
        return true;
      });
      if(keep.length!==SAVED.length){ SAVED=keep; }
    }
  }catch(e){}
  /* 云端同样清一遍（已删过就是 204/404，幂等） */
  try{
    Object.keys(TEST_NOS).forEach(function(no){
      if(String(no).indexOf('-')>=0){
        SUPA.q('prescriptions?no=eq.'+encodeURIComponent(no), {method:'DELETE'}).catch(function(){});
      }
    });
    SUPA.q('prescriptions?name=eq.'+encodeURIComponent('截图测试'), {method:'DELETE'}).catch(function(){});
  }catch(e){}
  if(hit){ console.warn('已清理测试处方数据', hit, '条'); }
  return hit;
}
SUPA.loadNew=function(){
  return SUPA.qAll('prescriptions?select=*&is_hist=eq.false&order=dt.desc')
  .then(function(rows){
    if(!rows) return 0;
    /* 🔴 云端**不再做任何内容去重**，一律按处方编号（主键）取并集。
       理由（2026-10-08 用户明确要求「续开」后必须改）：
       - 任何按内容/姓名/日期的折叠都可能把**另一张真实处方**藏起来。
         数据还在库里，界面却看不到、改不了，等于丢失。
         「续开」尤其致命：它复制的药味与原方完全一样，一旦被折叠，
         用户刷新后就查不到刚续开的那条 —— 直接违反需求。
       - 2026-10-07 那批 72 条连点重复**早已在云端清理干净**
         （2026-10-08 实测：is_hist=false 共 38 条，内容重复 0 组），
         根因也已从写入侧堵死（保存撞号绝不换号 + 60 秒同指纹复用编号），
         展示侧不需要再兜这一层。
       - 宁可多显示一条（用户自己能看出来并处理），
         也绝不能少显示一条（用户根本不知道它存在）。 */
    var map={}, order=[];
    function put(r){ if(r&&r.no){ if(!(r.no in map)) order.push(r.no); map[r.no]=r; } }
    /* 唯一来源是云端 prescriptions 表。墓碑（已删除）一律跳过，删了就不会复活。 */
    (rows||[]).forEach(function(r){ if(isDelNo(r.no)) return; put(supaRowToRec(r)); });
    SAVED=order.map(function(k){ return map[k]; });
    if(!Array.isArray(SAVED)) SAVED=[];
    return SAVED.length;
  });
};
/* ================= 云端写入总闸（2026-10-07 11:45）=================
   🔴 血泪事故：RX1791302966254-7654af（陈海 马凤荣 代煎）在库里 items 变成空，
      用户在数据库后台看到该行「EMPTY」。云端数据被本机覆盖成空。

   为什么会发生：
   `collectRecord()` 是**从 DOM 单元格重建**明细的（readAllCells → filledItems）。
   只要有一个瞬间 `items` 是空的（页面刚打开还没渲染、历史处方载入中、
   renderSheet 抛错、用户正在清空重填），此时任何 input 事件都会触发
   `syncRecordSoon()` → `persistCur()` → `supaSaveNew()` → 用 `items:[]`
   **upsert 覆盖云端那条完好的记录**。防抖 400ms 挡不住这种时序。

   铁律：**空值绝不允许覆盖云端**（与 rx_drugs_v3 清空事故同源，见 IRON_RULES 第六条）。
   这里做成唯一入口的总闸，`SUPA.saveRx` / `SUPA.updateHist` 都必须先过它。 */
function rxRowEmpty(row){
  if(!row) return true;
  var it=row.items;
  if(it==null) return true;
  if(Array.isArray(it)) return it.length===0;
  if(typeof it==='string') return it.replace(/[\s,]/g,'')==='';
  return false;
}
/* 写库前的最终校验。返回 true = 允许写入；false = 已拦截。
   `isNew` 只影响提示文案：新单是空 → 拦；覆盖旧单是空 → 拦（保护云端已有数据）。 */
function rxGuardWrite(row, isNew){
  if(!rxRowEmpty(row)) return true;
  var no=(row&&row.no)||'（无编号）';
  console.warn('⛔ 已拦截空明细写库，保护云端数据:', no);
  supaSaveFail('明细为空，未上传（已保护云端数据）');
  return false;
}

/* ---------- 4. 新处方写入（upsert，按处方编号）----------
   ⚠️ 曾经的坑（2026-10-06 夜）：撞号时「自动换一个编号重试」，
   结果每次重试都产生一条**新记录**——用户连点保存 20 多次，
   云端一度存进 72 条同一张方子（其中 57 条内容完全相同）。
   换号 = 新建数据，这是错的。

   现在改成：**绝不换号**。409 只说明「同一编号已存在」，
   说明这条其实已经写进去了，等一下用同一个编号重试即可（幂等覆盖）。
   只有确认「库里根本没有这个编号」时，才生成新号。 */
SUPA.saveRx=function(rec){
  var row=supaRecToRow(rec,false);
  /* 🔴 总闸：明细为空一律不写，绝不用空数组覆盖云端完好的处方 */
  if(!rxGuardWrite(row,true)) return Promise.resolve(null);
  function attempt(tries){
    return SUPA.q('prescriptions?on_conflict=no', {method:'POST', body:row})
    .catch(function(e){
      var msg=String(e&&e.message||'');
      var dup=msg.indexOf('409')>=0 || msg.indexOf('23505')>=0 || msg.indexOf('duplicate key')>=0;
      if(!dup) throw e;
      /* 409 = 这个编号已经写过了。查一下确认：
         · 若库里有这个编号 → 说明刚才那次其实成功了，直接返回，不重试；
         · 若库里没有（极少见）→ 可能是别的客户端占了号，换新号重试。 */
      return SUPA.q('prescriptions?select=no&no=eq.'+encodeURIComponent(row.no), {method:'GET'})
      .then(function(rows){
        if(rows&&rows.length){ console.warn('编号已存在，视为写入成功:', row.no); return null; }
        if(tries>0){
          var fresh=(typeof newRxNo==='function')?newRxNo():('RX'+Date.now()+'-'+rxNoSalt());
          rec.no=fresh; row.no=fresh;
          console.warn('编号被占用，已改为 '+fresh);
          return attempt(tries-1);
        }
        throw e;
      })
      .catch(function(e2){
        /* 查询本身失败：保守起见等 600ms 用同一编号重试（幂等，不会产生新记录）*/
        if(tries<=0) throw e2;
        return new Promise(function(rs){ setTimeout(rs,600); }).then(function(){ return attempt(tries-1); });
      });
    });
  }
  return attempt(2);
};
/* ---------- 4. 历史处方改后写回（update，按处方编号）---------- */
SUPA.updateHist=function(rec){
  var row=supaRecToRow(rec,true);
  /* 🔴 总闸：历史处方 5650 条是用户 10-20 年的档案，
     更不能被一次空明细的同步覆盖掉。只改金额/备注时明细本来就不会为空。 */
  if(!rxGuardWrite(row,false)) return Promise.resolve(null);
  return SUPA.q('prescriptions?no=eq.'+encodeURIComponent(rec.no),
                {method:'PATCH', body:row});
};
/* ---------- 5. 只改发药状态 ---------- */
SUPA.setFayao=function(no, on){
  return SUPA.q('prescriptions?no=eq.'+encodeURIComponent(no), {method:'PATCH', body:{fayao:!!on}});
};
/* ---------- 6. 药价改价（upsert 按药名，同时记改价历史）----------
   drugs 主键是「药名」——同名本来就该合并成一条，不存在撞号问题。
   但万一撞了也不能静默丢数据，所以失败时把错误原样抛出去。 */
SUPA.saveDrug=function(d, doctor, fromP){
  var price=(d.p===''||d.p==null)?null:parseFloat(d.p);
  var row={name:d.n, py:d.py||'', unit:d.u||'g', usage:d.c||'', category:d.cat||'中药',
           tccat:d.tc||'', price:price, cost:(d.bp===''||d.bp==null)?null:parseFloat(d.bp)};
  var p1=SUPA.q('drugs?on_conflict=name',{method:'POST',body:row});
  if(doctor&&fromP!=null&&price!=null){
    p1=p1.then(function(){
      return SUPA.q('price_logs',{method:'POST',body:{
        doctor:doctor, drug:d.n, from_price:fromP, to_price:price, rx_no:''}});
    });
  }
  return p1;
};
/* ---------- 7. 医生专属价 ---------- */
SUPA.saveDoctor=function(name, prices){
  return SUPA.q('doctors?on_conflict=name',{method:'POST',body:{name:name, prices:prices||{}}});
};
SUPA.loadDoctors=function(){
  return SUPA.q('doctors?select=*').then(function(rows){
    var m={};
    (rows||[]).forEach(function(r){ m[r.name]=r; });
    return m;
  });
};
/* 常用方全量写入：按客户名把数组放进 prices.__gcommon，其他价格字段原样保留 */
SUPA.saveGuestCommon=function(name, list){
  name=String(name||'').trim();
  if(!name) return Promise.resolve(null);
  return SUPA.q('doctors?select=name,prices&name=eq.'+encodeURIComponent(name)).then(function(rows){
    var p=(rows && rows[0] && rows[0].prices) || {};
    p.__gcommon=Array.isArray(list)?list:[];
    return SUPA.q('doctors?on_conflict=name',{method:'POST',body:{name:name, prices:p}});
  });
};
/* ---------- 8. 云端是否已加「批发价 / 各价格倍率」列 ----------
   加列语句见 supabase_price_rates.sql（drugs.wp numeric、drugs.rates jsonb）。
   没加之前只存本机：绝不能把未知列塞进 upsert —— 一批 300 味药会整批 400，
   连零售价/进货价一起写不进去。 */
SUPA.ext={ok:false, checked:false};
SUPA.probeExt=function(){
  if(SUPA.ext.checked) return Promise.resolve(SUPA.ext.ok);
  return SUPA.q('drugs?select=wp,rates&limit=1').then(function(){
    SUPA.ext.checked=true; SUPA.ext.ok=true; return true;
  }).catch(function(){
    SUPA.ext.checked=true; SUPA.ext.ok=false;
    console.info('[价格] 云端暂无 drugs.wp / drugs.rates 列，批发价与倍率仅存本机；执行 supabase_price_rates.sql 后自动上云。');
    return false;
  });
};

/* ---------- 9. 配送地址（2026-10-07 16:00 上云）----------
   🔴 之前只存 RX_STORE（ADDR_KEY='rx_addr_v1'），换设备看不到，
   地址还是处方上的关键信息（跑腿/闪送要寄到哪），必须上云。
   表结构（supabase_schema.sql 第 5 节）：
     addresses(id bigserial, name text, addr text, paotui numeric,
               shansong numeric, created_at, unique(name,addr))
   唯一键是 (name,addr) → 同一人同一地址只应有一条，
   改价用 PATCH 覆盖，删除用 DELETE。 */
function addrRow(list){
  return {
    name:String(list.a||'').trim(),
    addr:String(list.p!=null?list.p:'')===''?null:parseFloat(list.p),
  };
}
SUPA.saveAddr=function(name, list){
  var n=String(name||'').trim();
  if(!n||!Array.isArray(list)||!list.length) return Promise.resolve(null);
  /* 逐条 upsert：同一 (name,addr) 冲突时后写的覆盖先写的（价格以最后一次为准） */
  var rows=list.map(function(x){
    return {
      name:n, addr:String(x.a||'').trim(),
      paotui:(x.p===''||x.p==null||isNaN(parseFloat(x.p)))?null:parseFloat(x.p),
      shansong:(x.e===''||x.e==null||isNaN(parseFloat(x.e)))?null:parseFloat(x.e)
    };
  }).filter(function(r){ return r.addr; });
  if(!rows.length) return Promise.resolve(null);
  return SUPA.q('addresses?on_conflict=name,addr',{method:'POST',body:rows});
};
SUPA.delAddr=function(name, addr){
  return SUPA.q('addresses?name=eq.'+encodeURIComponent(String(name||'').trim())
    +'&addr=eq.'+encodeURIComponent(String(addr||'').trim()), {method:'DELETE'});
};
SUPA.loadAddrs=function(){
  return SUPA.qAll('addresses?select=name,addr,paotui,shansong&order=name').then(function(rows){
    var m={};
    (rows||[]).forEach(function(r){
      var k=String(r.name||'').trim();
      if(!k||!r.addr) return;
      if(!Array.isArray(m[k])) m[k]=[];
      m[k].push({a:String(r.addr), p:(r.paotui==null?'':String(r.paotui)),
                 e:(r.shansong==null?'':String(r.shansong))});
    });
    return m;
  });
};
/* ---------- 10. 常用备注（2026-10-07 16:00 上云）----------
   之前只存 RX_STORE（NOTE_KEY='rx_notes_v1'）。表结构：
     notes(id bigserial, text text unique, created_at)
   text 唯一 → 重复的备注直接靠数据库去重，不用在代码里先比对。 */
SUPA.saveNotes=function(list){
  var arr=(Array.isArray(list)?list:[]).map(function(t){ return String(t||'').trim(); })
    .filter(function(t){ return t; });
  if(!arr.length) return Promise.resolve(null);
  return SUPA.q('notes?on_conflict=text',{method:'POST',body:arr.map(function(t){ return {text:t}; })});
};
SUPA.delNote=function(text){
  return SUPA.q('notes?text=eq.'+encodeURIComponent(String(text||'')), {method:'DELETE'});
};
SUPA.loadNotes=function(){
  return SUPA.qAll('notes?select=text&order=id').then(function(rows){
    return (rows||[]).map(function(r){ return String(r.text||''); }).filter(Boolean);
  });
};
/* ---------- 8. 连通性探测（只判断"能不能连上"，不负责加载数据）----------
   ⚠️ 这里只取 1 条，纯粹为了省流量判断连通性。
      **药价真正的加载在 SUPA.loadDrugs()，那里是全量拉取（qAll 自动翻页）。**
      不要因为看到 limit=1 就以为药价只加载了一条。 */
SUPA.ping=function(){
  return SUPA.q('drugs?select=name&limit=1').then(function(){ SUPA.on=true; return true; });
};var DOCTORS={};          /* 重要客人档案表 */
var DOCTOR_HINT={};      /* 姓名 → 1（用户手动指定为医生，非猜测） */
var CLOUD_DOC_PRICES={}; /* 云端 doctors.prices 里各客人的药价（换设备/清缓存后靠它还原） */
var CLOUD_DOC_RATES={};  /* 云端 doctors.prices.__rates：各客人每味药的倍率 */

function loadDoctors(){
  /* 客人档案 / 专属价只来自 Supabase doctors 表（见 guestLoadAll）。 */
  try{
    var t=RX_STORE.getItem('rx_doctor_names_v1');
    if(t){ var a=JSON.parse(t)||[]; for(var i=0;i<a.length;i++) DOCTOR_HINT[a[i]]=1; }
  }catch(e){}
  /* 云端各客人已存的药价补进来（本机有的优先，只补缺） */
  for(var cn in CLOUD_DOC_PRICES){
    var cp=CLOUD_DOC_PRICES[cn]; if(!cp) continue;
    if(!DOCTORS[cn]) DOCTORS[cn]={n:cn, at:nowStr(), price:{}, log:[]};
    var t2=DOCTORS[cn]; t2.price=t2.price||{};
    for(var ck in cp){
      if(!Object.prototype.hasOwnProperty.call(t2.price,ck)) t2.price[ck]=cp[ck];
    }
    DOCTOR_HINT[cn]=1;
  }
  /* 云端各客人的倍率也补进来（本机已有的不覆盖） */
  for(var rn in CLOUD_DOC_RATES){
    var rr=CLOUD_DOC_RATES[rn]; if(!rr) continue;
    if(!DOCTORS[rn]) DOCTORS[rn]={n:rn, at:nowStr(), price:{}, log:[]};
    var t3=DOCTORS[rn]; t3.rates=t3.rates||{};
    for(var rk in rr){ if(t3.rates[rk]==null) t3.rates[rk]=rr[rk]; }
  }
  try{ purgeTestGuests(); }catch(e){}
}
/* ---------- 一次性清理：浏览器自动化验证留下的测试客人 ----------
   早期验证时往 doctors 表写过「测试医生甲 / 测试医生乙 / 检索医生」，
   这些不是真实客人，上线版本「重要客人价格」必须是空状态。
   命中后本机与云端一并删除，之后靠 PURGE_GUEST_KEY 只做内存过滤，不再重复打库。 */
var PURGE_GUEST_KEY='rx_purge_testguests_20261030';
function purgeTestGuests(){
  var re=/^(测试|检索医生|测试医生)/;
  var hit=[], nm, i;
  for(nm in DOCTORS){ if(DOCTORS.hasOwnProperty(nm) && re.test(nm)) hit.push(nm); }
  if(typeof GUESTS!=='undefined' && GUESTS){
    for(nm in GUESTS){ if(GUESTS.hasOwnProperty(nm) && re.test(nm) && hit.indexOf(nm)<0) hit.push(nm); }
  }
  if(!hit.length) return;
  for(i=0;i<hit.length;i++){
    nm=hit[i];
    try{ delete DOCTORS[nm]; }catch(e){}
    try{ if(typeof GUESTS!=='undefined' && GUESTS) delete GUESTS[nm]; }catch(e){}
  }
  try{ saveDoctors(); }catch(e){}
  if(SUPA.on){
    for(i=0;i<hit.length;i++){
      try{ SUPA.q('doctors?name=eq.'+encodeURIComponent(hit[i]),{method:'DELETE'}).catch(function(){}); }catch(e){}
    }
    try{ console.info('[清理测试客人] '+hit.join('、')); }catch(e){}
  }
}
/* ---------- 一次性清理：药物管理里验证/试录留下的测试药 ----------
   验证划价或排版时往药物目录加过「测试新药 / 测试药甲 / 艾草黄试」这类假药，
   它们不是真实药价，必须随正式版本清掉，否则打开「药物管理」还能搜到。
   命中后：本机 drugsList 过滤 + 云端 drugs 表按药名硬删，幂等、不碰真实药。 */
var PURGE_DRUG_KEY='rx_purge_testdrugs_20261030';
function purgeTestDrugs(){
  var re=/^测试|艾草黄试/;
  var before=drugsList.length, hit=[];
  drugsList=drugsList.filter(function(d){
    var nm=String(d&&d.n||'').trim();
    if(re.test(nm)){ hit.push(nm); return false; }
    return true;
  });
  if(drugsList.length!==before){ try{ saveDrugsLS(); }catch(e){} }   /* 内存目录已不含测试药 */
  if(!hit.length || !SUPA.on) return;
  hit.forEach(function(nm){
    try{ SUPA.q('drugs?name=eq.'+encodeURIComponent(nm),{method:'DELETE'}).catch(function(){}); }catch(e){}
  });
  try{ console.info('[清理测试药] '+hit.join('、')); }catch(e){}
}
function saveDoctors(){
  /* 客人档案的权威存储在 doctors 表；这里只额外记住「被标记为医生」的姓名清单。 */
  try{ RX_STORE.setItem('rx_doctor_names_v1', JSON.stringify(Object.keys(DOCTOR_HINT))); }catch(e){}
  /* 重要客人价格 → 写回数据库；顺带把「重要客人」页的折扣/备注/置顶/标星一起带上，
     否则只写药名价格会把那边的档案字段冲掉。 */
  try{
    if(SUPA.on){
      for(var dn in DOCTORS){
        (function(nm, d){
          var pr={}, src=(d&&d.price)||{};
          for(var k in src){ if(Object.prototype.hasOwnProperty.call(src,k)) pr[k]=src[k]; }
          var g=(typeof GUESTS!=='undefined'&&GUESTS)?GUESTS[nm]:null;
          if(g){ pr.discount=g.discount||0; pr.note=g.note||'';
                 pr.pins=(g.pins||[]).slice(0,3); pr.stars=(g.stars||{}); }
          if(d && d.rates) pr.__rates=d.rates;      /* 该客人各味药的倍率 */
          /* 🔴 必须把该客人的常用方原样带回，否则保存客人价格会清空 __gcommon */
          var cf=gstCfForGuest(nm);
          if(cf.length) pr.__gcommon=cf;
          SUPA.saveDoctor(nm, pr);
        })(dn, DOCTORS[dn]);
      }
    }
  }catch(e){}
}
/* 当前处方归属的医生名（改价时一并写进 price_logs） */
function curDoctorOf(){
  try{
    var nm=(typeof curRec!=='undefined'&&curRec&&curRec.n)||($('fName')&&$('fName').value)||'';
    return doctorOfName(nm);
  }catch(e){ return ''; }
}
/* 传「陈医生」或「陈医生 张三」都能认出；已建档的整串也算 */
function isDoctor(name){
  var k=String(name||'').trim();
  if(!k) return false;
  if(DOCTOR_HINT[k] || DOCTORS[k]) return true;
  return !!doctorFromName(k);
}
function docName(){ return String($('fName').value||'').trim(); }
/* 当前处方归属的医生：整串已建档就用整串，否则取抽出来的称谓 */
function curDoctor(){
  var k=docName();
  if(!k) return '';
  if(DOCTORS[k] || DOCTOR_HINT[k]) return k;
  return doctorFromName(k);
}
/* 取该医生该药的专属价（没有则 null） */
function docPrice(doc, drug){
  if(!doc || !drug) return null;
  var d=DOCTORS[doc]; if(!d||!d.price) return null;
  var key=drugKey(drug);
  if(Object.prototype.hasOwnProperty.call(d.price,key)) return n(d.price[key]);
  return null;
}
/* 价格键：药名归一（忽略尾缀/括号差异），保证「白芍」与「白芍[另包]」各自独立 */
function drugKey(nm){
  var s=String(nm||'').trim().toLowerCase();
  return s.replace(/\s+/g,'');
}
/* 写入医生专属价 + 记一条改价历史 */
function setDocPrice(doc, drug, price, oldPrice, rxNo, who){
  if(!doc||!drug) return;
  if(!DOCTORS[doc]) DOCTORS[doc]={n:doc, at:nowStr(), price:{}, log:[]};
  var d=DOCTORS[doc], key=drugKey(drug);
  if(!d.price) d.price={};
  var from=(oldPrice==null)?'':String(oldPrice);
  d.price[key]=n(price);
  if(!d.log) d.log=[];
  d.log.unshift({t:nowStr(), d:drug, from:from, to:String(price), rx:rxNo||'', who:who||doc});
  if(d.log.length>500) d.log.length=500;
  /* 药价改动写进 Supabase price_logs，客人「最新动态」按 doctor 读取展示 */
  try{
    var toN=n(price);
    var hasOld=(oldPrice!=null && String(oldPrice)!=='' && isFinite(parseFloat(oldPrice)));
    var hasNew=String(price)!=='' && isFinite(toN);
    if(hasOld && hasNew && Math.abs(parseFloat(oldPrice)-toN)>1e-9){
      var pl={doctor:doc, drug:drug, from_price:parseFloat(oldPrice), to_price:toN,
              rx_no:rxNo||'', created_at:nowStr()};
      if(typeof GST_PRICE_LOGS!=='undefined'){
        if(!GST_PRICE_LOGS[doc]) GST_PRICE_LOGS[doc]=[];
        GST_PRICE_LOGS[doc].unshift(pl);
        if(GST_PRICE_LOGS[doc].length>200) GST_PRICE_LOGS[doc].length=200;
      }
      if(window.SUPA && SUPA.on){
        SUPA.q('price_logs',{method:'POST',body:{doctor:doc, drug:drug,
          from_price:parseFloat(oldPrice), to_price:toN, rx_no:rxNo||''}})
          .catch(function(e){ console.warn('药价改动写库失败:', e&&e.message); });
      }
    }
  }catch(e){}
  saveDoctors();
}
function nowStr(){
  var d=new Date(), p=function(x){ return (x<10?'0':'')+x; };
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
/* 把医生专属价套到当前处方（自动划价之前调用）。
   返回被套用的条数，便于提示。 */
function applyDoctorPrices(){
  var doc=curDoctor(); if(!doc) return [0,[]];
  var hit=0, miss=[];
  for(var i=0;i<items.length;i++){
    var it=items[i]; if(!it||!it.name||it.zibei) continue;
    var dp=docPrice(doc, it.name);
    if(dp!=null){ it.price=dp; it.nm0=it.name; hit++; }
    else miss.push(it.name);
  }
  return [hit, miss];
}
/* 该医生名下的全部处方（本机保存 + 书剑历史，含已发药状态） */
function doctorRxs(doc){
  var out=[], list=allRx();
  for(var i=0;i<list.length;i++){
    var r=list[i], nm=String(r.n||'').trim();
    var d=(nm===doc)?doc:doctorFromName(nm);
    if(d!==doc) continue;
    var a=statAmount(r);
    out.push({dt:r.dt||'', tm:r.tm||'', name:r.n||'', no:r.no||'', fy:r.fy||'',
              j:a.j, total:a.total, src:(idxOfSaved(r.no)>=0)?'本机':'历史'});
  }
  out.sort(function(x,y){ return (x.dt+y.tm)>(y.dt+y.tm)?-1:1; });
  return out;
}
/* 把某张处方一键载入当前笺（医生页里「复制沿用」） */
function doctorLoadRx(rx){
  var list=allRx(), found=null;
  for(var i=0;i<list.length;i++){ if(list[i].no===rx.no){ found=list[i]; break; } }
  if(!found){ toastErr('找不到这条处方'); return; }
  loadRx(found);
  toast('已载入 '+found.n+' 的处方，可直接修改后保存为新单');
}

/* ---------- 新处方编号：全局唯一，绝不能撞号 ----------
   原来用 'RX'+Date.now()（毫秒时间戳），同一毫秒内保存两张必然相同
   → 云端 prescriptions 主键冲突 HTTP 409 / code 23505
   「duplicate key value violates unique constraint prescriptions_pkey」，
   表现为「云端写入失败，只存了本机」（2026-10-07 实测复现）。

   现在拆成三段：RX + 毫秒时间戳 + 6 位随机 + 3 位序号。
   - 随机段来自 crypto.getRandomValues（不可预测），没有就退到 Math.random；
   - 序号段保证同一毫秒内连按多次保存也不会重复；
   - 最后再查一次本机已有编号，双保险。 */
function rxNoSalt(){
  try{
    if(window.crypto&&crypto.getRandomValues){
      var a=new Uint8Array(3); crypto.getRandomValues(a);
      return Array.prototype.map.call(a,function(x){
        return ('0'+x.toString(16)).slice(-2);
      }).join('');
    }
  }catch(e){}
  return pad2x(Math.floor(Math.random()*0xffffff).toString(16).slice(-6), 6);
}
function newRxNo(){
  var t=Date.now();
  for(var k=0;k<1000;k++){
    var no='RX'+t+'-'+rxNoSalt()+(k?('_'+k):'');
    if(idxOfSaved(no)<0) return no;
  }
  return 'RX'+t+'-'+rxNoSalt()+'-'+Math.floor(Math.random()*1e6);
}
function idxOfSaved(no){ for(var i=0;i<SAVED.length;i++) if(SAVED[i].no===no) return i; return -1; }
/* 空状态统一渲染：引导图 + 标题 + 说明（+ 可选行动） */
function rxEmptyHTML(title, desc, actionLabel, actionFn){
  return '<div class="rxEmpty">'
    +'<svg class="ico-empty" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" '
    +'stroke-linecap="round" stroke-linejoin="round">'
    +'<rect x="3" y="4" width="18" height="16" rx="3"/>'
    +'<path d="M3 9h18M8 4v5"/>'
    +'<path d="M8 14h8M8 17h5" stroke-dasharray="2 2"/>'
    +'</svg>'
    +'<div class="t">'+esc(title)+'</div>'
    +'<div class="d">'+esc(desc||'')+'</div>'
    +(actionLabel ? '<button class="mini" style="margin-top:8px" onclick="'+actionFn+'">'+esc(actionLabel)+'</button>' : '')
    +'</div>';
}

/* 把当前记录写回它「本来的地方」：
   - 本机保存的单 →覆盖 SAVED 里那一条
   - 书剑历史处方 → 写进 HIST_EDIT（就地修改），绝不新建 */
function persistCur(rec, keepFy){
  autoBackup();   /* 每次保存处方 → 立刻写一份硬盘备份 */
  if(curIsHist&&curSrcRx&&curSrcRx.__hi!=null){
    var key=hKey(curSrcRx.__hi);
    var patch={};
    patch.m=rec.m; patch.f=rec.f; patch.e=rec.e; patch.g=rec.g;
    patch.dj=rec.dj; patch.pt=rec.pt; patch.ex=rec.ex; patch.kd=rec.kd;
    patch.o=rec.o; patch.fw=rec.fw; patch.w=rec.w; patch.j=rec.j;
    patch.b=rec.b; patch.n=rec.n; patch.s=rec.s; patch.a=rec.a; patch.t=rec.t;
    if(keepFy) patch.fy=keepFy;
    HIST_EDIT[key]=patch;
    saveHistEdits();
    supaSaveHist(rec);   /* 历史处方的修改 → 写回自建数据库 */
    return;
  }
  var k=idxOfSaved(rec.no);
  rec.__savedAt=Date.now();   /* 记录保存时刻：60 秒内同内容重复保存时复用编号（防重复） */
  if(k>=0) SAVED[k]=rec; else SAVED.unshift(rec);
  supaSaveNew(rec);     /* 新处方 → 唯一持久化目标：Supabase prescriptions 表 */
}
/* 同步前的空明细拦截（2026-10-07 11:45）。
   `syncRecordNow` 由所有输入框的 input 事件经 400ms 防抖触发，
   页面刚打开 / 历史处方还在载入 / renderSheet 抛错时 items 会短暂为空，
   此时 persistCur 会把一条「空明细」覆盖到本机 SAVED 和云端 → 云端数据变空。
   这里在**写本机之前**就停住：空明细既不上云，也不污染本机列表。
   已经存好的老记录（k>=0）保留原样，只跳过这次同步。

   🔴 追加铁律（2026-10-08）：**没有用户输入，就不许写记录**。
   事故：只是点开一条历史处方看一眼、什么都不改，约 0.4s 后
   syncRecordNow 就跑起来 persistCur → HIST_EDIT 里凭空多出这条：
   原记录药味的空格被规整、原本空着的合计被自动算出来填上，
   还被 supaSaveHist 推回云端 —— 「查看」等于「修改」，原方被污染。
   成因：recalc() 结尾调 syncRecordSoon()，而 renderSheet()/loadRx()/
   copyRx()/continueRx() 都会跑 recalc()，属于被动触发而非用户编辑。
   对策：RX_DIRTY 只由**真实的用户输入**置位（见各 input 监听），
   载入/渲染引发的一律不置位；未置位时本函数直接返回，一个字节都不写。 */
function syncRecordNow(){
  if(!curRec&&!curIsHist) return;
  /* 静默载入中（loadRx/copyRx/continueRx 的 rxQuiet 区间）→ 不写 */
  if(typeof RX_QUIET!=='undefined' && RX_QUIET>0) return;
  /* 🔴 没有真实用户输入 → 不写。这是「只是看一眼就改了原方」的根治点。 */
  if(!RX_DIRTY) return;
  var base=(curIsHist&&curSrcRx)?curSrcRx:curRec;
  var rec=collectRecord(base.no);
  if(rxRowEmpty({items:rec.m})){
    /* 明细为空 → 放弃这次同步（不清 curRec，用户继续填药即可） */
    return;
  }
  rec.fy=curRec?(curRec.fy||''):'';
  rec.tm=base.tm||rec.tm;
  /* 续开刚生成、用户还没保存过时，自动同步**不能**撤掉这个标记，
     否则下一次输入就把续开那条并进 60 秒防连点池，可能被误覆盖。 */
  if(curRec && curRec.__contNew){ rec.__contNew=1; rec.__contFrom=curRec.__contFrom||''; }
  persistCur(rec, curRec?(curRec.fy||''):'');
  if(curIsHist){ var m={}; for(var k in base) m[k]=base[k]; m.m=rec.m; m.o=rec.o; m.f=rec.f; m.fy=rec.fy; m.__hi=base.__hi; curRec=m; }
  else curRec=rec;
}
function syncRecordSoon(){
  if(!curRec&&!curIsHist) return;
  /* 🔴 静默加载期间禁止自动同步（2026-10-08 修）。
     症状：只是**点开看一眼**一条历史处方，什么都不改，
           约 0.4s 后 HIST_EDIT 里就凭空多出这条，
           原记录的药味空格被规整、原本空着的合计被自动算出来填上，
           并被 supaSaveHist 推回云端 —— 等于「查看」就改了原方。
     原因：recalc() 结尾调 syncRecordSoon()，而 loadRx()/copyRx()/
           continueRx() 载入完都会跑 recalc()，于是被动触发写回。
     铁律：**用户没有输入过，就不许写任何记录**。
     真正修改时（input 事件）RX_QUIET 早已被清零，同步照常。 */
  if(typeof RX_QUIET!=='undefined' && RX_QUIET>0) return;
  clearTimeout(syncT);
  syncT=setTimeout(function(){ syncRecordNow(); renderHistory(); },400);
}
/* 静默计数：>0 时 recalc() 引发的自动同步一律忽略。
   用 try/finally 配对，任何异常都必须还原，绝不能把用户锁死在静默态。 */
var RX_QUIET=0;
function rxQuiet(fn){
  RX_QUIET++;
  try{ return fn(); }
  finally{ RX_QUIET=Math.max(0, RX_QUIET-1); }
}
/* 「用户真的动过手」标记：只有真实输入才置位。
   载入(loadRx/copyRx/continueRx)与渲染(renderSheet→recalc)不得置位，
   否则点开看一眼就会把原处方改写并推上云端（见 syncRecordNow 注释）。

   实现要点：真实输入 = 浏览器派发 input/change 事件；
   而代码里 `$('fName').value=x` 这种**程序化赋值不会**触发 input。
   所以在 document 上挂一个捕获阶段监听，就天然把两者分开了，
   不必去每个控件里手动插标记，也不会漏。 */
var RX_DIRTY=false;
function rxMarkClean(){ RX_DIRTY=false; }
/* 切换/载入任何记录后都要清脏标记：上一条留下的编辑痕迹不该带过来。 */
function rxMarkDirty(){ RX_DIRTY=true; }
if(typeof document!=='undefined'){
  ['input','change'].forEach(function(ev){
    document.addEventListener(ev, function(){ RX_DIRTY=true; }, true);
  });
}
function saveRx(){
  readAllCells();
  if(!filledCount()){ toastErr('处方为空：请先粘贴药方或输入药名'); return; }
  var nm=$('fName').value.trim();
  if(!nm){ toastErr('请先填写姓名，否则无法保存'); $('fName').focus(); return; }
  /* 三种情况：
     1) 正在编辑书剑历史处方 → 就地覆盖那一条，绝不新建
     2) 正在编辑本机已保存的单 → 覆盖本单
     3) 全新处方 → 新建 */
  var isHistEdit=!!(curIsHist&&curSrcRx&&curSrcRx.__hi!=null);
  var isUpdate=!!(curRec&&curRec.no);
  var base=isHistEdit?curSrcRx:curRec;
  var no=(isHistEdit||isUpdate)?base.no:newRxNo();
  /* 重复保存防护（2026-10-07 00:30 事故：连点保存，库里一度有 72 条同一张方子）：
     全新处方时，若**最近 60 秒内已经存过内容完全相同的一张**，
     就直接复用那一条的编号做覆盖，不再新建。 */
  if(!isHistEdit && !isUpdate){
    try{
      var sig=rxDupKey({dt:$('fDate').value||today(), n:$('fName').value.trim(),
                        m:filledItems().map(itemText).join('   '), j:curJishu()});
      var recent=SAVED.filter(function(r){
        /* ⚠ 排除「续开刚生成、用户还没亲自保存过」的那条：
           续开后若用户点「新建处方」重录同名同一天，60 秒内容去重会
           误判成连点，把续开那条直接覆盖掉。续开必须只增不改。 */
        return r.__savedAt && !r.__contNew && (Date.now()-r.__savedAt)<60000 && rxDupKey(r)===sig;
      });
      if(recent.length){
        no=recent[0].no;          // 复用旧编号 → 走覆盖
        isUpdate=true; base=recent[0];
      }
    }catch(e){}
  }
  /* 单剂药费还空着（用户没点「自动划价」）→ 按当前目录价自动算出来，
     保证新建的处方里单剂药费与合计不是 0 */
  if(!$('fPerDose').value.trim()){
    var pf=perDoseFee();
    if(pf>0) $('fPerDose').value=money(pf);
  }
  var rec=collectRecord(no);
  /* ⚠ 2026-10-07 修复崩溃：`isUpdate` 可能在上面的「60 秒重复保存防护」里被
     从 false 改成 true（复用 SAVED 里那条的编号走覆盖），但此时 curRec 仍是 null
     —— 原写法 `curRec.fy` 直接抛 TypeError，整个 saveRx 中断、处方没存进去。
     复现路径：点历史处方 → 点「复用」→ 点「保存」。
     改成从 base（isHistEdit 时是 curSrcRx，isUpdate 时优先 curRec）安全取值。 */
  var fySrc=(isHistEdit?curSrcRx:(curRec||base))||null;
  rec.fy=isHistEdit?((base&&base.fy)||''):(isUpdate?((fySrc&&fySrc.fy)||''):'');
  /* 用户亲自保存过了 → 撤掉「续开未保存」标记，之后它就参与 60 秒防连点去重 */
  if(isUpdate && curRec && curRec.__contNew){ rec.__contFrom=curRec.__contFrom||''; }
  rec.__contNew=0;
  persistCur(rec, rec.fy);
  /* 这张单里用过的「药名[后缀]」要进后缀记忆：作废缓存，下次搜药时按处方重算 */
  sfxMemInvalidate();
  if(isHistEdit){
    /* 更新内存中的显示副本（保持 __hi 标记，便于后续继续就地编辑） */
    var hi=curSrcRx.__hi;
    var tgt=HISTORY_ORIG[hi];
    if(tgt){ for(var k in rec) if(k!=='__hi') tgt[k]=rec[k]; }
    rec.__hi=hi;
  }
  curRec=rec; curIsHist=isHistEdit; curSrcRx=isHistEdit?curSrcRx:null;
  clearTimeout(syncT);
  /* 自动排版：压缩空位，一行三味 */
  items=filledItems().slice();
  padCells();
  renderSheet();
  /* 左侧列表定位到该处方日期 */
  $('hFrom').value=rec.dt; $('hTo').value=rec.dt;
  $('hName').value='';
  renderHistory();
  var word=isHistEdit?'已就地修改该历史处方':(isUpdate?'已更新本单':'已新建处方');
  if($('saveTip')) $('saveTip').textContent=word+'　'+rec.dt+' '+rec.tm+'　合计 ¥'+rec.o;
  toast(word+'：'+rec.n+'　'+filledCount()+' 味　合计 ¥'+rec.o);
}
function setFa(mark){
  if(curIsHist&&curSrcRx&&curSrcRx.__hi!=null){
    /* 书剑历史处方：发药标记写进就地修改，不新建 */
    var hi=curSrcRx.__hi, key=hKey(hi);
    var patch=HIST_EDIT[key]||{};
    patch.fy=mark;
    HIST_EDIT[key]=patch;
    saveHistEdits();
    if(HISTORY_ORIG[hi]) HISTORY_ORIG[hi].fy=mark;
    if(curRec) curRec.fy=mark;
    renderHistory();
    supaFayao(curSrcRx.no, mark);   /* 历史处方发药标记 → 写回数据库 */
    toast(mark?'已发药（左侧标记【发】）':'已撤消发药（【发】已取消）');
    return;
  }
  if(!curRec){ toastErr('请先点「保存」，再发药'); return; }
  var k=idxOfSaved(curRec.no);
  if(k<0){ toastErr('请先点「保存」，再发药'); return; }
  /* 撤消发药：把【发】标记清空，左侧列表同步去掉 */
  SAVED[k].fy=mark;
  curRec=SAVED[k];
  renderHistory();
  supaFayao(curRec.no, mark);      /* 新处方发药标记 → 写回数据库 */
  toast(mark?'已发药（左侧标记【发】）':'已撤消发药（【发】已取消）');
}
/* 发药状态 → 数据库（历史处方与新处方都在同一张表） */
function supaFayao(no, mark){
  if(!SUPA.on||!no) return;
  SUPA.setFayao(no, !!mark).catch(function(e){ console.warn('发药状态写库失败:',e.message); });
}

/* ---------------- 历史处方 ---------------- */
/* 书剑历史处方 + 用户在其上的就地修改（修改不会新建，覆盖显示）
   注意：键必须稳定——不能用 rxKey（含 tm，保存一次就变），改用历史数组下标 */
function hKey(i){ return 'H'+i; }
/* 给历史记录打上来源标记，供 loadRx 判定与 persistCur 定位 */
function markHist(r, i){
  var m={}; for(var k in r) m[k]=r[k];
  m.__hi=i;
  return m;
}
/* 列表数据源。
   ⚠️ **只对新录的处方（SAVED）去重，历史处方一律不去重。**
   历史档案里同一个人同一天开多张方子是**正常业务**（实测 5650 条里有 199 条
   这种情况，如「大为 2024-06-23」4 张、「顾客 2025-10-16」4 张），
   按姓名+日期去重会把它们误删——那才是真正的数据丢失。 */
function allRx(){
  var out=SAVED.slice();
  for(var i=0;i<HISTORY_ORIG.length;i++){
    var r=HISTORY_ORIG[i], e=HIST_EDIT[hKey(i)];
    if(e){
      var m=markHist(r,i);
      for(var k2 in e) m[k2]=e[k2];
      out.push(m);
    }else out.push(markHist(r,i));
  }
  return out;
}
function saveHistEdits(){ RX_STORE.setItem(LS_HISTEDIT,JSON.stringify(HIST_EDIT)); autoBackup(); }
function rxKey(r){ return (r.no||'')+'|'+r.dt+'|'+(r.tm||'')+'|'+r.n; }
/* 列表里的时间：同年只显示 MM-DD（省 3 个字符宽度），跨年才带年份；悬停提示仍是完整日期 */
function histWhen(dt,tm){
  var s=String(dt||'');
  if(s.length===10 && s.slice(0,4)===today().slice(0,4)) s=s.slice(5);
  return '['+s+(tm?(' '+tm):'')+']';
}
function renderHistory(){
  var nm=$('hName').value.trim().toLowerCase();
  /* 按姓名查顾客时不限日期：该顾客的全部历史处方一起显示（含 23 年以前漏记的） */
  var byCust=!!nm;
  var f=byCust?'':$('hFrom').value, t=byCust?'':$('hTo').value;
  var list=allRx().filter(function(r){
    if(f && (!r.dt || r.dt<f)) return false;
    if(t && (!r.dt || r.dt>t)) return false;
    if(nm){ var hay=((r.n||'')+' '+(r.py||'')).toLowerCase(); if(hay.indexOf(nm)<0) return false; }
    return true;
  });
  /* 排序：已发药（【发】）的置顶，其余按日期+时间倒序 */
  list.sort(function(a,b){
    var fa=a.fy?1:0, fb=b.fy?1:0;
    if(fa!==fb) return fb-fa;
    var ka=(a.dt||'')+' '+(a.tm||''), kb=(b.dt||'')+' '+(b.tm||'');
    return ka<kb?1:(ka>kb?-1:0);
  });
  var cap=800, shown=list.slice(0,cap), h='';
  if(!shown.length){
    h=rxEmptyHTML((f||t)?'该日期范围内没有处方':'暂无历史处方',
        (f||t)?('换个日期试试，或点下方「历史处方」查看全部 '+HISTORY_ORIG.length+' 条')
               :'保存过的处方会出现在这里，方便随时调方');
  }else{
    for(var i=0;i<shown.length;i++){
      var r=shown[i], tm=r.tm?(' '+r.tm):'';
      var name=r.n||'(未填姓名)';
      h+='<div class="hitem'+(r.fy?' fa':'')+'" data-k="'+esc(rxKey(r))+'" title="'+esc(name+' '+r.dt+tm+'\n'+(r.m||''))+'">'
        +'<span class="tx">'+esc(name)+'<span class="tm">'+esc(histWhen(r.dt,tm))+'</span></span>'
        +(r.fy?('<span class="fx">'+esc(r.fy)+'</span>'):'')
        +'</div>';
    }
  }
  $('hList').innerHTML=h;
  markHistSel(curSrcRx?rxKey(curSrcRx):'');
  $('hStat').textContent='共 '+list.length+' 条'
    +(byCust?'（按顾客查询，不限日期）':'')
    +(list.length>cap?('（显示前 '+cap+' 条，请缩小范围）'):'');
}
/* 默认查询范围：以**今天**为基准（2026-10-07）。
   上一天 / 下一天就是「昨天 / 明天」，符合看当日及相邻日期的日常用法
   （用户 2026-10-07 明确要求：今天 10.7，则上一天 6日、下一天 8 日）。

   为什么不再默认「一年前」：那是上一轮我按「要能看到历史」加的，
   但会让上下一天从 2025 年开始跳，不符合直觉。

   ⚠️ 副作用：默认只看今天，历史处方不在列表里。
     想看全部历史，点「历史处方」按钮（清空日期范围）即可。 */
var LS_HRANGE='rx_hist_range';
function defaultRange(){
  var t=today();
  $('hFrom').value=t; $('hTo').value=t;
  $('hName').value='';
  renderHistory();
}
/* 记住当前日期范围（下次打开若用户手动调过，可恢复） */
function saveHRange(){
  try{
    RX_STORE.setItem(LS_HRANGE, JSON.stringify({from:$('hFrom').value,to:$('hTo').value}));
  }catch(e){}
}
function showToday(){
  var t=today();
  $('hFrom').value=t; $('hTo').value=t;
  $('hName').value='';
  renderHistory(); saveHRange();
}
/* 上一天/下一天：基准是**当前显示的日期**。
   万一 hFrom 是空的（初始化失败/被清空），退回今天而不是 1970 之类。 */
function shiftDay(d){
  var f=$('hFrom').value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(f)) f=today();
  var dt=new Date(f+'T00:00:00');
  if(isNaN(dt.getTime())) dt=new Date();
  dt.setDate(dt.getDate()+d);
  var s=dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate());
  $('hFrom').value=s; $('hTo').value=s;
  renderHistory();
}
/* 左侧历史列表：标出当前正在看的那一条（浅蓝底） */
function markHistSel(k){
  var box=$('hList'); if(!box) return;
  var list=box.querySelectorAll('.hitem');
  for(var i=0;i<list.length;i++){
    if(k && list[i].getAttribute('data-k')===k) list[i].classList.add('sel');
    else list[i].classList.remove('sel');
  }
  if(k){
    var cur=box.querySelector('.hitem.sel');
    if(cur&&cur.scrollIntoView) cur.scrollIntoView({block:'nearest'});
  }
}
/* 把记录里保存的单价写回 items（用户在清单里手改过的价）。
   记录没有 px（旧数据）或某味没有价时不动，仍按目录价自动划价。 */
function applySavedPrices(list, px){
  if(!px || !list.length) return;
  var arr=String(px).split('|');
  if(arr.length!==list.length) return;      /* 药味对不上就别乱套 */
  for(var i=0;i<list.length;i++){
    var it=list[i]; if(!it) continue;
    var v=arr[i];
    if(v===''||v==null) continue;
    var num=n(v);
    if(num>0){ it.price=num; it.nm0=it.name; }
  }
}
function loadRx(r){
  rxMarkClean();          /* 换记录了：清掉脏标记，载入本身不算「用户改过」 */
  curSrcRx=r;
  /* 若这条是自己保存过的（存在于 SAVED），则允许就地修改保存，不新建 */
  var k=idxOfSaved(r.no);
  /* 区分「本机保存的单」与「书剑历史处方」：两者都可就地覆盖保存，都不新建 */
  var isHist=(r.__hi!=null);
  curIsHist=isHist;
  curRec=(k>=0)?SAVED[k]:(r||null);
  items=parseItems(r.m||'');
  applySavedPrices(items, r.px);
  padCells();
  $('fName').value=r.n||''; $('fSex').value=r.s||''; $('fAge').value=r.a||'';
  $('fPhone').value=r.t||''; $('fDate').value=r.dt||today(); $('fNo').value=r.no||'';
  $('fJishu').value=r.j||1; $('fNote').value=r.b||'';
  $('fProcess').value=(r.e!=null&&r.e!=='')?money(r.e):'';
  $('fGoods').value=(r.g!=null&&r.g!=='')?money(r.g):'';
  $('cbProcess').checked=!!(r.e!=null&&r.e!==''&&n(r.e));
  $('cbGoods').checked=!!(r.g!=null&&r.g!==''&&n(r.g));
  $('cbDaijian').checked=!!(r.dj&&n(r.dj)); $('fDaijian').value=(r.dj&&n(r.dj))?money(r.dj):'';
  $('cbPaotui').checked=!!(r.pt&&n(r.pt)); $('fPaotui').value=(r.pt&&n(r.pt))?money(r.pt):'';
  $('cbExpress').checked=!!(r.ex&&n(r.ex)); $('fExpress').value=(r.ex&&n(r.ex))?money(r.ex):'';
  $('cbKuaidi').checked=!!(r.kd&&n(r.kd)); $('fKuaidi').value=(r.kd&&n(r.kd))?money(r.kd):'';
  autoPrice(); priced=true;
  /* 单剂药费：库里存了正数就沿用；存 0/空但当前药味划得出价 → 用划价结果自愈。
     （2026-10-25：斤 bug 曾把一批方子的 f 存成 0.00，不治则打开合计永远少一块） */
  var _f=(r.f!=null&&r.f!=='')?n(r.f):0;
  $('fPerDose').value=(_f>0?money(_f):money(perDoseFee()));
  renderSheet(); renderPriceList();
  /* 静默载入：recalc() 会触发 syncRecordSoon()，必须静音，
     否则「只是点开看一眼」就会把这条记录改写并推上云端（见 syncRecordSoon 注释）*/
  rxQuiet(function(){ recalc(); });   /* 姓名变了要同步刷新配送地址区 */
  markHistSel(rxKey(r));
  if(curRec){
    var tip='已载入 '+r.n+'（'+(r.fy?'【发】':(k>=0?'已保存':'历史'))+'）　直接修改后点「保存」即覆盖本条，不会新建';
    if($('saveTip')) $('saveTip').textContent=tip;
    toast(tip);
  }
}
/* 复制处方：把当前载入的处方另开为「当日」新单，保存时新建 */
function copyRx(){
  rxMarkClean();          /* 复制出的新单还没被用户改过 */
  var src=curSrcRx;
  if(!src){
    if(!filledCount()){ toastErr('当前处方笺为空，无可复制'); return; }
    /* 无历史来源时，直接以当前笺内容复制一份新单 */
    src={n:$('fName').value,m:items.filter(function(x){return x&&x.name;}).map(itemText).join('   '),
         s:$('fSex').value,a:$('fAge').value,t:$('fPhone').value,j:$('fJishu').value,
         f:$('fPerDose').value,e:processFee()?money(processFee()):'',g:goodsFee()?money(goodsFee()):'',
         dj:$('cbDaijian').checked?$('fDaijian').value:'',pt:$('cbPaotui').checked?$('fPaotui').value:'',
         ex:$('cbExpress').checked?$('fExpress').value:'',
         kd:$('cbKuaidi').checked?$('fKuaidi').value:'',
         b:$('fNote').value};
  }
  curSrcRx=null;
  curRec=null;                 /* 关键：置空 → 下次保存走「新建」 */
  curIsHist=false;             /* 复制出来的是新单，不是历史处方 */
  items=parseItems(src.m||'');
  applySavedPrices(items, src.px);
  padCells();
  $('fName').value=src.n||''; $('fSex').value=src.s||''; $('fAge').value=src.a||''; $('fPhone').value=src.t||'';
  $('fDate').value=today();   /* 当日 */
  $('fNo').value='';          /* 新编号 */
  $('fJishu').value=src.j||1; $('fNote').value=src.b||'';
  $('fProcess').value=(src.e!=null&&src.e!=='')?money(src.e):'';
  $('fGoods').value=(src.g!=null&&src.g!=='')?money(src.g):'';
  $('cbProcess').checked=!!(src.e!=null&&src.e!==''&&n(src.e));
  $('cbGoods').checked=!!(src.g!=null&&src.g!==''&&n(src.g));
  $('cbDaijian').checked=!!(src.dj&&n(src.dj)); $('fDaijian').value=(src.dj&&n(src.dj))?money(src.dj):'';
  $('cbPaotui').checked=!!(src.pt&&n(src.pt)); $('fPaotui').value=(src.pt&&n(src.pt))?money(src.pt):'';
  $('cbExpress').checked=!!(src.ex&&n(src.ex)); $('fExpress').value=(src.ex&&n(src.ex))?money(src.ex):'';
  $('cbKuaidi').checked=!!(src.kd&&n(src.kd)); $('fKuaidi').value=(src.kd&&n(src.kd))?money(src.kd):'';
  autoPrice(); priced=true;
  /* 同 loadRx：f 存成 0/空但划得出价 → 自愈，别把坏数据复制进新单 */
  var _cf=(src.f!=null&&src.f!=='')?n(src.f):0;
  $('fPerDose').value=(_cf>0?money(_cf):money(perDoseFee()));
  renderSheet(); renderPriceList();
  rxQuiet(function(){ recalc(); });   /* 静默：复制不该触发写回 */
  markHistSel('');
  if($('saveTip')) $('saveTip').textContent='已复制为 '+today()+' 新单　点「保存」将新建一条当日处方';
  toast('已复制为当日新单，点「保存」新建');
}
/* ---------------- 续开（2026-10-14 按用户最新规格）----------------
   场景：李丽珍的方子开完了，要照着计算区再开一张（如家人同名/复诊调整药味）。

   规格（用户 2026-10-14 明确要求，红笔圈划）：
   【清空】药方明细整列（药名/数量/煎煮法）、单剂药费、合计金额、单剂重量、总重量。
   【保留】患者姓名、日期（当前日期）、剂数、用法/备注，
           以及 加工费/代煎费/跑腿费/闪送费/快递费/物品费用 复选框的勾选状态与金额。
   【生成】一条全新可编辑处方：编号清空，点「保存」时生成新编号
           → supaSaveNew → Supabase insert 新记录（明细为空时写库总闸会拦，绝不会写入空方）。
   【铁律】绝不覆盖/修改原处方：curSrcRx/curRec/curIsHist 全部断开，
           persistCur 永远走不到 HIST_EDIT 分支，源对象一个字节都不碰。

   实现要点：计算区字段本来就显示在表单上，续开**不动它们**即可；
   只需清空 items（药味格）、fNo（编号）、fPerDose（单剂药费），
   合计与重量由 recalc() 按空明细自动归零。
   整段 rxQuiet 静默 + rxMarkClean：续开动作本身绝不触发任何写库。 */
function continueRx(){
  rxMarkClean();          /* 续开出的新单还没被用户改过 */
  readAllCells();
  if(!filledCount()){ toastErr('当前处方笺为空，无可续开'); return; }
  clearTimeout(syncT);    /* 别让源方待执行的延迟同步在我们操作期间乱写 */
  rxQuiet(function(){
    /* ① 保留：姓名/性别/年龄/电话/日期/剂数/用法备注/各费用勾选与金额 —— 表单原样不动 */
    /* ② 清空：药味明细整列 */
    items=[]; padCells();
    /* ③ 新处方：编号清空（保存时生成新号 insert）、单剂药费清空（合计/重量随空明细自动归零） */
    $('fNo').value='';
    $('fPerDose').value='';
    curSrcRx=null; curRec=null; curIsHist=false; priced=false;
    renderSheet(); renderPriceList(); recalc();
  });
  rxMarkClean();          /* 收尾这次 recalc 不算用户编辑，不许触发同步 */
  markHistSel('');        /* 取消源方高亮，避免误以为还在看原方 */
  if($('saveTip')) $('saveTip').textContent='已续开新单（姓名/日期/剂数/备注/费用勾选已保留）　录入药味后点「保存」生成新记录，原方未动';
  $('plState').textContent='待自动划价';
  $('hFrom').value=$('fDate').value||today(); $('hTo').value=$('hFrom').value; $('hName').value='';
  renderHistory();
  var c=cellEl(0); if(c) c.querySelector('.nm').focus();
  toast('已续开新单：明细与药费已清空，计算区保留　录入药味后保存');
}
function newRx(){
  rxMarkClean();
  curRec=null; curSrcRx=null; curIsHist=false; priced=false;
  items=[]; padCells();
  $('fName').value=''; $('fSex').value=''; $('fAge').value=''; $('fPhone').value='';
  $('fDate').value=today(); $('fNo').value='';
  $('fJishu').value=1; $('fNote').value='';
  $('fPerDose').value=''; $('fProcess').value=''; $('fGoods').value='';
  $('cbProcess').checked=false; $('fProcess').value='';
  $('cbDaijian').checked=false; $('fDaijian').value='';
  $('cbPaotui').checked=false; $('fPaotui').value='';
  $('cbExpress').checked=false; $('fExpress').value='';
  $('cbKuaidi').checked=false; $('fKuaidi').value='';
  $('cbGoods').checked=false; $('fGoods').value='';
  if($('saveTip')) $('saveTip').textContent=''; $('plState').textContent='待自动划价';
  renderSheet(); renderPriceList();
  var c=cellEl(0); if(c) c.querySelector('.nm').focus();
}
function clearSheet(){
  if(!filledCount()){ return; }
  if(!confirm('清空当前处方笺的药味？（姓名/日期保留）')) return;
  items=[];
  priced=false;
  rxMarkClean();          /* 清空后是全新未保存的笺，用户没动过 */
  padCells();
  $('fPerDose').value=''; $('fProcess').value=''; $('fGoods').value='';
  $('fDaijian').value=''; $('fPaotui').value=''; $('fExpress').value=''; $('fKuaidi').value='';
  $('cbProcess').checked=false; $('cbDaijian').checked=false;
  $('cbPaotui').checked=false; $('cbExpress').checked=false; $('cbGoods').checked=false; $('cbKuaidi').checked=false;
  if($('saveTip')) $('saveTip').textContent=''; $('plState').textContent='待自动划价';
  curRec=null; curSrcRx=null; curIsHist=false;
  renderSheet(); renderPriceList();
  var c=cellEl(0); if(c) c.querySelector('.nm').focus();
}

/* ---------------- 打印 ---------------- */
/* margin：页边距 mm（不传=8）；css：这次打印额外需要的样式（如小票模板） */
function doPrint(html,paper,margin,css){
  var pa=$('printArea');
  pa.innerHTML=html;
  var st=document.createElement('style'); st.id='__pg';
  var mg=(margin==null?8:margin);
  st.textContent='@page{size:'+paper+';margin:'+mg+'mm;}'+(css||'');
  document.head.appendChild(st);
  var done=function(){
    window.removeEventListener('afterprint',done);
    try{document.head.removeChild(st);}catch(e){}
    pa.innerHTML='';
  };
  window.addEventListener('afterprint',done);
  setTimeout(function(){ window.print(); setTimeout(done,1600); },50);
}
function sheetHTML(){
  readAllCells();
  var showClinic=!!SET.showClinic, j=curJishu();
  var head='<div class="rxhead"><span><span class="lbl">姓名：</span><b>'+esc($('fName').value)+'</b></span>'
    +'<span><span class="lbl">日期：</span><b>'+esc($('fDate').value||today())+'</b></span></div>';
  if(showClinic&&SET.clinic){
    head='<div style="text-align:center;font-size:16px;font-weight:700;margin-bottom:4px">'+esc(SET.clinic)+'</div>'+head;
  }
  var h='<div class="rxs">'+head+'<div class="rxgrid">', L=filledItems();
  for(var i=0;i<L.length;i++){
    var it=L[i], sp=splitSfx(it.name);
    h+='<div class="cell'+(it.zibei?' zibei':'')+'">'
      +'<span class="nm">'+esc(sp.nm)+'</span>'
      +'<span class="ds">'+esc(doseText(it))+'</span>'
      +'<span class="sfx">'+esc(sfxTextBr(sp.sfx))+'</span></div>';
  }
  h+='</div><div class="rxfoot">';
  /* 共 N 剂 + 备注/用法（横线填写区） */
  h+='<div class="rxline1"><span>共 <b>'+j+'</b> 剂</span>'
    +'<span class="notebox">'+esc($('fNote').value||'')+'</span></div>';
  /* 金额区：单剂药费 与 合计 并排；备选费用按 加工→代煎→跑腿→快递→物品 顺序排列（勾了才打印） */
  h+='<div class="rxmoney">'
    +'<div class="f"><span class="lb">单剂药费：</span><span class="val">'+money(n($('fPerDose').value))+'</span></div>'
    +'<div class="f"><span class="lb">合计：</span><span class="val">'+money(curTotal())+'</span></div>'
    +'</div>';
  var opt=[];
  if($('cbProcess').checked) opt.push('<span class="lb">加工费用：</span><span class="val">'+money(processFee())+'</span>');
  if($('cbDaijian').checked) opt.push('<span class="lb">代煎费：</span><span class="val">'+money(daijianFee())+'</span>');
  if($('cbPaotui').checked)  opt.push('<span class="lb">跑腿费：</span><span class="val">'+money(paotuiFee())+'</span>');
  if($('cbExpress').checked) opt.push('<span class="lb">闪送费：</span><span class="val">'+money(expressFee())+'</span>');
  if($('cbKuaidi').checked) opt.push('<span class="lb">快递费：</span><span class="val">'+money(kuaidiFee())+'</span>');
  if($('cbGoods').checked)  opt.push('<span class="lb">物品费用：</span><span class="val">'+money(goodsFee())+'</span>');
  if(opt.length) h+='<div class="rxopts">'+opt.map(function(x){return '<span class="f">'+x+'</span>';}).join('')+'</div>';
  h+='<div class="rxweight"><span>单剂重量：<b>'+Math.round(perDoseWeight())+'</b>g</span>'
    +'<span>总重量：<b>'+Math.round(perDoseWeight()*j)+'</b>g</span></div>';
  h+='</div></div>';
  return h;
}
/* ================= 本地打印助手（静默打印到指定打印机） =================
   助手在运行：点「打印处方」或清单打印直接出纸，不弹打印窗口、也不用选打印机。
   助手没运行：自动退回浏览器打印窗口（功能不受影响）。
   助手是本机后台程序，只监听 127.0.0.1:8899，需先双击「启动打印助手.vbs」。 */
var RX_AGENT='http://127.0.0.1:8899', AGENT_ON=false;
function agentPing(){
  try{
    return fetch(RX_AGENT+'/ping',{method:'GET',mode:'cors',cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(function(j){ AGENT_ON=!!(j&&j.ok); return AGENT_ON; })
      .catch(function(){ AGENT_ON=false; return false; });
  }catch(e){ AGENT_ON=false; return Promise.resolve(false); }
}
function agentPrint(job){
  return fetch(RX_AGENT+'/print',{method:'POST',mode:'cors',cache:'no-store',
      headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(job)})
    .then(function(r){ return r.json(); })
    .then(function(j){ if(!j||!j.ok) throw new Error((j&&j.msg)||'打印助手返回失败'); return j; });
}
/* 把一段 HTML 渲染成 PNG（与图片复制同一条管线） */
function rasterize(svg,w,h,scale){
  return new Promise(function(resolve,reject){
    var img=new Image();
    img.onload=function(){
      try{
        var cv=document.createElement('canvas');
        cv.width=Math.max(1,Math.round(w*scale)); cv.height=Math.max(1,Math.round(h*scale));
        var g=cv.getContext('2d');
        g.fillStyle='#fff'; g.fillRect(0,0,cv.width,cv.height);
        g.drawImage(img,0,0,cv.width,cv.height);
        resolve({url:cv.toDataURL('image/png'),w:cv.width,h:cv.height});
      }catch(e){ reject(e); }
    };
    img.onerror=function(){ reject(new Error('生成打印图失败')); };
    img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  });
}
/* 取页面里打印用的那套样式（.rxs/.rxgrid/.cell…），保证图片与打印预览一致 */
function printCSS(){
  var out=[], want=/(\.rxs|\.rxhead|\.rxgrid|\.rxfoot|\.rxline1|\.rxmoney|\.rxopts|\.rxweight|\.cell|\.notebox)/;
  for(var i=0;i<document.styleSheets.length;i++){
    var rules; try{ rules=document.styleSheets[i].cssRules; }catch(e){ continue; }
    if(!rules) continue;
    for(var j=0;j<rules.length;j++){
      var t=rules[j].cssText||'';
      if(want.test(t)) out.push(t);
    }
  }
  return out.join('\n');
}
/* A5 处方笺：按 A5 比例出图，打印宽度 132mm（=148-8×2，与打印边距一致） */
/* A5 打印图：直接复用「复制处方图片」那一张（同一 HTML、同一 CSS、同一画布） */
function buildA5Image(){
  /* 350×496 固定尺寸 */
  var W=350, H=496;
  var inner='<div style="width:'+W+'px;min-width:'+W+'px;height:'+H+'px;padding:10px 12px;'
    +'background:#fff;box-sizing:border-box;color:#000;overflow:visible">'
    +'<div style="height:100%;display:flex;flex-direction:column">'
    +sheetHTML()
    +'<div style="flex:1 1 auto;min-height:0"></div>'
    +'</div></div>';
  var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'">'
    +'<foreignObject x="0" y="0" width="100%" height="100%">'
    +'<div xmlns="http://www.w3.org/1999/xhtml"><style>'+rxLayoutCSS()+'</style>'+inner+'</div>'
    +'</foreignObject></svg>';
  return rasterize(svg,W,H,2);
}
/* buildReceiptImage 已随「打印预览」弹窗一起移除（2026-10-08）：
   它只被预览弹窗调用。「复制小票」用的是 copyReceiptImage()，走另一条管线，保留。 */
/* 助手在/不在，两行提示文案不同 */
var AGENT_TOLD=false;
function agentTips(){
  var ag=$('agentState'); if(ag) ag.textContent=AGENT_ON?'已连接（点打印直接出纸）':'未运行（会改用打印窗口）';
  /* 界面不挂小字说明；只在助手没运行时给一次浮动提示 */
}
/* 打印机下拉：选项来自助手的 /printers（本机真实列表）。
   助手没运行或取不到时，退回默认值，保证仍可手动选。
   2026-10-08 移除「打印小票」后只剩 A5 一个下拉（原 setPrinterRcpt 已删）。 */
var PRINTER_DEFAULTS=['HP LaserJet 1020','Paperang P2'];
var PRINTERS_READY=false;
function fillPrinterSelects(list){
  var names=(list&&list.length)?list:PRINTER_DEFAULTS;
  /* 已保存的打印机若不在列表里（如换了机器），补进去，避免静默改成别的机器 */
  var all=names.slice();
  [SET.printerA5].forEach(function(v){
    if(v && all.indexOf(v)<0) all.push(v);
  });
  ['setPrinterA5'].forEach(function(id){
    var el=$(id); if(!el) return;
    var cur=el.value;
    el.innerHTML='';
    for(var i=0;i<all.length;i++){
      var o=document.createElement('option');
      o.value=all[i]; o.textContent=all[i];
      el.appendChild(o);
    }
    if(cur) el.value=cur;
  });
  PRINTERS_READY=true;
}
function loadPrinterList(){
  if(!AGENT_ON){ fillPrinterSelects(); return; }
  fetch(RX_AGENT+'/printers',{method:'GET',mode:'cors',cache:'no-store'})
    .then(function(r){ return r.json(); })
    .then(function(j){ fillPrinterSelects(j&&j.printers); })
    .catch(function(){ fillPrinterSelects(); });
}
function agentPrinterA5(){ return (SET.printerA5||'HP LaserJet 1020'); }
/* agentPrinterRcpt 已随「打印小票」移除（2026-10-08），小票不再走打印助手 */

/* 把一段页面内容交给助手静默打印：走 Edge 无头 → 58mm/A5 尺寸 PDF → SumatraPDF */
function agentHtmlPrint(printer, pw, ph, mm, innerHtml, css){
  var size=(ph>0)?('size:'+pw+'mm '+ph+'mm;'):('size:'+pw+'mm auto;');
  var html='<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    +'@page{'+size+'margin:'+mm+'mm;}'
    +'html,body{margin:0;padding:0;background:#fff;}'
    +(css||'')
    +'</style></head><body>'+innerHtml+'</body></html>';
  return agentPrintPdf({printer:printer, pw:pw, ph:ph, mm:mm, html:html, dry:0});
}

/* 静默打 A5 */
function printA5Silent(){
  var pw=148, ph=210, mm=8;
  return agentHtmlPrint(agentPrinterA5(), pw, ph, mm, sheetHTML(), rxLayoutCSS())
    .then(function(){ toast('已打印'); });
}
/* 静默打小票 */
function printRx(){
  if(!filledCount()){ toastErr('处方为空，无法打印'); return; }
  try{ RX_STORE.setItem('rx_last_print','a5'); }catch(e){}
  if(!AGENT_ON){ doPrint(sheetHTML(), SET.paper||'A5 portrait'); return; }
  toast('正在打印…');
  printA5Silent().catch(function(e){
    AGENT_ON=false;
    toastErr('打印助手失败：'+e.message+'（已改用浏览器打印）');
    setTimeout(function(){ doPrint(sheetHTML(), SET.paper||'A5 portrait'); }, 1500);
  });
}

/* 「打印预览」弹窗已于 2026-10-08 移除：它的唯一入口 openPrintPreview() 早已无人调用，
   弹窗里的「小票 56mm 热敏」选项属于要删的小票打印，一并去掉。
   buildA5Image / rasterize 等仍被「复制处方图片」使用，故保留。 */

/* 小票静默打印已于 2026-08-08 整体移除（用户要求）。
   保留：复制小票（copyReceiptImage）所需的模板/CSS/rcptWrap 一整套；
   保留：agentPrintPdf —— agentHtmlPrint 内部要用它，A5 处方与价格清单打印都走这条。
   移除：printReceipt / receiptContentMm 及小票打印入口（按钮、图标映射、点击绑定）。 */
function agentPrintPdf(job){
  return fetch(RX_AGENT+'/printpdf',{method:'POST',mode:'cors',cache:'no-store',
      headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(job)})
    .then(function(r){ return r.json(); })
    .then(function(j){ if(!j||!j.ok) throw new Error((j&&j.msg)||'打印助手返回失败'); return j; });
}

/* ================= 热敏小票模板（Paperang P2，58mm 卷纸） =================
   规则：每行最多 2 味；带尾缀（[另包]/[后下]/[代煎]…）或过长的药独占整行；
        药名+克数不加单位 g（非 g 单位如「个」保留）；备注加在「一付」上面；
        费用按 一付/ N付/ 跑腿/ 闪送/ 加工费/ 代煎费/ 物品费用/ 合计 逐行列出。 */
var RCPT_MM=58, RCPT_CONTENT_MM=56, RCPT_MARGIN_MM=0, RCPT_PAD_MM=1, RCPT_COL_EM=5.1, RCPT_GAP_EM=0.5, RCPT_ROW_GAP_EM=0.04;
function rcptBoxPx(){ return RCPT_CONTENT_MM*3.7795; }   /* 小票内容可印宽(px)：Paperang P2 热敏头可打印区≈整卷，内容用 56mm 满宽，字号才够大（曾误设 48mm 导致字缩到 3.5pt） */
/* 字号：设置里填了就用填的；留空则按纸宽反算，保证「一行 2 味」一定排得下
   列宽 = 列宽em × 字号，且 列宽 = (可印宽 - 2*内边距 - 列间距)/2，列间距 = 0.5em */
function rcptFontPx(){
  var manual=n(SET.rcptFs);
  if(manual>=8) return Math.round(manual*10)/10;
  var padPx=RCPT_PAD_MM*3.7795;
  return Math.floor((rcptBoxPx()-2*padPx)/(2*(RCPT_COL_EM+RCPT_GAP_EM/2))*10)/10;
}
/* 粗略字宽估算（单位 em）：中文/全角=1，数字=0.56，[ ]=0.35，空格=0.3，其余=0.6
   加粗时字面略宽（苹方加粗比常规宽约 6%），乘 1.06 留安全边，避免贴边被裁 */
function rcptEm(t){
  var em=0;
  for(var i=0;i<t.length;i++){
    var c=t.charCodeAt(i);
    if(c>=0x4e00&&c<=0x9fff) em+=1;
    else if(c>=0xff01&&c<=0xff5e) em+=1;
    else if(c===32) em+=0.3;
    else if(c>=48&&c<=57) em+=0.56;
    else if(c===91||c===93) em+=0.35;
    else em+=0.6;
  }
  return SET.rcptBold?em*1.06:em;
}
/* 金额：整数不显示小数（64 → 64元），有小数才带两位 */
function rcptMoney(v){
  var x=Math.round(n(v)*100)/100;
  return (Math.abs(x-Math.round(x))<0.005?String(Math.round(x)):x.toFixed(2));
}
function rcptCn(v){ return ({1:'一',2:'二',3:'三',4:'四',5:'五',6:'六',7:'七',8:'八',9:'九',10:'十'})[v]||String(v); }
function rcptCSS(){
  return ''
  +'.rcpt{font-family:"PingFang SC","苹方","Helvetica Neue","Microsoft YaHei",sans-serif;color:#000;background:#fff;'
  +'box-sizing:border-box;line-height:'+(n(SET.rcptLh)||1)+';font-weight:'+(SET.rcptBold?'700':'400')+';letter-spacing:0;overflow:visible;margin:0 auto;max-width:100%;overflow-wrap:anywhere;word-break:break-word}'
  +'.rcpt .rline{display:flex;gap:'+RCPT_GAP_EM+'em;align-items:flex-start;justify-content:space-between;'
  +'margin:'+(RCPT_ROW_GAP_EM*n(SET.rcptLh||1)).toFixed(3)+'em 0}'
  +'.rcpt .ritem{flex:0 0 auto;white-space:nowrap;overflow-wrap:anywhere}'
  +'.rcpt .ritem.full{white-space:normal;word-break:break-all;overflow-wrap:anywhere}'
  +'.rcpt .rnote{margin-top:1em;white-space:pre-wrap;word-break:break-all}'
  +'.rcpt .rfee{margin-top:1em}'
  +'.rcpt .rfloor{margin-top:1.3em;white-space:normal;word-break:break-word;overflow-wrap:anywhere}'
  +'.rcpt .rfloor-date{white-space:nowrap}';   /* 日期不拆字：放不下就整段换到下一行 */
}
function receiptHTML(){
  readAllCells();
  var L=filledItems(), j=curJishu();
  /* 实际列宽 / 整行可容宽度（都换算成 em，和字号无关地按比例判断） */
  var fs=rcptFontPx(), padPx=RCPT_PAD_MM*3.7795;
  var colEm=(rcptBoxPx()-2*padPx-RCPT_GAP_EM*fs)/2/fs;
  var fullEm=2*colEm+RCPT_GAP_EM;
  /* 贪心排版：一行最多 2 味；累计宽度超过整行宽度就提前换行；
     带尾缀（[另包]/[后下]/[代煎]…）或本身超宽的药 → 自己占一行 */
  var rows=[], cur=[], curW=0, i, it, sp, u, ds, line, w;
  for(i=0;i<L.length;i++){
    it=L[i]; sp=splitSfx(it.name); u=String(it.unit||'g');
    ds=it.zibei?'自备':(it.qty?((+it.qty)+(u==='g'?'':u)):'');
    /* 药名与克数之间不留空格（省纸）；带尾缀时按「药名[另包] 30」保留一个空格。
       ⚠ 尾缀显示：**屏幕界面去方括号，打印图/小票带方括号**（2026-10-07 用户要求）。
       宽度估算必须用**实际渲染的那一份文本**，否则折行会算错。 */
    var sfxTxt=sfxTextBr(sp.sfx);
    line=sp.nm+sfxTxt+(ds!==''?((sfxTxt?' ':'')+ds):'');
    w=rcptEm(line);
    if(!!sfxTxt||w>fullEm){                          /* 尾缀药 / 比整行还宽的药 → 独占一行 */
      if(cur.length){ rows.push(cur); cur=[]; curW=0; }
      rows.push([{t:line,full:true}]);
      continue;
    }
    if(cur.length>=2||(cur.length===1&&curW+RCPT_GAP_EM+w>fullEm)){ rows.push(cur); cur=[]; curW=0; }
    cur.push({t:line,full:false}); curW+=(cur.length>1?RCPT_GAP_EM:0)+w;
  }
  if(cur.length) rows.push(cur);
  var h='';
  for(i=0;i<rows.length;i++){
    h+='<div class="rline">';
    for(var k=0;k<rows[i].length;k++)
      h+='<span class="ritem'+(rows[i][k].full?' full':'')+'">'+esc(rows[i][k].t)+'</span>';
    h+='</div>';
  }
  var note=String($('fNote').value||'').trim();          /* 备注加在「一付」上面 */
  if(note) h+='<div class="rnote">'+esc(note)+'</div>';
  var per=n($('fPerDose').value)||perDoseFee();   /* 与合计同源：手改过优惠价时也能对得上 */
  h+='<div class="rfee"><div>一付 '+rcptMoney(per)+'元</div>';
  if(j>1) h+='<div>'+rcptCn(j)+'付 '+rcptMoney(per*j)+'元</div>';
  if($('cbProcess').checked) h+='<div>加工费 '+rcptMoney(processFee())+'元</div>';
  if($('cbDaijian').checked) h+='<div>代煎费 '+rcptMoney(daijianFee())+'元</div>';
  if($('cbPaotui').checked)  h+='<div>跑腿 '+rcptMoney(paotuiFee())+'元</div>';
  if($('cbExpress').checked) h+='<div>闪送 '+rcptMoney(expressFee())+'元</div>';
  if($('cbKuaidi').checked) h+='<div>快递 '+rcptMoney(kuaidiFee())+'元</div>';
  if($('cbGoods').checked)  h+='<div>物品费用 '+rcptMoney(goodsFee())+'元</div>';
  h+='<div>合计 '+rcptMoney(curTotal())+'元</div></div>';
  var d=$('fDate').value||today(), m=d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  h+='<div class="rfloor">'+esc($('fName').value)+' <span class="rfloor-date">'+(m?((+m[2])+'月'+(+m[3])+'日'):esc(d))+'</span></div>';
  return h;
}
/* 小票纸面放大倍数（用户要字更大、铺满整纸）。
   ⚠ 关键：容器宽度必须和字号**同比例放大**。
   原来只放大字号、宽度固定 212px，两列实际需要 ~287px，于是
   `.rcpt{overflow:hidden}` 把右边整列裁掉——印出来是「制附子[先煎」缺右括号、
   「麦冬4」后面全空（用户照片 2026-10-06 19:33）。
   宽度放大后由打印助手按纸宽点阵缩放回去，纸上仍是满幅，字号比例不变。 */
var RCPT_SCALE=1.111;
function rcptWrap(){
  var pad=Math.round(RCPT_PAD_MM*3.7795);
  /* 宽度按同一倍数放大，padding 不放大（保持与纸边的相对留白） */
  var w=Math.round(rcptBoxPx()*RCPT_SCALE)+pad*2;
  var f=Math.round(rcptFontPx()*RCPT_SCALE*10)/10;
  return '<div class="rcpt" style="width:'+w+'px;padding:'+pad+'px;font-size:'+f+'px">'
    +receiptHTML()+'</div>';
}
/* ---------------- 复制小票图片（与打印同一份 HTML + 同一套 CSS，所见即所得） ---------------- */
function copyReceiptImage(){
  if(!filledCount()){ toastErr('处方为空，无法生成小票图片'); return; }
  if(shotBusy){ toast('正在生成，请稍候…'); return; }
  shotBusy=true;
  toast('正在生成小票图片…');
  try{
    var inner=rcptWrap(), W=Math.round(rcptBoxPx()*RCPT_SCALE)+Math.round(RCPT_PAD_MM*3.7795)*2;
    /* 先在页面里量一次真实高度：备注多、味数多时也不会被裁掉 */
    var meas=document.createElement('div');
    meas.style.cssText='position:absolute;left:-99999px;top:0;visibility:hidden;width:'+W+'px';
    meas.innerHTML='<style>'+rcptCSS()+'</style>'+inner;
    document.body.appendChild(meas);
    var box=meas.querySelector('.rcpt');
    var H=Math.ceil((box?box.getBoundingClientRect().height:W))+4;
    document.body.removeChild(meas);
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'">'
      +'<foreignObject x="0" y="0" width="100%" height="100%">'
      +'<div xmlns="http://www.w3.org/1999/xhtml"><style>'+rcptCSS()+'</style>'+inner+'</div>'
      +'</foreignObject></svg>';
    var img=new Image();
    img.onload=function(){
      try{
        var S=3, cv=document.createElement('canvas');      /* 3 倍图，粘贴到微信也清晰 */
        cv.width=W*S; cv.height=H*S;
        var g=cv.getContext('2d');
        g.fillStyle='#fff'; g.fillRect(0,0,cv.width,cv.height);
        g.drawImage(img,0,0,cv.width,cv.height);
        cv.toBlob(function(blob){
          shotBusy=false;
          if(!blob){ toastErr('生成失败，请重试一次'); return; }
          if(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem){
            navigator.clipboard.write([new ClipboardItem({'image/png':blob})])
              .then(function(){ toast('小票图片已复制，可直接粘贴到微信发给客户'); })
              .catch(function(){ fallbackDownload(blob); });
          }else{
            fallbackDownload(blob);
          }
        },'image/png');
      }catch(err){ shotBusy=false; toastErr('生成失败：'+err.message); }
    };
    img.onerror=function(){ shotBusy=false; toastErr('当前浏览器不支持生成图片，请换用 Chrome 或 Edge'); };
    img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  }catch(e){
    shotBusy=false; toastErr('生成失败：'+e.message);
  }
}
/* 药味 ≥12 味时，把小票按钮标出来（提示可用短纸打印） */
/* 药味 ≥12 味时把「复制小票」标出来（提示可用短纸）
   2026-10-08：打印小票按钮已移除，这里只管 btnShotR。 */
function rcptHint(){
  var many=filledCount()>=12;
  var b=$('btnShotR');
  if(b) b.className=(many?'rcptOn':'');
}
/* ---------------- 复制处方图片（把打印预览渲染成 PNG 进剪贴板） ---------------- */
/* 做法：把「打印预览用的同一份 HTML + 同一套 CSS」渲染成图，
   所以复制出来的图和点「打印」看到的完全一致（不会另走一套样式） */
var shotBusy=false;
/* 截图/打印共用的排版样式：药名 14px、费用 12px、尾缀同行不换行 */
/* 处方笺字体设置（设置弹窗里可调，打印与复制图片同步生效） */
function rxFontPx(){ var v=n(SET.rxFs); return (v>=8&&v<=30)?v:14; }
function rxFontWeight(){ return SET.rxBold?'700':'400'; }
function rxLineHeight(){ var v=n(SET.rxLh); return v>0?v:1.6; }
function rxLayoutCSS(){
  /* 500px 宽的小图专用：三列排版，字号相对更大、间距压紧，费用区贴底 */
  var FS=rxFontPx(), FW=rxFontWeight(), LH=rxLineHeight();
  return ''
  +'.rxs{font-family:"PingFang SC","苹方","Helvetica Neue","Microsoft YaHei",sans-serif;font-size:'+FS+'px;line-height:'+LH+';'
  +'font-weight:'+FW+';color:#000;display:flex;flex-direction:column;background:#fff;height:100%}'
  +'.rxhead{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:3px;'
  +'border-bottom:1.5px solid #000;margin-bottom:6px;flex:0 0 auto}'
  +'.rxhead .lbl{font-weight:700;font-size:12px;line-height:1.6;white-space:nowrap}'
  +'.rxhead b{font-weight:700;font-size:12px;line-height:1.6;white-space:nowrap}'
  +'.rxhead>span{white-space:nowrap;display:inline-block}'
  +'.rxhead b{font-weight:700;font-size:12px;line-height:1.6;white-space:nowrap}'
  +'.rxhead>span{white-space:nowrap}'
  +'.rxhead>span:last-child{flex:0 0 auto}'
  +'.rxhead b{white-space:nowrap}'
  +'.rxgrid{display:grid;grid-template-columns:repeat(3,1fr);column-gap:4px;row-gap:1px;'
  +'padding:2px 0;flex:0 0 auto;align-content:start}'
  +'.cell{display:flex;align-items:baseline;gap:3px;justify-content:flex-start;flex-wrap:nowrap;white-space:nowrap;overflow:hidden}'
  +'.cell .nm,.cell .ds,.cell .sfx{font-family:"PingFang SC","苹方","Helvetica Neue","Microsoft YaHei",sans-serif;font-size:'+FS+'px;'
  +'line-height:'+LH+';font-weight:'+FW+';color:#000;white-space:nowrap}'
  +'.cell .nm{flex:0 1 auto;width:auto;min-width:0;max-width:100%}'
  +'.cell .ds{flex:0 0 auto;width:auto;min-width:0}'
  +'.cell .sfx{flex:0 1 auto;width:auto;color:#555}'
  +'.cell.zibei .ds{color:var(--aux)}'
  +'.rxfoot{border-top:1.5px solid #000;margin-top:8px;padding-top:6px;flex:0 0 auto;margin-top:auto}'
  +'.rxline1{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:13px}'
  +'.rxline1 b{font-weight:700}'
  +'.rxline1 .notebox{flex:1;min-width:0;display:block;border-bottom:1px solid #000;padding:0 2px 1px;font-size:13px;min-height:1.2em}'
  +'.rxmoney{display:grid;grid-template-columns:1fr 1fr;gap:2px 14px;font-size:13px}'
  +'.rxmoney .f{display:flex;align-items:baseline;gap:3px}'
  +'.rxmoney .f .lb{white-space:nowrap}'
  +'.rxmoney .f .val{font-size:13px;font-weight:700;padding:0 2px;min-width:50px}'
  +'.rxopts{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;margin-top:4px}'
  +'.rxopts .f{display:inline-flex;align-items:baseline;gap:3px}'
  +'.rxopts .lb{white-space:nowrap}'
  +'.rxopts .val{font-size:13px;font-weight:700;padding:0 2px}'
  +'.rxweight{display:flex;gap:16px;font-size:12px;color:#000;margin-top:4px}';
}
function copyRxImage(){
  if(!filledCount()){ toastErr('处方为空，无法生成图片'); return; }
  if(shotBusy){ toast('正在生成，请稍候…'); return; }
  shotBusy=true;
  toast('正在生成处方图片…');
  try{
    var html=sheetHTML();
    /* 500×640：图小 → 排版也按 500 宽来，字才够大看得清；2 倍图输出 1000×1280 */
    var W=500, H=640;
    var css=rxLayoutCSS();
    var inner='<div style="width:'+W+'px;height:'+H+'px;padding:10px 12px;background:#fff;'
      +'box-sizing:border-box;font-family:&quot;PingFang SC&quot;,&quot;苹方&quot;,&quot;Helvetica Neue&quot;,&quot;Microsoft YaHei&quot;,sans-serif;color:#000">'
      /* 整页纵向 flex：药味在上、费用区贴底（与打印预览一致） */
      +'<div style="height:100%;display:flex;flex-direction:column">'
      +html
      +'<div style="flex:1 1 auto;min-height:0"></div>'
      +'</div></div>';
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'">'
      +'<foreignObject x="0" y="0" width="100%" height="100%">'
      +'<div xmlns="http://www.w3.org/1999/xhtml"><style>'+css+'</style>'+inner+'</div>'
      +'</foreignObject></svg>';
    var svgUrl='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    var img=new Image();
    img.onload=function(){
      try{
        var cv=document.createElement('canvas');
        cv.width=W*2; cv.height=H*2;
        var g=cv.getContext('2d');
        g.fillStyle='#fff'; g.fillRect(0,0,cv.width,cv.height);
        g.drawImage(img,0,0,cv.width,cv.height);
        cv.toBlob(function(blob){
          shotBusy=false;
          if(!blob){ toastErr('生成失败，请改用「打印」'); return; }
          if(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem){
            navigator.clipboard.write([new ClipboardItem({'image/png':blob})])
              .then(function(){ toast('处方图片已复制，可直接粘贴到微信发给客户'); })
              .catch(function(){ fallbackDownload(blob); });
          }else{
            fallbackDownload(blob);
          }
        },'image/png');
      }catch(err){ shotBusy=false; toastErr('生成失败：'+err.message); }
    };
    img.onerror=function(){ shotBusy=false; toastErr('当前浏览器不支持生成图片，请用「打印」'); };
    img.src=svgUrl;
  }catch(e){
    shotBusy=false;
    toastErr('生成失败：'+e.message);
  }
}
function fallbackDownload(blob){
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='处方_'+$('fName').value+'_'+( $('fDate').value||today() )+'.png';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); },2000);
  toastErr('浏览器不支持直接复制图片，已改为下载 PNG，请手动发送');
}
function priceListStats(){
  var cnt=0, wt=0, tot=0, L=filledItems();
  for(var i=0;i<L.length;i++){
    var it=L[i]; if(it.zibei) continue;
    cnt++;
    var u=String(it.unit||'').toLowerCase();
    if(u==='g'||u==='') wt+=n(it.qty); else if(u==='kg') wt+=n(it.qty)*1000;
    var p=priceOf(it); tot+=(p==null?0:p*n(it.qty));
  }
  return {cnt:cnt,wt:Math.round(wt),tot:tot};
}

/* 清单单位显示：g/克 → 克（表格里用中文字），其余单位原样 */
function listUnit(it){
  if(!it || it.zibei) return '';
  var u=String(it.unit||'').trim();
  if(!u || u.toLowerCase()==='g') return '克';
  return u;
}
function listSheetHTML(){
  readAllCells();
  var j=curJishu(), L=filledItems(), s=priceListStats();
  var head='<div style="text-align:center;font-weight:700;font-size:15px;margin-bottom:6px">'
    +esc(SET.clinic||'')+(SET.clinic?' ':'')+'价格清单</div>'
    +'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">'
    +'<span>姓名：'+esc($('fName').value||'')+'</span>'
    +'<span>日期：'+esc($('fDate').value||today())+'</span>'
    +'<span>共 '+j+' 剂</span></div>';

  /* 逐行金额与总重量累加 —— 底部汇总直接由这些数算出来，不再抄处方的横线格式 */
  var rows='', sumAmt=0, sumWt=0, sumQty=0, cnt=0;
  for(var i=0;i<L.length;i++){
    var it=L[i], p=it.zibei?0:priceOf(it);
    var amt1=(it.zibei||p==null)?0:p*n(it.qty);      /* 单剂金额 */
    var amt=amt1*j;                                  /* 本方总金额 = 单剂 × 剂数 */
    var wt=0;
    if(!it.zibei){
      cnt++;
      var u=String(it.unit||'').toLowerCase();
      if(u==='g'||u==='') wt=n(it.qty)*j;
      else if(u==='kg')  wt=n(it.qty)*1000*j;
      if(u==='g'||u===''||u==='kg') sumQty+=n(it.qty);
    }
    sumAmt+=amt; sumWt+=wt;
    rows+='<tr><td style="text-align:left">'+esc(it.name)+(it.zibei?'（自备）':'')+'</td>'
      +'<td style="text-align:center">'+(it.zibei?'':(+it.qty))+'</td>'
      +'<td style="text-align:center">'+esc(listUnit(it))+'</td>'
      +'<td style="text-align:center">'+esc(it.zibei?'':(p==null?'':e3(p)))+'</td>'
      +'<td style="text-align:center">'+(it.zibei?'':e3(amt))+'</td></tr>';
  }

  /* 汇总行：数量按单位合并只显一次（默认 g），金额/重量都是各行相加 */
  var extra=[];
  if(processFee())  extra.push(['加工费用', money(processFee())]);
  if(daijianFee())  extra.push(['代煎费', money(daijianFee())]);
  if(paotuiFee())   extra.push(['跑腿费', money(paotuiFee())]);
  if(expressFee())  extra.push(['闪送费', money(expressFee())]);
  if(kuaidiFee())   extra.push(['快递费', money(kuaidiFee())]);
  if(goodsFee())    extra.push(['物品费用', money(goodsFee())]);

  var tfoot='<tfoot>'
    +'<tr class="lssum"><td style="text-align:left">合计</td>'
    +'<td style="text-align:center">'+e3(Math.round(sumQty*100)/100)+'</td>'
    +'<td style="text-align:center">克</td><td></td>'
    +'<td style="text-align:center">'+e3(Math.round(sumAmt*1000)/1000)+' 元</td></tr>'
    +'<tr class="lssum"><td style="text-align:left">总重量</td>'
    +'<td colspan="4" style="text-align:center">'+Math.round(sumWt)+' 克　（共 '+j+' 剂）</td></tr>';
  for(var k=0;k<extra.length;k++){
    tfoot+='<tr class="lssum"><td style="text-align:left">'+extra[k][0]+'</td>'
      +'<td colspan="4" style="text-align:right;padding-right:14px">'+extra[k][1]+' 元</td></tr>';
  }
  tfoot+='<tr class="lstot"><td style="text-align:left">应付合计</td>'
    +'<td colspan="4" style="text-align:right;padding-right:14px">'
    +money(sumAmt + processFee()+goodsFee()+daijianFee()+paotuiFee()+expressFee()+kuaidiFee())
    +' 元</td></tr></tfoot>';

  var note=$('fNote').value.trim();
  var tbl='<table class="lstbl">'
    +'<thead><tr><th style="text-align:left">药名</th>'
    +'<th style="width:62px">数量</th><th style="width:46px">单位</th>'
    +'<th style="width:76px">单价</th><th style="width:88px">金额</th></tr></thead>'
    +'<tbody>'+rows+'</tbody>'+tfoot+'</table>';
  if(note){
    tbl+='<div style="margin-top:6px;font-size:12px">备注：'+esc(note)+'</div>';
  }
  return {html:head+tbl, w:Math.round(sumWt), cnt:cnt,
          amount:Math.round(sumAmt*100)/100};
}
/* 清单专用样式（快照与打印共用） */
function listCSS(){
  return '.lstbl{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}'
    +'.lstbl th{border:1px solid #666;padding:3px 4px;background:#e8e6df;font-weight:700}'
    +'.lstbl td{border:1px solid #666;padding:2px 4px}'
    +'.lstbl .lssum td{background:#f4f2ec;font-weight:700}'
    +'.lstbl .lstot td{background:#e8e6df;font-weight:700;font-size:13px}';
}
/* 清单静默打印（与处方笺同一条链路：不弹窗口） */
function printList(){
  if(!priced){ toastErr('请先点「自动划价」'); return; }
  if(!filledCount()){ toastErr('处方为空'); return; }
  var inner=listSheetHTML().html;
  if(!AGENT_ON){
    doPrint(inner, SET.paper||'A5 portrait', 8, listCSS());
    return;
  }
  toast('正在打印清单…');
  agentHtmlPrint(agentPrinterA5(), 148, 210, 8, inner, listCSS())
    .then(function(){ toast('清单已打印'); })
    .catch(function(e){
      AGENT_ON=false;
      toastErr('打印助手失败：'+e.message+'（已改用浏览器打印）');
      setTimeout(function(){ doPrint(inner, SET.paper||'A5 portrait', 8, listCSS()); }, 1500);
    });
}
/* 复制清单快照图片（与「复制处方图片」同一管线） */
function copyListImage(){
  if(!filledCount()){ toastErr('处方为空'); return; }
  if(shotBusy){ toast('正在生成，请稍候…'); return; }
  shotBusy=true;
  toast('正在生成清单图片…');
  try{
    var inner=listSheetHTML().html;
    var W=500, H=709, css=listCSS();
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'">'
      +'<foreignObject x="0" y="0" width="100%" height="100%">'
      +'<div xmlns="http://www.w3.org/1999/xhtml"><style>'+css+'</style>'
      +'<div style="width:'+W+'px;height:'+H+'px;padding:10px 12px;background:#fff;'
      +'box-sizing:border-box;color:#000">'+inner+'</div>'
      +'</div></foreignObject></svg>';
    rasterize(svg,W,H,2).then(function(im){
      return fetch(im.url).then(function(r){ return r.blob(); });
    }).then(function(blob){
      shotBusy=false;
      if(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem){
        return navigator.clipboard.write([new ClipboardItem({'image/png':blob})])
          .then(function(){ toast('清单图片已复制，可直接粘贴发送'); });
      }
      fallbackDownload(blob);
    }).catch(function(e){ shotBusy=false; toastErr('生成失败：'+e.message); });
  }catch(e){ shotBusy=false; toastErr('生成失败：'+e.message); }
}

/* =========================================================
   药物维护
   ========================================================= */
function loadDrugs(){
  /* 药价只从 Supabase drugs 表加载（见 SUPA.loadDrugs）。
     启动瞬间先置空，绝不读取本地内置目录文件；云端没有就显示为空。 */
  drugsList=[];
  buildIndex();
}
/* 药价目录有变动 → 整目录 upsert 回数据库。
   药价条目之间互相独立，个别失败不阻断其他，用 allSettled 式兜底。 */
var _supaDrugPush=null;
function supaPushDrugs(){
  if(!SUPA.on||!drugsList.length) return;
  if(_supaDrugPush) clearTimeout(_supaDrugPush);
  _supaDrugPush=setTimeout(function(){
    /* 🔴 上传前再核一次数量（2026-10-07 加）：
       「药物管理」里点「清空药物」会先把 drugsList 清空再重建，
       若中途有防抖窗口触发上传，就会把云端 1039 味药价覆盖成极少几条。
       与其猜时序，不如在这里硬性要求「不能少于云端已有量的一半」才允许整表覆盖。 */
    var n=drugsList.length;
    if(!n){ console.warn('⛔ 药价目录为空，跳过上传（保护云端）'); return; }
    if(RX_DRUG_FLOOR && n<RX_DRUG_FLOOR){
      console.warn('⛔ 药价仅 '+n+' 味 < 安全下限 '+RX_DRUG_FLOOR+'，跳过整表上传（保护云端）');
      supaSaveFail('药价数量异常（'+n+' 味），已跳过上传以保护云端数据');
      return;
    }
    /* 🔴 云端药价必须先拉回来，才允许整表上传（2026-10-30 加）：
       否则一打开旧页面 / 缓存页，本机那份**没有进货价**的旧目录就会被整表 upsert 回去，
       把云端的 cost（进货价）全冲成 null，甚至把列错位的值写进去（列定义改版时必然错位）。
       判据：SUPA.on=true 且尚未 loadDrugs 成功 → 一律不上传，只在本机落盘。 */
    if(SUPA.on && !SUPA.drugsPulled){
      console.warn('⛔ 云端药价尚未拉取完成，跳过整表上传（保护云端数据）');
      return;
    }
    var doc='';
    try{ doc=curDoctorOf(); }catch(e){}
    /* ⚠ 空名行必须剔掉（2026-10-08 加）：
       「添加」按钮新加的那一行如果用户没填药名，name='' 会被当成一条记录上传；
       而 drugs 表主键就是 name，两条空名行落在同一个 300 条批次里 → 整批 409，
       连带这一批里其他药的更新全部静默失败。 */
    var rows=[], seen={};
    for(var i=0;i<drugsList.length;i++){
      var d=drugsList[i];
      if(!d || !String(d.n||'').trim()) continue;
      var nm=String(d.n).trim();
      /* ⚠ 同名必须去重（2026-10-08 加）：
         drugs 主键就是 name，而 ON CONFLICT DO UPDATE 不允许同一条命令里
         出现两行同名 —— 整批会直接报 PostgreSQL 21000
         「ON CONFLICT DO UPDATE command cannot affect row a second time」→ HTTP 500，
         这一批 300 味药的更新全部丢失，而且只是 console.warn，用户完全看不见。
         本地出现同名有两条常见原因：
           1) 用户在药物管理里新增了一味和库里重名的药（本行插入后库里已有一条）
           2) 用户把已有药名改成了另一味药的名字
         同名时保留**后出现**的那条（数组后面的通常是用户最新填/改的）。 */
      if(seen[nm]!==undefined){
        rows[seen[nm]]=null;                       /* 旧的那条作废，稍后压缩 */
      }
      seen[nm]=rows.length;
      /* 用 dmRowOfFull：含新增字段（日常打单价 / 产地 / 别名 / 多单位），
         需先执行 supabase_new_tables.sql，否则云端会因未知列报错（错误被捕获并提示，本机不受影响）。 */
      rows.push(dmRowOfFull(d));
    }
    rows=rows.filter(Boolean);
    if(!rows.length){ console.warn('⛔ 没有有效药名，跳过整表上传'); return; }
    var B=300;
    for(var i=0;i<rows.length;i+=B){
      (function(chunk){
        SUPA.q('drugs?on_conflict=name',{method:'POST',body:chunk}).catch(function(e){
          console.warn('药价写库失败:',e.message);
          /* 整批 300 味药都没写进去，得多说一声，别只在控制台里闷掉 */
          supaSaveFail('药价写库失败：'+e.message);
        });
      })(rows.slice(i,i+B));
    }
  },1200);
}
/* 药价目录的唯一持久化目标是 Supabase drugs 表；本函数只重建索引并触发整表写库。 */
function saveDrugsLS(){ buildIndex(); autoBackup(); supaPushDrugs(); }

/* ---------- 新增药材 → 走真正的 INSERT 写进云端（2026-10-08 加）----------
   原来新增药材只能靠 supaPushDrugs() 的「整表 upsert」顺带写进去：
     - 防抖 1200ms，页面一关就没了；
     - 失败只 console.warn，用户完全看不到；
     - 万一被 RX_DRUG_FLOOR 拦下（数量异常），新增的那味药根本进不了云端。
   现在：凡是「添加」按钮新建、且已填药名的记录，单独发一条 POST /drugs
   （不带 on_conflict → 走标准 INSERT 语义），成功后清掉 __new 标记。
   同名已存在时自动降级为 upsert，不会报错。 */
function dmRowOf(d){
  return {name:String(d.n||'').trim(), py:d.py||'', unit:d.u||'g', usage:d.c||'',
          category:d.cat||'中药', tccat:d.tc||'',
          price:(d.p===''||d.p==null)?null:parseFloat(d.p),
          cost:(d.bp===''||d.bp==null)?null:parseFloat(d.bp)};
}
/* 增强版：含新增字段（日常打单价/产地/别名/多单位）。
   ⚠ 仅在已执行 supabase_new_tables.sql 后调用，否则云端会因未知列报错。 */
function dmRowOfFull(d){
  var row={name:String(d.n||'').trim(), py:d.py||'', unit:d.u||'g', usage:d.c||'',
          category:d.cat||'中药', tccat:d.tc||'',
          price:(d.p===''||d.p==null)?null:parseFloat(d.p),
          cost:(d.bp===''||d.bp==null)?null:parseFloat(d.bp),
          daily_price:(d.dp===''||d.dp==null)?null:parseFloat(d.dp),
          origin:d.og||'', aliases:Array.isArray(d.al)?d.al:[],
          units:Array.isArray(d.un)?d.un:[]};
  /* 批发价 + 各价格倍率：只有在云端确实有这两列时才带（见 SUPA.probeExt） */
  if(SUPA.ext && SUPA.ext.ok){
    var wp=(d.wp===''||d.wp==null)?null:parseFloat(d.wp);
    row.wp=(wp==null||isNaN(wp))?null:wp;
    row.rates=(d.rates&&typeof d.rates==='object')?d.rates:null;
  }
  return row;
}
function supaInsertNewDrugs(){
  if(!SUPA.on) return Promise.resolve(0);
  var pend=[];
  for(var i=0;i<drugsList.length;i++){
    var d=drugsList[i];
    if(d && d.__new && String(d.n||'').trim()) pend.push(d);
  }
  if(!pend.length) return Promise.resolve(0);
  var names=pend.map(function(d){ return d.n; });
  return Promise.all(pend.map(function(d){
    var row=dmRowOfFull(d);
    /* 先试标准 INSERT；409（同名已存在）→ 降级 upsert 覆盖，保证不报错 */
    return SUPA.q('drugs',{method:'POST',body:row}).catch(function(e){
      if(/duplicate key|already exists|23505|409/i.test(e.message||'')){
        return SUPA.q('drugs?on_conflict=name',{method:'POST',body:[row]});
      }
      throw e;
    }).then(function(){
      try{ delete d.__new; }catch(e2){ d.__new=false; }
    });
  })).then(function(){
    /* 标记清掉了；持久化已经由 drugs 表写入完成，不再写本地副本 */
    return names.length;
  }).catch(function(e){
    console.warn('新增药材写库失败:',e.message);
    supaSaveFail('新增药材：'+e.message);
    return 0;
  });
}
/* 中药名用字 → 拼音首字母（720 字）
   从云端 1041 味药价的「药名↔拼音」反推得到：906 条纯药名零冲突，
   仅 3 条差异，全部是库里本来就错的：
     羊角丝A（脏数据，名字里混了字母）、炒薏仁=cr、薏仁=r —— 薏读 yi，已修正为 y。
   ⚠ 刻意保留的两个「非标准但与库一致」的读音，改了会破坏搜索：
     术 = s（库里 白术=bs/苍术=cs/莪术=es 一致用 s；标准读音是 zhú。
             但搜索是匹配「药名+拼音」字段，改成 z 就会导致搜 es 找不到莪术）
   覆盖 1041 味药的 720 个全部用字，够日常录药；
   表外生僻字自动跳过（拼音留空，可手填）。*/
var PY_CHARS='一丁七三上下不丑专东丝两个中丸丹丽乌九乳二五交京人仁仙代仲休众伞伸何余佛佩使侧倍倒健僧僵儿元先光克党全八公六兰内冠冬冰决凌凤凰出刀分切刘制刺前力功加劳勃包化北十千升半华单南卡卷卿厚去参叉双口古另叶合名后君吴味哈商四回圆土地坎垂基塔壁壳备夏夜大天太头夷女奴好姜威娘子字孢季安实宽寄密寒寻射小尖尾层山岗川州己巴布带常干年床应延开异归当徐心必忍志急性息患慈戟房扁手打扛拔指换接救斑斛斤断方旋无旱昆明星春晒普景智曲月服木本札术朱朴李杏杖杜杞杨杭杷松板枇林果枝枣枫枯枳枸柏柱柳柴柽柿栀树栝核根桂桃桐桑桔梅梓梗梧梨棉棕棘棠棱椒椿楂楝楞楠楮楼榄榆榈榔榕榧榴槐槟槿樟樱橘橼檀檵欢款正母毒毕毛气水汉江沉沙没河油法泻泽洋洛活流浙浮海消淡淫淮清渣溪滑漆漏澄火灯灰灵灶炒炙炭炮点烊焦然煅煎熟爪片牌牛牡狗独狼猪猫猬玄玉王玛玫珀珍珠球琥瑰瓜瓦甘甜生用田甲留番白百皂皮盆益盐盘目眼瞿矢知矮石矾砂研破硝硫硬硼碎磁磨磺礞神福禹秦积稻穗穿竭竹竺笕笼筋箭米籽粉粒粮粳精糯素索紫红纸细络绞续绿罗羊羌羽翁翘老耳肉股肤肾肿胆背胎胖胡胶脂脑脚腊腥腹膏膝自臭舌良艽艾节芍芎芒芙芝芡芥芦芨芩芪芫花芷芽苁苇苈苋苍苎苏苑苓苣苦英茄茅茇茉茎茜茯茱茴茵茶茸茹茺荆草荔荜荞荡药荷荽莉莪莱莲莶菀菇菊菔菖菜菝菟菱萆萍萸萹落葙葚葛葜葫葱葵葶蒂蒌蒙蒜蒡蒲蒺蒿蓄蓉蓝蓟蔓蔚蔹蔻蕊蕲薄薇薏薢薤薰薷藁藏藕藜藤藻藿虎虫虱虻虾蚁蚂蚕蚣蚤蚶蛄蛇蛋蛎蛤蛭蛴蛸蛾蜂蜈蜍蜓蜕蜜蜡蜻蝉蝎蝥蝴蝶蝼螬螵蟆蟾血行衔衣补西覆见角诃谷豆豉豨贝贞败贯贼赤赭走起路车软轻辛辣辰边过进远连透通遂郁部酒酥酱酸醋里重野金针钩钱铁铜银锁锦长闹防阳阿陀附陆陈降雄雪雷霄霍霜青非面鞭韦韭顶须颓风食首香馨马驳骨高鬼鱼鲜鳔鳖鸡鸦鹅鹤鹳鹿麒麝麟麦麻黄黑黛齿龙龟';
var PY_LETTERS='ydqssxfczdslgzwdlwjrewjjrrxdzxzsshyfpscbdjsjeyxgkdqbgllngdbjlfhcdfqlzcqlgjlbbhbsqsbhdnqjqhqscskglyhmhjwwhsshytdkcjtbkbxydtttynnhjwnzcbjaskjmhxsxjwcsgczjbbdcgncyykygdxxbrzjxxhcjfbsdkbzhjjbhjdfxwhkmxcspjzqyfmbzszplxzdqyhpsbplgzzfkzjbzlccszsghggttsjmzgwlmzjtljczllncllyllrflhbjzyjytjhkzmdbmqscjcsmhyfxzylhlzfhxdyhqzxhqlchdhlzcztpdyjrdjszppnmgdlzmwxywmmpzzqhggwgtsytjlfbbzppyypmyqszasfsypxlypscmhmsfyqjdscjzzjljjmzflljjnsszhzxljxllyqywqlergfszdbtphjznjxxfgxzcslqajsxmfzqjljqqyhzycwlxczsyljkyqmbmjqfzhycrrcjclbqdyhslellxwgjfccbtlbpyblxsgqhcktdlmsbpjhxrljmwlkrqbwyxxxrgcoltzhhcsmxymcgzhgsdlgzqxefwcttmlqcxmhdlcpmcxhxybxfjjhgdcxbzbgzczzqlcrqxlcbgjylttsybjsjsclzyjzgqttysjcnfyatflcjxxlxhsqfmbwjdxtfssxxmbgggyxbbjyehglqslmmhhdclg';
var PY_MAP=(function(){
  var m={};
  for(var i=0;i<PY_CHARS.length;i++) m[PY_CHARS[i]]=PY_LETTERS[i];
  return m;
})();
/* 药名 → 拼音首字母。括号里的规格标注也计入（麦冬[另包] → mdlb）。 */
function genPinyin(name){
  var s=String(name||'');
  var out='';
  for(var i=0;i<s.length;i++){
    var c=s.charAt(i);
    if(!/[一-龥]/.test(c)) continue;   /* 只取汉字：跳过 [] {} 数字 字母 空格 */
    var L=PY_MAP[c];
    if(L) out+=L;   /* 表外生僻字跳过，留空给人手填 */
  }
  return out;
}
/* 表格只平铺常用核心列；常用量/分类/拼音/斗位/进价等挪到「详情」弹窗里看。 */
/* 建议价（只读计算列）：进货单保存时把「进货价 × 批发倍率」记成快照 d.rates.sg。
   ⚠ 用户 2026-10-30 明确：改批发价**不动**建议价，只有进货价变了建议价才变。
     所以优先读快照；没有快照（老数据 / 还没进过货）才用实时「进货价 × 倍率」算。 */
function dmSuggestOf(d){
  if(!d || !d.n) return '';
  var rs=(d.rates&&typeof d.rates==='object')?d.rates:{};
  var snap=parseFloat(rs.sg);
  if(isFinite(snap) && snap>0) return Math.round(snap*100)/100;
  var cost=null;
  try{ if(typeof Purchase!=='undefined' && Purchase.latestCost) cost=Purchase.latestCost(d.n); }catch(e){ cost=null; }
  if(cost==null){ var b=parseFloat(d.bp); if(isFinite(b)) cost=b; }
  if(cost==null || !isFinite(cost)) return '';
  return Math.round(cost*dmWpRate(d)*100)/100;
}
/* 批发倍率：优先 d.rates.wp；老数据按「批发价 ÷ 进货价」反推；都没有用默认 1.25。
   主规格和子规格共用同一个倍率（同一味药，加价策略一致）。 */
function dmWpRate(d){
  var rs=(d&&d.rates&&typeof d.rates==='object')?d.rates:{};
  var r=parseFloat(rs.wp);
  if(isFinite(r) && r>0) return r;
  var bp0=parseFloat(d&&d.bp), wp0=parseFloat(d&&d.wp);
  if(isFinite(bp0) && bp0 && isFinite(wp0)) return wp0/bp0;
  return (typeof DEF_RATE!=='undefined' && DEF_RATE)?DEF_RATE:1.25;
}
/* ================= 一药多规格：主表 + 子表 =================
   主表（drugs 表一行）：药名 n / 别名 al / 产地 og / 常用量 c
   子表（units jsonb）：规格数组，一条一个「单位」，各自带 零售价 / 批发价 / 进货价 / 库存
   ⚠ 兼容做法：规格 #0 仍是主字段（d.u / d.p / d.wp / d.bp / d.st / d.rates.sg），
      其余规格放 d.un[]。全站计价（findDrug → priceFor）只读主字段，计价链路不受影响。
   ⚠ 库存的持久化：drugs 表没有 stock 列，库存只存在 units jsonb 里，
      所以主单位的库存会在 d.un 里保有一条「同单位镜像」（unit === d.u）。
      这个镜像不占规格位（列表里不会出现两行 g），但写库存时必须同步它，否则刷新就丢。 */
/* 规格枚举：0 = 主规格（u 为 null，值走主字段），1..n = 子规格（u 指向 d.un 里的条目） */
function dmSpecEntries(d){
  var out=[{s:0,u:null}], un=(d&&Array.isArray(d.un))?d.un:[], main=String((d&&d.u)||'g').trim(), k=0;
  for(var i=0;i<un.length;i++){
    var u=un[i]||{};
    if(String(u.unit||'').trim()===main) continue;      /* 主单位镜像：跳过，它只负责存库存 */
    k++; out.push({s:k,u:u});
  }
  return out;
}
function dmSpecsOf(d){
  if(!d) return [];
  var es=dmSpecEntries(d), out=[];
  for(var i=0;i<es.length;i++){
    var e=es[i], u=e.u;
    if(!u){
      out.push({ s:0, unit:(d.u||'g'), amt:(d.c==null?'':d.c), st:(d.st==null?'':d.st), p:(d.p==null?'':d.p),
                 wp:(d.wp==null?'':d.wp), bp:(d.bp==null?'':d.bp), sg:dmSuggestOf(d) });
    }else{
      out.push({ s:e.s, unit:(u.unit||''), amt:(u.amt==null?'':u.amt), st:(u.stock==null?'':u.stock),
                 p:(u.retail==null?'':u.retail), wp:(u.wp==null?'':u.wp),
                 bp:(u.cost==null?'':u.cost), sg:dmSubSuggest(d,u) });
    }
  }
  return out;
}
/* 子规格建议价：有快照读快照，没有就按「进货价 × 批发倍率」实时算 */
function dmSubSuggest(d,u){
  if(!u) return '';
  var sg=parseFloat(u.sg);
  if(isFinite(sg) && sg>0) return Math.round(sg*100)/100;
  var c=parseFloat(u.cost);
  if(!isFinite(c)) return '';
  return Math.round(c*dmWpRate(d)*100)/100;
}
/* 规格下标 → 子表条目（0 = 主规格，返回 null） */
function dmSpecAt(d,s){
  if(!d || !(s>0)) return null;
  var es=dmSpecEntries(d);
  return (es[s]||{}).u||null;
}
/* 主单位库存的镜像条目：有就返回，没有就建一条（云端只认 units 里的库存） */
function dmMainMirror(d, create){
  if(!d) return null;
  var main=String(d.u||'g').trim()||'g';
  if(!Array.isArray(d.un)) d.un=[];
  for(var i=0;i<d.un.length;i++){
    if(String((d.un[i]||{}).unit||'').trim()===main) return d.un[i];
  }
  if(!create) return null;
  var rec={unit:main, stock:(d.st==null?'':d.st), cost:(d.bp==null?'':d.bp), retail:'', daily:'', wp:'', sg:''};
  d.un.push(rec);
  return rec;
}
/* 单元格取值 / 存值：f 用统一字段名（c/u/p/wp/bp/st），内部自动分派主规格 or 子规格。
   常用量 c 也按规格独立：主规格读 d.c，子规格读该条的 amt（一个规格一个常用量）。 */
function dmCellVal(d,f,s){
  if(!d) return '';
  var sp=dmSpecAt(d,s);
  if(f==='c')  return sp?(sp.amt==null?'':sp.amt):(d.c==null?'':d.c);
  if(f==='u')  return sp?(sp.unit||''):(d.u||'g');
  if(f==='p')  return sp?(sp.retail==null?'':sp.retail):(d.p==null?'':d.p);
  if(f==='wp') return sp?(sp.wp==null?'':sp.wp):(d.wp==null?'':d.wp);
  if(f==='bp') return sp?(sp.cost==null?'':sp.cost):(d.bp==null?'':d.bp);
  if(f==='st') return sp?(sp.stock==null?'':sp.stock):(d.st==null?'':d.st);
  if(f==='sg') return sp?dmSubSuggest(d,sp):dmSuggestOf(d);
  return (d[f]==null?'':d[f]);
}
function dmCellSet(d,f,s,v){
  if(!d) return;
  var sp=dmSpecAt(d,s);
  if(f==='c') { if(sp) sp.amt=v; else d.c=v; return; }
  if(f==='u') { if(sp) sp.unit=v; else d.u=v; return; }
  if(f==='p') { if(sp) sp.retail=v; else d.p=v; return; }
  if(f==='wp'){ if(sp) sp.wp=v; else d.wp=v; return; }
  if(f==='bp'){ if(sp) sp.cost=v; else { d.bp=v; var mm=dmMainMirror(d,false); if(mm) mm.cost=v; } return; }
  if(f==='st'){ if(sp) sp.stock=v; else { d.st=v; var m2=dmMainMirror(d,true); if(m2) m2.stock=v; } return; }
  d[f]=v;
}
/* 改主单位名 → 镜像条目跟着改名（否则刷新后多出一条旧单位规格） */
function dmRenameMainUnit(d, oldU, newU){
  if(!d || !newU) return;
  var un=Array.isArray(d.un)?d.un:[], o=String(oldU||'').trim();
  for(var i=0;i<un.length;i++){
    if(String((un[i]||{}).unit||'').trim()===o && o!==newU){ un[i].unit=newU; break; }
  }
  d.u=newU;
  dmMainMirror(d,true);
}
/* 规格归一：单位去空格、重复单位只留一条、空单位条目丢掉；主单位库存以镜像为准（镜像才是云端存的）。加载时跑一遍 */
function dmNormalizeSpecs(d){
  if(!d) return d;
  d.u=String(d.u||'g').trim()||'g';
  var main=String(d.u), un=Array.isArray(d.un)?d.un:[], out=[], seen={}, mirror=null;
  for(var i=0;i<un.length;i++){
    var u=un[i]||{}, ut=String(u.unit||'').trim();
    if(!ut) continue;
    u.unit=ut;
    if(ut===main){ if(!mirror) mirror=u; continue; }
    if(seen[ut]) continue;
    seen[ut]=1; out.push(u);
  }
  if(mirror){
    if(mirror.stock!=='' && mirror.stock!=null) d.st=String(mirror.stock);
    if((d.bp===''||d.bp==null) && mirror.cost!=='' && mirror.cost!=null) d.bp=String(mirror.cost);
    out.push(mirror);                       /* 镜像仍留在 d.un 里：库存要靠它存回云端 */
  }
  d.un=out;
  return d;
}
/* 同名药拦截：返回已存在的另一条记录下标，没有则 -1（2026-10-30 用户要求禁止建两个同名药） */
function dmNameTaken(name, exceptIdx){
  var nm=String(name||'').trim().toLowerCase();
  if(!nm) return -1;
  for(var i=0;i<drugsList.length;i++){
    if(i===exceptIdx) continue;
    var d=drugsList[i]; if(!d) continue;
    if(String(d.n||'').trim().toLowerCase()===nm) return i;
  }
  return -1;
}
/* 建议价快照：进货价变动时按当前批发倍率重算（cost 为空 → 不写，返回原值） */
function dmSetSuggest(d, cost){
  if(!d) return;
  var c=parseFloat(cost);
  if(!isFinite(c) || c<=0) return;
  var rs=(d.rates&&typeof d.rates==='object')?d.rates:{};
  var r=parseFloat(rs.wp);
  if(!isFinite(r)){
    var bp0=parseFloat(d.bp), wp0=parseFloat(d.wp);
    if(isFinite(bp0) && bp0 && isFinite(wp0)) r=wp0/bp0;
  }
  if(!isFinite(r)) r=(typeof SET!=='undefined' && SET && parseFloat(SET.rate)) || 1.5;
  d.rates=rs; d.rates.wp=Math.round(r*10000)/10000;
  d.rates.sg=Math.round(c*r*100)/100;
}
var DM_RO={sg:1};
function renderTabs(){
  /* 只保留「中药」一个分类（2026-10-07 用户要求：删除中药颗粒/穴位/西成药/收费项目/用法）
     2026-10-28：只剩一个分类，页签本身已从页面移除 —— 容器不存在就直接跳过。 */
  var box=$('dmTabs'); if(!box) return;
  var cats=['中药'], h='';
  for(var i=0;i<cats.length;i++) h+='<button data-tab="'+cats[i]+'" class="'+(dmCurTab===cats[i]?'on':'')+'">'+cats[i]+'</button>';
  $('dmTabs').innerHTML=h;
}
/* 按药名排序：优先拼音（等同 A-Z 字母顺序），无拼音时按中文原名排。
   localeCompare('zh') 让中文按拼音字典序，英文按字母序。 */
function dmSortRows(list){
  return list.sort(function(a,b){
    /* 「+ 添加」新建的空行（__new）统一排到最后。
       2026-10-08 用户要求：有搜索结果时新行要「紧跟最后一条搜索结果」，
       没有搜索结果时就是「全部列表底部」—— 两种情况都落在末尾，所以不需要按位置 splice，
       只靠这条排序规则即可（也避免了插到中间导致后面所有 data-i 错位的老坑）。
       sort 自 ES2019 起是稳定排序，多个新行按点「添加」的先后顺序排列。 */
    var an=!!(a.d&&(a.d.__new||a.d.__fresh)), bn=!!(b.d&&(b.d.__new||b.d.__fresh));
    if(an!==bn) return an?1:-1;
    var pa=String((a.d&&a.d.py)||'').toLowerCase();
    var pb=String((b.d&&b.d.py)||'').toLowerCase();
    var na=String((a.d&&a.d.n)||'');
    var nb=String((b.d&&b.d.n)||'');
    if(pa&&pb&&pa!==pb) return pa<pb?-1:1;      /* 都有拼音 → 按拼音=A-Z */
    if(pa&&!pb) return -1;                        /* 有拼音的排前面 */
    if(!pa&&pb) return 1;
    return na.localeCompare(nb,'zh-Hans-CN');     /* 都没拼音 → 中文按拼音序*/
  });
}
function dmMatchFilter(d,f){
  if(!f) return true;
  /* __new = 刚点「添加」的空行；__fresh = 本次会话里刚新增的行。
     两者都跳过搜索过滤，免得新行一填完药名就从列表里「消失」，
     用户以为没保存成功。__fresh 在用户再次改搜索词时清掉（见 dmSearch 的 input 事件）。 */
  if(d.__new||d.__fresh) return true;
  /* 搜索范围：药名 + 拼音 + 别名 + 产地（别名如「麻黄」也能搜到艾草黄） */
  var al=Array.isArray(d.al)?d.al.join(' '):'';
  var hay=((d.n||'')+' '+(d.py||'')+' '+al+' '+(d.og||'')).toLowerCase();
  return hay.indexOf(f)>-1;
}
function dmRows(){
  var f=dmFilter.toLowerCase(), out=[];
  for(var i=0;i<drugsList.length;i++){
    var d=drugsList[i];
    if((d.cat||'')!==dmCurTab) continue;
    if(!dmMatchFilter(d,f)) continue;
    out.push({i:i,d:d});
  }
  return dmSortRows(out);   /* A-Z 排序（2026-10-07 用户要求），__new 行排在末尾 */
}
/* 渲染药物表：一味药 = 一组行（主规格 + 各子规格），组尾一条「＋ 添加新规格」。
   列序：药物名称 | 常用量 | 单位 | 零售价 | 批发价 | 进货价 | 建议价 | 库存量 | 产地 | 操作
   主表字段（药名 / 常用量 / 产地 / 操作）用 rowspan 跨整组，子表字段一规格一行。 */
function renderDrugTable(){
  var rows=dmRows(), h='';
  for(var r=0;r<rows.length;r++){
    var idx=rows[r].i, d=rows[r].d, specs=dmSpecsOf(d), n=specs.length||1;
    var sel=selDrugRow===idx;
    if(!n) continue;
    for(var s=0;s<n;s++){
      var sp=specs[s]||{}, gv=(sp.sg===0?'':sp.sg), wv=sp.wp, bv=sp.bp;
      /* 批发价低于建议价 → 橙色加粗（批价压得比建议价还低，一眼看出来） */
      var low=(wv!=='' && gv!=='' && isFinite(parseFloat(wv)) && isFinite(parseFloat(gv)) &&
               parseFloat(wv)<parseFloat(gv)-1e-9);
      h+='<tr data-i="'+idx+'" data-s="'+s+'" class="dm-sprow'+(sel?' sel':'')+(s>0?' dm-subrow':'')+'">';
      if(s===0){
        h+='<td class="c-nm" data-f="n" rowspan="'+n+'"><div class="dm-nmrow">'
          +'<span>'+esc(d.n||'')+'</span>'
          +(n>1?'<i class="dm-multi" title="这味药有 '+n+' 个规格">多规格</i>':'')
          +'<button type="button" class="dm-addspec" data-i="'+idx+'" title="为这味药再加一个规格（盒 / 个 / 斤…）">＋ 添加规格</button>'
          +'</div></td>';
      }
      /* 常用量：每个规格各一格，跟 单位/规格 同行同序（不再 rowspan 共用第一行） */
      h+='<td class="c-amt" data-f="c" data-s="'+s+'"><span>'+esc(sp.amt==null?'':sp.amt)+'</span></td>'
        +'<td class="c-u" data-f="u" data-s="'+s+'"><span>'+esc(sp.unit||'')
        +(s>0?'<b class="dm-specdel" data-del="'+idx+'" data-s="'+s+'" title="删除这个规格">×</b>':'')
        +'</span></td>'
        +'<td class="c-money c-bold" data-f="p" data-s="'+s+'"><span>'+esc(sp.p==null?'':sp.p)+'</span></td>'
        +'<td class="c-money c-bold'+(low?' c-low':'')+'" data-f="wp" data-s="'+s+'"><span>'+esc(wv==null?'':wv)+'</span></td>'
        +'<td class="c-money" data-f="bp" data-s="'+s+'"><span>'+esc(bv==null?'':bv)+'</span></td>'
        +'<td class="c-money c-ro" data-f="sg" data-s="'+s+'" title="最新进货价 × 批发倍率（进货单保存后自动更新；改批发价不影响）"><span>'+esc(gv==null?'':gv)+'</span></td>'
        +'<td class="c-st" data-f="st" data-s="'+s+'"><span>'+esc(sp.st==null?'':sp.st)+'</span></td>';
      if(s===0){
        h+='<td class="c-og" data-f="og" rowspan="'+n+'"><span>'+esc(d.og||'')+'</span></td>'
          +'<td class="c-act" rowspan="'+n+'">'
          +'<button type="button" class="dm-rowbtn" data-act="detail" data-i="'+idx+'">详情</button>'
          +'<button type="button" class="dm-rowbtn del" data-act="del" data-i="'+idx+'">删除</button>'
          +'</td>';
      }
      h+='</tr>';
    }
  }
  $('dmBody').innerHTML=h||'<tr><td colspan="10" style="padding:0!important;border:none!important">'+rxEmptyHTML(
        '药物库是空的','点上方「添加」录入第一味药，之后会自动划价与计价')+'</td></tr>';
  var nspec=0;
  for(var q=0;q<rows.length;q++){ nspec+=dmSpecsOf(rows[q].d).length; }
  $('dmStat').textContent='中药：'+rows.length+' 味 / '+nspec+' 个规格 / 共 '+drugsList.length+' 味';
  if(window.__dmHoverReset) window.__dmHoverReset();   /* 重绘后行元素全换了，悬停缓存要清掉 */
}
/* 组尾「＋ 添加新规格」：在当前药下加一个空规格行，并直接进入单位编辑 */
function dmAddSpec(idx){
  var d=drugsList[idx]; if(!d) return;
  if(!Array.isArray(d.un)) d.un=[];
  d.un.push({unit:'', amt:'', stock:'', cost:'', retail:'', daily:'', wp:'', sg:''});
  saveDrugsLS(); renderDrugTable();
  var s=dmSpecsOf(d).length-1;
  var tr=$('dmBody').querySelector('tr[data-i="'+idx+'"][data-s="'+s+'"]');
  if(!tr) return;
  try{ tr.scrollIntoView({block:'center'}); }catch(e){}
  var td=tr.querySelector('td[data-f="u"]');
  if(td) dmStartEdit(td,tr);
  toast('已为「'+(d.n||'')+'」新增规格，填个单位（盒 / 个 / 斤…）');
}
/* 子规格行上的「×」：删掉这一条规格（库存一起删） */
function dmDelSpec(idx, s){
  var d=drugsList[idx]; if(!d) return;
  var u=dmSpecAt(d,s); if(!u) return;
  var ut=String(u.unit||''), qty=String(u.stock==null?'':u.stock);
  if(!confirm('删除「'+(d.n||'')+'」的「'+ut+'」规格？\n该规格库存 '+(qty===''?'0':qty)+' '+ut+' 会一起删掉。')) return;
  var k=d.un.indexOf(u);
  if(k>=0) d.un.splice(k,1);
  saveDrugsLS(); renderDrugTable();
  toast('已删除规格「'+ut+'」');
}
function openDrugMaint(){ navGo('drug'); }
/* ============ 药物管理：独立页 + 详情抽屉 ============
   详情抽屉编辑：产地 / 别名 / 三档价格（含「建议价格」）/ 多单位 / 进货价历史。
   ⚠ 这些增强字段（daily_price/origin/aliases/units）依赖 supabase_new_tables.sql，
      未执行该 SQL 时云端 upsert 会因未知列报错（已被捕获提示，本机不受影响）。 */
/* ---------- 药物详情：售价历史 ----------
   数据来源：本机已存处方（SAVED）的 px 字段（与药味一一对应的成交单价）。
   m 是一整串药味文字，先按 2 个以上空格切成单味，取首词以药名主体开头的那些行。 */
function dmBaseName(name){ return String(name||'').replace(/[（(\[【{].*$/,'').trim(); }
function dmSaleScan(d){
  var base=dmBaseName(d&&d.n);
  if(!base) return [];
  var sales=[], list=SAVED;
  if(!list||!list.length) return sales;
  for(var i=0;i<list.length;i++){
    var r=list[i]; if(!r) continue;
    var m=String(r.m||''); if(m.indexOf(base)<0) continue;
    var parts=m.split(/\s{2,}/), at=-1;
    for(var p=0;p<parts.length;p++){
      var toks=parts[p].split(/\s+/);
      if(toks.length && toks[0].indexOf(base)===0){ at=p; break; }
    }
    if(at<0 || !r.px) continue;
    var px=String(r.px).split('|');
    if(px[at]!=null && px[at]!=='' && px[at]!=='-'){
      sales.push({dt:String(r.tm||r.dt||''), guest:r.n||'—', p:px[at]});
    }
  }
  return sales;
}
function ddLoadSaleLog(d){
  var saleBox=$('ddSaleLog'); if(!saleBox) return;
  var sales=dmSaleScan(d);
  function render(list){
    if(!list.length){ saleBox.innerHTML='<div class="dd-empty">暂无成交记录（发药后的成交价与导入的历史价都会显示在这里）</div>'; return; }
    var hs='<table><thead><tr><th>日期</th><th>客人</th><th style="text-align:right">成交单价</th></tr></thead><tbody>';
    var n1=Math.min(list.length,30);
    for(var i=0;i<n1;i++){ var x=list[i];
      hs+='<tr><td>'+esc(x.dt)+'</td><td>'+esc(x.guest)+'</td><td class="num">'+esc(x.p)+'</td></tr>';
    }
    saleBox.innerHTML=hs+'</tbody></table>';
  }
  /* 本机处方 + 云端 price_logs（发药成交 / 历史计划单导入）合并展示 */
  var name=String((d&&d.n)||'').trim();
  if(!SUPA.on || !name){ render(sales); return; }
  SUPA.q('price_logs?select=doctor,drug,to_price,created_at&drug=eq.'+encodeURIComponent(name)+'&order=created_at.desc&limit=50')
    .then(function(rows){
      for(var i=0;i<(rows||[]).length;i++){
        var r=rows[i];
        sales.push({dt:String(r.created_at||'').slice(0,10), guest:r.doctor||'—', p:r.to_price});
      }
      sales.sort(function(a,b){ return String(b.dt||'') > String(a.dt||'') ? 1 : -1; });
      render(sales);
    })
    .catch(function(){ render(sales); });
}

/* =========================================================
   药物详情：中药分类（来源 + 药用部位）
   两级组织，二级选项可搜索过滤。
   识别规则：药名在下表能命中（自动剥掉「炙/炒/醋/酒/制/生…」等炮制前缀）
   → 自动填默认分类；命中不了（如本店的「艾草黄」）→ 留空，由用户手动选，
   不做强制校验。
   ========================================================= */
var TC_TREE=[
  {g:'植物类',items:['根及根茎类','块根类','块茎类','茎木类','皮类','叶类','花类','果实类','种子类','全草类','菌藻类']},
  {g:'动物类',items:['动物胶类','昆虫类','贝壳类','角骨类','其他动物类']},
  {g:'矿物类',items:['矿物类']},
  {g:'加工品类',items:['加工品']}
];
var TC_DICT_SRC={
  '根及根茎类':'人参 红参 白参 党参 太子参 西洋参 高丽参 黄芪 甘草 白术 苍术 当归 川芎 白芍 赤芍 丹参 紫丹参 玄参 苦参 沙参 北沙参 南沙参 桔梗 柴胡 银柴胡 防风 羌活 独活 白芷 藁本 细辛 葛根 粉葛 柴葛根 升麻 前胡 白前 紫菀 龙胆 威灵仙 白头翁 板蓝根 黄芩 黄连 大黄 巴戟天 肉苁蓉 锁阳 淫羊藿 仙茅 狗脊 骨碎补 续断 牛膝 川牛膝 土茯苓 萆薢 芦根 白茅根 苎麻根 山豆根 北豆根 秦艽 防己 徐长卿 知母 远志 白蔹 三棱 莪术 姜黄 香附 木香 虎杖 常山 甘遂 商陆 乌药 天葵子 黄精 玉竹 土贝母 川贝母 浙贝母 平贝母 白薇 白前 高良姜 干姜 紫草 白芷 苦楝根 岗梅根 岗梅',
  '块根类':'麦冬 麦门冬 天冬 天门冬 百部 地黄 生地 熟地 熟地黄 何首乌 生首乌 白首乌 郁金 川乌 草乌 附子 天葵 白头翁 威灵仙 甘薯 参薯',
  '块茎类':'半夏 天南星 白附子 天麻 山药 泽泻 元胡 延胡索 白及 百合 薤白 山慈菇 魔芋 黄独 白芨 贝母',
  '茎木类':'桂枝 桑枝 苏木 降香 沉香 檀香 木通 川木通 通草 小通草 鸡血藤 大血藤 忍冬藤 钩藤 络石藤 海风藤 青风藤 夜交藤 首乌藤 皂角刺 紫苏梗 荆芥穗 桑寄生 槲寄生 木贼 鬼箭羽 丁公藤 宽筋藤 竹茹 天仙藤 油松节 苏梗 桂枝尖',
  '皮类':'杜仲 厚朴 黄柏 关黄柏 牡丹皮 丹皮 地骨皮 桑白皮 肉桂 官桂 五加皮 秦皮 白鲜皮 苦楝皮 椿皮 合欢皮 海桐皮 紫荆皮 茯苓皮 生姜皮 姜皮 大腹皮 冬瓜皮 梓白皮 石榴皮 橘红 化橘红 香加皮 救必应',
  '叶类':'艾叶 桑叶 荷叶 紫苏叶 枇杷叶 侧柏叶 淡竹叶 竹叶 番泻叶 银杏叶 罗布麻叶 功劳叶 大青叶 淫羊藿 石韦 棕榈叶 龙脷叶',
  '花类':'金银花 忍冬花 菊花 野菊花 红花 西红花 番红花 槐花 槐米 辛夷 辛夷花 丁香 公丁香 玫瑰花 月季花 旋覆花 密蒙花 芫花 款冬花 冬花 蒲黄 鸡冠花 凌霄花 合欢花 厚朴花 葛花 扁豆花 玉米须 夏枯草 莲须 松花粉 木棉花 素馨花',
  '果实类':'五味子 山楂 木瓜 陈皮 青皮 枳实 枳壳 佛手 香橼 砂仁 白豆蔻 豆蔻 草豆蔻 草果 益智仁 枸杞 枸杞子 女贞子 栀子 连翘 川楝子 山茱萸 山萸肉 乌梅 诃子 芡实 龙眼肉 桂圆 大枣 红枣 吴茱萸 花椒 川椒 胡椒 白胡椒 荜茇 覆盆子 金樱子 桑椹 桑葚 瓜蒌 瓜蒌皮 瓜蒌仁 蔓荆子 苍耳子 地肤子 蛇床子 石榴 八角 八月札 白果 罗汉果 胖大海 无花果 阳春砂 春砂仁 豆蔻壳',
  '种子类':'决明子 菟丝子 沙苑子 车前子 牛蒡子 王不留行 莱菔子 紫苏子 白芥子 葶苈子 牵牛子 使君子 槟榔 苦杏仁 桃仁 郁李仁 火麻仁 柏子仁 酸枣仁 莲子 薏苡仁 白扁豆 黑芝麻 葫芦巴 韭菜子 韭子 谷芽 麦芽 稻芽 绿豆 赤小豆 冬瓜子 甜瓜子 南瓜子 白花菜子 大枫子 鸦胆子 郁李 蕤仁 楮实子 茺蔚子',
  '全草类':'麻黄 薄荷 荆芥 紫苏 藿香 佩兰 香薷 蒲公英 紫花地丁 益母草 泽兰 车前草 金钱草 广金钱草 半边莲 半枝莲 马齿苋 鱼腥草 败酱草 白花蛇舌草 穿心莲 青蒿 茵陈 大蓟 小蓟 仙鹤草 地锦草 老鹳草 豨莶草 臭梧桐 灯心草 卷柏 马鞭草 透骨草 伸筋草 鹅不食草 金牛草 鸡骨草 积雪草 旱莲草 墨旱莲 刘寄奴 北刘寄奴 寻骨风 白英 龙葵 浮萍 矮地茶 肿节风 白花丹 走马胎 白背桐 石见穿 半边旗 落地生根 地耳草 田基黄 虎耳草 猫爪草 筋骨草 飞天蠄蟧',
  '菌藻类':'茯苓 茯神 猪苓 灵芝 冬虫夏草 海藻 昆布 银耳 桑黄 雷丸 马勃 竹荪 云芝 蝉花 金蝉花',
  '动物胶类':'阿胶 鹿角胶 龟甲胶 鳖甲胶 黄明胶 新阿胶 猪皮胶 鹿胎胶',
  '昆虫类':'全蝎 蜈蚣 地龙 僵蚕 白僵蚕 蝉蜕 土鳖虫 水蛭 虻虫 斑蝥 桑螵蛸 蜂房 蜂蜜 蜂王浆 蚕沙 蚕砂 九香虫 蝼蛄 蛴螬 五倍子 鸡内金 蝉花 虻 蝎尾',
  '贝壳类':'石决明 珍珠母 牡蛎 瓦楞子 蛤壳 海蛤壳 海螵蛸 珍珠 紫贝齿 砗磲 海螺蛸 蚝壳',
  '角骨类':'鹿茸 鹿角 鹿角霜 龟甲 龟板 鳖甲 穿山甲 羚羊角 水牛角 牛角 犀角 虎骨 豹骨 猪蹄甲 鹿筋 鹿鞭',
  '其他动物类':'紫河车 蛇蜕 乌梢蛇 白花蛇 蕲蛇 金钱白花蛇 海马 海龙 蛤蚧 壁虎 守宫 地龙 蛴螬 紫梢花 海狗肾 狗肾 猪脾 牛黄 人工牛黄 熊胆 麝香 蟾酥 哈蟆油 燕窝',
  '矿物类':'石膏 煅石膏 寒水石 磁石 代赭石 赭石 赤石脂 滑石 芒硝 玄明粉 龙骨 龙齿 朱砂 辰砂 雄黄 硫黄 白矾 硼砂 炉甘石 阳起石 禹余粮 紫石英 白石英 自然铜 铅丹 琥珀 玛瑙 云母 浮石 海浮石 胆矾 轻粉 皂矾 钟乳石 花蕊石 金礞石 青礞石 密陀僧 玄精石 伏龙肝 无名异 赤石 白石脂',
  '加工品':'神曲 建曲 六神曲 红曲 半夏曲 沉香曲 胆南星 淡豆豉 大豆黄卷 青黛 冰片 竹沥 阿胶珠 焦三仙 炮姜 血余炭 人中白 人中黄 焦神曲 炒神曲 陈曲 麦芽曲 霞天曲 姜汁 竹沥水'
};
var TC_BY_NAME={};
(function(){
  for(var k in TC_DICT_SRC){
    var arr=String(TC_DICT_SRC[k]).split(/\s+/);
    for(var i=0;i<arr.length;i++){ var w=arr[i]; if(w && !TC_BY_NAME[w]) TC_BY_NAME[w]=k; }
  }
})();
/* 常见别名 / 规格写法（药名比词典多了品牌、产地、规格前缀时的兜底） */
(function(){
  var alias={
    '根及根茎类':'三七 田七 三七粉 北柴胡 南柴胡 柴胡头 穿山龙 穿破石 菝葜 白头翁 白芷 独活 羌活 前胡 生姜 干姜 甘松 地榆 地榆炭 刺五加',
    '块根类':'川贝 浙贝 平贝 麦冬 大川麦冬 天冬 生地 熟地 何首乌',
    '块茎类':'半夏 法半夏 姜半夏 清半夏 白及 天麻 山药 炒好山药',
    '茎木类':'半枫荷 柽柳 桑枝 桂枝 鸡血藤',
    '皮类':'椿根皮 海桐皮 杜仲 厚朴 黄柏',
    '叶类':'薄荷叶 布渣叶 侧柏叶 艾叶 桑叶',
    '花类':'藏红花 白丁香 辛夷 金银花 菊花',
    '果实类':'蒺藜 白蒺藜 刺蒺藜 荜澄茄 毕澄茄 五味子 砂仁 炒小茴香',
    '种子类':'薏仁 薏米 炒薏仁 杏仁 炒杏仁 草决明 巴豆 补骨脂 炒牛子 炒苏子 覆盆子 大覆盆子 浮小麦 冬葵子 榧子 刀豆',
    '全草类':'垂盆草 萹蓄 葱白 薄荷 鹅不食草 地丁 凤尾草 冬凌草 独脚金 风流果',
    '菌藻类':'虫草花 赤茯苓 炒茯苓卷 茯苓 灵芝',
    '昆虫类':'五倍子 蚕沙 蝉蜕',
    '其他动物类':'五灵脂 炒五灵脂 刺猬皮 蟾蜍 紫河车',
    '矿物类':'石膏 龙骨 牡蛎',
    '加工品':'薄荷冰 薄荷脑 安息香 乳香 没药 血竭 儿茶 芦荟 青黛 冰片'
  };
  for(var k in alias){
    if(!TC_BY_NAME[k]) continue;                 /* 只补已存在的分类，避免拼错造出野分类 */
    var arr=String(alias[k]).split(/\s+/);
    for(var i=0;i<arr.length;i++){ var w=arr[i]; if(w && !TC_BY_NAME[w]) TC_BY_NAME[w]=k; }
  }
})();
/* 兜底：名字里含词典词（如「大川麦冬」含「麦冬」）按最长词命中 */
var TC_KEYS=(function(){ var a=[]; for(var k in TC_BY_NAME) a.push(k); a.sort(function(x,y){ return y.length-x.length; }); return a; })();
/* 炮制前缀 / 形态后缀：识别前先剥掉，再查表 */
var TC_PROC=/^(麸炒|土炒|清炒|砂炒|蜜炙|酒炙|醋炙|盐炙|姜炙|姜制|酒制|醋制|蜜制|清水|炙|炒|生|制|醋|酒|盐|蜜|姜|煅|焦|煨|蒸|烫|法|清|鲜|干)/;
var TC_TAIL=/[片丝条粉末炭块]$/;
function tcGuess(name){
  var s=String(name||'').replace(/[\[［{【（(].*$/,'').trim();   /* 去掉 [先煎] / {…} / （规格） 等尾巴 */
  if(!s) return '';
  if(TC_BY_NAME[s]) return TC_BY_NAME[s];
  var t=s,g=0;
  while(g++<4){
    var m=t.match(TC_PROC); if(!m) break;
    t=t.slice(m[0].length);
    if(TC_BY_NAME[t]) return TC_BY_NAME[t];
  }
  if(TC_TAIL.test(t)){
    var t2=t.replace(TC_TAIL,'');
    if(TC_BY_NAME[t2]) return TC_BY_NAME[t2];
  }
  /* 兜底：名字里包含某个词条（取最长命中），如「大川麦冬」「阿胶福牌」 */
  for(var i=0;i<TC_KEYS.length;i++){
    var k=TC_KEYS[i];
    if(t.length>k.length && t.indexOf(k)>=0) return TC_BY_NAME[k];
  }
  return '';
}
function tcAll(){ var a=[]; for(var i=0;i<TC_TREE.length;i++){ var g=TC_TREE[i]; for(var j=0;j<g.items.length;j++) a.push({g:g.g,n:g.items[j]}); } return a; }
function tcInTree(v){ var a=tcAll(); for(var i=0;i<a.length;i++){ if(a[i].n===v) return true; } return false; }

/* ---------- 中药分类：可搜索下拉 ---------- */
var _tcAct=-1;
function tcGet(){ return String(($('ddTc')&&$('ddTc').value)||'').trim(); }
function tcTip(txt,warn){
  var el=$('ddTcTip'); if(!el) return;
  el.textContent=txt||'';
  el.className='dd-tip'+(warn?' warn':'');
}
function tcSetVal(v,tipText){
  var inp=$('ddTc'); if(!inp) return;
  inp.value=v||'';
  if(tipText!==undefined){ tcTip(tipText,false); return; }
  if(!v) tcTip('未填（可不填，不影响保存）',false);
  else if(!tcInTree(v)) tcTip('旧分类「'+v+'」，可重新选择',false);
  else tcTip('',false);
}
function tcRender(q){
  var box=$('ddTcList'); if(!box) return;
  q=String(q||'').trim().toLowerCase();
  var cur=tcGet(), h='', n=0;
  for(var i=0;i<TC_TREE.length;i++){
    var g=TC_TREE[i], rows=[];
    for(var j=0;j<g.items.length;j++){
      var it=g.items[j];
      if(q && it.toLowerCase().indexOf(q)<0 && g.g.toLowerCase().indexOf(q)<0) continue;
      rows.push(it);
    }
    if(!rows.length) continue;
    h+='<div class="dd-cg">'+esc(g.g)+'</div>';
    for(var k=0;k<rows.length;k++){
      h+='<div class="dd-ci" data-v="'+esc(rows[k])+'"><span>'+esc(rows[k])+'</span>'
        +(cur===rows[k]?'<span class="chk">✓</span>':'')+'</div>';
      n++;
    }
  }
  box.innerHTML=h||'<div class="dd-cnone">没有匹配的分类，可直接留空</div>';
  _tcAct=-1;
}
function tcPlace(){
  /* 弹窗 body 是滚动容器，下拉若用 absolute 会被裁掉 → 改成 fixed 定位贴在输入框下方 */
  var inp=$('ddTc'), list=$('ddTcList');
  if(!inp||!list) return;
  var r=inp.getBoundingClientRect();
  var below=window.innerHeight-r.bottom-12, above=r.top-12;
  var h=Math.min(232, Math.max(140, Math.max(below, above)));
  list.style.width=r.width+'px';
  list.style.left=r.left+'px';
  list.style.maxHeight=h+'px';
  if(below>=h || below>=above){ list.style.top=(r.bottom+4)+'px'; }
  else { list.style.top=(r.top-h-4)+'px'; }
}
function tcOpen(){ tcRender(''); var b=$('ddTcList'); if(b){ tcPlace(); b.classList.add('on'); } }
function tcClose(){ var b=$('ddTcList'); if(b) b.classList.remove('on'); _tcAct=-1; }
function tcMove(step){
  var box=$('ddTcList'); if(!box) return;
  var its=box.querySelectorAll('.dd-ci'); if(!its.length) return;
  if(_tcAct>=0 && its[_tcAct]) its[_tcAct].classList.remove('act');
  _tcAct=(_tcAct+step+its.length)%its.length;
  its[_tcAct].classList.add('act');
  try{ its[_tcAct].scrollIntoView({block:'nearest'}); }catch(e){}
}
function tcPick(v){ tcSetVal(v); tcClose(); var inp=$('ddTc'); if(inp) inp.blur(); }

/* ---------- 底部提示条 ---------- */
function ddMsgBox(txt){
  var e=$('ddMsg'); if(!e) return;
  if(!txt){ e.style.display='none'; e.textContent=''; return; }
  e.style.display=''; e.textContent=txt;
}
function ddBadClear(){
  ['ddName','ddBp','ddWp','ddP'].forEach(function(id){
    var el=$(id); if(!el) return;
    var box=el.closest('.dd-pin'); (box||el).classList.remove('bad');
  });
}
function ddBadMark(ids){
  ddBadClear();
  ids.forEach(function(id){
    var el=$(id); if(!el) return;
    var box=el.closest('.dd-pin'); (box||el).classList.add('bad');
  });
}

var Drug=(function(){
  var curIdx=-1;
  function ensure(){ try{ renderTabs(); renderDrugTable(); }catch(e){ console.warn('Drug.ensure', e); } }
  function openDetail(idx){
    var i=(idx==null)?selDrugRow:idx;
    if(i<0 || !drugsList[i]){ toastErr('先点一行，再点「详情」'); return; }
    var d=drugsList[i]; if(!d) return;
    selDrugRow=i; curIdx=i;
    /* 核心信息区 */
    $('ddName').value=d.n||'';
    $('ddBp').value=(d.bp==null?'':d.bp);
    $('ddWp').value=(d.wp==null?'':d.wp);
    $('ddP').value=(d.p==null?'':d.p);
    $('ddPUnit').textContent=d.u||'g';
    /* 每个价格各自的倍率（按已存倍率回填；旧数据按「价格 ÷ 进货价」反推） */
    $('ddRateP').value=rateOf('p', d);
    $('ddRateWp').value=rateOf('wp', d);
    /* 批发价 / 零售价缺省时，按各自的倍率×进货价算出（已有值则保留） */
    if(String($('ddWp').value||'').trim()==='' && String($('ddBp').value||'').trim()!==''){ applyRate('wp'); }
    /* 次要信息区 */
    $('ddUnit').value=d.u||'g';
    $('ddAmount').value=d.c||'';
    $('ddPy').value=d.py||'';
    $('ddDw').value=d.dw||'';
    $('ddOrigin').value=d.og||'';
    $('ddAlias').value=Array.isArray(d.al)?d.al.join(' '):'';
    /* 中药分类：已有值原样回填；空值才尝试按药名识别，识别不到就留空 */
    var tcV=String(d.tc||'').trim(), hit='';
    if(!tcV){ var g=tcGuess(d.n); if(g){ tcV=g; hit='已按药名自动识别，可修改'; } }
    if(hit) tcSetVal(tcV, hit); else tcSetVal(tcV);
    $('ddMore').open=false;
    $('ddMore').scrollTop=0;
    ddBadClear(); ddMsgBox('');
    ddRenderUnits(d.un||[]);
    ddLoadCostLog(d.n);
    ddLoadSaleLog(d);
    ddRenderGuest(d);
    ddMarkLow();
    $('mDrugDetail').classList.add('on');
    var body=$('mDrugDetail').querySelector('.body'); if(body) body.scrollTop=0;
    setTimeout(function(){ try{ $('ddName').focus(); }catch(e){} },60);
  }
  function ddRenderUnits(units){
    /* 主单位是规格 #1（在核心信息里编），它的库存镜像条目不在「多单位」里重复列出来 */
    var h='', main=String((drugsList[curIdx]||{}).u||'g').trim(), n=0;
    for(var i=0;i<units.length;i++){ var u=units[i];
      if(String(u.unit||'').trim()===main) continue;
      n++;
      h+='<div class="dd-unit" data-i="'+i+'">'
        +'<input class="u-name" data-f="unit" value="'+esc(u.unit||'')+'">'
        +'<input class="u-num" data-f="stock" placeholder="库存" value="'+(u.stock==null?'':u.stock)+'">'
        +'<input class="u-num" data-f="cost" placeholder="进货价" value="'+(u.cost==null?'':u.cost)+'">'
        +'<input class="u-num" data-f="retail" placeholder="零售价" value="'+(u.retail==null?'':u.retail)+'">'
        +'<input class="u-num" data-f="daily" placeholder="日常价" value="'+(u.daily==null?'':u.daily)+'">'
        +'<span class="xu" data-del="'+i+'" data-u="'+esc(u.unit||'')+'">✕</span></div>';
    }
    $('ddUnits').innerHTML=h||'<div class="dd-empty">暂无其它规格，点下方「+ 添加单位」。</div>';
  }
  function ddSyncUnits(){
    var d=drugsList[curIdx]; if(!d) return;
    var old=d.un||[], byUnit={}, units=[], nodes=$('ddUnits').querySelectorAll('.dd-unit');
    var mainU=String(d.u||'g').trim(), mirror=null;
    /* 详情弹窗只编 单位/库存/进货价/零售价/日常价，批发价和建议价快照没在界面上，
       这里按单位名把旧值带回来，否则一保存详情「批发价」就被清空了。 */
    for(var k=0;k<old.length;k++){
      var o=old[k]; if(!o||!o.unit) continue;
      if(String(o.unit).trim()===mainU) mirror=o;
      byUnit[String(o.unit)]=o;
    }
    for(var i=0;i<nodes.length;i++){ var nd=nodes[i];
      var ut=(nd.querySelector('[data-f="unit"]').value||'').trim();
      if(!ut) continue;
      var rec={ unit:ut,
                stock:(nd.querySelector('[data-f="stock"]').value||'').trim(),
                cost:(nd.querySelector('[data-f="cost"]').value||'').trim(),
                retail:(nd.querySelector('[data-f="retail"]').value||'').trim(),
                daily:(nd.querySelector('[data-f="daily"]').value||'').trim() };
      var keep=byUnit[ut];
      if(keep){
        if(keep.amt!=null && keep.amt!=='') rec.amt=keep.amt;   /* 常用量按规格各自保留 */
        if(keep.wp!=null && keep.wp!=='') rec.wp=keep.wp;
        if(keep.sg!=null && keep.sg!=='') rec.sg=keep.sg;
      }
      if(ut===mainU){ continue; }          /* 与主单位同名 → 交给镜像处理，别存两条 */
      units.push(rec);
    }
    /* 主单位库存镜像：drugs 表没有 stock 列，库存只存在 units 里，必须原样留着 */
    if(mirror) units.push(mirror);
    else if(d.st!=='' && d.st!=null) units.push({unit:mainU, stock:d.st, cost:(d.bp==null?'':d.bp), retail:'', daily:'', wp:'', sg:''});
    d.un=units;
  }
  function ddAddUnit(){ ddSyncUnits(); var d=drugsList[curIdx]; (d.un=d.un||[]).push({unit:'',stock:'',cost:'',retail:'',daily:''}); ddRenderUnits(d.un); }
  /* 按单位名删（ddSyncUnits 会把主单位镜像挪到末尾，用旧下标可能删错行） */
  function ddDelUnit(i, unit){
    ddSyncUnits();
    var d=drugsList[curIdx]; if(!d||!Array.isArray(d.un)) return;
    var k=-1;
    if(unit!=null && unit!==''){
      for(var q=0;q<d.un.length;q++){ if(String((d.un[q]||{}).unit||'')===String(unit)){ k=q; break; } }
    }
    if(k<0) k=i;
    if(d.un&&d.un.length>k){ d.un.splice(k,1); ddRenderUnits(d.un); }
  }
  function latestCost(d){
    /* 主单位成本优先：主价（日常价/零售价）按主单位计，应取主单位进货价。
       bp 即主单位成本；其次取与主单位同名的单位成本；都没有再退而取最高单位成本。 */
    if(d.bp!==''&&d.bp!=null) return n(d.bp);
    var un=d.un||[];
    var main=null, alt=null;
    for(var i=0;i<un.length;i++){
      if(un[i].cost===''||un[i].cost==null) continue;
      var x=n(un[i].cost);
      if(un[i].unit===d.u){ main=x; break; }
      if(alt==null||x>alt) alt=x;
    }
    return main!=null?main:(alt!=null?alt:null);
  }
  /* ================= 每个价格各自的倍率 =================
     价格 = 进货价 × 该价格自己的倍率；各行独立，改动只联动自己那一行。
     单位：进货价 / 批发价按 元/kg，零售价 / 客人价按 元/g → 算 元/g 时再 ÷1000。
     倍率存 d.rates={p:.., wp:..}；旧数据没有 rates 时按「价格 ÷ 进货价」反推。 */
  var DEF_RATE=1.5;      /* 批发价默认倍率 */
  var DEF_RATE_P=2.5;    /* 零售价默认倍率（零售通常高于批发；可在行内随时改） */
  function numOrNull(v){ if(v===''||v==null) return null; var x=parseFloat(v); return isNaN(x)?null:x; }
  function rateOf(kind, d){
    d=d||drugsList[curIdx]||{};
    var rs=(d.rates&&typeof d.rates==='object')?d.rates:{};
    var v=numOrNull(rs[kind]);
    if(v!=null) return Math.round(v*10000)/10000;
    var bp=numOrNull(d.bp);
    if(bp){
      if(kind==='wp'){ var wp=numOrNull(d.wp); if(wp!=null) return Math.round(wp/bp*10000)/10000; }
      if(kind==='p'){ var p=numOrNull(d.p); if(p!=null) return Math.round(p*1000/bp*10000)/10000; }
    }
    /* 老数据：沿用原来的单倍率 d.rate / SET.rate；零售倍率至少给到 2.5（否则零售=批发） */
    var legacy=numOrNull(d.rate);
    if(legacy==null && typeof SET!=='undefined' && SET) legacy=numOrNull(SET.rate);
    if(kind==='p') return Math.round(Math.max(legacy==null?0:legacy, DEF_RATE_P)*10000)/10000;
    return Math.round((legacy==null?DEF_RATE:legacy)*10000)/10000;
  }
  function rateInputOf(kind){
    var el=$(kind==='p'?'ddRateP':'ddRateWp');
    var v=numOrNull(el&&el.value);
    return (v==null)?rateOf(kind):v;
  }
  /* 用「进货价 × 该行倍率」重算某一行 */
  function applyRate(kind){
    var bp=numOrNull($('ddBp')?$('ddBp').value:null);
    if(bp==null) return;
    var inp=kind==='p'?'ddRateP':'ddRateWp';
    var rate=numOrNull($(inp)&&$(inp).value);
    if(rate==null) return;
    if(kind==='p'){
      $('ddP').value=Math.round(bp*rate/1000*100000)/100000;      /* 元/kg → 元/g */
      var b1=$('ddP').closest('.dd-pin'); if(b1) b1.classList.remove('bad');
    }else{
      $('ddWp').value=Math.round(bp*rate*1000)/1000;
      var b2=$('ddWp').closest('.dd-pin'); if(b2) b2.classList.remove('bad');
    }
    ddMarkLow();
  }
  /* 进货价变动 → 只按各自倍率更新对应价格，互不影响 */
  function calcWholesale(){
    if(numOrNull($('ddRateWp')&&$('ddRateWp').value)!=null) applyRate('wp');
    if(numOrNull($('ddRateP')&&$('ddRateP').value)!=null)  applyRate('p');
  }
  /* 某行当前的建议价 = 进货价 × 该行倍率（kind: 'p' | 'wp'）；缺进货价或倍率时返回 null */
  function ddSugOf(kind){
    var bp=numOrNull($('ddBp')?$('ddBp').value:null);
    if(bp==null) return null;
    var rEl=$(kind==='p'?'ddRateP':'ddRateWp');
    var rate=numOrNull(rEl?rEl.value:null);
    if(rate==null) return null;
    return (kind==='p')?Math.round(bp*rate/1000*100000)/100000   /* 元/kg → 元/g */
                       :Math.round(bp*rate*1000)/1000;
  }
  /* 手动输入价 < 建议价 → 金额橙色高亮（.low），悬浮提示建议价 */
  function ddMarkLow(){
    var kinds=[['p','ddP'],['wp','ddWp']];
    for(var i=0;i<kinds.length;i++){
      var el=$(kinds[i][1]); if(!el) continue;
      var sug=ddSugOf(kinds[i][0]), v=numOrNull(el.value);
      var low=(v!=null&&sug!=null&&v<sug-1e-9);
      el.classList.toggle('low',low);
      el.title=low?('低于建议价 '+sug):'';
    }
    /* 客人价格行：建议价 = 批发价 ÷ 1000（未成交时默认计入的口径） */
    var gbox=$('ddGuest'), d=drugsList[curIdx];
    if(!gbox||!d) return;
    var gsug=wpPerGram();
    var pins=gbox.querySelectorAll('input[data-gp]');
    for(var j=0;j<pins.length;j++){
      var inp=pins[j];
      var v=numOrNull(inp.value);
      var low2=(v!=null&&gsug!=null&&v<gsug-1e-9);
      inp.classList.toggle('low',low2);
      inp.title=low2?('低于建议价 '+gsug):'';
    }
  }
  function ddSuggest(which){
    var d=drugsList[curIdx]; if(!d) return;
    /* 进货价以「当前输入框」为准（用户可能刚改了还没保存），没填才退回多单位 / 已存值 */
    var cost=numOrNull(String($('ddBp').value||'').trim());
    if(cost==null) cost=latestCost(d);
    if(cost==null){ toastErr('没有进货价可参考（先填进货价或多单位进货价）'); return; }
    var kind=(which==='p')?'p':'wp';
    var rate=rateInputOf(kind);
    var sug=(kind==='p') ? Math.round(cost*rate/1000*100000)/100000
                         : Math.round(cost*rate*1000)/1000;
    var box=$(kind==='p'?'ddP':'ddWp'); if(!box) return;
    box.value=sug;
    var b=box.closest('.dd-pin'); if(b) b.classList.remove('bad');
    ddMarkLow();
    toast('按 进货价 ¥'+cost+' 元/kg × 倍率 '+rate+' → ¥'+sug+(kind==='p'?' 元/g':' 元/kg'));
  }
  /* ============ 重要客人价格（客人名单 + 最近成交价沉淀） ============
     价格来源：订单【标记发药】时的成交价（WPlan.toggleFy → recordDealHistory 自动写入）。
     详情页默认不写价，只展示「最近成交 / 未成交按批发价」；
     手动填只作覆盖手段，之后再有改价订单仍以订单成交价为准。 */
  function ddGuestKey(d){ return drugKey(d.n||''); }
  function ddDocGp(doc, d){
    if(!doc||!d) return null;
    var o=DOCTORS[doc]; if(!o||!o.price) return null;
    var k=ddGuestKey(d);
    if(Object.prototype.hasOwnProperty.call(o.price,k)) return o.price[k];
    return null;
  }
  /* 该客人这味药最近一次「订单成交」记录（详情页手改的不算，没有单号跳过） */
  function ddLastDeal(doc, d){
    var o=DOCTORS[doc]; if(!o||!o.log||!o.log.length) return null;
    var k=ddGuestKey(d);
    for(var i=0;i<o.log.length;i++){
      var r=o.log[i];
      if(r && r.rx && drugKey(r.d||'')===k) return r;
    }
    return null;
  }
  /* 该客人这味药的倍率：有实际成交价时显示「实际价 ÷ 进货价」的有效倍率（与金额一致），
     没有价格才用存过的倍率，再没有就跟随批发倍率 */
  function ddGuestRate(doc, d){
    var bp=numOrNull($('ddBp')?$('ddBp').value:null);
    if(bp==null) bp=numOrNull(d.bp);
    var p=ddDocGp(doc,d);
    if(bp && p!=null && p!=='' && !isNaN(parseFloat(p))){
      return Math.round(parseFloat(p)*1000/bp*10000)/10000;
    }
    var o=DOCTORS[doc], k=ddGuestKey(d);
    if(o && o.rates){ var v=numOrNull(o.rates[k]); if(v!=null) return v; }
    return rateOf('wp', d);
  }
  /* 批发价（元/kg）→ 元/g，作为「未成交」时的默认参考价 */
  function wpPerGram(){
    var wp=numOrNull($('ddWp')?$('ddWp').value:null);
    return (wp==null)?null:Math.round(wp/1000*100000)/100000;
  }
  /* 名单 = 「重要客人」页的客人 ∪ 有药价记录的客人；有本药价的排前面 */
  function ddGuestNames(d){
    var out=[], seen={};
    var g=(typeof GUESTS!=='undefined'&&GUESTS)?GUESTS:{};
    for(var k in g){ if(g[k] && !seen[k]){ seen[k]=1; out.push(k); } }
    for(var m in DOCTORS){ if(DOCTORS[m] && !seen[m]){ seen[m]=1; out.push(m); } }
    out.sort(function(a,b){
      var pa=(ddDocGp(a,d)!=null)?0:1, pb=(ddDocGp(b,d)!=null)?0:1;
      if(pa!==pb) return pa-pb;
      return a.localeCompare(b,'zh');
    });
    return out;
  }
  function ddRenderGuest(d){
    var box=$('ddGuest'); if(!box) return;
    var drugNm=String(d.n||'').trim();
    if(!drugNm){ box.innerHTML='<div class="dd-gempty">先填写药品名称，再维护重要客人价格。</div>'; return; }
    var docs=ddGuestNames(d);
    if(!docs.length){
      box.innerHTML='<div class="dd-gempty">还没有重要客人。点右上「+ 客人」新增（也可在「重要客人」页维护名单）。</div>';
      return;
    }
    var wpg=wpPerGram(), h='';
    for(var i=0;i<docs.length;i++){
      var doc=docs[i], gv=ddDocGp(doc,d), rv=ddGuestRate(doc,d), deal=ddLastDeal(doc,d);
      var src, cls;
      if(gv==null || gv===''){ src='未成交'; cls=''; }
      else if(deal && Math.abs(parseFloat(deal.to)-parseFloat(gv))<1e-9){ src='成交 '+String(deal.t||'').slice(5,10); cls='ord'; }
      else { src='手动覆盖'; cls='mn'; }
      h+='<div class="dd-grow" data-doc="'+esc(doc)+'">'
        +'<div class="dd-grow-nm"><b title="'+esc(doc)+'">'+esc(doc)+'</b>'
        +'<span class="dd-gsrc '+cls+'" title="元/g · '+esc(src)+'">元/g · '+esc(src)+'</span></div>'
        +'<div class="dd-pin">'
        +'<input data-gp="'+esc(doc)+'" class="num" inputmode="decimal" autocomplete="off" value="'+(gv==null?'':gv)+'"'
        +' placeholder="'+(wpg==null?'0.00':wpg)+'"></div>'
        +'<div class="dd-grow-rate"><span>倍率</span><div class="dd-rate-in">'
        +'<input data-gr="'+esc(doc)+'" class="num" inputmode="decimal" autocomplete="off" value="'+rv+'"></div></div>'
        +'<div class="dd-gact"><button type="button" data-gren="'+esc(doc)+'">改名</button>'
        +'<button type="button" data-gdel="'+esc(doc)+'">移除</button></div>'
        +'</div>';
    }
    box.innerHTML=h;
  }
  /* 名单：新增 / 改名 / 移除 */
  function ddGuestAdd(){
    var d=drugsList[curIdx]; if(!d) return;
    var nm=String(prompt('新增重要客人姓名：')||'').trim();
    if(!nm) return;
    if(DOCTORS[nm]){ toastErr('「'+nm+'」已在名单里'); return; }
    DOCTORS[nm]={n:nm, at:nowStr(), price:{}, log:[], rates:{}};
    /* 名单同时进「重要客人」页（同一张 doctors 表） */
    if(typeof GUESTS!=='undefined' && !GUESTS[nm] && typeof guestSave==='function'){
      guestSave({name:nm, discount:0, note:'', pins:[], stars:{}});
    }
    saveDoctors();
    ddRenderGuest(d);
    toast('已添加客人「'+nm+'」');
  }
  function ddGuestRename(doc){
    var nm=String(prompt('修改客人姓名：', doc)||'').trim();
    if(!nm || nm===doc) return;
    if(DOCTORS[nm]){ toastErr('「'+nm+'」已存在，不能重名'); return; }
    var o=DOCTORS[doc]||{n:doc, price:{}, log:[]};
    o.n=nm; DOCTORS[nm]=o; delete DOCTORS[doc];
    /* 「重要客人」页那份档案也跟着改名 */
    if(typeof GUESTS!=='undefined' && GUESTS[doc]){
      GUESTS[nm]=GUESTS[doc]; GUESTS[nm].name=nm; delete GUESTS[doc];
      if(typeof guestSave==='function') guestSave(GUESTS[nm]);
    }
    saveDoctors();
    /* 旧名那一行必须删掉，否则刷新时云端又把旧客人拉回来 */
    if(SUPA.on){ SUPA.q('doctors?name=eq.'+encodeURIComponent(doc),{method:'DELETE'}).catch(function(){}); }
    var d=drugsList[curIdx]; if(d) ddRenderGuest(d);
    toast('已改名为「'+nm+'」');
  }
  function ddGuestDel(doc){
    if(!confirm('把「'+doc+'」从重要客人名单移除？\n\n该客人各味药的专属价格与改价记录会一并删除；已保存的药方不受影响。')) return;
    delete DOCTORS[doc];
    if(typeof GUESTS!=='undefined') delete GUESTS[doc];
    saveDoctors();
    if(SUPA.on){ SUPA.q('doctors?name=eq.'+encodeURIComponent(doc),{method:'DELETE'}).catch(function(){}); }
    var d=drugsList[curIdx]; if(d) ddRenderGuest(d);
    toast('已移除「'+doc+'」');
  }
  /* 手动覆盖某客人价格（失焦保存；后续订单改价仍会覆盖它） */
  function ddGuestPriceChange(doc, el){
    var d=drugsList[curIdx]; if(!d) return;
    if(!DOCTORS[doc]) DOCTORS[doc]={n:doc, at:nowStr(), price:{}, log:[], rates:{}};
    if(!DOCTORS[doc].price) DOCTORS[doc].price={};
    var k=ddGuestKey(d);
    var old=(Object.prototype.hasOwnProperty.call(DOCTORS[doc].price,k))?DOCTORS[doc].price[k]:'';
    var val=String(el.value||'').trim();
    if(val===''){
      if(old!==''){ delete DOCTORS[doc].price[k]; setDocPrice(doc, d.n, '', old, '', (SET&&SET.doctor)||'详情页'); }
    }else{
      var nv=numOrNull(val);
      if(nv==null){ el.value=(old===''?'':old); toastErr('请输入数字'); return; }
      if(String(old)==='' || Math.abs(parseFloat(old)-nv)>1e-9){
        setDocPrice(doc, d.n, nv, old, '', (SET&&SET.doctor)||'详情页');
      }
    }
    saveDoctors();
    ddRenderGuest(d);
    ddMarkLow();
  }
  /* 改某客人的倍率 → 只联动该客人的价格（进货价 × 倍率，元/kg → 元/g） */
  function ddGuestRateChange(doc, el){
    var d=drugsList[curIdx]; if(!d) return;
    var rate=numOrNull(String(el.value||'').trim());
    if(rate==null){ toastErr('倍率必须是数字'); ddRenderGuest(d); return; }
    if(!DOCTORS[doc]) DOCTORS[doc]={n:doc, at:nowStr(), price:{}, log:[], rates:{}};
    DOCTORS[doc].rates=DOCTORS[doc].rates||{};
    DOCTORS[doc].rates[ddGuestKey(d)]=rate;
    var bp=numOrNull($('ddBp')?$('ddBp').value:null);
    if(bp!=null){
      var nv=Math.round(bp*rate/1000*100000)/100000;
      var old=ddDocGp(doc,d);
      if(old==null || Math.abs(parseFloat(old)-nv)>1e-9){
        setDocPrice(doc, d.n, nv, (old==null?'':old), '', (SET&&SET.doctor)||'详情页');
      }
    }
    saveDoctors();
    ddRenderGuest(d);
    ddMarkLow();
    toast('「'+doc+'」倍率改为 '+rate+'，价格已联动更新');
  }
  function ddLoadCostLog(name){
    var box=$('ddCostLog'); box.innerHTML='<div class="dd-empty">加载中…</div>';
    if(!SUPA.on){ box.innerHTML='<div class="dd-empty">未连接云端，无进货价历史。</div>'; return; }
    /* 云端没响应时不要一直卡在「加载中」——8 秒后给明确提示 */
    var done=false;
    var killed=setTimeout(function(){
      if(done) return; done=true;
      box.innerHTML='<div class="dd-empty">加载超时（云端无响应），稍后再开可重试。</div>';
    },8000);
    SUPA.loadCostLog(name).then(function(rows){
      if(done) return; done=true; clearTimeout(killed);
      if(!rows||!rows.length){ box.innerHTML='<div class="dd-empty">暂无进货价历史。</div>'; return; }
      var h='<table><thead><tr><th>日期</th><th>数量</th><th>单位</th><th>进货单价</th><th>供应商</th><th>单号</th></tr></thead><tbody>';
      for(var i=0;i<rows.length;i++){ var r=rows[i];
        h+='<tr><td>'+esc(r.dt||'')+'</td><td class="num">'+esc(r.qty==null?'':r.qty)+'</td><td>'+esc(r.unit||'')+'</td><td class="num">'+esc(r.cost==null?'':r.cost)+'</td><td>'+esc(r.supplier||'')+'</td><td>'+esc(r.purchase_no||'')+'</td></tr>';
      }
      box.innerHTML=h+'</tbody></table>';
    }).catch(function(e){
      if(done) return; done=true; clearTimeout(killed);
      box.innerHTML='<div class="dd-empty" style="color:#c00">加载失败：'+esc(e.message)+'</div>';
    });
  }
  function ddSave(){
    var d=drugsList[curIdx]; if(!d) return;
    /* ---- 核心字段校验：药品名称 + 进货价 / 批发价 / 零售价 非空 ----
       客人价格由订单成交自动沉淀（按客人维度存在 DOCTORS 里），不参与这里保存。 */
    var nm=String($('ddName').value||'').trim();
    var vBp=String($('ddBp').value||'').trim();
    var vWp=String($('ddWp').value||'').trim();
    var vP =String($('ddP').value||'').trim();
    var vRp=String($('ddRateP').value||'').trim();
    var vRw=String($('ddRateWp').value||'').trim();
    var miss=[], bad=[];
    if(!nm){ miss.push('药品名称'); bad.push('ddName'); }
    if(!vBp){ miss.push('进货价'); bad.push('ddBp'); }
    if(!vWp){ miss.push('批发价'); bad.push('ddWp'); }
    if(!vP){  miss.push('零售价'); bad.push('ddP'); }
    if(miss.length){
      ddBadMark(bad);
      ddMsgBox('请先填写：'+miss.join('、'));
      var first=$(bad[0]); if(first){ try{ first.focus(); }catch(e){} }
      return;
    }
    var numBad=[];
    [['ddBp','进货价',vBp],['ddWp','批发价',vWp],['ddP','零售价',vP],
     ['ddRateP','零售倍率',vRp],['ddRateWp','批发倍率',vRw]]
      .forEach(function(x){ if(x[2]!=='' && isNaN(parseFloat(x[2]))) numBad.push(x[1]); });
    if(numBad.length){
      ddMsgBox('价格/倍率必须是数字：'+numBad.join('、'));
      return;
    }
    ddBadClear(); ddMsgBox('');
    /* ---- 改名：云端以 name 为主键，改名前先确认 ---- */
    var oldName=String(d.n||'').trim();
    /* 重名拦截：不允许建两味同名的药（2026-10-30 用户要求） */
    var dupIdx=dmNameTaken(nm, curIdx);
    if(dupIdx>=0){
      ddBadMark(['ddName']);
      ddMsgBox('已有同名药「'+String(drugsList[dupIdx].n||'').trim()+'」，不能建两味同名的药');
      return;
    }
    if(oldName && oldName!==nm){
      if(!confirm('药名「'+oldName+'」改为「'+nm+'」？\n\n改名后：\n· 药价目录、进货价历史会跟着改\n· 已保存处方里的文字不会自动改')) return;
    }
    ddSyncUnits();
    /* 改价前先记住旧进货价 / 旧倍率：建议价快照要靠它判断「进货价到底变没变」 */
    var oldBp=numOrNull(d.bp);
    var oldU=String(d.u||'g').trim();
    var oldRs=(d.rates&&typeof d.rates==='object')?d.rates:null;
    d.n=nm;
    var newU=($('ddUnit').value||'g').trim()||'g';
    if(newU!==oldU) dmRenameMainUnit(d, oldU, newU);   /* 主单位改名 → 库存镜像跟着改 */
    else d.u=newU;
    d.c=String($('ddAmount').value||'').trim();
    d.tc=String($('ddTc').value||'').trim();
    d.dw=String($('ddDw').value||'').trim();
    d.cat=d.cat||'中药';             /* 「药品信息」输入框已去掉，分类沿用原值 */
    var pyIn=String($('ddPy').value||'').trim();
    d.py=pyIn||genPinyin(d.n||'');
    d.og=String($('ddOrigin').value||'').trim();
    d.al=String($('ddAlias').value).split(/[\s,，、]+/).map(function(s){return s.trim();}).filter(Boolean);
    d.bp=vBp; d.wp=vWp; d.p=vP;
    /* 保存时按最终金额回算倍率：避免「手改了价格、倍率还是旧的」，
       否则下次改进货价联动又会把价格算回去。金额与倍率一致时回算结果不变。 */
    var rp=numOrNull(vRp), rw=numOrNull(vRw);
    var bpN=numOrNull(vBp), pN=numOrNull(vP), wpN=numOrNull(vWp);
    if(bpN && pN!=null && pN>0) rp=Math.round(pN*1000/bpN*10000)/10000;
    if(bpN && wpN!=null && wpN>0) rw=Math.round(wpN/bpN*10000)/10000;
    var rwFinal=(rw==null?rateOf('wp',d):rw);
    d.rates={ p:(rp==null?rateOf('p',d):rp), wp:rwFinal };
    /* 建议价快照 d.rates.sg：只有进货价变了才重算（用户 2026-10-30 规则），
       改批发价 / 批发倍率时保持原来那个建议价不变。 */
    var sgPrev=(oldRs && isFinite(parseFloat(oldRs.sg)))?parseFloat(oldRs.sg):null;
    var bpChanged=!(oldBp!=null && bpN!=null && Math.abs(oldBp-bpN)<1e-9);
    if(sgPrev!=null && !bpChanged){
      d.rates.sg=sgPrev;
    }else if(bpN && rwFinal){
      d.rates.sg=Math.round(bpN*rwFinal*100)/100;
    }
    d.dp=vP;                         /* 云端 daily_price 列沿用，值同步为零售价 */
    delete d.gp;                     /* 客人专属价 → 改为「重要客人价格」，按客人维度存 DOCTORS */
    d.st=d.st||'';
    saveDrugsLS(); renderDrugTable(); renderDrugList();
    if(oldName && oldName!==d.n && SUPA.on){
      /* 旧名那一行必须删掉，否则刷新时云端又会把它拉回来（变成两条同名药） */
      SUPA.q('drugs?name=eq.'+encodeURIComponent(oldName),{method:'DELETE'}).catch(function(){});
      SUPA.q('drug_cost_log?drug=eq.'+encodeURIComponent(oldName),{method:'PATCH',body:{drug:d.n}}).catch(function(){});
    }
    $('mDrugDetail').classList.remove('on');
    toast('已保存「'+d.n+'」详情');
  }
  return { ensure:ensure, openDetail:openDetail, ddRenderUnits:ddRenderUnits, ddAddUnit:ddAddUnit,
           ddDelUnit:ddDelUnit, ddSuggest:ddSuggest, ddSave:ddSave, calcWholesale:calcWholesale,
           applyRate:applyRate, ddRenderGuest:ddRenderGuest, ddGuestAdd:ddGuestAdd,
           ddGuestRename:ddGuestRename, ddGuestDel:ddGuestDel,
           ddGuestPriceChange:ddGuestPriceChange, ddGuestRateChange:ddGuestRateChange,
           ddMarkLow:ddMarkLow };
})();
/* ---------- 药物管理：行内编辑（inline edit） ----------
   默认每个单元格只渲染纯文本 <span>，表格里没有常驻输入框；
   点单元格 → 原地换成 <input>；失焦 / 回车保存并回到文本；Esc 取消恢复原值；
   保存成功该单元格绿色闪一下，失败红色闪一下并保留编辑状态（输入框不收起）。 */
function dmCellText(td, v){ td.innerHTML='<span>'+esc(v==null?'':v)+'</span>'; }
/* 按 data-f / data-s 回填一个单元格（单位列的「×」要跟着重建） */
function dmFillCell(td, d){
  if(!td||!d) return;
  var f=td.getAttribute('data-f'), s=+(td.getAttribute('data-s')||0);
  /* 药名格是「名称 + 悬停浮现的＋添加规格」组合，改完名要整块重建，否则按钮会丢 */
  if(f==='n'){
    var tr0=td.closest('tr'), i0=tr0?tr0.getAttribute('data-i'):'';
    var multi=(dmSpecsOf(d).length>1);
    td.innerHTML='<div class="dm-nmrow"><span>'+esc(d.n||'')+'</span>'
      +(multi?'<i class="dm-multi" title="这味药有多个规格">多规格</i>':'')
      +'<button type="button" class="dm-addspec" data-i="'+esc(i0)+'"'
      +' title="为这味药再加一个规格（盒 / 个 / 斤…）">＋ 添加规格</button></div>';
    return;
  }
  if(f==='u'){
    var tr=td.closest('tr'), idx=tr?tr.getAttribute('data-i'):'';
    td.innerHTML='<span>'+esc(dmCellVal(d,'u',s))
      +(s>0?'<b class="dm-specdel" data-del="'+esc(idx)+'" data-s="'+s+'" title="删除这个规格">×</b>':'')
      +'</span>';
    return;
  }
  dmCellText(td, dmCellVal(d,f,s));
}
/* 批发价低于建议价 → 该格橙色加粗（改完价即时更新，不用整表重绘） */
function dmRowLow(tr, d, s){
  if(!tr||!d) return;
  if(s==null) s=+(tr.getAttribute('data-s')||0);
  var td=tr.querySelector('td[data-f="wp"]'); if(!td) return;
  var sg=dmCellVal(d,'sg',s), w=parseFloat(dmCellVal(d,'wp',s));
  var low=(isFinite(w) && sg!=='' && isFinite(parseFloat(sg)) && w<parseFloat(sg)-1e-9);
  td.classList.toggle('c-low', low);
}
function dmFlash(td, ok){
  td.classList.remove('dm-flash-ok','dm-flash-err');
  void td.offsetWidth;                    /* 强制重排：连续两次保存都能看到闪 */
  td.classList.add(ok?'dm-flash-ok':'dm-flash-err');
  setTimeout(function(){ td.classList.remove('dm-flash-ok','dm-flash-err'); }, 1000);
}
/* 行内「删除」：二次确认后删本行（本地 + 云端同步删） */
function dmDelByIdx(idx){
  if(idx==null||idx<0||!drugsList[idx]){ toastErr('先点一行，再点「删除」'); return; }
  var d=drugsList[idx];
  if(!confirm('确定删除「'+(d.n||'(空)')+'」？')) return;
  var nm=String(d.n||'').trim();
  drugsList.splice(idx,1); selDrugRow=-1;
  /* 删除必须同步云端：否则刷新时 SUPA.loadDrugs() 会把这一味重新拉回来
     （整表 upsert 只写不删，数据库里的行还在）。2026-10-08 一并修。 */
  saveDrugsLS();
  if(nm && SUPA.on){
    SUPA.q('drugs?name=eq.'+encodeURIComponent(nm),{method:'DELETE'})
       .catch(function(e){ console.warn('删除药价云端失败:',e.message); supaSaveFail('删除「'+nm+'」：'+e.message); });
  }
  renderDrugTable(); renderDrugList();
  toast(nm?('已删除「'+nm+'」'):'已删除空行');
}
function dmCommit(td,tr){
  var f=td.getAttribute('data-f'), idx=+tr.getAttribute('data-i');
  var s=+(td.getAttribute('data-s')||0);          /* 0 = 主规格，1..n = 第 n 个子规格 */
  var d=drugsList[idx];
  var inp=td.querySelector('input');
  if(!inp) return;                        /* 已收尾过，别重复提交 */
  if(td.__cancel){                        /* Esc：丢弃本次改动，恢复原值 */
    td.__cancel=false; td.classList.remove('dm-editing');
    if(d) dmFillCell(td, d);
    return;
  }
  var v=String(inp.value==null?'':inp.value);
  if(!d){ td.classList.remove('dm-editing'); dmCellText(td,v); return; }
  if(f==='u') v=v.trim();
  var old=String(dmCellVal(d,f,s));
  if(v===old){                            /* 没改动：不写盘、不闪 */
    td.classList.remove('dm-editing'); dmFillCell(td, d); return;
  }
  /* ---- 校验（不通过：原地保留输入框，红闪 + 顶部提示，用户接着改） ---- */
  if(f==='n'){
    if(!v.trim()){ dmBadCell(td,inp,'药品名称不能为空'); return; }
    var dup=dmNameTaken(v, idx);
    if(dup>=0){ dmBadCell(td,inp,'已有同名药「'+String(drugsList[dup].n||'').trim()+'」，不能建两味同名的药'); return; }
  }
  if(f==='u'){
    if(!v){
      if(s>0){                            /* 加规格时没填单位就走了 → 这条空规格直接撤掉 */
        var blank=dmSpecAt(d,s), bk=(blank?d.un.indexOf(blank):-1);
        if(bk>=0) d.un.splice(bk,1);
        saveDrugsLS();
        td.classList.remove('dm-editing'); renderDrugTable();
        toast('已取消新增规格');
        return;
      }
      dmBadCell(td,inp,'单位不能为空'); return;
    }
    var specs=dmSpecsOf(d), dupU=null;
    for(var q=0;q<specs.length;q++){ if(specs[q].s!==s && String(specs[q].unit)===v){ dupU=specs[q]; break; } }
    if(dupU){ dmBadCell(td,inp,'同一味药已有「'+v+'」这个单位，不能重复'); return; }
  }
  if(f==='p'||f==='wp'||f==='bp'||f==='st'){
    if(v!=='' && !isFinite(parseFloat(v))){ dmBadCell(td,inp,'必须是数字（可留空）'); return; }
  }
  try{
    /* ---- 药名：存盘 + 重排（排序按拼音，改名会换位置） ---- */
    if(f==='n'){
      d.n=v.trim();
      d.py=genPinyin(d.n);
      saveDrugsLS();
      td.classList.remove('dm-editing'); renderDrugTable();
      toast('已保存「'+d.n+'」');
      if(d.__new){
        renderDrugList();
        supaInsertNewDrugs().then(function(k){ if(k) toast('已新增「'+d.n+'」并写入云端数据库'); });
      }
      return;
    }
    if(f==='u'){ if(s>0) dmCellSet(d,'u',s,v); else dmRenameMainUnit(d, old, v); }
    else dmCellSet(d,f,s,v);
    /* 改进货价（元/kg）→ 批发价按「进货价 × 批发倍率」联动（同为元/kg，无需换算）
       + 建议价重算（进货价变了建议价才变，改批发价不动建议价） */
    if(f==='bp' && v!==''){
      var bpv=parseFloat(v), rr=dmWpRate(d);
      var nwp=Math.round(bpv*rr*1000)/1000;
      dmCellSet(d,'wp',s,String(nwp));
      var sp0=dmSpecAt(d,s);
      if(sp0){ sp0.sg=String(Math.round(bpv*rr*100)/100); }   /* 子规格：快照写在自己那条上 */
      else { dmSetSuggest(d, bpv); }
      if(!d.rates||typeof d.rates!=='object') d.rates={};
      d.rates.wp=Math.round(rr*10000)/10000;
      var tdWp=tr.querySelector('td[data-f="wp"]'); if(tdWp) dmCellText(tdWp, dmCellVal(d,'wp',s));
      var tdSg=tr.querySelector('td[data-f="sg"]'); if(tdSg) dmCellText(tdSg, dmCellVal(d,'sg',s));
    }
    if(f==='bp' || f==='wp') dmRowLow(tr, d, s);   /* 批发价低于建议价 → 橙色加粗，随改随更新 */
    saveDrugsLS();                        /* 本机落盘 + 云端（防抖整表上传） */
  }catch(err){
    dmBadCell(td,inp,'保存失败：'+((err&&err.message)||err));
    return;
  }
  td.classList.remove('dm-editing');
  dmFillCell(td, d);
  dmFlash(td, true);                      /* 保存成功：该格短暂高亮 */
  /* 改了价格 → 右侧「药品目录」四档价格同步刷新（同一份 drugsList，无需等切页） */
  if(f==='p'||f==='wp'||f==='bp'){ try{ renderDrugList(); }catch(e4){} }
  /* 改了目录价 → 当前处方若已划价就重算一遍（原来靠顶部「保存」按钮顺带做） */
  if((f==='p'||f==='dp') && priced && filledCount()){
    try{ autoPrice(); renderPriceList(); recalc(); }catch(e3){ console.warn('改价后重划失败:', e3.message); }
  }
}
/* 校验失败：红闪 + 提示，输入框保持打开（不把用户辛苦打的字弄丢） */
function dmBadCell(td, inp, msg){
  dmFlash(td,false);
  toastErr(msg);
  try{ inp.focus(); }catch(e){}
}
/* 把鼠标落点换算成「文字里的第几个字符」，供编辑框定位光标用。
   点空白处 / 不支持 caretRangeFromPoint 时返回 null（退回默认行为）。 */
function dmCaretOffset(td, x, y){
  try{
    var sp=td.querySelector('span'); if(!sp) return null;
    var r=null;
    if(document.caretRangeFromPoint){ r=document.caretRangeFromPoint(x,y); }
    else if(document.caretPositionFromPoint){
      var p=document.caretPositionFromPoint(x,y);
      if(p){ r=document.createRange(); r.setStart(p.offsetNode,p.offset); r.collapse(true); }
    }
    if(!r || !td.contains(r.startContainer)) return null;
    var pre=document.createRange();
    pre.selectNodeContents(sp);
    try{ pre.setEnd(r.startContainer, r.startOffset); }catch(e){ return null; }
    return pre.toString().length;
  }catch(e){ return null; }
}
function dmStartEdit(td,tr){
  if(!td||td.querySelector('input')) return;
  var f=td.getAttribute('data-f'), idx=+tr.getAttribute('data-i');
  var s=+(td.getAttribute('data-s')||0);
  if(!f) return;                          /* 操作列没有 data-f，不进入编辑 */
  if(DM_RO[f]) return;                    /* 建议价是计算列，不可编辑 */
  var d=drugsList[idx]; if(!d) return;
  var v=dmCellVal(d,f,s);
  td.__cancel=false;
  td.classList.add('dm-editing');
  td.innerHTML='<input type="text" autocomplete="off" spellcheck="false" value="'+esc(v)+'">';
  var inp=td.querySelector('input');
  inp.focus();
  try{
    /* 数值列全选（直接重打），文本列光标落在末尾（可在原位置接着改） */
    if(/^(bp|dp|p|wp|st|c|dw)$/.test(f)) inp.select();
    else { var L=String(v).length; inp.setSelectionRange(L,L); }
  }catch(e){}
  inp.addEventListener('blur',function(){ dmCommit(td,tr); });
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){ e.preventDefault(); inp.blur(); }            /* 回车 = 保存退出 */
    else if(e.key==='Escape'){ e.preventDefault(); td.__cancel=true; inp.blur(); }  /* Esc = 取消 */
  });
}

/* =========================================================
   药名自动提示
   ========================================================= */
var acList=[], acSel=-1, acInput=null;
function acHide(){ var b=$('acBox'); if(b) b.style.display='none'; acList=[]; acSel=-1; acInput=null; }
function acShow(inp,list){
  var b=$('acBox');
  acInput=inp; acList=list; acSel=0;
  var h='';
  for(var i=0;i<list.length;i++){
    var d=list[i];
    /* 一行看清：药名 · 后缀胶囊 · 规格（单位） · 价格。助记码不显示，但底层照样能拼音搜 */
    h+='<div class="ai'+(i===0?' on':'')+'" data-i="'+i+'"><span class="nm2">'+esc(d.__sfx?(d.base||d.n):d.n)+'</span>'
      +(d.__sfx?'<span class="sfxtag">'+esc(d.sfx)+'</span>':'')
      +'<span class="un">'+(d.u?esc(d.u):'g')+'</span>'
      +'<span class="pr">'+(d.p!=null&&d.p!==''?esc(d.p):'—')+'</span></div>';
  }
  b.innerHTML=h;
  b.style.display='block';
  var r=inp.getBoundingClientRect();
  var top=r.bottom+2, left=r.left;
  if(top+b.offsetHeight>window.innerHeight-6) top=Math.max(4,r.top-b.offsetHeight-2);
  if(left+b.offsetWidth>window.innerWidth-6) left=Math.max(4,window.innerWidth-b.offsetWidth-6);
  b.style.top=top+'px'; b.style.left=left+'px';
}
function acToken(inp){
  var v=inp.value, p=(inp.selectionStart==null?v.length:inp.selectionStart);
  var m=v.slice(0,p).match(/[^\s,，、;；]*$/);
  var tok=m?m[0]:'';
  return {tok:tok, start:p-tok.length, end:p};
}
function acTrigger(inp){
  var tk=acToken(inp), q=tk.tok.trim();
  if(q.length<1 || DOSE_RE.test(q) || q.indexOf('自备')>=0){ acHide(); return; }
  var list=acSearch(q);
  if(!list.length){ acHide(); return; }
  acShow(inp,list);
}
function acMove(d){
  if(!acList.length||!acInput) return;
  acSel=(acSel+d+acList.length)%acList.length;
  var nodes=$('acBox').querySelectorAll('.ai');
  for(var i=0;i<nodes.length;i++) nodes[i].classList.toggle('on',i===acSel);
  if(nodes[acSel]&&nodes[acSel].scrollIntoView) nodes[acSel].scrollIntoView({block:'nearest'});
}
function acAccept(idx){
  if(!acInput||!acList.length) return false;
  var d=acList[(idx==null?acSel:idx)];
  if(!d) return false;
  var inp=acInput, tk=acToken(inp), k=+inp.getAttribute('data-i');
  var cell=cellEl(k);
  /* 选中候选 = 整格替换：药名与尾缀都要重写，不能只改 nm（否则旧尾缀残留成「丹皮[另包]丹皮」） */
  if(cell){
    var sp=splitSfx(d.n);
    cell.querySelector('.nm').value=sp.nm;
    var sx=cell.querySelector('.sfx'); if(sx) sx.textContent=sfxText(sp.sfx);   /* 去方括号 */
    /* 标签颜色跟着后缀变（先煎=琥珀 / 后下=蓝 / 其余=绿），别沿用上一味药的类别 */
    var kd=sfxKind(sp.sfx);
    if(kd) cell.setAttribute('data-sfx-kind',kd); else cell.removeAttribute('data-sfx-kind');
    /* 选中范围覆盖到 token 之后可能残留的旧尾缀文本 */
    inp.value=sp.nm;
  }else{
    inp.value=inp.value.slice(0,tk.start)+d.n+inp.value.slice(tk.end);
  }
  var dsIn=cell?cell.querySelector('.ds'):null;
  if(dsIn && !dsIn.value.trim() && d.c!=null && String(d.c).trim()!==''){
    /* 常用量原样带出：纯数字才补单位（「10」→「10g」），已经是「10g」「1盒」就直接用，
       否则子规格会拼成「10g盒」 */
    var cv0=String(d.c).trim();
    dsIn.value=/^\d+(\.\d+)?$/.test(cv0) ? (cv0+(d.u||'g')) : cv0;
    cell.classList.remove('zibei');
  }
  /* 记住用户选中的那条（单位 + 该单位的价格），后续计价按它算。
     ⚠ readCell 在药名变化时会把 du/dp 清空，所以要在它之后再写回去。 */
  var wantU=(d.u||'g'), wantP=(d.p!=null&&d.p!=='')?n(d.p):null;
  acHide();
  dupMerged=-1;
  readCell(k);
  if(items[k]&&!items[k].zibei){ items[k].du=wantU; items[k].dp=wantP; }
  if(dupMerged>=0){
    toastErr('「'+d.n+'」重复了，已把剂量合并到第 '+(dupMerged+1)+' 格');
    renderSheet(); growCells(); recalc();
    return true;
  }
  if(dsIn && !dsIn.value.trim()){ dsIn.focus(); }
  else { inp.focus(); try{ inp.setSelectionRange(inp.value.length,inp.value.length); }catch(e){} }
  growCells();
  recalc();
  return true;
}
/* 一格药味的 HTML（renderSheet 与 growCells 共用，保证两边结构完全一致）：
   左「＋」/ 右「＋」（悬停才出现，用来前后插一行）+ 药名 + 克数 + 绿色后缀胶囊 + 后缀下拉框 */
function cellHTML(i, nm, ds, sfx, extraCls, ph){
  return '<button type="button" class="xadd l" data-i="'+i+'" data-ins="before" tabindex="-1" title="在这一格前面插入一行">+</button>'
    +'<input class="nm" data-i="'+i+'" value="'+esc(nm)+'" autocomplete="off"'
    +(ph?' placeholder="'+esc(ph)+'"':'')+'>'
    +'<input class="ds" data-i="'+i+'" value="'+esc(ds)+'" autocomplete="off">'
    +'<span class="sfx" data-i="'+i+'">'+esc(sfx)+'</span>'
    +'<button type="button" class="sfxq" data-i="'+i+'" tabindex="-1" title="选常用后缀（先煎 / 后下 / 烊化…）">后缀</button>'
    +'<button type="button" class="xadd r" data-i="'+i+'" data-ins="after" tabindex="-1" title="在这一格后面插入一行">+</button>';
}
/* 后缀浮层：点格尾「后缀」按钮或点已有的绿色胶囊都能打开，选完立刻落到胶囊上 */
var _sfxPickK=-1;
function closeSfxPick(){ var m=document.getElementById('sfxPick'); if(m) m.style.display='none'; _sfxPickK=-1; }
function openSfxPick(k, anchor){
  var m=document.getElementById('sfxPick');
  if(!m){
    m=document.createElement('div'); m.id='sfxPick'; document.body.appendChild(m);
    m.addEventListener('mousedown',function(e){ e.preventDefault(); });
    m.addEventListener('click',function(e){
      var it=e.target.closest('.sp'); if(!it) return;
      var kk=_sfxPickK; closeSfxPick();
      if(kk<0) return;
      setCellSfx(kk, it.getAttribute('data-v')||'');
    });
  }
  var cell=cellEl(k); if(!cell) return;
  var cur=sfxText((cell.querySelector('.sfx')||{}).textContent||'');
  /* 这味药用过的后缀排在最前（记忆优先），其余按「设置 → 后缀管理」的顺序跟在后面 */
  var nmv=((cell.querySelector('.nm')||{}).value||'');
  var mem=sfxMemFor(nmv), ord=[];
  for(var i=0;i<mem.length;i++) ord.push(mem[i]);
  for(var i=0;i<SFX_LIB.length;i++){ if(ord.indexOf(SFX_LIB[i])<0) ord.push(SFX_LIB[i]); }
  var h='';
  for(var i=0;i<ord.length;i++){
    var own=(mem.indexOf(ord[i])>=0)?' own':'';
    h+='<button type="button" class="sp'+(ord[i]===cur?' on':'')+own+'" data-v="'+esc(ord[i])+'">'+esc(ord[i])+'</button>';
  }
  if(cur) h+='<button type="button" class="sp del" data-v="">清除后缀</button>';
  m.innerHTML=h;
  m.style.display='block';
  _sfxPickK=k;
  var r=(anchor||cell).getBoundingClientRect();
  var w=m.offsetWidth, hh=m.offsetHeight;
  var top=r.bottom+4, left=r.left;
  if(top+hh>window.innerHeight-6) top=Math.max(4,r.top-hh-4);
  if(left+w>window.innerWidth-6) left=Math.max(4,window.innerWidth-w-6);
  m.style.top=top+'px'; m.style.left=left+'px';
}
/* 下拉框 / 候选选中后缀 → 写进 .sfx（数据层仍拼回 [后缀]，打印与保存不受影响） */
function setCellSfx(k, txt){
  var cell=cellEl(k); if(!cell) return false;
  var nmIn=cell.querySelector('.nm'), sx=cell.querySelector('.sfx');
  if(!nmIn || !nmIn.value.trim()){ toastErr('先填药名，再选后缀'); return false; }
  var t=String(txt||'').trim();
  if(sx) sx.textContent=t;
  var kd=sfxKind(t);
  if(kd) cell.setAttribute('data-sfx-kind',kd); else cell.removeAttribute('data-sfx-kind');
  var it0=items[k], du0=it0?it0.du:'', dp0=it0?it0.dp:null;
  readCell(k);
  if(items[k]&&!items[k].zibei){ items[k].du=du0||items[k].du; items[k].dp=(dp0==null?items[k].dp:dp0); }
  /* 手动选的后缀 → 进这味药的后缀记忆（下次搜这味药就会带出来）。
     保存时会整段重算一次，所以这里只补「新后缀」，不会重复计数。 */
  if(t && nmIn.value.trim() && SFX_LIB.indexOf(t)>=0 && sfxMemFor(nmIn.value).indexOf(t)<0){
    sfxMemAdd(nmIn.value, t, 1);
  }
  cell.classList.toggle('empty', !nmIn.value.trim() && !cell.querySelector('.ds').value.trim() && !t);
  fitCell(k); recalc();
  return true;
}
/* 行内「＋」：在当前格前面 / 后面插一格空白药名并聚焦，方便直接打字 */
function insertCellAt(k, where){
  if(!(k>=0) || k>items.length) return;
  readCell(k);
  var at=(where==='before')?k:k+1;
  items.splice(at,0,mkItem('',0,'',false));
  renderSheet(); growCells(); recalc();
  var c=cellEl(at);
  if(c){
    var nm=c.querySelector('.nm');
    try{ c.scrollIntoView({block:'nearest'}); }catch(e){}
    if(nm) nm.focus();
  }
}
/* 末尾追加空格子（保持随时可继续输入） */
function growCells(){
  var need=Math.max(12, Math.ceil((filledCount()+1)/3)*3+3);
  if(need>items.length){
    var g=$('sGrid');
    for(var i=items.length;i<need;i++){
      items.push(mkItem('',0,'',false));
      var div=document.createElement('div');
      /* 空行同样打 .empty，CSS 据此把输入框完全透明（用户要求隐藏空白药品行） */
      div.className='cell empty'; div.setAttribute('data-i',i);
      div.innerHTML=cellHTML(i,'','','',false,'');
      g.appendChild(div);
    }
  }
}

/* =========================================================
   初始化与事件
   ========================================================= */
function loadSet(){
  try{ SET=JSON.parse(RX_STORE.getItem(LS_SET)||'{}'); }catch(e){ SET={}; }
  SET.clinic=SET.clinic||''; SET.doctor=SET.doctor||''; SET.rate=SET.rate||1.5;
  SET.paper=SET.paper||'A5 portrait';
  if(SET.rcptLh==null||!(n(SET.rcptLh)>0)) SET.rcptLh=1;
  if(SET.rcptBold===undefined) SET.rcptBold=false;
  if(SET.rxFs==null||!(n(SET.rxFs)>0)) SET.rxFs=14;
  if(SET.rxBold===undefined) SET.rxBold=false;
  if(SET.rxLh==null||!(n(SET.rxLh)>0)) SET.rxLh=1.6;
  if(SET.showPrice===undefined) SET.showPrice=true;
}
/* 打开设置面板（原顶栏「设置」按钮，2026-10-28 导航上移后统一由顶部导航调用） */
/* ===== 设置 · 后缀管理 =====
   编辑副本 _setSfx，只有点「保存设置」才落库（rx_sfx_v1，随云端同步）。 */
var _setSfx=[];
function setSfxRead(){
  var box=$('setSfxList'); if(!box) return;
  var rows=box.querySelectorAll('.set-sfxrow'), out=[];
  for(var i=0;i<rows.length;i++){
    var n=rows[i].querySelector('.s-n').value;
    var p=rows[i].querySelector('.s-p').value;
    out.push({n:n, py:p});
  }
  _setSfx=out;
}
function renderSetSfx(){
  var box=$('setSfxList'); if(!box) return;
  var h='';
  if(!_setSfx.length) h='<div class="set-sfxempty">还没有后缀，点右上「＋ 添加后缀」新增</div>';
  for(var i=0;i<_setSfx.length;i++){
    h+='<div class="set-sfxrow">'
      +'<input class="s-n" value="'+esc(_setSfx[i].n||'')+'" placeholder="后缀名，如 先煎" autocomplete="off">'
      +'<input class="s-p" value="'+esc(_setSfx[i].py||'')+'" placeholder="编码" autocomplete="off" spellcheck="false">'
      +'<button type="button" class="s-del" data-i="'+i+'" title="删除这个后缀">✕</button>'
      +'</div>';
  }
  box.innerHTML=h;
}
function bindSetSfx(){
  var box=$('setSfxList'); if(!box || box.__bound) return;
  box.__bound=1;
  box.addEventListener('click',function(e){
    var b=e.target.closest('.s-del'); if(!b) return;
    setSfxRead();
    var i=+b.getAttribute('data-i');
    _setSfx.splice(i,1);
    renderSetSfx();
  });
  /* 填了后缀名但没填编码 → 自动补一个（中文按字表，其余留空由保存时再补） */
  box.addEventListener('blur',function(e){
    var inp=e.target;
    if(!inp.classList || !inp.classList.contains('s-n')) return;
    var row=inp.closest('.set-sfxrow'); if(!row) return;
    var py=row.querySelector('.s-p');
    if(py && !py.value.trim() && inp.value.trim()) py.value=pyByChar(inp.value.trim());
  },true);
}
/* ===== 设置 · 加工方式管理已移除（2026-10-31） =====
   加工 / 包装耗材改为订单明细里的普通行，按「数量 × 单价」直接计入总价。 */
function openSettings(){
  $('setRcptFs').value=SET.rcptFs||'';
  $('setRcptBold').checked=!!SET.rcptBold; $('setRcptLh').value=(SET.rcptLh==null?'':SET.rcptLh);
  $('setRxFs').value=(SET.rxFs==null?'':SET.rxFs); $('setRxBold').checked=!!SET.rxBold;
  $('setRxLh').value=(SET.rxLh==null?'':SET.rxLh);
  if(typeof applySheetFont==='function') applySheetFont();
  fillPrinterSelects();
  $('setPrinterA5').value=SET.printerA5||'HP LaserJet 1020';
  var ag=$('agentState'); if(ag) ag.textContent=AGENT_ON?'已连接（点打印直接出纸）':'未运行（会改用打印窗口）';
  $('setShowPrice').checked=SET.showPrice!==false; $('setShowClinic').checked=!!SET.showClinic;
  refreshStorageStat();
  loadPrinterList();
  /* 后缀管理：每次打开都以已保存的清单为准（编辑副本，取消不影响） */
  _setSfx=SFX_ITEMS.map(function(o){ return {n:o.n, py:o.py}; });
  renderSetSfx(); bindSetSfx();
  $('mSet').classList.add('on');
}
function bind(){
  $('btnNew').onclick=newRx;
  $('setSave').onclick=function(){
    SET.rcptFs=$('setRcptFs').value.trim();
    SET.printerA5=$('setPrinterA5').value||'HP LaserJet 1020';
    SET.rcptBold=$('setRcptBold').checked;
    SET.rcptLh=n($('setRcptLh').value)>0?n($('setRcptLh').value):1;
    var _rfs=n($('setRxFs').value);
    SET.rxFs=(_rfs>=8&&_rfs<=30)?_rfs:14;
    SET.rxBold=$('setRxBold').checked;
    var _rlh=n($('setRxLh').value);
    SET.rxLh=(_rlh>0)?_rlh:1.6;
    SET.showPrice=$('setShowPrice').checked; SET.showClinic=$('setShowClinic').checked;
    RX_STORE.setItem(LS_SET,JSON.stringify(SET)); autoBackup();
    if(typeof applySheetFont==='function') applySheetFont();
    /* ---- 后缀管理：和设置一起保存 ---- */
    setSfxRead();
    var sfxOut=[], sfxSeen={};
    for(var si=0;si<_setSfx.length;si++){
      var sn=String(_setSfx[si].n||'').replace(/[\s\u3000\[\]［］{}｛｝]/g,'');
      if(!sn) continue;
      if(sfxSeen[sn]) continue;
      sfxSeen[sn]=1;
      sfxOut.push({n:sn, py:String(_setSfx[si].py||'').trim().toLowerCase()});
    }
    if(!sfxOut.length){ toastErr('后缀至少要保留一个'); return; }
    var saved=sfxSave(sfxOut);
    _setSfx=saved.map(function(o){ return {n:o.n, py:o.py}; });
    $('mSet').classList.remove('on'); toast('设置已保存');
  };
  /* 后缀管理：新增一行空后缀，聚焦到名字框 */
  var _sfxAdd=$('setSfxAdd');
  if(_sfxAdd) _sfxAdd.onclick=function(){
    setSfxRead();
    _setSfx.push({n:'', py:''});
    renderSetSfx();
    var rows=$('setSfxList').querySelectorAll('.set-sfxrow');
    var last=rows[rows.length-1];
    if(last){ var inp=last.querySelector('.s-n'); inp.focus(); try{ inp.setSelectionRange(0,0); }catch(e){} }
  };
  /* 加工方式：新增入口已移除（2026-10-31） */
  /* 备份相关设置已移除（纯云端，无需本地备份） */
  /* 弹窗关闭：右上角 × / 点遮罩 / 按 Esc，三条路都要通。
     （2026-10-07 用户报「设置弹窗关不掉」——根因是昨天主题改版时
      覆盖层把 .modal 误写成 display:flex，盖掉了原来的 display:none，
      移除 .on 后仍然显示。这里同时把事件绑定也加固：
      · 用 click 而不是 mousedown（输入框会吃掉 mousedown，导致点遮罩无效）
      · mousedown + click 都绑，鼠标按下与抬起都试一次
      · Esc 关闭最上层弹窗
      · 关闭后把焦点还给 body，避免键盘焦点卡在已隐藏的元素上 */
  function closeModal(m){ m.classList.remove('on'); }
  Array.prototype.forEach.call(document.querySelectorAll('.modal'),function(m){
    Array.prototype.forEach.call(m.querySelectorAll('[data-close]'),function(b){
      b.onclick=function(e){ e.stopPropagation(); closeModal(m); };
    });
    /* 点遮罩：mousedown 与 click 都试，只在真正点到遮罩本身时才关 */
    function onBg(e){ if(e.target===m) closeModal(m); }
    m.addEventListener('mousedown',onBg);
    m.addEventListener('click',onBg);
  });
  window.addEventListener('keydown',function(e){
    if(e.key!=='Escape'&&e.key!=='Esc'&&e.keyCode!==27) return;
    /* 只关「最上层」那个开着且有焦点的弹窗 */
    var open=[].slice.call(document.querySelectorAll('.modal.on'));
    if(!open.length) return;
    var last=open[open.length-1];
    closeModal(last);
    last.setAttribute('data-was-open','1');
  });
  window.addEventListener('focus',function(){
    /* 焦点回到 body 后清掉标记 */
    if(document.activeElement===document.body){
      document.querySelectorAll('.modal[data-was-open]').forEach(function(m){
        m.removeAttribute('data-was-open');
      });
    }
  });

  /* 历史 */
  $('hQuery').onclick=renderHistory;
  $('hToday').onclick=showToday;
  $('hAll').onclick=function(){ $('hFrom').value=''; $('hTo').value=''; $('hName').value=''; renderHistory(); };
  $('hPrev').onclick=function(){ shiftDay(-1); saveHRange(); };
  $('hNext').onclick=function(){ shiftDay(1); saveHRange(); };
  $('hName').onkeydown=function(e){ if(e.key==='Enter') renderHistory(); };
  $('hList').onclick=function(e){
    var el=e.target.closest('.hitem'); if(!el) return;
    var k=el.getAttribute('data-k');
    var r=allRx().filter(function(x){ return rxKey(x)===k; })[0];
    if(r) loadRx(r);
  };
  /* 历史处方右键：删除该条
       - 本机保存的处方 → 直接删除
       - 书剑历史处方 → 只能撤销你的「就地修改」，恢复成原始记录 */
  $('hList').addEventListener('contextmenu',function(e){
    var el=e.target.closest('.hitem'); if(!el) return;
    e.preventDefault();
    var k=el.getAttribute('data-k');
    var r=allRx().filter(function(x){ return rxKey(x)===k; })[0];
    if(!r){ toastErr('未找到该处方'); return; }
    var idx=idxOfSaved(r.no);
    var hk=(r.__hi!=null)?hKey(r.__hi):null;
    if(idx<0){
      if(!hk||!HIST_EDIT[hk]){
        if(!confirm('「'+esc(r.n||'未填姓名')+' '+esc(r.dt||'')+'」是书剑原始历史处方，\n本机没有保存过，无法删除。')) return;
        return;
      }
      if(!confirm('「'+esc(r.n||'未填姓名')+' '+esc(r.dt||'')+'」是书剑原始历史处方，不能删除。\n\n是否撤销你在这条上的修改，恢复成原始记录？')) return;
      delete HIST_EDIT[hk];
      saveHistEdits();
      if(curSrcRx&&curSrcRx.__hi!=null&&hk===hKey(curSrcRx.__hi)){ curSrcRx=null; curRec=null; curIsHist=false; }
      renderHistory();
      toast('已撤销该历史处方的修改，恢复原始记录');
      return;
    }
    if(!confirm('确定删除这条处方吗？\n\n'+(r.n||'未填姓名')+'　'+r.dt+' '+(r.tm||'')+'\n共 '+((r.m||'').split(/\s{2,}/).filter(Boolean).length||'?')+' 味　合计 ¥'+(r.o||'—')+'\n\n删除后不可恢复。')) return;
    SAVED.splice(idx,1);
    /* 🔴 必须同步删云端，否则下次 loadNew 会从云端拉回来，等于没删（2026-10-14 事故）。
       同时记墓碑：即便云端别处又出现同编号，本机也不再显示/补推它。 */
    markDelNo(r.no);
    if(SUPA.on){
      SUPA.q('prescriptions?no=eq.'+encodeURIComponent(r.no), {method:'DELETE'})
      .catch(function(e){ console.warn('云端删除失败:', e&&e.message); });
    }
    if(curRec && curRec.no===r.no){ curRec=null; curSrcRx=null; curIsHist=false; }
    renderHistory(); refreshStorageStat();
    toast('已删除：'+(r.n||'未填姓名')+' '+r.dt+'（本机与云端都已删除）');
  });

  /* 处方笺：点空白处 → 聚焦第一个空格子 */
  $('sheetWrap').addEventListener('mousedown',function(e){
    if(e.target.closest('.cell')||e.target.closest('.rxhead')||e.target.closest('.rxfoot')) return;
    var k=firstEmptyIndex(), c=cellEl(k);
    if(c){ e.preventDefault(); c.querySelector('.nm').focus(); }
  });
  $('sGrid').addEventListener('input',function(e){
    var inp=e.target;
    if(!inp.classList||(!inp.classList.contains('nm')&&!inp.classList.contains('ds'))) return;
    var k=+inp.getAttribute('data-i');
    dupMerged=-1;
    readCell(k);
    if(dupMerged>=0){
      var dupName=(items[dupMerged]&&items[dupMerged].name)||'';
      toastErr('「'+dupName+'」重复了，已把剂量合并到第 '+(dupMerged+1)+' 格');
      acHide();
      renderSheet();
      growCells(); recalc();
      return;
    }
    if(inp.classList.contains('nm')) acTrigger(inp); else acHide();
    /* 空/非空实时切换：空格的输入框要立刻透明（用户要求隐藏空白药品行） */
    var cell=inp.closest?inp.closest('.cell'):null;
    if(cell){
      var nmEl=cell.querySelector('.nm'), dsEl=cell.querySelector('.ds'), sxEl=cell.querySelector('.sfx');
      var blank=(!nmEl.value && !dsEl.value && !(sxEl&&sxEl.textContent));
      cell.classList.toggle('empty',blank);
    }
    growCells();
    recalc();
  });
  /* 点已有内容的药名：全选该格文字 + 立刻弹出含该药名的候选（改药不用重新输入）
     点空格或点克数框：正常定位光标，不打扰 */
  /* 点药名：出候选，但**不动光标**。
     原来这里 setSelectionRange(v.length,v.length) 把光标硬拉到末尾，
     用户点药名中间想改一个字做不到（只能全删重输）。
     现在：只要用户自己把光标/选区放到了中间或开头，就尊重他的选择；
     仅当光标本来就在末尾（或未聚焦）时才出候选。 */
  $('sGrid').addEventListener('click',function(e){
    var inp=e.target;
    if(!inp.classList||!inp.classList.contains('nm')) return;
    var v=inp.value;
    if(!v) return;
    setTimeout(function(){
      if(document.activeElement!==inp) return;
      /* 关键：**不碰** selectionStart/selectionRange，保留浏览器按点击位置算出的光标点 */
      var list=acSearch(v);
      if(list.length) acShow(inp,list); else acHide();
    },0);
  });
  /* 药名格两侧圆形「＋」：前面 / 后面插一格空白药名并自动聚焦。
     用捕获阶段先接住，免得被格子的框选 / 点选逻辑吃掉这次点击。 */
  $('sGrid').addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('.xadd'):null;
    if(!b) return;
    e.preventDefault(); e.stopPropagation();
    insertCellAt(+b.getAttribute('data-i'), b.getAttribute('data-ins'));
  },true);
  /* 快捷后缀：点格尾「后缀」按钮、或点已有的绿色胶囊 → 弹后缀浮层 */
  $('sGrid').addEventListener('click',function(e){
    var btn=e.target.closest?e.target.closest('.sfxq'):null;
    var pill=e.target.closest?e.target.closest('.cell .sfx'):null;
    if(!btn && !(pill && String(pill.textContent||'').trim())) return;
    e.preventDefault(); e.stopPropagation();
    var host=btn||pill;
    openSfxPick(+host.getAttribute('data-i'), btn||pill);
  },true);
  /* 药名获得焦点时不要抢走浏览器算好的光标位置 */
  $('sGrid').addEventListener('mousedown',function(e){
    var inp=e.target;
    if(inp && inp.classList && inp.classList.contains('nm')){
      inp.dataset.rxFocus='1';
    }
  });
  $('sGrid').addEventListener('keyup',function(e){
    var inp=e.target;
    if(!inp.classList||!inp.classList.contains('nm')) return;
    /* 光标在中间或末尾时重新出候选（便于加后缀、改字） */
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='Home'||e.key==='End'||e.key==='Backspace'||e.key==='Delete'){
      if(inp.selectionStart===inp.value.length && inp.value) acTrigger(inp);
    }
  });
  $('sGrid').addEventListener('focusout',function(e){
    var inp=e.target;
    if(!inp.classList||!inp.classList.contains('nm')) return;
    /* ⚠ renderSheet 重建格子（g.innerHTML=…）时，旧输入框被移除也会触发 focusout。
       此时若照常 readCell(k)，读到的是**旧格子的残值**（常常是空），
       会把刚载入的第一味药从 items 里清掉（2026-10-21 实测：刘一衡 大枣[斤] 凭空消失）。
       重建期间 / 输入框已不在文档里 → 都是重建引起的假事件，直接跳过。 */
    if(RX_SHEET_BUILDING||!inp.isConnected) return;
    var k=+inp.getAttribute('data-i');
    var it=readCell(k);
    if(it&&it.name&&!it.qty&&!it.zibei){
      var d=findDrug(it.name);
      if(d&&normName(d.n)===normName(it.name)&&d.c!=null&&d.c!==''){
        it.qty=n(d.c); it.unit=d.u||'g';
        var cell=cellEl(k);
        if(cell){ cell.querySelector('.ds').value=doseText(it); }
      }
    }
    recalc();
  });
  /* 已全选状态下点任意格 → 取消全选，回到正常编辑 */
  $('sGrid').addEventListener('mousedown',function(e){
    if(selAll && e.target.classList && (e.target.classList.contains('nm')||e.target.classList.contains('ds'))){
      setTimeout(function(){ selAll=false; clearSelMark(); },0);
    }
  });
  function clearSelMark(){
    var nodes=$('sGrid').querySelectorAll('.cell');
    for(var i=0;i<nodes.length;i++) nodes[i].classList.remove('allsel');
  }
  /* 整格删除：药名 + 克数 + 尾缀 一次清干净（不留 [另包] 残渣）
     触发：Alt+Delete / 鼠标中键点格子 / 选中整格后按 Delete */
  function clearCell(k){
    var c=cellEl(k); if(!c) return false;
    var nm=c.querySelector('.nm'), ds=c.querySelector('.ds'), sx=c.querySelector('.sfx');
    if(nm) nm.value='';
    if(ds) ds.value='';
    if(sx) sx.textContent='';
    items[k]=mkItem('',0,'',false);
    c.classList.remove('zibei');
    c.classList.remove('allsel');
    return true;
  }
  $('sGrid').addEventListener('mouseup',function(e){
    /* 中键点击 = 整格删除 */
    if(e.button!==1) return;
    var c=e.target.closest?e.target.closest('.cell'):null;
    if(!c) return;
    e.preventDefault();
    var k=+c.getAttribute('data-i');
    if(clearCell(k)){ toast('已删除该药'); growCells(); renderSheet(); recalc(); }
  });

  /* ============ 处方区交互：框选 / 右键菜单 / 点选删除 ============ */
  function clearRngMark(){
    var ns=$('sGrid').querySelectorAll('.cell');
    for(var i=0;i<ns.length;i++) ns[i].classList.remove('rngsel');
    rngStart=rngEnd=-1;
  }
  function rngIdxList(){
    if(rngStart<0||rngEnd<0) return [];
    var a=Math.min(rngStart,rngEnd), b=Math.max(rngStart,rngEnd), out=[];
    for(var i=a;i<=b;i++){ var it=items[i]; if(it&&it.name) out.push(i); }
    return out;
  }
  function markRng(){
    var ns=$('sGrid').querySelectorAll('.cell'), set={};
    rngIdxList().forEach(function(k){ set[k]=1; });
    for(var i=0;i<ns.length;i++) ns[i].classList.toggle('rngsel',!!set[+ns[i].getAttribute('data-i')]);
  }
  function setPickMode(on){
    pickMode=!!on;
    var ns=$('sGrid').querySelectorAll('.cell');
    for(var i=0;i<ns.length;i++) ns[i].classList.toggle('pickmode',pickMode);
    if(!pickMode){
      for(var i2=0;i2<ns.length;i2++) ns[i2].classList.remove('picked');
      selAll=false; clearSelMark();
    }
    toast(pickMode?'点选模式：点要删除的药味（可多选），再按 Delete 或右键删除；按 Esc 退出':'已退出点选模式');
  }
  function pickedList(){
    var ns=$('sGrid').querySelectorAll('.cell'), out=[];
    for(var i=0;i<ns.length;i++) if(ns[i].classList.contains('picked')) out.push(+ns[i].getAttribute('data-i'));
    return out;
  }
  function deleteCells(list){
    if(!list||!list.length){ toastErr('没有选中的药味'); return; }
    list.forEach(function(k){ clearCell(k); });
    growCells(); renderSheet(); recalc();
    toast('已删除 '+list.length+' 味药');
  }
  /* ---- 框选：在空白处按下并拖动 ---- */
  $('sheetWrap').addEventListener('mousedown',function(e){
    if(e.target.closest('.cell')||e.target.closest('.rxhead')||e.target.closest('.rxfoot')) return;
    if(e.button!==0) return;
    var k=firstEmptyIndex();
    rngStart=rngEnd=k; rngDragging=true;
    var k2=cellEl(k);
    if(k2){ e.preventDefault(); k2.querySelector('.nm').focus(); }
  });
  $('sheetWrap').addEventListener('mousemove',function(e){
    if(!rngDragging) return;
    var c=e.target.closest?e.target.closest('.cell'):null;
    if(!c) return;
    rngEnd=+c.getAttribute('data-i');
    markRng();
  });
  window.addEventListener('mouseup',function(e){
    if(!rngDragging) return;
    rngDragging=false;
    /* 拖过多个格子 → 保持框选高亮，等右键删除 */
    if(rngStart!==rngEnd) markRng();
  });
  /* ---- 点选模式下点击格子 = 选中/取消 ---- */
  $('sGrid').addEventListener('click',function(e){
    if(!pickMode) return;
    var c=e.target.closest?e.target.closest('.cell'):null;
    if(!c) return;
    c.classList.toggle('picked');
    e.stopPropagation();
  });

  /* ---- 右键菜单 ---- */
  var sheetMenu=$('sheetMenu');
  function closeSheetMenu(){ sheetMenu.style.display='none'; }
  function openSheetMenu(x,y,html){
    sheetMenu.innerHTML=html;
    sheetMenu.style.display='block';
    var w=sheetMenu.offsetWidth, h=sheetMenu.offsetHeight;
    if(x+w>window.innerWidth-6) x=Math.max(4,window.innerWidth-w-6);
    if(y+h>window.innerHeight-6) y=Math.max(4,window.innerHeight-h-6);
    sheetMenu.style.left=x+'px'; sheetMenu.style.top=y+'px';
  }
  sheetMenu.addEventListener('click',function(e){
    var mi=e.target.closest('.mi'); if(!mi) return;
    var act=mi.getAttribute('data-act');
    closeSheetMenu();
    if(act==='all'){ setPickMode(true); }
    else if(act==='clearAll'){ clearAllCells(); growCells(); renderSheet(); recalc(); }
    else if(act==='delRng'){ deleteCells(rngIdxList()); clearRngMark(); }
    else if(act==='delPicked'){ deleteCells(pickedList()); setPickMode(false); }
    else if(act==='selAll'){ selectAllCells(); }
    else if(act==='delCell'){ var k=+mi.getAttribute('data-k'); if(clearCell(k)){ growCells(); renderSheet(); recalc(); toast('已删除该药'); } }
    else if(act==='pickMode'){ setPickMode(true); }
    else if(act==='exitPick'){ setPickMode(false); }
  });
  document.addEventListener('mousedown',function(e){
    /* 点别处：关闭候选框与右键菜单 */
    if(!e.target.closest('#acBox')) acHide();
    if(!e.target.closest('#sfxPick')) closeSfxPick();
    if(!e.target.closest('#sheetMenu')) closeSheetMenu();
  });

  $('sheetWrap').addEventListener('contextmenu',function(e){
    var c=e.target.closest?e.target.closest('.cell'):null;
    e.preventDefault();
    if(c){
      /* 有框选高亮 → 优先给「删除选中」 */
      var rng=rngIdxList();
      if(rng.length>1){
        openSheetMenu(e.clientX,e.clientY,
          '<div class="mi danger" data-act="delRng">删除选中的 '+rng.length+' 味</div>'
          +'<div class="mi" data-act="exitPick">退出框选</div>');
        return;
      }
      var k=+c.getAttribute('data-i');
      var picked=pickedList();
      if(pickMode||picked.length){
        openSheetMenu(e.clientX,e.clientY,
          '<div class="mi danger" data-act="delPicked">删除选中的 '+(picked.length||1)+' 味</div>'
          +'<div class="mi" data-act="exitPick">退出点选模式</div>');
        return;
      }
      openSheetMenu(e.clientX,e.clientY,
        '<div class="mi danger" data-act="delCell" data-k="'+k+'">删除这一味</div>'
        +'<div class="sep"></div>'
        +'<div class="mi" data-act="all">点选删除（可多选）</div>'
        +'<div class="mi" data-act="selAll">全选整张处方</div>'
        +'<div class="mi danger" data-act="clearAll">全部删除</div>');
      return;
    }
    /* 空白处右键 */
    var picked=pickedList();
    if(pickMode||picked.length){
      openSheetMenu(e.clientX,e.clientY,
        '<div class="mi danger" data-act="delPicked">删除选中的 '+picked.length+' 味</div>'
        +'<div class="mi" data-act="exitPick">退出点选模式</div>');
      return;
    }
    var rng=rngIdxList();
    if(rng.length>1){
      openSheetMenu(e.clientX,e.clientY,
        '<div class="mi danger" data-act="delRng">删除框选的 '+rng.length+' 味</div>'
        +'<div class="mi" data-act="exitPick">退出框选</div>');
      return;
    }
    openSheetMenu(e.clientX,e.clientY,
      '<div class="mi" data-act="all">点选删除（可多选）</div>'
      +'<div class="mi" data-act="selAll">全选整张处方 <span class="kk">Ctrl+A</span></div>'
      +'<div class="sep"></div>'
      +'<div class="mi danger" data-act="clearAll">全部删除（清空整张处方）</div>');
  });
  /* Esc：退出点选模式 / 关闭菜单与候选 */
  window.addEventListener('keydown',function(e){
    if(e.key!=='Escape') return;
    if(document.getElementById('sfxPick') && document.getElementById('sfxPick').style.display==='block'){ closeSfxPick(); return; }
    if(sheetMenu.style.display==='block'){ closeSheetMenu(); return; }
    if(pickMode){ setPickMode(false); return; }
    if(rngIdxList().length){ clearRngMark(); return; }
    acHide();
  });
  /* 点选模式下 Delete 删除选中项 */
  $('sGrid').addEventListener('keydown',function(e){
    if(e.key!=='Delete'&&e.key!=='Backspace') return;
    var picked=pickedList();
    if(pickMode||picked.length){
      if(!picked.length){ toastErr('请先点选要删除的药味'); return; }
      e.preventDefault();
      deleteCells(picked);
      setPickMode(false);
      return;
    }
    var rng=rngIdxList();
    if(rng.length>1){ e.preventDefault(); deleteCells(rng); clearRngMark(); }
  });
  $('sGrid').addEventListener('keydown',function(e){
    var inp=e.target;
    if(!inp.classList||(!inp.classList.contains('nm')&&!inp.classList.contains('ds'))) return;
    /* 整个药方全选：Ctrl+A（在药名或克数框内都可用）；已全选时 Delete 清空全部 */
    if((e.ctrlKey||e.metaKey) && (e.key==='a'||e.key==='A')){ e.preventDefault(); selectAllCells(); return; }
    if((e.key==='Delete'||e.key==='Backspace') && selAll){ e.preventDefault(); clearAllCells(); return; }
    /* 整格删除：Alt+Delete（或 Alt+Backspace）→ 药名/克数/尾缀 一次清干净 */
    if(e.altKey && (e.key==='Delete'||e.key==='Backspace')){
      e.preventDefault();
      var k=+inp.getAttribute('data-i');
      if(clearCell(k)){ toast('已删除该药'); growCells(); renderSheet(); recalc(); }
      return;
    }
    if(acList.length){
      if(e.key==='ArrowDown'){ e.preventDefault(); acMove(1); return; }
      if(e.key==='ArrowUp'){ e.preventDefault(); acMove(-1); return; }
      if(e.key==='Enter'){ e.preventDefault(); acAccept(); return; }
      if(e.key==='Escape'){ acHide(); return; }
    }
    if(e.key==='Enter'){ e.preventDefault(); inp.blur(); return; }
    if(e.key==='Tab'&&!e.shiftKey&&inp.classList.contains('ds')){
      e.preventDefault();
      var nx=cellEl((+inp.getAttribute('data-i'))+1);
      if(nx) nx.querySelector('.nm').focus();
      return;
    }
    if(e.key==='Tab'&&e.shiftKey&&inp.classList.contains('nm')){
      var k=+inp.getAttribute('data-i');
      if(k>0){ e.preventDefault(); cellEl(k-1).querySelector('.ds').focus(); }
      return;
    }
  });
  /* 粘贴：整段药方自动铺到格子里（含“药名 剂量g”任意排布） */
  function handlePaste(e){
    var t=e.target;
    if(!t||!t.closest) return;
    /* 只允许在「药味格子」内粘贴才解析药材；地址/姓名/费用等输入框的粘贴必须放行，
       否则地址文本会被当药材解析并写进处方（用户反馈的 bug） */
    if(!t.closest('.cell')) return;
    var txt='';
    try{ txt=(e.clipboardData||window.clipboardData).getData('text'); }catch(err){}
    if(!txt) return;
    var parsed=parseItems(txt);
    if(!parsed.length) return;
    e.preventDefault();
    var cell=t.closest('.cell');
    var start;
    if(parsed.length===1 && cell && t.classList.contains('nm')){
      start=+cell.getAttribute('data-i');
      // 单元格内单条：直接替换该格（覆盖原药名，不产生重名）
      var c=cellEl(start);
      c.querySelector('.nm').value=parsed[0].name;
      c.querySelector('.ds').value=doseText(parsed[0]);
      var sx0=c.querySelector('.sfx'); if(sx0) sx0.textContent='';
      c.classList.toggle('zibei',!!parsed[0].zibei);
      readCell(start);
    }else{
      start=(cell && !cell.querySelector('.nm').value.trim())?+cell.getAttribute('data-i'):firstEmptyIndex();
      for(var i=0;i<parsed.length;i++){
        var k=start+i;
        while(k>=items.length){ items.push(mkItem('',0,'',false)); }
      }
      growCells();
      renderSheet();
      for(var j=0;j<parsed.length;j++){
        var kk=start+j, cc=cellEl(kk); if(!cc) continue;
        cc.querySelector('.nm').value=parsed[j].name;
        cc.querySelector('.ds').value=doseText(parsed[j]);
        var sx=cc.querySelector('.sfx'); if(sx) sx.textContent='';
        cc.classList.toggle('zibei',!!parsed[j].zibei);
        readCell(kk);
      }
    }
    growCells();
    renderSheet();
    acHide();
    /* 粘贴后按原样铺开（不预先排版），保存时才排成一行三味 */
    if($('saveTip')) $('saveTip').textContent='已铺入 '+parsed.length+' 味（按原顺序）　点「保存」后自动排成一行三味';
    toast('已铺入 '+parsed.length+' 味药，点「保存」自动排版');
    recalc();
  }
  $('rxSheet').addEventListener('paste',handlePaste);
  document.addEventListener('paste',function(e){
    if(!e.defaultPrevented && $('sheetWrap').contains(e.target)) handlePaste(e);
  });
  $('acBox').addEventListener('mousedown',function(e){
    var el=e.target.closest('.ai'); if(!el) return;
    e.preventDefault();
    acAccept(+el.getAttribute('data-i'));
  });
  /* 双击候选也可选中 */
  $('acBox').addEventListener('dblclick',function(e){
    var el=e.target.closest('.ai'); if(!el) return;
    e.preventDefault();
    acAccept(+el.getAttribute('data-i'));
  });

  /* 处方笺表头 / 按钮 */
  /* 保存按钮防连点：1.2 秒内重复点击直接忽略。
   原因（2026-10-07 00:30 事故）：用户 4 分钟内点了 20 多次保存，
   每次都新建一条，云端一度出现 72 条同一张方子（57 条完全重复）。
   保存本来就该幂等——「已保存的单」再次保存应当是覆盖，不该新建。 */
var saveLastClick=0;
$('btnSave').onclick=function(){
  var t=Date.now();
  if(t-(saveLastClick||0)<1200){ toastErr('刚保存过，稍等一下再点'); return; }
  saveLastClick=t;
  saveRx();
};
  $('btnCopy').onclick=copyRx;
  $('btnContinue').onclick=continueRx;
  $('btnShot').onclick=copyRxImage;
  $('btnPrint').onclick=printRx;
  $('btnShotR').onclick=copyReceiptImage;
  $('btnClearSheet2').onclick=clearSheet;
  ['fJishu','fProcess','fGoods','fDaijian','fPaotui','fExpress','fKuaidi'].forEach(function(id){
    $(id).addEventListener('input',function(){ recalc(); });
    $(id).addEventListener('change',function(){ recalc(); });
  });
  /* 手改「单剂药费」时，把差额按各行金额比例回写到清单单价，
     保证「清单金额相加」与「处方合计」永远一致（改单价仍以清单为准） */
  $('fPerDose').addEventListener('input',function(){
    fitMoneyInputs();
    recalc();
    if(!priced) return;
    var want=n($('fPerDose').value), cur=priceListStats().tot;
    if(!(cur>0) || want===cur) return;
    var k=(want>0)?(want/cur):0, L=filledItems(), touched=false;
    for(var i=0;i<L.length;i++){
      var it=L[i]; if(it.zibei) continue;
      var p=priceOf(it);
      if(p==null) continue;
      if(it.dp!=null && it.dp!==''){ it.dp=n(it.dp)*k; touched=true; }
      else { it.price=(it.price!=null&&it.price!=='')?n(it.price)*k:p*k; touched=true; }
    }
    if(touched) renderPriceList();
  });
  ['cbProcess','cbDaijian','cbPaotui','cbExpress','cbKuaidi','cbGoods'].forEach(function(id){
    $(id).onchange=function(){ recalc(); };
  });
  ['fName','fDate','fSex','fAge','fPhone','fNote'].forEach(function(id){
    $(id).addEventListener('input',function(){ syncRecordSoon(); });
  });
  /* 备注常用词：下拉选择 / 新增 / 删除 */
  $('noteToggle').onclick=function(e){ e.preventDefault(); e.stopPropagation(); noteMenuToggle(); };
  $('fNote').addEventListener('focus',function(){ noteMenuToggle(true); });
  $('fNote').addEventListener('input',function(){
    var menu=$('noteMenu');
    if(menu && menu.style.display==='block') renderNoteMenu();   /* 刷新「+新增」用当前内容 */
  });
  /* ---- 配送地址：姓名联动 + 跑腿/闪送价 + 复制（清单常显，无下拉开关） ---- */
  $('fName').addEventListener('input',function(){
    syncRecordSoon();
    /* 换人 → 地址清单跟着换，地址框清空（避免把别人的地址带到新单） */
    if($('fAddr')) $('fAddr').value='';
    if(typeof addrSummary==='function') addrSummary();
    if(ADDR_OPEN) renderAddrMenu();
  });
  $('addrAdd').onclick=function(){
    var a=$('fAddr').value.trim();
    if(!a){ toastErr('请先填写地址'); $('fAddr').focus(); return; }
    if(!$('fName').value.trim()){ toastErr('请先填写姓名'); $('fName').focus(); return; }
    var pt=$('fAddrPt').value.trim(), ex=$('fAddrEx').value.trim();
    addAddr($('fName').value, a, pt, ex);
    $('fAddr').value=''; $('fAddrPt').value=''; $('fAddrEx').value='';
    renderAddrMenu(); addrSummary();
    toast('已保存该地址（'+a+'）');
  };
  $('addrFold').onclick=function(){ addrFold(); };
  $('addrClear').onclick=function(){
    if(!$('fAddr').value.trim()){ toastErr('地址栏本来就是空的'); return; }
    $('fAddr').value=''; addrSummary(); $('fAddr').focus();
    toast('已清空地址栏');
  };
  $('addrMenu').addEventListener('input',function(e){
    /* 改价：在清单里直接改跑腿/闪送价，input 时实时保存（mousedown 读不到已改的值） */
    var pi=e.target.closest('[data-pt]'), ei=e.target.closest('[data-ex]');
    if(pi||ei){
      var idx=+(pi?pi.getAttribute('data-pt'):ei.getAttribute('data-ex'));
      var list=addrsOf($('fName').value.trim());
      if(!list[idx]) return;
      addAddr($('fName').value.trim(), list[idx].a,
        pi?pi.value:list[idx].p, ei?ei.value:list[idx].e);
      toast('已保存该地址价格');
      return;
    }
    /* 改地址文字：就地改名（不重排，避免输入时行号漂移）；失焦时再整表刷新 */
    var ed=e.target.closest('[data-edit]');
    if(ed){
      var ei2=+ed.getAttribute('data-edit');
      var L2=addrsOf($('fName').value.trim());
      if(!L2[ei2]) return;
      if(renameAddr($('fName').value.trim(), L2[ei2].a, ed.value)) toast('已保存该地址');
      return;
    }
  });
  $('addrMenu').addEventListener('change',function(e){
    /* 地址文字改完（失焦/回车）→ 整表刷新，行号与 data-* 重新对齐 */
    if(e.target.closest('[data-edit]')){ renderAddrMenu(); recalc(); }
  });
  $('addrMenu').addEventListener('mousedown',function(e){
    var del=e.target.closest('[data-del]');
    if(del){
      e.preventDefault();
      var L=addrsOf($('fName').value.trim());
      var k=+del.getAttribute('data-del');
      if(!L[k]) return;
      if(!confirm('删除地址「'+L[k].a+'」？\n会同时删除本机和云端数据库里的这个地址，不影响历史处方。')) return;
      delAddr($('fName').value.trim(), L[k].a);
      if($('fAddr').value.trim()===L[k].a) $('fAddr').value='';
      renderAddrMenu();
      toast('已删除地址：'+L[k].a);
      return;
    }
    var cp=e.target.closest('[data-copy]');
    if(cp){ e.preventDefault(); copyAddr(cp.getAttribute('data-copy')); return; }
    var pk=e.target.closest('[data-pick]');
    if(pk){ e.preventDefault(); useAddr(pk.getAttribute('data-pick'), pk.getAttribute('data-kind')||''); }
  });
  $('noteMenu').addEventListener('mousedown',function(e){
    var del=e.target.closest('[data-del]');
    if(del){
      e.preventDefault();
      var list=loadNotes();
      var i=+del.getAttribute('data-del');
      var val=list[i];
      list.splice(i,1);
      saveNotes(list);
      supaDelNoteRow(val);      /* → 云端 notes 表同步删除 */
      if($('fNote').value.trim()===val) $('fNote').value='';
      renderNoteMenu(); recalc(); syncRecordSoon();
      toast('已删除常用备注：'+(val||'（空）'));
      return;
    }
    var add=e.target.closest('[data-add]');
    if(add){
      e.preventDefault();
      var v=$('fNote').value.trim();
      if(!v){ toastErr('先在输入框里写好要新增的备注'); $('fNote').focus(); return; }
      var l2=loadNotes();
      if(l2.indexOf(v)>=0){ toastErr('已存在：'+v); return; }
      l2.push(v);
      saveNotes(l2);
      supaPushNotes(l2);        /* → 云端 notes 表 */
      renderNoteMenu();
      toast('已新增常用备注：'+v);
      return;
    }
    var pick=e.target.closest('[data-pick]');
    if(pick){
      e.preventDefault();
      $('fNote').value=pick.getAttribute('data-pick');
      noteMenuToggle(false);
      recalc(); syncRecordSoon();
    }
  });
  document.addEventListener('mousedown',function(e){
    var menu=$('noteMenu');
    if(!menu || menu.style.display!=='block') return;
    /* 菜单展开时被搬到了 body 下，closest('.notewrap') 判不到 ——
       要把「菜单本身」和「触发它的输入框/按钮」都算作内部点击。 */
    if(menu.contains(e.target)) return;
    if(e.target.closest && e.target.closest('.notewrap')) return;
    noteMenuToggle(false);
  });

  /* 右侧药品目录：点一下插入到第一个空格 */
  $('dSearch').addEventListener('input',renderDrugList);
  /* 药品目录：双击词条才插入（单击只选中，不误插） */
  function insertDrug(d, typedQty, spec){
    if(!d) return;
    var k=firstEmptyIndex(), c=cellEl(k);
    if(!c){ toastErr('处方笺已满'); return; }
    /* 数量优先用浮层/右侧「数量」框填的内容，否则用该规格的常用量 */
    var u=(spec&&spec.unit)?spec.unit:(d.u||'g');
    var pr=(spec?spec.p:d.p);
    var amt=(spec?(spec.amt==null?'':spec.amt):d.c);
    var typed=(typedQty==null?String($('dDose').value||''):String(typedQty)).trim();
    var qtyTxt;
    if(typed) qtyTxt=typed+(/^[\d.]+$/.test(typed)?u:'');
    else qtyTxt=((amt!=null&&amt!=='')?amt:'10')+u;
    var sp=splitSfx(d.n);
    c.querySelector('.nm').value=sp.nm;
    c.querySelector('.ds').value=qtyTxt;
    var sx=c.querySelector('.sfx'); if(sx) sx.textContent=sfxText(sp.sfx);   /* 去方括号 */
    c.classList.remove('zibei');
    /* 记录选中的单位与该单位的价格，计价按它算 */
    var it=items[k];
    if(it){ it.du=u; it.dp=(pr!=null&&pr!=='')?n(pr):null; }
    readCell(k);
    growCells(); fitAllCells(); recalc();
    $('dDose').value='';
    toast('已插入：'+d.n+' '+qtyTxt+'（'+u+'）');
  }
  $('dBody').addEventListener('click',function(e){
    var tr=e.target.closest('tr'); if(!tr) return;
    var nodes=$('dBody').querySelectorAll('tr');
    for(var i=0;i<nodes.length;i++) nodes[i].classList.remove('sel');
    tr.classList.add('sel');
  });
  /* ---- 双击药品 → 药名下方浮出「克数」输入层 ----
     浮层 position:fixed，不占列表高度，下一味药不会下移；
     输入框自动聚焦，回车或点绿色 ✓ 插入处方；点其他地方 / Esc / 滚动即消失。 */
  var _dosePop=null;
  function dosePopAway(e){
    if(_dosePop && e && _dosePop.contains(e.target)) return;
    dosePopClose();
  }
  function dosePopClose(){
    if(!_dosePop) return;
    if(_dosePop.parentNode) _dosePop.parentNode.removeChild(_dosePop);
    _dosePop=null;
    document.removeEventListener('mousedown',dosePopAway,true);
    window.removeEventListener('scroll',dosePopClose,true);
    window.removeEventListener('resize',dosePopClose);
  }
  function dosePopOpen(d, anchor, spec){
    dosePopClose();
    if(!d || !anchor) return;
    var u=(spec&&spec.unit)?spec.unit:(d.u||'g');
    var pop=document.createElement('div');
    pop.className='dose-pop';
    pop.innerHTML='<input class="dose-pop-in" type="text" inputmode="decimal" autocomplete="off" placeholder="数量（'+esc(u)+'）">'
      +'<button type="button" class="dose-pop-ok" title="确认并插入处方" aria-label="确认">'
      +'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4l3.1 3.1L13 4.7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      +'</button>';
    document.body.appendChild(pop);
    var r=anchor.getBoundingClientRect(), W=170, H=44;
    var left=Math.max(8, Math.min(r.left, window.innerWidth-W-8));
    var top=r.bottom+6;
    if(top+H>window.innerHeight-8) top=Math.max(8, r.top-H-6);
    pop.style.left=left+'px'; pop.style.top=top+'px';
    _dosePop=pop;
    var inp=pop.querySelector('.dose-pop-in');
    function ok(){
      var v=String(inp.value||'').trim();
      var dd=d, ss=spec;
      dosePopClose();
      insertDrug(dd, v, ss);
    }
    pop.querySelector('.dose-pop-ok').addEventListener('click',ok);
    inp.addEventListener('keydown',function(e){
      if(e.key==='Enter'){ e.preventDefault(); ok(); }
      else if(e.key==='Escape'){ e.preventDefault(); dosePopClose(); }
    });
    try{ inp.focus(); inp.select(); }catch(e){}
    setTimeout(function(){ document.addEventListener('mousedown',dosePopAway,true); },0);
    window.addEventListener('scroll',dosePopClose,true);
    window.addEventListener('resize',dosePopClose);
  }
  /* 双击某一行 = 插入该行对应的规格（单位 / 零售价都按这一行） */
  function specOfRow(tr){
    var d=drugsList[+tr.getAttribute('data-i')];
    if(!d) return {d:null,spec:null};
    var s=+(tr.getAttribute('data-s')||0);
    return {d:d, spec:dmSpecsOf(d)[s]||null};
  }
  $('dBody').addEventListener('dblclick',function(e){
    var tr=e.target.closest('tr'); if(!tr || tr.classList.contains('dgroup')) return;
    e.preventDefault();
    var x=specOfRow(tr);
    dosePopOpen(x.d, tr.querySelector('td.nw')||tr, x.spec);
  });
  /* 药名输入：回车跳到「克数」框；克数框回车则插入第一条匹配 */
  $('dSearch').addEventListener('keydown',function(e){
    if(e.key==='Enter'){ e.preventDefault(); $('dDose').focus(); $('dDose').select(); }
  });
  $('dDose').addEventListener('keydown',function(e){
    if(e.key==='Enter'){
      e.preventDefault();
      var tr=$('dBody').querySelector('tr[data-i]');
      if(tr){ var x=specOfRow(tr); insertDrug(x.d, null, x.spec); }
      else toastErr('先在上方输入药名');
    }
  });

  /* 药物维护 */
  /* 搜索框右侧清除按钮：有内容才出现（.has），点一下清空 + 重新过滤 + 光标留在框内 */
  var _dmSBox=$('dmSearchBox'), _dmSInput=$('dmSearch'), _dmSClear=$('dmSearchClear');
  function dmSyncClearBtn(){
    if(!_dmSBox) return;
    if(_dmSInput.value) _dmSBox.classList.add('has'); else _dmSBox.classList.remove('has');
  }
  if(_dmSClear){
    /* mousedown 阻止默认，避免先失焦再 focus 造成闪烁 */
    _dmSClear.addEventListener('mousedown',function(e){ e.preventDefault(); });
    _dmSClear.addEventListener('click',function(e){
      e.preventDefault(); e.stopPropagation();
      _dmSInput.value=''; dmFilter='';
      for(var i=0;i<drugsList.length;i++){ if(drugsList[i]) delete drugsList[i].__fresh; }
      dmSyncClearBtn();
      renderDrugTable();
      try{ _dmSInput.focus({preventScroll:true}); }catch(err){ _dmSInput.focus(); }
    });
  }
  dmSyncClearBtn();
  $('dmSearch').addEventListener('input',function(){
    dmFilter=this.value;
    /* 用户主动改搜索词了 → 之前靠 __fresh 强行留在列表里的新行不再特权，
       按新搜索词正常过滤（该出现就出现、该消失就消失）。 */
    for(var i=0;i<drugsList.length;i++){ if(drugsList[i]) delete drugsList[i].__fresh; }
    dmSyncClearBtn();
    renderDrugTable();
  });
  $('dmBody').onclick=function(e){
    /* 组尾「＋ 添加新规格」 */
    var as=e.target.closest('.dm-addspec');
    if(as){ e.preventDefault(); e.stopPropagation();
      dmAddSpec(+as.getAttribute('data-i')); return; }
    /* 子规格行上的「×」= 删掉这一条规格 */
    var sd=e.target.closest('.dm-specdel');
    if(sd){ e.preventDefault(); e.stopPropagation();
      dmDelSpec(+sd.getAttribute('data-del'), +sd.getAttribute('data-s')); return; }
    /* 每行的「详情 / 删除」按钮（优先级最高，不进入行内编辑） */
    var btn=e.target.closest('button[data-act]');
    if(btn){
      e.preventDefault(); e.stopPropagation();
      var bi=+btn.getAttribute('data-i');
      if(btn.getAttribute('data-act')==='detail') Drug.openDetail(bi);
      else dmDelByIdx(bi);
      return;
    }
    var tr=e.target.closest('tr'); if(!tr) return;
    selDrugRow=+tr.getAttribute('data-i');
    var td=e.target.closest('td');
    if(!td||!tr) return;
    /* 先记住点击落点在文字里的位置：编辑框打开后光标就停在点的地方
       （点名中间插字，不用再从末尾按左箭头挪回来） */
    var off=dmCaretOffset(td, e.clientX, e.clientY);
    dmStartEdit(td,tr);
    if(off!=null && !/^(bp|dp|p|wp|st|c|dw)$/.test(td.getAttribute('data-f')||'')){
      var inp=td.querySelector('input');
      if(inp){ try{ inp.setSelectionRange(off,off); }catch(e2){} }
    }
  };
  /* 悬停整味药：同一 data-i 的所有规格行一起高亮（CSS 的 :hover 只能命中一行）。
     选中行不再染绿，这里的 .dm-hov 就是唯一的行高亮来源。 */
  var _dmHovIdx=null;
  window.__dmHoverReset=function(){ _dmHovIdx=null; };
  window.dmHoverGroup=function(i){
    var on=$('dmBody').querySelectorAll('tr.dm-hov');
    if(i===_dmHovIdx && (on.length || i==null)) return;
    for(var q=0;q<on.length;q++) on[q].classList.remove('dm-hov');
    _dmHovIdx=i;
    if(i==null) return;
    var mine=$('dmBody').querySelectorAll('tr[data-i="'+i+'"]');
    for(var w=0;w<mine.length;w++) mine[w].classList.add('dm-hov');
  };
  $('dmBody').addEventListener('mouseover',function(e){
    var tr=e.target.closest('tr[data-i]');
    if(tr) window.dmHoverGroup(tr.getAttribute('data-i'));
  });
  $('dmBody').addEventListener('mouseleave',function(){ window.dmHoverGroup(null); });
  /* 表格渲染时用不到 data-i，所以插入/定位都靠它 */
  $('dmAdd').onclick=function(){
    /* 「添加」= 在目录末尾**新增一条真正的空记录**，绝不复用任何已有行的编辑逻辑。
       ⚠ 2026-10-08 修复的老 bug：这里原来 unshift 完就
       querySelector('tr td[data-f="n"]') 取「第一行」开编辑框，
       而表格是按拼音排序渲染的（空行没拼音 → 排在最末），
       于是编辑框开到了「艾草黄」那一行，一输入就把艾草黄改名了。
       现在改成按新记录的真实下标 data-i 精确定位它自己的那一行。
       ⚠ 2026-10-08 用户新要求：新增行要跟着搜索结果走 ——
       有搜索结果时紧跟最后一条搜索结果，没有搜索结果时才在全部列表底部。
       实现：不再清空搜索词，靠 dmSortRows() 把 __new 行统一排到末尾 +
             dmMatchFilter() 让 __new 行不被搜索词滤掉，两种场景都自动落在末尾。 */
    var d={n:'',c:'',u:'g',tc:'',py:'',dw:'',cat:dmCurTab,bp:'',dp:'',p:'',st:'',og:'',al:[],un:[],__new:true,__fresh:true};
    drugsList.push(d);
    var idx=drugsList.length-1;
    buildIndex(); selDrugRow=idx; renderDrugTable();
    var tr=$('dmBody').querySelector('tr[data-i="'+idx+'"]');
    if(!tr){ toast('已添加一行，请在表格末尾查找'); return; }
    try{ tr.scrollIntoView({block:'center'}); }catch(e){}
    var td=tr.querySelector('td[data-f="n"]');
    if(td) dmStartEdit(td,tr);
    toast(dmFilter?('已在 '+dmRows().length+' 条搜索结果末尾新增一行，直接输入药名')
                  :'已在全部列表末尾新增一行，直接输入药名');
  };
  /* 顶部「删除」= 删掉当前选中行；行内每行也有独立的「删除」 */
  $('dmDel').onclick=function(){ dmDelByIdx(selDrugRow); };
  $('dmExpDrug').onclick=function(){ download('药物明细.csv', toCSV(drugsList,['n','c','u','tc','py','dw','cat','bp','wp','p','st']), 'text/csv'); };
  $('dmExpStock').onclick=function(){
    /* 一药多规格 → 按规格逐条导出（只导 d.st 会把 盒 / 个 的库存漏掉） */
    var rows=[];
    for(var i=0;i<drugsList.length;i++){
      var d=drugsList[i]; if(!d||!d.n) continue;
      var sp=dmSpecsOf(d);
      for(var j=0;j<sp.length;j++){
        rows.push({n:d.n, u:sp[j].unit, st:(sp[j].st==null?'':sp[j].st), og:d.og||''});
      }
    }
    download('库存.csv', toCSV(rows,['n','u','st','og']), 'text/csv');
  };
  /* 药物详情抽屉（入口只保留在每行的「详情」按钮上） */
  $('ddClose').onclick=function(){ $('mDrugDetail').classList.remove('on'); };
  $('ddSave').onclick=function(){ Drug.ddSave(); };
  $('ddAddUnit').onclick=function(){ Drug.ddAddUnit(); };
  $('ddSugWp').onclick=function(){ Drug.ddSuggest('wp'); };
  $('ddSugP').onclick=function(){ Drug.ddSuggest('p'); };
  /* 进货价变动 → 按各自倍率更新对应价格；某一行倍率变动 → 只联动该行 */
  $('ddBp').oninput=function(){ Drug.calcWholesale(); Drug.ddMarkLow(); };
  $('ddRateWp').oninput=function(){ Drug.applyRate('wp'); Drug.ddMarkLow(); };
  $('ddRateP').oninput=function(){ Drug.applyRate('p'); Drug.ddMarkLow(); };
  /* 手动改零售/批发价 → 实时判断是否低于建议价（橙色高亮） */
  $('ddP').oninput=function(){ Drug.ddMarkLow(); };
  $('ddWp').oninput=function(){ Drug.ddMarkLow(); };
  /* 重要客人价格：名单增删改 + 价格/倍率编辑 */
  $('ddGuestAdd').onclick=function(){ Drug.ddGuestAdd(); };
  /* 客人价格手动输入时实时判断是否低于建议价（失焦才落库，输入中只做高亮） */
  $('ddGuest').addEventListener('input', function(e){
    if(e.target.getAttribute('data-gp')){ Drug.ddMarkLow(); }
  });
  $('ddGuest').addEventListener('change', function(e){
    var gp=e.target.getAttribute('data-gp');
    var gr=e.target.getAttribute('data-gr');
    if(gp){ Drug.ddGuestPriceChange(gp, e.target); }
    if(gr){ Drug.ddGuestRateChange(gr, e.target); }
  });
  $('ddGuest').addEventListener('click', function(e){
    var rn=e.target.getAttribute('data-gren');
    var dl=e.target.getAttribute('data-gdel');
    if(rn){ Drug.ddGuestRename(rn); }
    if(dl){ Drug.ddGuestDel(dl); }
  });
  /* 单位改动 → 价格卡片右上角的「元 / g」跟着变 */
  $('ddUnit').oninput=function(){ var u=(this.value||'').trim()||'g'; $('ddPUnit').textContent=u; };
  /* 中药分类：可搜索下拉 */
  (function(){
    var inp=$('ddTc'), list=$('ddTcList');
    if(!inp||!list) return;
    inp.addEventListener('focus',function(){ tcOpen(); });
    inp.addEventListener('input',function(){ tcRender(inp.value); tcPlace(); list.classList.add('on'); });
    (function(){
      var body=$('mDrugDetail').querySelector('.body');
      if(body) body.addEventListener('scroll',function(){ tcClose(); });
      window.addEventListener('resize',function(){ tcClose(); });
    })();
    inp.addEventListener('keydown',function(e){
      if(e.key==='ArrowDown'){ e.preventDefault(); if(!list.classList.contains('on')){ tcOpen(); } else { tcMove(1); } }
      else if(e.key==='ArrowUp'){ e.preventDefault(); tcMove(-1); }
      else if(e.key==='Enter'){
        if(list.classList.contains('on')){
          var act=list.querySelector('.dd-ci.act');
          if(act){ e.preventDefault(); tcPick(act.getAttribute('data-v')); }
        }
      }
      else if(e.key==='Escape'){ tcClose(); }
    });
    inp.addEventListener('blur',function(){ setTimeout(function(){ if(!list.contains(document.activeElement)) tcClose(); },120); tcSetVal(tcGet()); });
    list.addEventListener('mousedown',function(e){
      var it=e.target.closest('.dd-ci'); if(!it) return;
      e.preventDefault(); tcPick(it.getAttribute('data-v'));
    });
    document.addEventListener('click',function(e){
      if(!$('ddTcCombo').contains(e.target)) tcClose();
    });
  })();
  $('ddUnits').onclick=function(e){
    var x=e.target.closest('.xu'); if(!x) return;
    Drug.ddDelUnit(+x.getAttribute('data-del'), x.getAttribute('data-u'));
  };

  /* 价格清单 */
  $('plBody').onclick=function(e){
    var td=e.target.closest('td'); if(!td) return;
    var tr=e.target.closest('tr'); if(!tr) return;
    if(td.getAttribute('data-edit')) plStartEdit(td,tr);
  };
  $('plAuto').onclick=function(){
    var L=filledItems();
    if(!L.length){ toastErr('处方为空，请先粘贴药方'); return; }
    /* 划价前**实时拉一次云端药价目录**（2026-10-25 用户要求）：
       本机 rx_drugs_v3 可能是旧价（换设备改价没同步过来 / 上次加载失败），
       先读库再划价，结果才严格等于当前库价。拉取失败只是退回本机目录并告知。 */
    var go=function(fromCloud){
      var miss=autoPrice();
      priced=true;
      $('fPerDose').value=money(perDoseFee());
      renderSheet(); renderPriceList(); renderDrugList();
      if(curRec) syncRecordSoon();
      toast((fromCloud?'':'（云端药价拉取失败，本次按本机目录划价）')+
            (miss.length?('自动划价完成；未匹配到目录价：'+miss.slice(0,5).join('、')+(miss.length>5?'…':'')):'自动划价完成，已在清单中列出'));
    };
    if(SUPA.on){
      SUPA.loadDrugs(true).then(function(){ go(true); })
      .catch(function(e){ console.warn('划价前拉取云端药价失败，改用本机目录:', e.message); go(false); });
    } else { go(false); }
  };
  $('plFa').onclick=function(){ setFa('【发】'); };
  $('plUnfa').onclick=function(){ setFa(''); };
  $('plPrint').onclick=printList;
  $('plShot').onclick=copyListImage;
}
/* 右侧目录渲染 */
function renderDrugList(){
  var f=$('dSearch').value.trim();
  var fl=f.toLowerCase();
  var out=[], all=0, skipped=0;
  for(var i=0;i<drugsList.length;i++){
    var d=drugsList[i];
    if((d.cat||'')!=='中药') continue;              /* 药品目录只收中药 */
    if(!String(d.n||'').trim()) continue;            /* 「添加」后还没填药名的空行不进目录 */
    if(hasDoseInName(d.n)){ skipped++; continue; }   /* 跳过「山药10g」这类脏数据 */
    all++;
    if(fl){ var hay=((d.n||'')+' '+(d.py||'')).toLowerCase(); if(hay.indexOf(fl)<0) continue; }
    out.push({i:i,d:d});
  }
  out=dmSortRows(out);              /* A-Z 排序（2026-10-07 用户要求） */
  if(out.length>300) out.length=300;
  var h='', lastInit='';
  for(var r=0;r<out.length;r++){
    var d=out[r].d, nm=esc(d.n);
    /* 分组：按拼音首字母（无拼音则归到 #），纯视觉分组，不影响筛选与点击 */
    var ini=String(d.py||'').charAt(0).toUpperCase();
    if(!/^[A-Z]$/.test(ini)) ini='#';
    if(ini!==lastInit){
      h+='<tr class="dgroup"><td colspan="6"><span>'+ini+'</span></td></tr>';
      lastInit=ini;
    }
    /* 关键词高亮（仅高亮药名中的匹配片段） */
    if(fl){
      var low=String(d.n||'').toLowerCase(), pos=low.indexOf(fl);
      if(pos>=0){
        nm=esc(String(d.n).slice(0,pos))+'<b>'+esc(String(d.n).slice(pos,pos+fl.length))+'</b>'+esc(String(d.n).slice(pos+fl.length));
      }
    }
    /* 四档价格与「药物管理」模块同源，并且**按规格逐条列出**：
       dmSpecsOf(d) = 主规格（d.p/wp/bp + dmSuggestOf）+ d.un 里的每个子规格
       （各自带 单位 / 零售价 / 批发价 / 进货价 / 建议价），与药物管理表一致。 */
    var specs=dmSpecsOf(d);
    if(!specs.length) specs=[{s:0,unit:(d.u||'g'),amt:(d.c==null?'':d.c),p:(d.p==null?'':d.p),
                              wp:(d.wp==null?'':d.wp),bp:(d.bp==null?'':d.bp),sg:dmSuggestOf(d)}];
    for(var si=0;si<specs.length;si++){
      var sp=specs[si];
      var unit=sp.unit||'g';
      var pv=(sp.p==null?'':sp.p), wpv=(sp.wp==null?'':sp.wp), bpv=(sp.bp==null?'':sp.bp);
      var sg=(sp.sg==null?'':sp.sg);
      var low=(wpv!=='' && sg!=='' && isFinite(parseFloat(wpv)) && isFinite(parseFloat(sg)) &&
               parseFloat(wpv)<parseFloat(sg)-1e-9);
      var tt=d.n+'　单位 '+unit+'　零售价 '+(pv||'—')+' 元/'+unit+
             '　批发价 '+(wpv||'—')+' 元/kg　进货价 '+(bpv||'—')+' 元/kg　建议价 '+(sg||'—')+' 元/kg'+
             '　常用量 '+(sp.amt==null||sp.amt===''?'—':sp.amt)+
             (specs.length>1?'（多规格 '+(si+1)+'/'+specs.length+'）':'');
      h+='<tr data-i="'+out[r].i+'" data-s="'+sp.s+'" title="'+esc(tt)+'">'
        +'<td class="nw">'+nm+'</td>'
        +'<td class="un">'+esc(unit)+'</td>'
        +'<td class="num bold">'+esc(pv)+'</td>'
        +'<td class="num bold'+(low?' low':'')+'">'+esc(wpv)+'</td>'
        +'<td class="num">'+esc(bpv)+'</td>'
        +'<td class="num">'+esc(sg)+'</td></tr>';
    }
  }
  $('dBody').innerHTML=h||'<tr><td colspan="6" style="padding:0;border:none">'+rxEmptyHTML(
        '没有匹配的药物','换个药名试试，或到「药物管理」里添加')+'</td></tr>';
  $('dStat').textContent='中药 '+all+' 味'+(fl?('　匹配 '+out.length):'')+(out.length>=300?'（前300条）':'')+(skipped?('　已隐藏 '+skipped+' 条名称含剂量的无效条目'):'');
}
/* 下载 / CSV */
function toCSV(list,keys){
  var lines=[keys.join(',')];
  for(var i=0;i<list.length;i++){
    lines.push(keys.map(function(k){
      var v=list[i][k]; v=(v==null?'':String(v));
      return /[",\n]/.test(v)?('"'+v.replace(/"/g,'""')+'"'):v;
    }).join(','));
  }
  return '\ufeff'+lines.join('\r\n');
}
function download(name,text,mime){
  var b=new Blob([text],{type:mime+';charset=utf-8'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(b); a.download=name; a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); },2000);
}
/* ============ 数据备份 / 迁移（已移除：纯云端，无需本地备份） ============ */
function refreshStorageStat(){
  var a=$('stSaved'), b=$('stDrugs');
  if(a) a.textContent=SAVED.length;
  if(b) b.textContent=drugsList.length;
}
/* ---------- CSV 编码兜底：Excel 导出的是 GBK，浏览器只认 UTF-8 ----------
   只用 readAsText(file,'utf-8') 时，GBK 字节会被解成 U+FFFD，中文全丢，
   表头匹配不到任何药名 →「导入完成：0 条」（用户 2026-10-06 19:26 遇到）。
   这里读成 ArrayBuffer，先按 UTF-8 严格解码，失败再退回 GBK。 */
var _gbkDecoder=null;
function decodeCsvBuffer(buf){
  var u8=new Uint8Array(buf);
  /* UTF-8 严格解码：失败会抛错，正好用来判断不是 UTF-8 */
  try{
    var t=new TextDecoder('utf-8',{fatal:true}).decode(u8);
    /* 即使解出来了，若含大量替换字符也当作不是 UTF-8 */
    if(t.indexOf('\ufffd')<0) return t;
  }catch(e){}
  if(!_gbkDecoder){ try{ _gbkDecoder=new TextDecoder('gbk'); }catch(e2){ _gbkDecoder=null; } }
  if(_gbkDecoder) return _gbkDecoder.decode(u8);
  /* 极老浏览器没有 gbk 解码器时，至少把坏字符换掉，别整篇丢弃 */
  return new TextDecoder('utf-8').decode(u8);
}
/* 统一的文本文件读取入口 */
function readCsvFile(file, cb){
  var fr=new FileReader();
  fr.onload=function(){ cb(decodeCsvBuffer(fr.result)); };
  fr.onerror=function(){ toast('读取文件失败'); };
  fr.readAsArrayBuffer(file);
}
function init(){
  loadSet();
  sfxLoad();          /* 云端 KV 已在启动时载入内存 */
  loadDrugs();
  /* 处方/客人数据全部在 supaBoot 里从 Supabase 拉取；启动时先保持为空。 */
  SAVED=[];
  HIST_EDIT={};
  try{ HIST_EDIT=JSON.parse(RX_STORE.getItem(LS_HISTEDIT)||'{}'); }catch(e){ HIST_EDIT={}; }
  bind();
  agentPing().then(agentTips);
  setInterval(function(){ agentPing().then(agentTips); }, 30000);
  rxWatchResize();
  vsBind();
  navInit();
  renderTabs();
  newRx();
  defaultRange();   /* 默认 2023-01-01 起至今天 */
  loadDoctors();
  renderDrugList();
  renderPriceList();
  /* ---- 连接 Supabase：历史处方、药价、客人、地址、备注全部以云端为准 ---- */
  supaBoot();
}

/* ================= Supabase 启动与写回 ================= */
/* 加载失败时在界面上明确显示，别只console.warn——
   用户看到"单价全是 0"却不知道是数据库没连上，这是今天最费时间的地方。 */
function supaLoadFail(kind, msg){
  try{
    var box=document.getElementById('supaWarn');
    if(!box){
      box=document.createElement('div');
      box.id='supaWarn';
      box.style.cssText='position:fixed;left:0;right:0;top:0;z-index:99998;background:#fff4e5;'
        +'color:var(--aux);border-bottom:2px solid #e8a33d;padding:9px 14px;'
        +'font:var(--fs-cap,12px)/1.6 sans-serif;text-align:center';
      document.body.appendChild(box);
    }
    var label={hist:'历史处方', newRx:'你新录的处方', drugs:'药价目录'}[kind]||kind;
    box.textContent='⚠ '+label+'没能从云端加载：'+msg+'　（页面会按空数据显示，不会读取本地内置数据）';
  }catch(e){}
}
function supaBoot(){
  /* 本地文件打开时浏览器会拦掉跨域请求，什么也读不到。
     直接点名告诉用户，别让他对着空列表猜。 */
  if(location.protocol==='file:'){
    supaLoadFail('全部','当前是本地文件模式，浏览器禁止它访问网络。请改用网址打开');
    return;
  }
  SUPA.ping().then(function(){
    SUPA.probeExt();   /* 探一次云端有没有 wp/rates 列（不阻塞主流程） */
    return Promise.all([
      SUPA.loadHist().catch(function(e){ console.warn('历史处方拉取失败:', e.message); supaLoadFail('hist', e.message); return 0; }),
      /* 新录的处方必须从云端读回来，否则换个设备就看不到自己录的东西 */
      SUPA.loadNew().catch(function(e){ console.warn('新处方拉取失败:', e.message); supaLoadFail('newRx', e.message); return 0; }),
      SUPA.loadDrugs().catch(function(e){ console.warn('药价拉取失败:', e.message); supaLoadFail('drugs', e.message); return 0; }),
      guestLoadAll().catch(function(e){ console.warn('重要客人数据拉取失败:', e.message); }),
      /* 地址 + 常用备注：云端为唯一来源 */
      SUPA.loadAddrs().then(function(cloud){
        return rxMergeAddrs(cloud);
      }).catch(function(e){ console.warn('地址拉取失败:', e.message); return {}; }),
      SUPA.loadNotes().then(function(cloud){
        return rxMergeNotes(cloud);
      }).catch(function(e){ console.warn('备注拉取失败:', e.message); return []; })
    ]);
  }).then(function(){
    renderHistory(); renderDrugList(); renderPriceList(); loadDoctors();
    /* 云端处方已拉回，清理历史遗留的测试处方（幂等，只删测试编号/姓名） */
    try{ purgeTestData(); }catch(e){}
    /* 云端药价已拉回，按药名把测试药从内存 + 云端 drugs 表一起清掉 */
    try{ purgeTestDrugs(); }catch(e){}
    /* 药物管理页（#drug）是并行渲染的：navInit 早就用本机缓存画完了，
       云端药价回来后必须重画一次，否则进货价/云端零售价要切走再切回才看得到。 */
    try{
      if((location.hash||'').replace(/^#/,'')==='drug') Drug.ensure();
    }catch(e){}
    autoBackup();
    /* 计价前提：有药名才算得出价。药价一个都没加载成功时直接点名。 */
    try{
      if(!drugsList.length){
        supaLoadFail('drugs','药价目录是空的，自动划价无法工作');
      }
    }catch(e){}
  }).catch(function(e){
    console.warn('数据库不可用:', e.message);
    supaLoadFail('全部', e.message);
  });
}
/* 新处方 → 写库（失败只提示，不打断保存） */
/* 云端写入失败必须**看得见**：toast 一闪而过，用户根本不知道自己录的处方没进云端。
   这里同时用橙色横幅常驻提示（和加载失败共用 supaWarn）。 */
function supaSaveFail(msg){
  /* 被总闸拦截（明细为空）时走轻提示：那不是"写入失败"，
     云端原数据完好，不需要用户重试保存，避免用户误操作反复点保存。 */
  if(String(msg).indexOf('明细为空')>=0){
    toast('明细为空，本次未上传（云端原数据已保留）');
    return;
  }
  try{
    var box=document.getElementById('supaWarn');
    if(!box){
      box=document.createElement('div');
      box.id='supaWarn';
      box.style.cssText='position:fixed;left:0;right:0;top:0;z-index:99998;background:#fff4e5;'
        +'color:var(--aux);border-bottom:2px solid #e8a33d;padding:9px 14px;'
        +'font:var(--fs-cap,12px)/1.6 sans-serif;text-align:center';
      document.body.appendChild(box);
    }
    box.textContent='⚠ 云端保存失败：'+msg+'　（数据已存在本机，但换设备看不到，请稍后重试保存）';
  }catch(e){}
  toast('云端保存失败（数据已存本机）');
}
function supaSaveNew(rec){
  if(!SUPA.on||!rec||!rec.no) return;
  /* 本机就已经是空明细 → 连云端都不用试，直接拦（省一次请求） */
  if(rxRowEmpty({items:rec.m})){ console.warn('⛔ 明细为空，跳过上传:', rec.no); supaSaveFail('明细为空，未上传（已保护云端数据）'); return; }
  SUPA.saveRx(rec).catch(function(e){ console.warn('云端保存失败:', e.message); supaSaveFail(e.message); });
}
/* 历史处方改后 → 写库 */
function supaSaveHist(rec){
  if(!SUPA.on||!rec||!rec.no) return;
  if(rxRowEmpty({items:rec.m})){ console.warn('⛔ 历史处方明细为空，跳过上传:', rec.no); return; }
  SUPA.updateHist(rec).catch(function(e){ toast('云端保存失败（数据已存本机）：'+e.message); });
}
/* 药名里自带剂量尾巴的条目（如「山药10g」）是源数据脏数据，插入处方会出现「1袋」这类怪单位
   → 药品目录与自动补全都跳过它们；处方里若已有，则在 readCell 里把尾巴并入克数 */
var DOSE_SUFFIX_RE=/\s*(\d+(?:\.\d+)?)\s*(g|克|kg|KG|ml|ML)\s*$/;
function hasDoseInName(nm){ return DOSE_SUFFIX_RE.test(String(nm||'')); }

/* =====================================================================
   🧭 导航与页面路由（2026-10-27）
   - 切页只改 .page 的 on 类，DOM 全部保留 → 切页不丢处方录入状态
   - hash 记忆当前页（#drug 等），刷新后停在同一页
   - 收起/展开状态存 RX_STORE（rx_nav_collapsed）
   ===================================================================== */
var NAV_ITEMS=[
  {key:'daily', tx:'日常药方打印', ico:'rx'},
  {key:'print', tx:'药方打印',     ico:'print'},
  {key:'drug',  tx:'药物管理',     ico:'drug'},
  {key:'purchase', tx:'进货单',     ico:'box'},
  {key:'guest', tx:'客人管理',     ico:'guest'},
  {key:'stat',  tx:'统计数据',     ico:'chart'},
  {key:'set',   tx:'设置',         ico:'gear'}
];
/* 导航图标（内联 SVG，与全站 RX_ICONS 同一套线条语言） */
var NAV_ICONS={
  chev:'<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  rx:'<rect x="2.5" y="3" width="11" height="11" rx="1.6"/><path d="M5 3V2h6v1"/><path d="M2.5 6.5h11"/><path d="M5.5 9.5h5M5.5 11.5h3"/>',
  print:'<path d="M4.5 6V2.5h7V6"/><rect x="2" y="6" width="12" height="5.5" rx="1"/><path d="M4.5 10h7v4.5h-7z"/>',
  drug:'<rect x="2.5" y="5.5" width="11" height="5" rx="2.5" transform="rotate(-45 8 8)"/><path d="M6.3 3.4 12.6 9.7"/>',
  guest:'<circle cx="8" cy="5.2" r="2.4"/><path d="M3.4 13.4c0-2.5 2-4 4.6-4s4.6 1.5 4.6 4"/>',
  chart:'<path d="M2.5 14h11"/><rect x="4" y="8" width="2.2" height="4"/><rect x="7" y="5" width="2.2" height="7"/><rect x="10" y="2.5" width="2.2" height="9.5"/>',
  gear:'<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>',
  box:'<path d="M2.5 4h11v8.5h-11z"/><path d="M2.5 7h11"/>'
};

/* 占位页的「打开现有面板」入口：药方打印暂无对应面板，其余四个都有现成弹窗 */
var NAV_EXIST={ guest:'openGuest', stat:'openStat', set:'_navOpenSet' };

function navTxOf(key){
  for(var i=0;i<NAV_ITEMS.length;i++){ if(NAV_ITEMS[i].key===key) return NAV_ITEMS[i].tx; }
  return '';
}
function navIcon(name){
  return '<svg viewBox="0 0 16 16" aria-hidden="true">'+(NAV_ICONS[name]||'')+'</svg>';
}

/* 渲染导航项 */
function navRender(){
  var box=document.getElementById('navList');
  if(!box) return;
  var h='';
  for(var i=0;i<NAV_ITEMS.length;i++){
    var it=NAV_ITEMS[i];
    h+='<button class="navItem" data-key="'+it.key+'" type="button" title="'+esc(it.tx)+'">'+
       '<span class="navIco">'+navIcon(it.ico)+'</span>'+
       '<span class="navTx">'+esc(it.tx)+'</span></button>';
  }
  box.innerHTML=h;
  var btns=box.querySelectorAll('.navItem');
  for(var j=0;j<btns.length;j++){
    (function(b){ b.onclick=function(){ navGo(b.getAttribute('data-key')); }; })(btns[j]);
  }
}

/* 切换页面：只改 .page 的 on 类，DOM 全部保留 */
function navGo(key, pushHash){
  /* 设置是现有弹窗面板（打印模板/字体/打印机等），不切页，直接打开 */
  if(key==='set'){
    if(!document.querySelector('.page.on')) navGo('daily', false);
    try{ openSettings(); }catch(e){ console.warn('Settings', e); }
    return;
  }
  var pages=document.querySelectorAll('.page');
  var found=false;
  for(var i=0;i<pages.length;i++){
    var k=pages[i].getAttribute('data-page');
    if(k===key){ pages[i].classList.add('on'); found=true; }
    else { pages[i].classList.remove('on'); }
  }
  if(!found) return;
  var items=document.querySelectorAll('.navItem');
  for(var j=0;j<items.length;j++){
    if(items[j].getAttribute('data-key')===key) items[j].classList.add('on');
    else items[j].classList.remove('on');
  }
  var tx=navTxOf(key);
  var nt=document.getElementById('navTitle');
  if(nt) nt.textContent=tx;
  /* 回到「日常药方打印」时重画右侧药品目录：四档价格与「药物管理」同源，
     在别的页改过价 / 进过货后切回来立刻是最新值。 */
  if(key==='daily'){ try{ renderDrugList(); }catch(e){ console.warn('目录刷新失败:', e); } }
  if(pushHash!==false){
    var hs='#'+key;
    if(location.hash!==hs){ try{ location.hash=hs; }catch(e){} }
  }
  /* 占位页填一次空状态组件 */
  var pe=document.getElementById('pgEmpty_'+key);
  if(pe && !pe.getAttribute('data-filled')){
    pe.setAttribute('data-filled','1');
    var fn=NAV_EXIST[key];
    if(fn){
      pe.innerHTML=rxEmptyHTML(tx, '这个模块还在建设中，暂时先用现有面板。', '打开现有面板', "navCallExisting('"+key+"')");
    }else{
      pe.innerHTML=rxEmptyHTML(tx, '这个模块还在建设中，稍后填充。');
    }
  }
  /* 切回日常页时，四栏宽度要按新容器宽度重算一次（拖拽分栏依赖它） */
  if(key==='guest'){ try{ Guest.ensure(); }catch(e){ console.warn('Guest', e); } }
  if(key==='print'){ try{ WPlan.ensure(); }catch(e){ console.warn('WPlan', e); } }
  if(key==='purchase'){ try{ Purchase.ensure(); }catch(e){ console.warn('Purchase', e); } }
  if(key==='drug'){ try{ Drug.ensure(); }catch(e){ console.warn('Drug', e); } }
  if(key==='daily'){ try{ vsFit(vsRead()); }catch(e){} try{ rxFitCols(); }catch(e){} }
}

/* 占位页里的「打开现有面板」 */
function navCallExisting(key){
  var fn=NAV_EXIST[key];
  if(!fn) return;
  if(fn==='_navOpenSet'){ openSettings(); return; }
  if(typeof window[fn]==='function'){ window[fn](); }
}

function navInit(){
  navRender();
  /* hash → 页面；无 hash 用 daily */
  var key=(location.hash||'').replace(/^#/,'');
  var ok=false;
  for(var i=0;i<NAV_ITEMS.length;i++){ if(NAV_ITEMS[i].key===key) ok=true; }
  navGo(ok? key : 'daily', false);
  /* 浏览器前进 / 后退 */
  window.addEventListener('hashchange',function(){
    var k=(location.hash||'').replace(/^#/,'');
    var good=false;
    for(var i=0;i<NAV_ITEMS.length;i++){ if(NAV_ITEMS[i].key===k) good=true; }
    if(good) navGo(k, false);
  });
}


/* ===================== 药方打印（批发计划药单）模块 ===================== */
var WPlan = (function(){
  var LS = 'rx_wplan_v1';
  var S = { orders: [], cur: null };
  var _tgt = null;            /* 当前弹窗操作的药方块 id */
  var _saveT = null;
  var _filter = 'all';        /* 列表发药状态筛选：all / done / undone */
  var _sub = 'list';          /* 子页面：list=订单列表，edit=制表/详情 */
  var _search = '';           /* 列表搜索关键字 */
  var _sel = {};              /* 多选结款：order id → 1 */
  var _view = 'flat';         /* 列表视图：flat=全部单据，plan=按客户+月份分组 */
  var _planKey = '';          /* 当前展开的计划汇总 */
  var _payBlob = null;        /* 批量结款图片 blob */
  var _imgName = '';          /* 下载图片的文件名 */
  var _ac = null;             /* 药名内联检索：{ bid, i, el, list:[], idx } */
  var _acSilent = false;      /* 选药后聚焦回填时，抑制下一次聚焦自动弹层 */
  /* ---- 医生注册表：只收录在打印页输入/选过的医生，无预置 ----
     存 rx_wplan_docs_v1（KEYS 内，自动云端同步）；同时往 Supabase doctors 表建独立实体。 */
  var DOC_LS = 'rx_wplan_docs_v1';
  var WPD = {};
  function loadDocs(){
    try{ WPD = JSON.parse(RX_STORE.getItem(DOC_LS)) || {}; }catch(e){ WPD = {}; }
    if(WPD.orders || WPD.cur){ WPD = {}; }   /* 旧结构容错 */
  }
  function saveDocs(){
    RX_STORE.setItem(DOC_LS, JSON.stringify(WPD));
  }
  function docNames(){ var out=[], k; for(k in WPD) out.push(k); out.sort(); return out; }
  /* 往 Supabase doctors 表建独立实体（已存在则不动，避免 upsert 清掉已有价格/折扣） */
  function pushDocEntity(nm){
    try{
      if(!(window.SUPA && SUPA.on)) return;
      SUPA.q('doctors?name=eq.' + encodeURIComponent(nm) + '&select=name,prices').then(function(rows){
        if(rows && rows.length) return;
        var pr = (typeof DOCTORS === 'object' && DOCTORS[nm] && DOCTORS[nm].price) || {};
        return SUPA.saveDoctor(nm, pr);
      }).catch(function(){});
    }catch(e){}
  }
  function addDoc(nm){
    nm = String(nm || '').trim(); if(!nm) return;
    if(!WPD[nm]){ WPD[nm] = { at: nowStr() }; saveDocs(); }
    pushDocEntity(nm);
  }

  function normalizeOrder(o){
    if(!o) return;
    o.blocks = Array.isArray(o.blocks) ? o.blocks : [];
    if(o.dish == null) o.dish = '';
    if(!(n(o.doses) >= 1)) o.doses = n(o.blocks[0] && o.blocks[0].doses) || 1;
    if(o.saveCommon == null) o.saveCommon = false;
    if(o.commonId == null) o.commonId = '';
    if(o.paid == null) o.paid = '';
    for(var i=0;i<o.blocks.length;i++){
      var b = o.blocks[i];
      if(!b.items) b.items = [];
      if(!(n(b.doses) >= 1)) b.doses = o.doses;
      if(b.date == null) b.date = '';
      if(b.ship == null) b.ship = '';
      if(b.saveCommon == null) b.saveCommon = false;
      if(b.commonId == null) b.commonId = '';
    }
  }
  function load(){
    try{ var s = RX_STORE.getItem(LS); S.orders = s ? (JSON.parse(s) || []) : []; }catch(e){ S.orders = []; }
    if(!Array.isArray(S.orders)) S.orders = [];
    S.orders.forEach(normalizeOrder);
    var curId = S.cur && S.cur.id;
    S.cur = curId ? findOrder(curId) : null;
    if(!S.cur) _sub = 'list';
    _sel = {};
    _planKey = '';
    loadDocs();
  }
  function save(silent){
    RX_STORE.setItem(LS, JSON.stringify(S.orders));
  }
  function saveDebounced(){ if(_saveT) clearTimeout(_saveT); _saveT = setTimeout(function(){ save(true); }, 400); }
  function uid(){ return 'WP' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
  function pad3(x){ x = String(x); while(x.length < 3) x = '0' + x; return x; }
  function blankOrder(){
    return { id: uid(), no: genNo(), guest: '', dish: '', doses: 1, date: today(), fy: '',
             paid: '', saveCommon: false, commonId: '', blocks: [], createdAt: nowStr(), updatedAt: nowStr() };
  }
  function genNo(){
    var d = (today() || '').replace(/-/g, '');
    return 'WP-' + d + '-' + pad3(S.orders.length + 1);
  }
  function blankBlock(){
    var d = S.cur ? (n(S.cur.doses) || 1) : 1;
    var t = (S.cur && String(S.cur.dish || '').trim()) || ('药方 ' + (curBlocks().length + 1));
    return { id: uid(), title: t, source: 'manual', fromRxNo: '', remark: '', items: [], fy: '', doses: d,
             date: (S.cur && S.cur.date) || '', ship: '', saveCommon: false, commonId: '' };
  }
  function curOrder(){ return S.cur; }
  function curBlocks(){ return (S.cur && S.cur.blocks) || []; }
  function blockById(bid){ var bs = curBlocks(); for(var i=0;i<bs.length;i++) if(bs[i].id === bid) return bs[i]; return null; }
  function findOrder(id){ for(var i=0;i<S.orders.length;i++) if(S.orders[i].id === id) return S.orders[i]; return null; }
  function curGuest(){ return S.cur ? (S.cur.guest || '') : ''; }

  /* ---- 计价：客人专属价优先，其次药品目录零售价 ---- */
  function dirPricePerUnit(name, unit){
    var all = findDrugAll(name) || []; if(!all.length) return null;
    unit = String(unit || 'g').toLowerCase();
    var d = null, i;
    for(i=0;i<all.length;i++){ if(String(all[i].u || 'g').toLowerCase() === unit){ d = all[i]; break; } }
    if(!d){ for(i=0;i<all.length;i++){ if(String(all[i].u || 'g').toLowerCase() === 'g'){ d = all[i]; break; } } }
    if(!d) d = all[0];
    if(d.p == null || d.p === '') return null;
    return { price: n(d.p) * unitCoef(d.u, unit), du: d.u };
  }
  function priceFor(name, guest, unit){
    unit = unit || 'g';
    if(guest){
      var dp = docPrice(guest, name);
      if(dp != null){
        var d0 = (findDrugAll(name) || [])[0]; var du = d0 ? String(d0.u || 'g') : unit;
        return dp * unitCoef(du, unit);
      }
    }
    var x = dirPricePerUnit(name, unit);
    return x ? x.price : null;
  }
  /* mk(name, guest, qty, fileUnit, keepUnit)
     keepUnit=true：保留原始单位（CSV 导入用）——数量不做任何换算，单价按该单位带出，
                     kg 行就存 kg、g 行就存 g，各行独立计价。
     否则（历史复用 / 文本制表等既有口径）：数量换算到目录单位后存储。 */
  function mk(name, guest, qty, fileUnit, keepUnit){
    var u = normUnit((fileUnit == null || fileUnit === '') ? 'g' : fileUnit) || 'g';
    var q = qty || 0;
    if(keepUnit){
      var nm = name;
      if(u !== 'g' && u !== 'kg'){ nm = baseOf({ name: name, unit: u }) + '（' + u + '）'; ensureUnitDrug(nm, u); }
      return { name: nm, qty: q, unit: u, du: u, price: priceFor(nm, guest, u), manual: false, zibei: false };
    }
    var all = findDrugAll(name) || []; var d = all[0] || null;
    var du = d ? String(d.u || 'g') : u;
    /* 数量换算：fileUnit → du（如 kg→g 应 ×1000）。
       unitCoef(a,b) 是「价格/单位a → 价格/单位b」系数，数量换算用其逆，即 unitCoef(du, fileUnit)。 */
    if(u !== du){ q = q * unitCoef(du, u); }
    return { name: name, qty: q, unit: du, du: du, price: priceFor(name, guest, du), manual: false, zibei: false };
  }
  function mkFromParsed(it, guest){
    if(it.zibei) return { name: it.name, qty: 0, unit: '', du: '', price: 0, manual: false, zibei: true, sfx: '' };
    var sp = splitSfx(it.name);
    var it2 = mk(sp.nm, guest, it.qty, it.unit);
    it2.sfx = sp.sfx;
    return it2;
  }
  function amountOf(it){ if(!it || it.zibei) return 0; return (it.price == null ? 0 : n(it.price)) * n(it.qty); }
  function blockSub(b){ var s = 0; for(var i=0;i<b.items.length;i++) s += amountOf(b.items[i]); return s; }
  /* 单付价 × 付数 = 该药方总价（加工 / 耗材已并入明细行，不再单列加工费） */
  function blockTotal(b){ return blockSub(b) * (n(b.doses) || 1); }
  /* 订单总付数：各药方付数之和（订单级付数输入已移除） */
  function orderDosesOf(o){
    var bs = (o && o.blocks) || [], d = 0, i;
    for(i=0;i<bs.length;i++) d += n(bs[i].doses) || 1;
    return d || 1;
  }
  var SHIP_LIST = ['自取', '快递', '同城配送', '送货上门'];
  function shipOptions(cur){
    var h = '<option value="">无</option>';
    for(var i=0;i<SHIP_LIST.length;i++) h += '<option value="' + SHIP_LIST[i] + '"' + (SHIP_LIST[i] === cur ? ' selected' : '') + '>' + SHIP_LIST[i] + '</option>';
    if(cur && SHIP_LIST.indexOf(cur) < 0) h += '<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>';
    return h;
  }
  function blockDate(o, b){ return String((b && b.date) || (o && o.date) || ''); }
  /* 该药方总重（克）：各药按 du 换算到克再 × 付数；非 g/kg 单位不计重 */
  function blockWeight(b){
    var g = 0;
    for(var i=0;i<b.items.length;i++){
      var it = b.items[i]; if(!it || it.zibei) continue;
      var du = String(it.du || it.unit || 'g').toLowerCase();
      if(du !== 'g' && du !== 'kg') continue;
      g += n(it.qty) * unitCoef('g', du) * (n(b.doses) || 1);
    }
    return g;
  }
  function isWeightUnit(u){ u = String(u || '').toLowerCase(); return u === 'g' || u === 'kg'; }
  function uCoef(a,b){ return unitCoef(String(a||'g').toLowerCase(), String(b||'g').toLowerCase()); }
  /* 显示数量：以 du 为基准存储，按显示单位 it.unit 换算 */
  function dispQty(it){ var du = it.du || it.unit || 'g'; return n(it.qty) * uCoef(it.unit || du, du); }
  /* 汇总重量的显示单位：整张表都是 kg → 用 kg，否则用 g */
  function blockWeightInfo(b){
    var g = blockWeight(b), has = false, allKg = true, i, u;
    for(i=0;i<(b.items||[]).length;i++){
      var it=b.items[i]; if(!it || it.zibei) continue;
      u=String(it.du||it.unit||'g').toLowerCase();
      if(u!=='kg' && u!=='g') continue;
      has=true; if(u!=='kg') allKg=false;
    }
    var useKg = has && allKg;
    var v = useKg ? (Math.round(g/1000*1000)/1000) : (Math.round(g*10)/10);
    return { g:g, u:useKg?'kg':'g', v:v, useKg:useKg };
  }
  function blockSubHtml(b){
    var d = n(b.doses) || 1;
    var wi = blockWeightInfo(b);
    return '单付 <b>¥' + money(blockSub(b)) + '</b> × ' + d + '付 = <b>¥' + money(blockTotal(b)) + '</b>'
      + (wi.g > 0 ? ' · 总重 ' + wi.v + wi.u : '');
  }

  /* ---- 渲染 ---- */
  function renderAll(){
    renderList(); renderOrderHead(); renderGuestList(); renderBlocks(); renderFoot(); renderSub(); renderSummary();
  }
  function dishOf(o){
    var d = String((o && o.dish) || '').trim();
    if(d) return d;
    var bs = (o && o.blocks) || [];
    if(bs.length === 1) return String(bs[0].title || '未命名药方');
    if(bs.length > 1){
      var names = [];
      for(var i=0;i<bs.length;i++) names.push(String(bs[i].title || ('药方' + (i+1))));
      return names.join('、');
    }
    return '未命名单';
  }
  function monthOf(o){
    var s = String((o && (o.date || o.createdAt)) || '');
    var m = s.match(/^(\d{4})-(\d{2})/);
    if(m) return { ym: m[1] + '-' + m[2], mm: m[2], year: m[1] };
    return { ym: '0000-00', mm: '', year: '' };
  }
  function planGroups(list){
    var map = {}, out = [], i;
    for(i=0;i<list.length;i++){
      var o = list[i], guest = String(o.guest || '').trim() || '未命名客人', mo = monthOf(o);
      var key = guest + '|' + mo.ym;
      if(!map[key]){
        map[key] = { key: key, guest: guest, ym: mo.ym, mm: mo.mm, orders: [], total: 0 };
        out.push(map[key]);
      }
      map[key].orders.push(o);
      map[key].total += orderTotal(o);
    }
    for(i=0;i<out.length;i++){
      var g = out[i];
      g.count = g.orders.length;
      g.label = g.guest + '-' + (g.mm ? (parseInt(g.mm, 10) + '月计划') : '未定月份计划');
      g.orders.sort(function(a,b){
        var x = String((a.date || '') + ' ' + (a.createdAt || ''));
        var y = String((b.date || '') + ' ' + (b.createdAt || ''));
        return x > y ? 1 : -1;
      });
    }
    out.sort(function(a,b){
      if(a.ym !== b.ym) return a.ym > b.ym ? -1 : 1;
      return a.guest < b.guest ? -1 : 1;
    });
    return out;
  }
  /* ---- 历史订单 / 药单列表 ---- */
  function orderTotal(o){ var t=0; for(var i=0;i<o.blocks.length;i++) t+=blockTotal(o.blocks[i]); return t; }
  function fmtTime(s){
    if(!s) return '';
    var d=new Date(s);
    if(isNaN(d.getTime())) return String(s);
    function p2(x){ x=String(x); return x.length<2?'0'+x:x; }
    return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes());
  }
  function filtered(){
    var list = S.orders.slice();
    if(_filter==='done') list = list.filter(function(o){ return !!o.fy; });
    else if(_filter==='undone') list = list.filter(function(o){ return !o.fy; });
    if(_search){
      list = list.filter(function(o){
        var hay = (String(o.guest || '未命名客人') + ' ' + dishOf(o) + ' ' +
                   fmtTime(o.createdAt || o.date) + ' ' + (o.fy ? '已发' : '未发') + ' ' +
                   (o.paid ? '已结' : '未结')).toLowerCase();
        return hay.indexOf(_search) >= 0;
      });
    }
    return list;
  }
  function applySegUI(boxSel, attr, val){
    var box = document.querySelector(boxSel); if(!box) return;
    var btns = box.querySelectorAll('.wp-seg-btn');
    for(var i=0;i<btns.length;i++){
      btns[i].classList.toggle('on', btns[i].getAttribute(attr) === val);
    }
  }
  function applyFilterUI(){ applySegUI('#wpSegStatus', 'data-f', _filter); }
  function applyViewUI(){ applySegUI('#wpSegView', 'data-v', _view); }
  function setFilter(f){
    _filter = f; renderList();
  }
  function setView(v){
    _view = (v === 'plan') ? 'plan' : 'flat';
    if(_view !== 'plan') _planKey = '';
    renderList();
  }
  function showSub(s){
    _sub = s;
    var l = document.getElementById('wpSubList'), e = document.getElementById('wpSubEdit');
    if(l) l.style.display = (s==='list') ? '' : 'none';
    if(e) e.classList.toggle('on', s==='edit');
  }
  function renderSub(){ showSub(_sub); }
  function setSearch(v){ _search = String(v || '').trim().toLowerCase(); renderList(); }
  function selCount(){ var n2 = 0, k; for(k in _sel){ if(_sel.hasOwnProperty(k)) n2++; } return n2; }
  function selectedOrders(){ var out = []; for(var i=0;i<S.orders.length;i++){ if(_sel[S.orders[i].id]) out.push(S.orders[i]); } return out; }
  function updateBatchBtn(){
    var b = document.getElementById('wpBatchBtn'); if(!b) return;
    var n2 = selCount();
    b.disabled = !n2;
    b.textContent = n2 ? ('批量结款 (' + n2 + ')') : '批量结款';
  }
  function toggleSel(id, on){
    if(on) _sel[id] = 1; else delete _sel[id];
    renderList();
  }
  function toggleSelAll(on){
    var list = filtered();
    for(var i=0;i<list.length;i++){
      if(on) _sel[list[i].id] = 1; else delete _sel[list[i].id];
    }
    renderList();
  }
  function renderList(){
    var box = document.getElementById('wpList'); if(!box) return;
    applyFilterUI(); applyViewUI(); updateBatchBtn();
    var list = filtered();
    var cEl = document.getElementById('wpListCount');
    if(cEl) cEl.textContent = (_view==='plan' ? '共 ' + planGroups(list).length + ' 个计划' : '共 ' + list.length + ' 单')
      + (selCount() ? (' · 已选 ' + selCount() + ' 单') : '');
    if(!list.length){
      box.innerHTML = '<div class="wp-list-empty">' + (_filter==='all' ? '暂无药单，点右上「新建订单」开始' : '该筛选下暂无药单') + '</div>';
      renderSummary(); return;
    }
    if(_view === 'plan'){ renderPlanList(list); renderSummary(); return; }
    var allSel = true;
    for(var a=0;a<list.length;a++){ if(!_sel[list[a].id]){ allSel = false; break; } }
    var h = '<div class="wp-row head"><div class="wp-c-ck"><input type="checkbox"' + (allSel ? ' checked' : '') +
      ' title="全选当前列表" onchange="WPlan.toggleSelAll(this.checked)"></div>' +
      '<div>订单时间</div><div>客人</div><div>订单名称</div><div>方数</div><div>总价</div><div>状态</div><div>操作</div></div>';
    for(var i=0;i<list.length;i++){
      var o = list[i];
      var total = orderTotal(o);
      var isCur = (S.cur && S.cur.id === o.id && _sub === 'edit');
      var fyCls = o.fy ? 'done' : 'undone';
      var fyTxt = o.fy ? '已发' : '未发';
      h += '<div class="wp-row' + (isCur?' on':'') + '" onclick="WPlan.selectOrder(\'' + o.id + '\')">'
        + '<div class="wp-c-ck"><input type="checkbox"' + (_sel[o.id] ? ' checked' : '') +
          ' onclick="event.stopPropagation()" onchange="WPlan.toggleSel(\'' + o.id + '\',this.checked)"></div>'
        + '<div class="wp-c-time">' + esc(fmtTime(o.createdAt || o.date)) + '</div>'
        + '<div class="wp-c-guest">' + esc(o.guest || '未命名客人') + '</div>'
        + '<div class="wp-c-dish" title="' + esc(dishOf(o)) + '">' + esc(dishOf(o)) +
          '<span class="sub">付数 ' + orderDosesOf(o) + '</span></div>'
        + '<div class="wp-c-cnt">' + o.blocks.length + ' 方</div>'
        + '<div class="wp-c-total">¥' + money(total) + '</div>'
        + '<div class="wp-c-status"><span class="tag ' + fyCls + '">' + fyTxt + '</span></div>'
        + '<div class="wp-c-act"><button class="btn sm" type="button" onclick="event.stopPropagation();WPlan.printOrder(\'' + o.id + '\')">打印</button></div>'
        + '</div>';
    }
    box.innerHTML = h;
    renderSummary();
  }
  function renderPlanList(list){
    var box = document.getElementById('wpList'); if(!box) return;
    var groups = planGroups(list);
    if(!groups.length){
      box.innerHTML = '<div class="wp-list-empty">暂无计划，点右上「新建订单」开始</div>';
      return;
    }
    var h = '';
    for(var i=0;i<groups.length;i++){
      var g = groups[i];
      h += '<div class="wp-plan-row' + (g.key===_planKey ? ' on' : '') + '" data-key="' + esc(g.key) +
        '" onclick="WPlan.openPlan(this.getAttribute(\'data-key\'))">'
        + '<div><div class="wp-plan-name">' + esc(g.label) + '</div>'
        + '<div class="wp-plan-sub">' + esc(g.guest) + ' · ' + (g.mm ? (g.ym + ' ') : '') + g.count + ' 张单据</div></div>'
        + '<div class="wp-plan-num">' + g.count + ' 单</div>'
        + '<div class="wp-plan-amt">¥' + money(g.total) + '</div>'
        + '<div class="wp-plan-act"><button class="btn sm" type="button" onclick="event.stopPropagation();WPlan.openPlan(this.getAttribute(\'data-key\'))" data-key="' + esc(g.key) + '">查看汇总</button></div>'
        + '</div>';
    }
    box.innerHTML = h;
  }
  function openPlan(key){
    _planKey = (_planKey === key) ? '' : key;
    renderList();
  }
  function closePlan(){ _planKey = ''; renderList(); }
  function renderSummary(){
    var box = document.getElementById('wpSummary'); if(!box) return;
    if(_view !== 'plan' || !_planKey){ box.style.display = 'none'; box.innerHTML = ''; return; }
    var groups = planGroups(filtered()), g = null;
    for(var i=0;i<groups.length;i++){ if(groups[i].key === _planKey){ g = groups[i]; break; } }
    if(!g){ _planKey = ''; box.style.display = 'none'; box.innerHTML = ''; return; }
    var rows = '';
    for(var k=0;k<g.orders.length;k++){
      var o = g.orders[k];
      rows += '<tr><td>' + esc(fmtTime(o.createdAt || o.date)) + '</td>'
        + '<td class="nm">' + esc(dishOf(o)) + '</td>'
        + '<td class="num">' + orderDosesOf(o) + ' 付</td>'
        + '<td class="money">¥' + money(orderTotal(o)) + '</td>'
        + '<td class="act"><button class="btn sm" type="button" onclick="event.stopPropagation();WPlan.printOrder(\'' + o.id + '\')">打印</button></td></tr>';
    }
    box.innerHTML = '<div class="wp-sum-head"><b>' + esc(g.label) + '</b>'
      + '<span class="meta">' + g.count + ' 单 · 合计 ¥' + money(g.total) + '</span><span class="spacer"></span>'
      + '<button class="btn" type="button" onclick="WPlan.exportPlanWord()">导出 Word 账单</button>'
      + '<button class="btn" type="button" onclick="WPlan.closePlan()">关闭</button></div>'
      + '<table class="wp-sum-tbl"><thead><tr><th>时间</th><th>单名</th><th class="num">付数</th><th class="num">总金额</th><th style="text-align:right">操作</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
    box.style.display = '';
  }
  function renderOrderHead(){
    var o = curOrder(); if(!o) return;
    var gi = document.getElementById('wpGuest'); if(gi && document.activeElement !== gi) gi.value = o.guest || '';
    var di = document.getElementById('wpDate'); if(di) di.value = o.date || today();
    var din = document.getElementById('wpDish'); if(din && document.activeElement !== din) din.value = o.dish || '';
    var ni = document.getElementById('wpNo'); if(ni) ni.value = o.no || '';
    var sc = document.getElementById('wpSaveCommon'); if(sc) sc.checked = !!o.saveCommon;
    var dt = document.getElementById('wpDetailTitle'); if(dt) dt.textContent = String(o.dish || '').trim() || '订单详情';
    var dn = document.getElementById('wpDetailNo'); if(dn) dn.textContent = o.no || '';
  }
  function renderGuestList(){
    var dl = document.getElementById('wpGuestList'); if(!dl) return;
    var ns = docNames(), h = '';
    for(var i=0;i<ns.length;i++) h += '<option value="' + esc(ns[i]) + '">';
    dl.innerHTML = h;
  }
  function renderBlocks(){
    var box = document.getElementById('wpBlocks'); if(!box) return;
    var o = curOrder();
    if(!o){ box.innerHTML = '<div class="wp-empty">请先新建或选择计划单</div>'; return; }
    if(!o.blocks.length){ box.innerHTML = '<div class="wp-empty">本单还没有药方。点下方「+ 添加药方」开始；或从日常药方数据里调取该客人的历史药方带入。</div>'; return; }
    var h = '';
    for(var i=0;i<o.blocks.length;i++) h += blockHTML(o.blocks[i]);
    box.innerHTML = h;
  }
  function blockHTML(b){
    var rows = '';
    if(!b.items.length){ rows = rowHTML(b.id, 0, BLANK_ITEM()); }
    else { for(var i=0;i<b.items.length;i++) rows += rowHTML(b.id, i, b.items[i]); }
    var bd = String(b.date || '');
    return '<div class="wp-block" id="wpBlock-' + b.id + '">'
      + '<div class="wp-block-head">'
      + '<input class="wp-block-title" value="' + esc(b.title || '') + '" oninput="WPlan.setBlockTitle(\'' + b.id + '\',this.value)">'
      + '<span class="wp-dose">付数 <input class="wp-dose-in" type="number" min="1" step="1" value="' + (n(b.doses) || 1) + '" oninput="WPlan.setDoses(\'' + b.id + '\',this.value)"></span>'
      + '<label class="wp-bi">日期 <input class="bi-in cal-input" type="text" readonly data-cal-mode="day" data-date="' + esc(bd) + '" value="' + esc(bd) + '" placeholder="选择日期" onchange="WPlan.setBlockDate(\'' + b.id + '\',this.value)"></label>'
      + '<label class="wp-bi">配送 <select class="bi-in" onchange="WPlan.setBlockShip(\'' + b.id + '\',this.value)">' + shipOptions(b.ship) + '</select></label>'
      + '<span class="wp-sub wp-sub-sum" id="wpSub-' + b.id + '">' + blockSubHtml(b) + '</span>'
      + '<span class="spacer"></span>'
      + '<label class="wp-ck"><input type="checkbox"' + (b.saveCommon ? ' checked' : '') + ' onchange="WPlan.setBlockSaveCommon(\'' + b.id + '\',this.checked)">存为药方</label>'
      + '<button class="btn sm" type="button" onclick="WPlan.exportBlockImage(\'' + b.id + '\')">导图</button>'
      + '<button class="btn danger sm" type="button" onclick="WPlan.delBlock(\'' + b.id + '\')">删除药方</button>'
      + '</div>'
      + '<div class="wp-block-tools">'
      + '<button class="btn sm" type="button" onclick="WPlan.openHistory(\'' + b.id + '\')">药方复用</button>'
      + '<button class="btn sm" type="button" onclick="WPlan.openText(\'' + b.id + '\')">粘贴文本制表</button>'
      + '<button class="btn sm" type="button" onclick="WPlan.openExcel(\'' + b.id + '\')">导入Excel</button>'
      + '</div>'
      + '<div class="wp-tbl-wrap"><table class="wp-tbl"><colgroup><col class="c-plus"><col style="width:29%"><col style="width:172px"><col style="width:104px"><col style="width:104px"><col><col class="c-act"></colgroup><thead><tr><th></th><th>药名 / 耗材名</th><th>克数 / 数量 · 单位</th><th style="text-align:center">单价</th><th style="text-align:right">金额</th><th>备注</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '</div>';
  }
  /* 该药材的可选单位：仓库主单位 + 多单位子规格 */
  function unitOptionsFor(name){
    var out = [], seen = {}, all = findDrugAll(name) || [], i, j;
    for(i=0;i<all.length;i++){
      var d = all[i], u = String(d.u || 'g');
      if(u && !seen[u]){ seen[u] = 1; out.push(u); }
      var sp = (typeof dmSpecsOf === 'function') ? dmSpecsOf(d) : [];
      for(j=1;j<sp.length;j++){
        var su = String(sp[j].unit || '');
        if(su && !seen[su]){ seen[su] = 1; out.push(su); }
      }
    }
    if(!out.length){ out = ['g', 'kg']; }
    return out;
  }
  function rowHTML(bid, i, it){
    var amt = amountOf(it);
    /* 单位备选 = 该药材在仓库里实际存在的规格（主单位 + 多单位子规格） */
    var uOpts = unitOptionsFor(it.name);
    var unitCell = '<input class="wp-unit-in" data-ddoptions="' + esc(JSON.stringify(uOpts)) + '" value="' + esc(it.unit || it.du || 'g') + '" title="单位（只列出该药材已有规格）" onchange="WPlan.setUnit(\'' + bid + '\',' + i + ',this.value)">';
    /* 输入框内部右侧的标签（绝对定位）：先煎等脚注 + 匹配到的仓库标准药 */
    var hasStd = !!(it.disp && it.name);
    var hasName = !!String(it.name || it.disp || '').trim();
    var tags = '';
    if(it.sfx || hasStd){
      tags = '<span class="wp-nm-tags">'
        + (it.sfx ? '<span class="wp-sfx">' + esc(it.sfx) + '</span>' : '')
        + (hasStd ? '<span class="wp-std" title="已匹配仓库标准药：【' + esc(it.name) + '】">' + esc(it.name) + '</span>' : '')
        + '</span>';
    }
    var wrapCls = 'wp-nm-wrap' + (it.sfx ? ' has-sfx' : '') + (hasStd ? ' has-std' : '') + (hasName ? '' : ' no-detail');
    return '<tr>'
      + '<td class="wp-plus-td"><button class="wp-plus" type="button" title="在下方新增一行" onmousedown="return false" onclick="WPlan.addBlankRow(\'' + bid + '\',' + i + ')"><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><line x1="6" y1="1.5" x2="6" y2="10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="1.5" y1="6" x2="10.5" y2="6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></td>'
      + '<td><div class="' + wrapCls + '"><input class="wp-nm" value="' + esc(it.disp || it.name || '') + '" placeholder="药名 / 耗材 / 拼音" autocomplete="off" onfocus="WPlan.nameFocus(\'' + bid + '\',' + i + ',this)" onclick="WPlan.nameFocus(\'' + bid + '\',' + i + ',this)" oninput="WPlan.nameInput(\'' + bid + '\',' + i + ',this)" onkeydown="WPlan.nameKey(event,\'' + bid + '\',' + i + ')" onkeyup="WPlan.nameCursor(event,\'' + bid + '\',' + i + ',this)" onselect="WPlan.nameFocus(\'' + bid + '\',' + i + ',this)" onblur="WPlan.nameBlur()">' + tags + (hasName ? '<button class="wp-nm-detail" type="button" title="查看药物详情" onmousedown="event.preventDefault()" onclick="WPlan.openDrugPeek(\'' + bid + '\',' + i + ')"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6.3" y="6.5" width="3.4" height="6.2" rx="1.7" fill="currentColor"/><circle cx="8" cy="4.2" r="1.7" fill="currentColor"/></svg></button>' : '') + '</div></td>'
      + '<td><div class="wp-qty-cell"><input class="num wp-qty" type="number" min="0" step="0.1" value="' + dispQty(it) + '" oninput="WPlan.setQty(\'' + bid + '\',' + i + ',this.value)">' + unitCell + '</div></td>'
      + '<td style="text-align:center"><input class="num wp-price" type="number" min="0" step="0.001" value="' + (it.price == null ? '' : n(it.price)) + '" oninput="WPlan.setPrice(\'' + bid + '\',' + i + ',this.value)" onmouseenter="WPlan.priceHover(\'' + bid + '\',' + i + ',this)" onmouseleave="WPlan.priceLeave()"></td>'
      + '<td class="wp-amt" id="wpAmt-' + bid + '-' + i + '">' + money(amt) + '</td>'
      + '<td class="wp-rm-td"><input class="wp-rm-in" placeholder="备注（选填）" value="' + esc(it.rm || '') + '" oninput="WPlan.setItemRemark(\'' + bid + '\',' + i + ',this.value)"></td>'
      + '<td class="row-act"><button class="btn danger sm" type="button" onclick="WPlan.delItem(\'' + bid + '\',' + i + ')">删除</button></td>'
      + '</tr>';
  }
  /* 底部小订单汇总（各药方 + 合计），单独抽出便于导入/改价后即时刷新 */
  function footTotalsHTML(o){
    var lines = '', total = 0, bs = o.blocks || [];
    for(var i=0;i<bs.length;i++){
      var b = bs[i], s = blockTotal(b); total += s;
      var d = n(b.doses) || 1;
      lines += '<div class="wp-line"><span>' + esc(b.title || ('药方' + (i+1))) + '（' + d + '付）</span><b>¥' + money(s) + '</b></div>';
    }
    if(!bs.length) lines = '<div class="wp-line"><span>合计</span><b>¥0.00</b></div>';
    var fyTag = o.fy ? '（已发药）' : '';
    var commonTag = o.saveCommon ? ' · 将存为常用方' : '';
    return lines + '<div class="wp-line wp-grand"><span>合计总价 ' + fyTag + commonTag + '</span><b id="wpGrand">¥' + money(total) + '</b></div>';
  }
  function renderFoot(){
    var o = curOrder(); var box = document.getElementById('wpFoot'); if(!box) return;
    if(!o){ box.innerHTML = ''; return; }
    box.innerHTML = '<div class="wp-totals" id="wpTotals">' + footTotalsHTML(o) + '</div>'
      + '<div class="wp-foot-actions">'
      + '<button class="btn pri" type="button" onclick="WPlan.saveNow()">保存</button>'
      + '<button class="btn pri" type="button" onclick="WPlan.saveAndBack()">保存并返回列表</button>'
      + '<button class="btn ' + (o.fy ? 'danger' : '') + '" type="button" onclick="WPlan.toggleFy()">' + (o.fy ? '取消发药' : '标记发药') + '</button>'
      + '<span id="wpSaveState" class="wp-hint"></span>'
      + '</div>';
  }
  function recount(){
    var o = curOrder(); if(!o) return; var total = 0;
    for(var i=0;i<o.blocks.length;i++){
      var b = o.blocks[i]; total += blockTotal(b);
      var se = document.getElementById('wpSub-' + b.id); if(se) se.innerHTML = blockSubHtml(b);
    }
    var ge = document.getElementById('wpGrand'); if(ge) ge.textContent = '¥' + money(total);
    /* 底部汇总列表（小订单名称 + 金额 + 合计）随导入/改价即时刷新 */
    var tp = document.getElementById('wpTotals');
    if(tp) tp.innerHTML = footTotalsHTML(o);
  }
  function updateAmt(bid, i){
    var b = blockById(bid); if(!b || !b.items[i]) return;
    var el = document.getElementById('wpAmt-' + bid + '-' + i);
    if(el) el.textContent = money(amountOf(b.items[i]));
  }

  /* ---- 操作 ---- */
  function selectOrder(id){
    var o = findOrder(id); if(!o) return;
    S.cur = o; renderAll(); showSub('edit');
    var body = document.querySelector('#wpSubEdit .wp-detail-body'); if(body) body.scrollTop = 0;
  }
  function setCurrent(id){ var o = findOrder(id); if(o){ S.cur = o; renderAll(); } return o; }
  function newOrder(){
    if(_filter==='done'){ _filter='all'; }
    var o = blankOrder(); S.orders.unshift(o); S.cur = o; save(); renderAll(); showSub('edit');
    setTimeout(function(){ var el = document.getElementById('wpDish'); if(el) el.focus(); }, 60);
    toast('已新建订单 ' + o.no);
  }
  function delOrder(){
    var o = curOrder(); if(!o) return;
    if(!confirm('确定删除单据「' + (dishOf(o) || o.no) + '」？此操作不可恢复。')) return;
    delete _sel[o.id];
    S.orders = S.orders.filter(function(x){ return x.id !== o.id; });
    S.cur = null; save(); renderAll(); showSub('list');
    toast('已删除');
  }
  function delOrderById(id, e){
    if(e && e.stopPropagation) e.stopPropagation();
    var o = findOrder(id); if(!o) return;
    if(!confirm('确定删除药单「' + (o.no || '') + '」？此操作不可恢复。')) return;
    delete _sel[id];
    S.orders = S.orders.filter(function(x){ return x.id !== id; });
    if(S.cur && S.cur.id === id) S.cur = null;
    save(); renderAll();
    toast('已删除');
  }
  function setGuest(v){ var o = curOrder(); if(!o) return; o.guest = String(v || '').trim(); saveDebounced(); }
  /* 顶部必填项：药膳名字 / 日期 / 付数 */
  function setDish(v){
    var o = curOrder(); if(!o) return;
    o.dish = String(v || '').trim();
    var bs = o.blocks || [];
    if(bs.length && /^药方\s*\d*$/.test(String(bs[0].title || ''))) bs[0].title = o.dish || bs[0].title;
    var dt = document.getElementById('wpDetailTitle');
    if(dt) dt.textContent = o.dish || '订单详情';
    saveDebounced(); renderFoot();
  }
  function setSaveCommon(v){
    var o = curOrder(); if(!o) return;
    o.saveCommon = !!v;
    saveDebounced(); renderFoot();
  }
  function validateOrder(o){
    if(!o){ toastErr('请先新建或选择订单'); return false; }
    if(!String(o.dish || '').trim()){
      /* 订单名称没填时，用第一个药方标题兜底，避免「保存并返回列表」被卡住 */
      var first = '';
      for(var i=0;i<(o.blocks||[]).length;i++){ if(o.blocks[i] && String(o.blocks[i].title||'').trim()){ first=String(o.blocks[i].title).trim(); break; } }
      if(first){ o.dish = first; }
      else{ toastErr('请填写订单名称（必填）'); var e = document.getElementById('wpDish'); if(e) e.focus(); return false; }
    }
    if(!o.date){
      toastErr('请选择日期（必填）'); var d = document.getElementById('wpDate'); if(d) d.focus(); return false;
    }
    return true;
  }
  /* 把勾了「存为药方」的小订单逐个存成常用方（与客人管理同一份云端数据） */
  function saveCommonFromOrder(o){
    if(!o || !o.blocks || !o.blocks.length) return true;
    var need = false, i;
    for(i=0;i<o.blocks.length;i++){ if(o.blocks[i].saveCommon) need = true; }
    if(!need) return true;
    /* 没进过客人页时 GST_CF 可能是空的，先读回已保存的常用方，避免覆盖旧数据 */
    if(typeof gstLoadCf === 'function'){ try{ gstLoadCf(); }catch(e){} }
    if(typeof GST_CF === 'undefined' || typeof gstCfPersist !== 'function') return true;
    if(!String(o.guest || '').trim()){ toastErr('存为药方需要先填写客人 / 医生'); return false; }
    var names = [], any = false;
    for(i=0;i<o.blocks.length;i++){
      var b = o.blocks[i];
      if(!b.saveCommon) continue;
      if(!(b.items || []).length){ toastErr('「' + (b.title || ('药方' + (i+1))) + '」为空，未保存'); continue; }
      var id = b.commonId || ('CF' + Date.now().toString(36) + Math.random().toString(36).slice(2,5));
      var rec = {
        id: id, guest: String(o.guest || '').trim(), name: String(b.title || o.dish || '未命名药方').trim(),
        doses: n(b.doses) || 1, items: JSON.parse(JSON.stringify(b.items || [])),
        updatedAt: nowStr()
      };
      var found = null;
      for(var k=0;k<GST_CF.length;k++){ if(GST_CF[k] && GST_CF[k].id === id){ found = GST_CF[k]; break; } }
      if(found){
        found.guest = rec.guest; found.name = rec.name; found.doses = rec.doses; found.items = rec.items; found.updatedAt = rec.updatedAt;
      }else{
        rec.createdAt = nowStr();
        GST_CF.unshift(rec);
      }
      b.commonId = id; b.saveCommon = false;
      names.push(rec.name); any = true;
    }
    if(any){
      gstCfPersist();
      toast('已存为药方：' + names.join('、'));
    }
    return true;
  }
  function saveNow(){
    var o = curOrder(); if(!o) return false;
    if(!validateOrder(o)) return false;
    if(!saveCommonFromOrder(o)) return false;
    o.updatedAt = nowStr();
    save(); renderAll();
    var st = document.getElementById('wpSaveState');
    if(st) st.textContent = '已保存 · ' + nowHM();
    toast('已保存');
    return true;
  }
  function saveAndBack(){
    /* 先切回列表，再落盘：避免任何校验/渲染异常把用户卡在详情页 */
    _sub = 'list';
    showSub('list');
    var l = document.getElementById('wpSubList'), e = document.getElementById('wpSubEdit');
    if(l) l.style.display = 'block';
    if(e) e.classList.remove('on');
    var o = curOrder();
    if(o){
      o.updatedAt = nowStr();
      try{ save(); }catch(err){ console.warn('保存异常:', err && err.message); }
      try{ saveCommonFromOrder(o); }catch(err2){ console.warn('常用方保存异常:', err2 && err2.message); }
      try{ renderList(); }catch(err3){ console.warn('列表渲染异常:', err3 && err3.message); }
    }
    toast('已保存，已返回订单列表');
  }
  function backToList(){
    var o = curOrder();
    /* 只是返回列表不强制补全；有小订单勾了「存为药方」才校验必填字段 */
    var need = false;
    if(o){ for(var i=0;i<(o.blocks || []).length;i++){ if(o.blocks[i].saveCommon){ need = true; break; } } }
    if(o && need){
      if(!validateOrder(o)) return;
      if(!saveCommonFromOrder(o)) return;
    }
    if(o){ o.updatedAt = nowStr(); save(); }
    showSub('list'); renderList();
  }
  function printCur(){
    var o = curOrder(); if(!o){ toastErr('请先选择单据'); return; }
    try{ WPrint.open(); }catch(e){ toastErr('打印面板打开失败：' + e.message); }
  }
  function printOrder(id){
    var o = setCurrent(id); if(!o){ toastErr('找不到单据'); return; }
    try{ WPrint.open(); }catch(e){ toastErr('打印面板打开失败：' + e.message); }
  }

  /* ---- 批量结款：把勾选的多张单据生成一张高清表格图片 ---- */
  function paySorted(list){
    return list.slice().sort(function(a,b){
      var x = String((a.date || '') + ' ' + (a.createdAt || ''));
      var y = String((b.date || '') + ' ' + (b.createdAt || ''));
      return x > y ? 1 : -1;
    });
  }
  function paySummary(list){
    var guests = [], seen = {}, total = 0, i;
    for(i=0;i<list.length;i++){
      var g = String(list[i].guest || '').trim() || '未命名客人';
      if(!seen[g]){ seen[g] = 1; guests.push(g); }
      total += orderTotal(list[i]);
    }
    var dates = [];
    for(i=0;i<list.length;i++){
      var s = String(list[i].date || list[i].createdAt || '');
      var m = s.match(/^\d{4}-\d{2}-\d{2}/);
      if(m) dates.push(m[0]);
    }
    dates.sort();
    var range = dates.length ? (dates[0] + (dates.length > 1 && dates[0] !== dates[dates.length-1] ? (' ~ ' + dates[dates.length-1]) : '')) : nowStr().slice(0,10);
    return { guests: guests, total: total, range: range, count: list.length };
  }
  function genPayImage(list, cb){
    list = paySorted(list);
    var info = paySummary(list);
    var W = 760, rowH = 40, headH = 122, footH = 92;
    var H = headH + 38 + list.length * rowH + footH;
    var rows = '';
    for(var i=0;i<list.length;i++){
      var o = list[i];
      rows += '<tr>'
        + '<td style="width:150px">' + esc(fmtTime(o.createdAt || o.date)) + '</td>'
        + '<td>' + esc(String(o.guest || '').trim() || '未命名客人') + '</td>'
        + '<td class="dish">' + esc(dishOf(o)) + '</td>'
        + '<td style="width:110px;text-align:right">¥' + money(orderTotal(o)) + '</td>'
        + '</tr>';
    }
    var css = ''
      + 'body{margin:0;font-family:"PingFang SC","Helvetica Neue","Microsoft YaHei",sans-serif;color:#111}'
      + '.wrap{width:' + W + 'px;box-sizing:border-box;padding:26px 28px;background:#fff}'
      + '.ttl{font-size:22px;font-weight:700;letter-spacing:1px}'
      + '.sub{margin-top:7px;font-size:12px;color:#666}'
      + 'table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px;line-height:1.5}'
      + 'th,td{border:1px solid #d5d8dc;padding:10px 12px;text-align:left}'
      + 'th{background:#f2f4f6;font-weight:700;color:#333}'
      + '.dish{font-size:13px;font-weight:700}'
      + 'tr:nth-child(even) td{background:#fafbfc}'
      + '.sum td{background:#eef7f1!important;font-weight:700;font-size:15px}'
      + '.foot{margin-top:14px;display:flex;justify-content:space-between;font-size:11px;color:#888}';
    var inner = '<div class="wrap"><div class="ttl">结款明细</div>'
      + '<div class="sub">客户：' + esc(info.guests.join('、')) + '　｜　期间：' + esc(info.range) + '　｜　共 ' + info.count + ' 单</div>'
      + '<table><thead><tr><th>时间</th><th style="width:120px">客人</th><th>订单名称</th><th style="width:110px;text-align:right">金额(元)</th></tr></thead><tbody>'
      + rows
      + '<tr class="sum"><td colspan="3">合计</td><td style="text-align:right">¥' + money(info.total) + '</td></tr>'
      + '</tbody></table>'
      + '<div class="foot"><span>制表日期：' + esc(nowStr().slice(0,10)) + '</span><span>请核对无误后付款</span></div></div>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">'
      + '<foreignObject x="0" y="0" width="100%" height="100%">'
      + '<div xmlns="http://www.w3.org/1999/xhtml"><style>' + css + '</style>' + inner + '</div>'
      + '</foreignObject></svg>';
    var img = new Image();
    img.onload = function(){
      try{
        var cv = document.createElement('canvas');
        cv.width = W * 2; cv.height = H * 2;
        var g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL('image/png');
        cv.toBlob(function(blob){ cb(null, data, blob); }, 'image/png');
      }catch(e){ cb(e, null, null); }
    };
    img.onerror = function(){ cb(new Error('当前浏览器不支持生成图片'), null, null); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function openPay(){
    var list = selectedOrders();
    if(!list.length){ toastErr('请先勾选要结款的单据'); return; }
    _payBlob = null;
    _imgName = '';
    var body = document.getElementById('wpPayBody');
    if(body) body.innerHTML = '<div class="wp-empty">正在生成结款图片…</div>';
    openModal('wpPayModal');
    genPayImage(list, function(err, data, blob){
      if(err){ if(body) body.innerHTML = '<div class="wp-empty">生成失败：' + esc(err.message) + '</div>'; return; }
      _payBlob = blob || null;
      if(body) body.innerHTML = '<img src="' + data + '" alt="结款明细">';
    });
  }
  function copyPay(){
    if(!_payBlob){ toastErr('结款图片还在生成，请稍候'); return; }
    if(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem){
      navigator.clipboard.write([new ClipboardItem({'image/png': _payBlob})])
        .then(function(){ toast('结款图片已复制，可直接粘贴发给客户'); })
        .catch(function(){ downloadPay(); });
    }else{
      downloadPay();
    }
  }
  function downloadPay(){
    if(!_payBlob){ toastErr('结款图片还在生成，请稍候'); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(_payBlob);
    a.download = _imgName || ('结款明细_' + nowStr().slice(0,10).replace(/-/g, '') + '.png');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
    toast('已下载图片');
  }

  /* ---- 订单详情 / 单方「生成表格图片」（明细行即全部费用） ---- */
  function genOrderImage(o, blocks, cb){
    /* 图片宽度固定 960px（不再 2 倍放大到 1600+）；字号放大后按 1:1 出图 */
    var W = 960, shown = blocks || (o.blocks || []);
    var items = 0, i, j;
    for(i=0;i<shown.length;i++) items += Math.max(1, (shown[i].items || []).length);
    /* 正文 16px、药名 18px 加粗；单行约 47px（行高随字号放大） */
    var ROW_H = 47, BLOCK_H = 150, multi = 0;
    for(i=0;i<shown.length;i++){ if((n(shown[i].doses) || 1) > 1) multi++; }
    /* 多付时每块额外两行汇总：1付 / XX付 */
    var H = 220 + shown.length * BLOCK_H + (items + multi * 2) * ROW_H;
    var total = 0, body = '';
    for(i=0;i<shown.length;i++){
      var b = shown[i], d = n(b.doses) || 1;
      var amt = blockSub(b) * d;
      total += amt;
      var rs = '';
      if(!(b.items || []).length) rs = '<tr><td colspan="6" style="color:#999">（药方为空）</td></tr>';
      var seq = 0;
      for(j=0;j<(b.items || []).length;j++){
        var it = b.items[j];
        if(!it) continue;
        seq++;
        /* 数量、单位拆成两列 */
        var qn = it.zibei ? '自备' : String(Math.round(dispQty(it) * 100) / 100);
        var un = it.zibei ? '—' : (it.unit || it.du || 'g');
        rs += '<tr><td class="sq" style="color:#777">' + seq + '</td><td class="dr">' + esc(it.disp || it.name || '') + '</td>'
          + '<td>' + esc(qn) + '</td><td>' + esc(un) + '</td>'
          + '<td>' + (it.price == null ? '' : money(it.price)) + '</td>'
          + '<td>' + money(amountOf(it)) + '</td></tr>';
      }
      /* 多付小订单：先列 1 付的数据，再列 XX 付的数据（重量跟随表格单位） */
      if(d > 1){
        var wT = blockWeight(b), w1 = wT / d, wi = blockWeightInfo(b);
        var roundW = function(x){ return wi.useKg ? (Math.round(x/1000*1000)/1000) : (Math.round(x*10)/10); };
        var kg1 = w1 > 0 ? String(roundW(w1)) : '—';
        var kgT = wT > 0 ? String(roundW(wT)) : '—';
        var uu = (wi.g > 0) ? wi.u : '—';
        rs += '<tr class="prow"><td class="sq"></td><td class="plb">1付</td><td>' + kg1 + '</td><td>' + uu + '</td><td></td><td>' + money(blockSub(b)) + '</td></tr>'
          + '<tr class="prow"><td class="sq"></td><td class="plb">' + d + '付</td><td>' + kgT + '</td><td>' + uu + '</td><td></td><td>' + money(amt) + '</td></tr>';
      }
      body += '<div class="bk">'
        + '<div class="bh"><span class="bn">' + (i + 1) + '. ' + esc(b.title || ('药方' + (i + 1))) + '</span>'
        + '<span class="bd">日期 ' + esc(blockDate(o, b) || '—') + '</span>'
        + '<span class="bd">付数 ' + d + '</span>'
        + (b.ship ? '<span class="bd">配送 ' + esc(b.ship) + '</span>' : '')
        + '<span class="ba">¥' + money(amt) + '</span></div>'
        + '<table><thead><tr><th style="width:7%">序号</th><th style="width:35%">药名</th><th style="width:12%">' + (d > 1 ? '数量(1付)' : '数量') + '</th><th style="width:10%">单位</th><th style="width:18%">单价</th><th style="width:18%">金额</th></tr></thead><tbody>'
        + rs + '</tbody></table>'
        + '<div class="bf">' + (d > 1 ? '合计' : '小计') + ' <b>¥' + money(amt) + '</b>' + (blockWeightInfo(b).g > 0 ? ('　总重 ' + blockWeightInfo(b).v + blockWeightInfo(b).u) : '') + '</div>'
        + '</div>';
    }
    var css = ''
      + 'body{margin:0;font-family:"PingFang SC","Helvetica Neue","Microsoft YaHei",sans-serif;color:#111}'
      + '.wrap{width:' + W + 'px;box-sizing:border-box;padding:24px 28px;background:#fff}'
      + '.ttl{font-size:24px;font-weight:700;letter-spacing:1px;text-align:center}'
      + '.sub{margin-top:8px;font-size:13px;color:#666;text-align:center}'
      + '.bk{border:1px solid #d5d8dc;border-radius:6px;margin-top:16px;overflow:hidden}'
      + '.bh{display:flex;align-items:center;gap:14px;padding:11px 12px;background:#f2f4f6;font-size:14px}'
      + '.bn{font-weight:700;font-size:15px}'
      + '.bd{color:#555}'
      + '.ba{margin-left:auto;font-weight:700;color:#12693a}'
      + 'table{width:100%;border-collapse:collapse;font-size:16px;line-height:1.5}'
      + 'th,td{border-bottom:1px solid #e3e6ea;border-left:none;border-right:none;padding:9px 10px;text-align:center}'
      + 'th{background:#fafbfc;font-weight:700;color:#333;font-size:16px}'
      /* 药名列重点突出：18px 加粗 */
      + '.dr{font-size:18px;font-weight:700;color:#111}'
      /* 多付汇总行：1付 / XX付 */
      + '.prow td{background:#fafbfc;font-weight:700}'
      + '.prow .plb{color:#555}'
      + '.bf{padding:10px 12px;font-size:13px;color:#555;text-align:center}'
      + '.bf b{color:#12693a}'
      + '.sum{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding:11px 14px;background:#eef7f1;border:1px solid #cfe8d8;border-radius:6px;font-size:15px}'
      + '.sum b{font-size:22px;color:#12693a}'
      + '.foot{margin-top:10px;display:flex;justify-content:space-between;font-size:12px;color:#888}';
    var inner = '<div class="wrap"><div class="ttl">订单明细</div>'
      + '<div class="sub">客户：' + esc(String(o.guest || '').trim() || '—') + '　｜　单据：' + esc(o.no || '—')
      + '　｜　日期：' + esc(o.date || '—') + '　｜　共 ' + shown.length + ' 个药方</div>'
      + body
      + '<div class="sum"><span>合计金额</span><b>¥' + money(total) + '</b></div>'
      + '<div class="foot"><span>制表日期：' + esc(nowStr().slice(0,10)) + '</span><span>明细以药方打印单为准</span></div></div>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">'
      + '<foreignObject x="0" y="0" width="100%" height="100%">'
      + '<div xmlns="http://www.w3.org/1999/xhtml"><style>' + css + '</style>' + inner + '</div>'
      + '</foreignObject></svg>';
    var img = new Image();
    img.onload = function(){
      try{
        var cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        var g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL('image/png');
        cv.toBlob(function(blob){ cb(null, data, blob); }, 'image/png');
      }catch(e){ cb(e, null, null); }
    };
    img.onerror = function(){ cb(new Error('当前浏览器不支持生成图片'), null, null); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function showOrderImage(o, blocks){
    if(!o) return;
    if(!(o.blocks || []).length){ toastErr('本单还没有药方'); return; }
    _payBlob = null;
    _imgName = safeFile((dishOf(o) || '订单') + '_' + ((blocks && blocks.length === 1) ? (blocks[0].title || '单方') : '整单') + '.png');
    var body = document.getElementById('wpPayBody');
    if(body) body.innerHTML = '<div class="wp-empty">正在生成表格图片…</div>';
    openModal('wpPayModal');
    genOrderImage(o, blocks || null, function(err, data, blob){
      if(err){ if(body) body.innerHTML = '<div class="wp-empty">生成失败：' + esc(err.message) + '</div>'; return; }
      _payBlob = blob || null;
      if(body) body.innerHTML = '<img src="' + data + '" alt="订单明细">';
    });
  }
  function exportOrderImage(){
    var o = curOrder(); if(!o){ toastErr('请先选择单据'); return; }
    showOrderImage(o, null);
  }
  function exportBlockImage(bid){
    var o = curOrder(), b = blockById(bid);
    if(!o || !b){ toastErr('找不到该药方'); return; }
    if(!(b.items || []).length){ toastErr('该药方为空，无法生成图片'); return; }
    showOrderImage(o, [b]);
  }

  /* ---- 计划单 Word 导出：只汇总，不替代单张打印 ---- */
  function safeFile(s){ return String(s || '').replace(/[\\/:*?"<>|]/g, '_'); }
  function exportPlanWord(){
    var groups = planGroups(filtered()), g = null;
    for(var i=0;i<groups.length;i++){ if(groups[i].key === _planKey){ g = groups[i]; break; } }
    if(!g){ toastErr('请先打开一个计划汇总'); return; }
    var rows = '', detail = '', total = 0, k, bi;
    for(k=0;k<g.orders.length;k++){
      var o = g.orders[k], amt = orderTotal(o); total += amt;
      var bs = o.blocks || [];
      rows += '<tr><td style="width:44pt;text-align:center">' + (k+1) + '</td>'
        + '<td style="width:92pt">' + esc(o.date || '') + '</td>'
        + '<td class="nm">' + esc(dishOf(o)) + '</td>'
        + '<td style="width:44pt;text-align:center">' + orderDosesOf(o) + '</td>'
        + '<td style="width:76pt;text-align:right">' + money(amt) + '</td></tr>';
      for(bi=0;bi<bs.length;bi++){
        var b = bs[bi], d = n(b.doses) || 1, items = '', sn = 0;
        for(var j=0;j<(b.items || []).length;j++){
          var it = b.items[j]; if(!it) continue;
          sn++;
          var um = it.zibei ? '' : String(it.unit || it.du || 'g');
          var qn = it.zibei ? '自备' : (Math.round(dispQty(it) * 100) / 100);
          items += '<tr><td class="cc">' + sn + '</td>'
            + '<td>' + esc(it.name || '') + '</td>'
            + '<td class="cc">' + esc(String(qn)) + '</td>'
            + '<td class="cc">' + esc(um) + '</td>'
            + '<td class="cc">' + (it.price == null ? '' : money(it.price)) + '</td>'
            + '<td class="cc">' + money(amountOf(it)) + '</td></tr>';
        }
        if(!items) items = '<tr><td colspan="6" style="color:#888;text-align:center">（药方为空）</td></tr>';
        detail += '<div class="det"><table class="dt"><thead>'
          + '<tr class="dh"><th colspan="3" class="dhn">订单名称：'
          + esc((k+1) + '.' + (bi+1) + '　' + (b.title || ('药方' + (bi+1))))
          + '</th><th colspan="3" class="dhd2">日期：' + esc(blockDate(o, b) || '') + '　' + d + '付'
          + (b.ship ? ('　配送 ' + esc(b.ship)) : '') + '</th></tr>'
          + '<tr><th style="width:44pt">序号</th><th>药名</th><th style="width:52pt">克数</th>'
          + '<th style="width:40pt">单位</th><th style="width:64pt">单价</th><th style="width:70pt">金额</th></tr>'
          + '</thead><tbody>' + items
          + '<tr class="rtot"><td colspan="5" class="cc">合计金额</td>'
          + '<td class="cc"><b>¥' + money(blockTotal(b)) + '</b></td></tr>'
          + '</tbody></table></div>';
      }
    }
    var title = g.label + ' · 汇总账单';
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
      + '<head><meta charset="utf-8"><title>' + esc(title) + '</title>'
      + '<style>@page{size:A4;margin:18mm}body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#111;font-size:12pt}'
      + 'h1{font-size:20pt;margin:0 0 6pt}h2{font-size:13pt;margin:18pt 0 6pt}'
      + '.meta{color:#666;font-size:10.5pt;margin-bottom:14pt}'
      + 'table{border-collapse:collapse;width:100%;font-size:10.5pt}th,td{border:1px solid #999;padding:6pt 8pt;text-align:left}th{white-space:nowrap}'
      + 'th{background:#f2f4f6}td.nm{font-weight:600}'
      + '.tot{margin-top:14pt;font-size:12pt}.tot b{font-size:16pt}'
      + '.det{page-break-inside:avoid}'
      + '.dt{font-size:10pt}.dt th,.dt td{padding:4pt 6pt}'
      + '.dt th{text-align:center}.dt td.cc{text-align:center}'
      + '.dt tr.dh th{text-align:left;background:#f7f8fa}'
      + '.dt tr.dh th.dhd2{text-align:right;font-weight:400;color:#555;font-size:9.5pt}'
      + '.dt tr.rtot td{background:#f7f8fa;font-weight:600}.dt tr.rtot b{color:#12693a}'
      + '</style></head><body>'
      + '<h1>' + esc(g.label) + '</h1>'
      + '<div class="meta">客户：' + esc(g.guest) + '　｜　月份：' + esc(g.mm ? (g.ym) : '未定') + '　｜　单据数：' + g.count + '</div>'
      + '<table><thead><tr><th style="width:44pt;text-align:center">序号</th><th style="width:92pt">日期</th>'
      + '<th>订单名称</th>'
      + '<th style="width:44pt;text-align:center">付数</th><th style="width:76pt;text-align:right">金额(元)</th></tr></thead><tbody>'
      + rows + '</tbody></table>'
      + '<div class="tot">计划汇总金额：<b>¥' + money(total) + '</b></div>'
      + '<div style="page-break-before:always"></div>'
      + '<h2>药方明细</h2>'
      + detail
      + '</body></html>';
    var blob = new Blob(['\ufeff' + html], {type: 'application/msword'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeFile(g.label + '_汇总账单') + '.doc';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
    toast('已导出 Word 汇总账单（含明细）');
  }

  /* 按"当前医生"重算所有非手动改价的药材单价（专属价优先，其次目录价） */
  function repriceAll(){
    var g = curGuest(), bs = curBlocks(), i, j;
    for(i=0;i<bs.length;i++){
      var b = bs[i];
      for(j=0;j<b.items.length;j++){
        var it = b.items[j]; if(!it || it.zibei || it.manual) continue;
        it.price = priceFor(it.name, g, it.du);
      }
    }
  }
  /* 医生输入完成（失焦/选中）：登记进医生列表 + 按该医生专属价体系重算价格 */
  function commitGuest(v){
    var o = curOrder(); if(!o) return;
    o.guest = String(v || '').trim();
    if(o.guest) addDoc(o.guest);
    repriceAll();
    save(); renderAll();
  }
  function setDate(v){ var o = curOrder(); if(!o) return; o.date = v || ''; saveDebounced(); }
  function toggleFy(){
    var o = curOrder(); if(!o) return;
    var on = !o.fy;
    o.fy = on ? '1' : '';
    /* 只有在「标记发药」时才把本单成交价沉淀为历史成交价与客人专属价 */
    if(on) recordDealHistory(o);
    save(); renderFoot(); toast(on ? '已标记发药（成交价已记入历史）' : '已取消发药');
  }

  /* ================= 成交价历史（仅发药时落库） =================
     数据去处：
       ① DOCTORS[客人].price/d.log —— 本机客人专属价与改价历史；
       ② Supabase price_logs —— 跨设备历史成交价（doctor/drug/to_price/rx_no/created_at）。
     未标记发药的订单只是草稿，不写任何历史。 */
  function recordDealHistory(o){
    if(!o || o.dealLogged) return false;
    var guest = String(o.guest || '').trim() || '未命名客人';
    var dstr = String(o.date || '') || today();
    var rows = [], logs = [], seen = {}, i, j, b, it;
    for(i=0;i<(o.blocks||[]).length;i++){
      b = o.blocks[i];
      for(j=0;j<(b.items||[]).length;j++){
        it = b.items[j];
        if(!it || it.zibei || !String(it.name||'').trim()) continue;
        if(it.price == null || it.price === '') continue;
        var nm = String(it.name).trim(), price = n(it.price);
        rows.push({doctor:guest, drug:nm, from_price:null, to_price:price,
                   rx_no:o.no||'', created_at:dstr+'T12:00:00+08:00'});
        if(!seen[nm]){
          seen[nm] = 1;
          logs.push({t:dstr+' '+nowHM(), d:nm, from:'', to:String(price), rx:o.no||'', who:guest});
        }
      }
    }
    if(!rows.length) return false;
    /* 客人专属价按药品基础单位存（与 priceFor 的口径一致） */
    if(!DOCTORS[guest]) DOCTORS[guest] = {n:guest, at:nowStr(), price:{}, log:[]};
    var d = DOCTORS[guest]; d.price = d.price || {}; d.log = d.log || [];
    for(i=0;i<logs.length;i++){
      var ln = logs[i];
      var bd = (findDrugAll(ln.d) || [])[0];
      var baseU = bd ? String(bd.u || 'g') : 'g';
      var orig = null, ic;
      for(ic=0;ic<(o.blocks||[]).length;ic++){
        var bb=o.blocks[ic];
        for(var jj=0;jj<(bb.items||[]).length;jj++){
          var ii=bb.items[jj];
          if(ii && String(ii.name||'').trim()===ln.d){ orig=ii; break; }
        }
        if(orig) break;
      }
      var price = n(ln.to);
      if(orig) price = price * unitCoef(String(orig.unit||orig.du||'g'), baseU);
      d.price[drugKey(ln.d)] = Math.round(price*1000000)/1000000;
      d.log.unshift(ln);
    }
    if(d.log.length > 800) d.log.length = 800;
    try{ saveDoctors(); }catch(e){}
    if(SUPA.on){
      SUPA.q('price_logs', {method:'POST', body:rows}).catch(function(e){
        console.warn('成交价历史写库失败:', e && e.message);
      });
    }
    o.dealLogged = String(o.no || '') + '|' + dstr;
    return true;
  }

  /* ================= 单价 Hover：三档价格历史 ================= */
  var _tipCache = {}, _tipSeq = 0, _tipShow = false;
  function histDay(t){
    var s = String(t || '');
    var m = s.match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : s.slice(0, 10);
  }
  function histMoney(v){
    if(v == null || v === '') return '—';
    return '¥' + money(v);
  }
  function tipSection(title, arr){
    var h = '<div class="sec"><h4>' + esc(title) + '</h4>';
    if(!arr.length) return h + '<div class="empty">暂无记录</div></div>';
    for(var i=0;i<arr.length;i++){
      h += '<div class="row"><span>' + esc(histDay(arr[i].t)) + '</span><span class="p">' + histMoney(arr[i].p) + '</span></div>';
    }
    return h + '</div>';
  }
  function renderPriceTip(deals, guestLog, costs, drug, guest, loading){
    deals = deals || []; costs = costs || [];
    var cust = [], other = [], i;
    for(i=0;i<deals.length;i++){
      var r = deals[i], who = String(r.doctor || '');
      var item = { t: r.created_at, p: r.to_price };
      if(who === guest) cust.push(item); else other.push(item);
    }
    if(!cust.length){
      for(i=0;i<(guestLog||[]).length;i++){
        var l = guestLog[i];
        if(l && normName(l.d) === normName(drug)) cust.push({t:l.t, p:l.to});
      }
    }
    if(!other.length){
      for(var nm in DOCTORS){
        if(!DOCTORS.hasOwnProperty(nm) || nm === guest) continue;
        var lg = DOCTORS[nm].log || [];
        for(i=0;i<lg.length;i++){
          if(lg[i] && normName(lg[i].d) === normName(drug)) other.push({t:lg[i].t, p:lg[i].to});
        }
      }
    }
    function sortTop(a){ a.sort(function(x,y){ return String(x.t||'') > String(y.t||'') ? -1 : 1; }); return a.slice(0,5); }
    cust = sortTop(cust); other = sortTop(other);
    var costArr = [];
    for(i=0;i<costs.length;i++){
      if(costs[i] && costs[i].cost != null) costArr.push({t:costs[i].dt, p:costs[i].cost});
    }
    costArr = sortTop(costArr);
    var gLabel = guest || '未指定客人';
    return tipSection('客户历史成交（' + gLabel + '专属）', cust)
      + tipSection('其他历史成交', other)
      + tipSection('历史进货价', costArr)
      + (loading ? '<div class="empty" style="padding-top:6px">正在同步云端记录…</div>' : '');
  }
  function placePriceTip(tip, el){
    var r = el.getBoundingClientRect();
    var w = tip.offsetWidth || 310, h = tip.offsetHeight || 120;
    var left = r.right - w;
    if(left < 8) left = 8;
    if(left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    var top = r.bottom + 8;
    if(top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function priceHover(bid, i, el){
    var b = blockById(bid), it = b && b.items[i];
    if(!it || !it.name) return;
    var drug = String(it.name).trim();
    var guest = String(curGuest() || '').trim();
    var tip = document.getElementById('wpPriceTip'); if(!tip) return;
    _tipShow = true;
    var token = ++_tipSeq;
    var glog = (DOCTORS[guest] && DOCTORS[guest].log) || [];
    tip.innerHTML = renderPriceTip([], glog, [], drug, guest, true);
    tip.style.display = 'block';
    placePriceTip(tip, el);
    var pack = _tipCache[drug];
    var p;
    if(pack){ p = Promise.resolve(pack); }
    else{
      var q1 = (SUPA.on ? SUPA.q('price_logs?select=doctor,drug,to_price,created_at,rx_no&drug=eq.'
        + encodeURIComponent(drug) + '&order=created_at.desc&limit=30') : Promise.resolve([])).catch(function(){ return []; });
      var q2 = (typeof SUPA.loadCostLog === 'function' ? SUPA.loadCostLog(drug) : Promise.resolve([])).catch(function(){ return []; });
      p = Promise.all([q1, q2]).then(function(arr){
        var packed = { deals: arr[0] || [], costs: arr[1] || [] };
        _tipCache[drug] = packed;
        return packed;
      });
    }
    p.then(function(packed){
      if(!_tipShow || token !== _tipSeq) return;
      tip.innerHTML = renderPriceTip(packed.deals, glog, packed.costs, drug, guest, false);
      placePriceTip(tip, el);
    });
  }
  function priceLeave(){
    _tipShow = false;
    var tip = document.getElementById('wpPriceTip');
    if(tip) tip.style.display = 'none';
  }

  /* ================= 药物详情侧栏（不打断开单） ================= */
  function openDrugPeek(bid, i){
    var b = blockById(bid), it = b && b.items[i];
    if(!it || !String(it.name || '').trim()){ toast('请先填写药名'); return; }
    closeAc();
    var nm = String(it.name).trim();
    var d = findDrug(nm) || (findDrugAll(nm) || [])[0] || null;
    var box = document.getElementById('wpDrugPeek');
    var title = document.getElementById('wpPeekTitle');
    var body = document.getElementById('wpPeekBody');
    if(!box || !body) return;
    if(title) title.textContent = (it.disp || nm);
    if(!d){
      body.innerHTML = '<div class="wp-empty">仓库里没有匹配到「' + esc(nm) + '」</div>';
      box.classList.add('on');
      return;
    }
    function kv(k, v){ return '<div class="wp-peek-kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v == null || v === '' ? '—' : v) + '</span></div>'; }
    var u = String(d.u || 'g');
    var rowU = String(it.unit || it.du || u);
    var guest = String(curGuest() || '').trim();
    var gp = guest ? docPrice(guest, d.n) : null;
    /* 客人价按目录基础单位（通常 g）记录；显示时换算到当前表格行的单位 */
    var gpShow = gp;
    if(gp != null){
      gpShow = gp * unitCoef(String((d && d.u) || 'g'), rowU);
    }
    /* 第一块：当前客人专属价（高亮） */
    var h = '<div class="wp-peek-hl"><div class="hl-k">' + (guest ? esc(guest) + ' 专属价' : '当前客人专属价') + '</div>'
      + (gpShow != null
          ? '<div class="hl-v">¥' + money(gpShow) + '<small>/' + esc(rowU) + '</small></div>'
          : '<div class="hl-none">暂无专属价</div>')
      + '<div class="hl-k" style="margin-top:3px">标记发药后按最近成交价自动更新</div></div>';
    /* 第二块：该客人的专属价历史 */
    h += '<div class="wp-peek-h4">专属价历史' + (guest ? '（' + esc(guest) + '）' : '') + '</div>'
      + '<div class="wp-peek-cost" id="wpPeekGuest">'
      + renderGuestHist(guest, d.n)
      + '</div>';
    /* 第三块：药品基础信息 */
    h += '<div class="wp-peek-h4">药品信息</div>'
      + kv('标准药名', d.n)
      + kv('别名', (Array.isArray(d.al) && d.al.length) ? d.al.join('、') : '—')
      + kv('单位 / 常用量', u + ' / ' + (d.c || '—'));
    /* 第四块：标准价格 */
    h += '<div class="wp-peek-h4">标准价格</div>'
      + kv('零售价', (d.p != null && d.p !== '') ? ('¥' + money(d.p) + ' / ' + u) : '—')
      + kv('批发价', (d.wp != null && d.wp !== '') ? ('¥' + money(d.wp)) : '—')
      + kv('进货价', (d.bp != null && d.bp !== '') ? ('¥' + money(d.bp)) : '—');
    /* 第五块：最近进货记录 */
    h += '<div class="wp-peek-h4">最近进货记录</div><div class="wp-peek-cost" id="wpPeekCost"><div class="empty">加载中…</div></div>';
    body.innerHTML = h;
    box.classList.add('on');
    /* 专属价历史：合并本机记录 + 云端 price_logs */
    function renderGuestHist(g, drug){
      var out = [], i;
      var lg = (g && DOCTORS[g] && DOCTORS[g].log) || [];
      for(i=0;i<lg.length;i++){
        if(lg[i] && normName(lg[i].d) === normName(drug)) out.push({t:lg[i].t, p:lg[i].to});
      }
      if(!out.length) return '<div class="empty">暂无专属价历史</div>';
      out.sort(function(a,b){ return String(a.t||'') > String(b.t||'') ? -1 : 1; });
      out = out.slice(0,5);
      var s = '';
      for(i=0;i<out.length;i++) s += '<div class="row"><span>' + esc(histDay(out[i].t)) + '</span><span class="p">' + histMoney(out[i].p) + '</span></div>';
      return s;
    }
    if(guest && SUPA.on){
      SUPA.q('price_logs?select=doctor,to_price,created_at&doctor=eq.' + encodeURIComponent(guest)
        + '&drug=eq.' + encodeURIComponent(d.n) + '&order=created_at.desc&limit=5')
        .then(function(rows){
          var el = document.getElementById('wpPeekGuest'); if(!el) return;
          var arr = [], i;
          for(i=0;i<(rows||[]).length;i++) arr.push({t:rows[i].created_at, p:rows[i].to_price});
          var lg = (DOCTORS[guest] && DOCTORS[guest].log) || [];
          for(i=0;i<lg.length;i++) if(lg[i] && normName(lg[i].d) === normName(d.n)) arr.push({t:lg[i].t, p:lg[i].to});
          arr.sort(function(a,b){ return String(a.t||'') > String(b.t||'') ? -1 : 1; });
          arr = arr.slice(0,5);
          if(!arr.length){ el.innerHTML = '<div class="empty">暂无专属价历史</div>'; return; }
          var s = '';
          for(i=0;i<arr.length;i++) s += '<div class="row"><span>' + esc(histDay(arr[i].t)) + '</span><span class="p">' + histMoney(arr[i].p) + '</span></div>';
          el.innerHTML = s;
        }).catch(function(){});
    }
    if(SUPA.on && typeof SUPA.loadCostLog === 'function'){
      SUPA.loadCostLog(d.n).then(function(rows){
        var c = document.getElementById('wpPeekCost'); if(!c) return;
        rows = (rows || []).slice(0, 5);
        if(!rows.length){ c.innerHTML = '<div class="empty">暂无进货记录</div>'; return; }
        var s = '';
        for(var k=0;k<rows.length;k++){
          s += '<div class="row"><span>' + esc(histDay(rows[k].dt)) + '</span><span>¥' + esc(money(rows[k].cost)) + '</span></div>';
        }
        c.innerHTML = s;
      }).catch(function(){ var c = document.getElementById('wpPeekCost'); if(c) c.innerHTML = '<div class="empty">进货记录加载失败</div>'; });
    }else{
      var c0 = document.getElementById('wpPeekCost'); if(c0) c0.innerHTML = '<div class="empty">未连接云端</div>';
    }
  }
  function closeDrugPeek(){
    var b = document.getElementById('wpDrugPeek'); if(b) b.classList.remove('on');
  }
  function addBlock(){
    var o = curOrder(); if(!o) return;
    o.blocks.push(blankBlock()); save(); renderBlocks(); recount();
  }
  function delBlock(bid){
    var o = curOrder(); if(!o) return;
    o.blocks = o.blocks.filter(function(b){ return b.id !== bid; }); save(); renderBlocks(); recount();
  }
  function setBlockTitle(bid, v){ var b = blockById(bid); if(!b) return; b.title = v; saveDebounced(); }
  function setBlockDate(bid, v){
    var b = blockById(bid); if(!b) return;
    b.date = String(v || '');
    saveDebounced();
  }
  function setBlockShip(bid, v){
    var b = blockById(bid); if(!b) return;
    b.ship = String(v || '');
    saveDebounced();
  }
  function setBlockSaveCommon(bid, v){
    var b = blockById(bid); if(!b) return;
    b.saveCommon = !!v;
    saveDebounced(); renderFoot();
  }
  function setRemark(bid, v){ var b = blockById(bid); if(!b) return; b.remark = v; saveDebounced(); }
  function setItemRemark(bid, i, v){
    var b = blockById(bid); if(!b) return;
    if(!b.items[i]) b.items[i] = BLANK_ITEM();
    b.items[i].rm = v; saveDebounced();
  }
  function setQty(bid, i, v){
    var b = blockById(bid); if(!b || !b.items[i]) return;
    var it = b.items[i]; var du = it.du || it.unit || 'g';
    it.qty = n(v) * uCoef(du, it.unit || du);
    saveDebounced(); updateAmt(bid,i); recount();
  }
  function setDoses(bid, v){
    var b = blockById(bid); if(!b) return;
    b.doses = Math.max(1, Math.round(n(v) || 1));
    saveDebounced(); recount(); renderFoot();
  }
  /* 去掉药名末尾「（当前单位）」后缀，得到基础药名（安全：只剥当前单位，避免误伤 姜半夏（旱）等变体名） */
  function baseOf(it){
    var s = String(it.name || '').trim();
    var cur = String(it.unit || it.du || '').trim();
    if(cur && cur !== 'g' && cur !== 'kg'){
      var s1 = '（' + cur + '）', s2 = '(' + cur + ')';
      if(s.length > s1.length && s.slice(-s1.length) === s1) return s.slice(0, -s1.length).trim();
      if(s.length > s2.length && s.slice(-s2.length) === s2) return s.slice(0, -s2.length).trim();
    }
    return s;
  }
  /* 药库没有该单位 → 新增一条「药名（单位）」记录（独立价格/库存），并落本机+云端 */
  function ensureUnitDrug(name, unit){
    var all = findDrugAll(name) || [];
    for(var i=0;i<all.length;i++){ if(String(all[i].u || 'g').toLowerCase() === String(unit).toLowerCase()) return all[i]; }
    var rec = { n: name, py: '', u: unit, c: '', cat: '中药', tccat: '', p: null, bp: null, st: 0 };
    if(!drugsList) drugsList = [];
    drugsList.push(rec);
    saveDrugsLS();     /* 写入 rx_drugs_v3（云端同步键）并触发 drugs 表 upsert */
    return rec;
  }
  /* 设置单位：支持 g/kg/罐/盒/瓶…（可自定义）。
     - g↔kg：按重量换算数量，金额不变
     - 换成非重量单位：数量不再换算成克，按「数量 × 单价」计价
     - 药库缺该单位→新增「药名（单位）」记录，单价带出（无价则留空手填） */
  function setUnit(bid, i, raw){
    var b = blockById(bid); if(!b || !b.items[i]) return;
    var it = b.items[i];
    var u = normUnit(raw) || 'g';
    var base = baseOf(it);
    var oldDu = String(it.du || it.unit || 'g').toLowerCase();
    var q = n(it.qty);
    if(isWeightUnit(oldDu) && isWeightUnit(u)){ q = q * uCoef(u, oldDu); }   /* 仅重量单位间换算 */
    it.qty = q;
    it.du = u;
    it.unit = u;
    /* 药库里没有这个名字（包装袋 / 无纺布袋 / 打细粉等耗材行）：
       保留原名称与手填单价，不生成「药名（单位）」记录，避免污染药品库 */
    if(!base || !(findDrugAll(base) || []).length){
      it.name = base;
      save(); renderBlocks(); recount(); return;
    }
    var uname = (u === 'g' || u === 'kg') ? base : (base + '（' + u + '）');
    it.name = uname;
    it.manual = false;
    if(u !== 'g' && u !== 'kg') ensureUnitDrug(uname, u);
    it.price = priceFor(uname, curGuest(), u);
    save(); renderBlocks(); recount();
  }
  function toggleUnit(bid, i){
    var b = blockById(bid); if(!b || !b.items[i]) return;
    var cur = String(b.items[i].unit || b.items[i].du || 'g').toLowerCase();
    setUnit(bid, i, cur === 'kg' ? 'g' : 'kg');
  }
  function setPrice(bid, i, v){
    var b = blockById(bid); if(!b || !b.items[i]) return;
    var it = b.items[i];
    it.price = (v === '' || v == null) ? null : n(v);
    it.manual = true;
    /* ⚠ 未发药的订单只是草稿：这里只改本行单价，不写客人专属价、不记历史成交。
       成交价统一在【标记发药】时由 recordDealHistory() 落库（2026-11-01 规则）。 */
    saveDebounced(); updateAmt(bid,i); recount();
  }
  function setItemName(bid, i, v){
    var b = blockById(bid); if(!b || !b.items[i]) return; var it = b.items[i];
    /* 用户手动改了输入框 → 不再沿用导入时的客户原名映射 */
    if(it.disp && String(v) !== String(it.disp)){ it.disp = null; it.sid = null; }
    it.name = v;
    if(!it.manual){ it.price = priceFor(it.name, curGuest(), it.du); }
    saveDebounced(); updateAmt(bid,i); recount();
  }
  function delItem(bid, i){ var b = blockById(bid); if(!b) return; b.items.splice(i,1); save(); renderBlocks(); recount(); }
  function addItems(bid, items){
    var b = blockById(bid); if(!b || !items || !items.length) return;
    b.items = b.items.concat(items); save(); renderBlocks(); recount();
  }
  function saveNow(){
    save(); var st = document.getElementById('wpSaveState');
    if(st) st.textContent = '已保存 · ' + nowHM();
    toast('已保存到云端（自动同步）');
  }

  /* ---- 药方复用：历史药方 + 常用方，卡片列表（可勾选多张） ---- */
  var _prevNos = [], _prevBid = null, _reuseTab = 'c', _prevSel = [], _reuseDose = {}, _prevSelCopy = [];
  function findRx(no){
    var all = allRx();
    for(var i=0;i<all.length;i++){ if(all[i].no === no) return all[i]; }
    return null;
  }
  function rxItems(rx){
    var its = parseItems(rx.m || ''); var items = [];
    for(var k=0;k<its.length;k++) items.push(mkFromParsed(its[k], curGuest()));
    return items;
  }
  function rkey(t, id){ return t + ':' + id; }
  function inReuseSel(t, id){ return _prevSel.indexOf(rkey(t, id)) >= 0; }
  function reuseDoseSet(t, id, v){ _reuseDose[rkey(t,id)] = Math.max(1, Math.round(n(v) || 1)); }
  function reuseDoseGet(t, id, def){ return _reuseDose[rkey(t,id)] || Math.max(1, Math.round(n(def) || 1)); }
  function reuseToggle(t, id, on){
    var k = rkey(t, id);
    _prevSel = _prevSel.filter(function(x){ return x !== k; });
    if(on) _prevSel.push(k);
    updateHistFoot();
  }
  function reuseTab(t){ _reuseTab = t === 'c' ? 'c' : 'h'; renderReuse(); }
  function itemsStats(items){
    var g = 0, per = 0, allKg = true, has = false, i;
    for(i=0;i<(items||[]).length;i++){
      var it = items[i]; if(!it || it.zibei) continue;
      var u = String(it.du || it.unit || 'g').toLowerCase();
      if(u === 'kg' || u === 'g'){ has = true; if(u !== 'kg') allKg = false; g += n(it.qty) * (u === 'kg' ? 1000 : 1); }
      per += n(it.price) * n(it.qty);
    }
    var useKg = has && allKg;
    return { w: useKg ? (Math.round(g/1000*1000)/1000) : (Math.round(g*10)/10), wu: useKg ? 'kg' : 'g', per: per };
  }
  function rxTitle(rx){
    var its = rxItems(rx), names = [];
    for(var i=0;i<its.length && names.length<3;i++){
      var nm = splitSfx(its[i].name || '').nm;
      if(nm) names.push(nm);
    }
    return names.length ? (names.join('、') + (its.length > 3 ? '…' : '')) : ('药方 ' + String(rx.no || ''));
  }
  function formulaOf(t, id){
    if(t === 'h'){
      var rx = findRx(id); if(!rx) return null;
      return { t:t, id:id, title:rxTitle(rx), items:rxItems(rx),
               doses:reuseDoseGet('h',id,n(rx.j)||1), date:rx.dt||'', tm:rx.tm||'', no:rx.no||'',
               guest:rx.n||'' };
    }
    var c = (typeof gstCfFind === 'function') ? gstCfFind(id) : null;
    if(!c) return null;
    var items = (c.items && c.items.length) ? JSON.parse(JSON.stringify(c.items)) : [];
    return { t:'c', id:id, title:c.name || '常用方', items:items,
             doses:reuseDoseGet('c',id,n(c.doses)||1), date:'', tm:'', no:'', guest:c.guest||'' };
  }
  function openHistory(bid){
    _tgt = bid; _prevBid = bid; _prevNos = []; _prevSel = []; _reuseDose = {}; _reuseTab = 'c';
    var o = curOrder();
    if(!o || !o.guest){ toastErr('请先在上方选择客人 / 医生'); return; }
    renderReuse();
    openModal('wpHistModal');
  }
  function renderReuse(){
    var body = document.getElementById('wpHistBody'); if(!body) return;
    var guest = curGuest();
    var h = '<div class="wp-reuse-tabs">'
      + '<button class="' + (_reuseTab === 'c' ? 'on' : '') + '" type="button" onclick="WPlan.reuseTab(\'c\')">常用方</button>'
      + '<button class="' + (_reuseTab === 'h' ? 'on' : '') + '" type="button" onclick="WPlan.reuseTab(\'h\')">历史药方</button>'
      + '</div>';
    var list = [];
    if(_reuseTab === 'h'){
      list = doctorRxs(guest);
      if(!list.length) h += '<div class="wp-empty">该客人暂无历史药方</div>';
      for(var i=0;i<list.length;i++){
        var r = list[i], rx = findRx(r.no); if(!rx) continue;
        var f = formulaOf('h', r.no); if(!f) continue;
        var st = itemsStats(f.items);
        h += '<div class="wp-reuse-card" onmouseenter="WPlan.reuseHover(this,\'h\',\'' + esc(r.no) + '\')" onmouseleave="WPlan.reuseLeave()">'
          + '<input class="chk" type="checkbox" ' + (inReuseSel('h', r.no) ? 'checked' : '') + ' onchange="WPlan.reuseToggle(\'h\',\'' + esc(r.no) + '\',this.checked)">'
          + '<div class="wp-reuse-main"><div class="wp-reuse-title">' + esc(f.title) + '</div>'
          + '<div class="wp-reuse-meta">' + esc(f.date) + ' ' + esc(f.tm || '') + ' ｜ 单付 ' + st.w + st.wu + ' ｜ <b>¥' + money(st.per) + '</b> ｜ ' + (rx.fy ? '已发' : '未发') + '</div></div>'
          + '<label class="wp-reuse-dose">付数<input type="number" min="1" step="1" value="' + f.doses + '" oninput="WPlan.reuseDoseSet(\'h\',\'' + esc(r.no) + '\',this.value)"></label>'
          + '<div class="wp-reuse-acts">'
          + '<button class="btn sm" type="button" onclick="WPlan.reuseOne(\'h\',\'' + esc(r.no) + '\',false)">复用</button>'
          + '<button class="btn sm" type="button" onclick="WPlan.reuseOne(\'h\',\'' + esc(r.no) + '\',true)">编辑</button>'
          + '</div></div>';
      }
    } else {
      var cfs = (typeof gstCfFor === 'function') ? gstCfFor(guest) : [];
      if(!cfs.length) h += '<div class="wp-empty">该客人暂无常用方</div>';
      for(var j=0;j<cfs.length;j++){
        var c = cfs[j], id = c.id || '';
        var fc = formulaOf('c', id); if(!fc) continue;
        var sc = itemsStats(fc.items);
        h += '<div class="wp-reuse-card" onmouseenter="WPlan.reuseHover(this,\'c\',\'' + esc(id) + '\')" onmouseleave="WPlan.reuseLeave()">'
          + '<input class="chk" type="checkbox" ' + (inReuseSel('c', id) ? 'checked' : '') + ' onchange="WPlan.reuseToggle(\'c\',\'' + esc(id) + '\',this.checked)">'
          + '<div class="wp-reuse-main"><div class="wp-reuse-title">' + esc(fc.title) + '</div>'
          + '<div class="wp-reuse-meta">常用方 ｜ 单付 ' + sc.w + sc.wu + ' ｜ <b>¥' + money(sc.per) + '</b></div></div>'
          + '<label class="wp-reuse-dose">付数<input type="number" min="1" step="1" value="' + fc.doses + '" oninput="WPlan.reuseDoseSet(\'c\',\'' + esc(id) + '\',this.value)"></label>'
          + '<div class="wp-reuse-acts">'
          + '<button class="btn sm" type="button" onclick="WPlan.reuseOne(\'c\',\'' + esc(id) + '\',false)">复用</button>'
          + '<button class="btn sm" type="button" onclick="WPlan.reuseOne(\'c\',\'' + esc(id) + '\',true)">编辑</button>'
          + '</div></div>';
      }
    }
    body.innerHTML = h;
    updateHistFoot();
  }
  function reuseHover(el, t, id){
    var f = formulaOf(t, id); if(!f || !el) return;
    var tip = document.getElementById('wpReuseTip'); if(!tip) return;
    var st = itemsStats(f.items), h = '<h4>' + esc(f.title) + '</h4>', i, it, u;
    for(i=0;i<f.items.length && i<10;i++){
      it = f.items[i];
      u = String(it.unit || it.du || 'g');
      h += '<div class="row"><span>' + esc(it.name || '') + '</span><span>' + (it.zibei ? '自备' : (dispQty(it) + ' ' + u)) + '</span></div>';
    }
    if(f.items.length > 10) h += '<div class="row">… 共 ' + f.items.length + ' 味</div>';
    h += '<div class="sum">单付 ' + st.w + st.wu + ' ｜ <span style="color:var(--pri-deep);font-weight:700">¥' + money(st.per) + '</span></div>';
    tip.innerHTML = h;
    tip.style.display = 'block';
    var r = el.getBoundingClientRect(), w = tip.offsetWidth || 300, hh = tip.offsetHeight || 120;
    var left = Math.min(r.left, window.innerWidth - w - 10); if(left < 8) left = 8;
    var top = r.bottom + 6; if(top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function reuseLeave(){ var t = document.getElementById('wpReuseTip'); if(t) t.style.display = 'none'; }
  function reuseOne(t, id, edit){
    var f = formulaOf(t, id); if(!f){ toastErr('药方不存在'); return; }
    var o = curOrder(); if(!o) return;
    var b = null;
    if(edit && _prevBid){ b = blockById(_prevBid); }
    if(b){
      b.items = JSON.parse(JSON.stringify(f.items));
      b.doses = f.doses;
      b.title = f.title || b.title;
      b.source = t === 'h' ? 'history' : 'common';
      b.fromRxNo = t === 'h' ? (f.no || '') : '';
      if(t === 'c') b.commonId = id;
    }else{
      if(_prevBid){
        var tb = blockById(_prevBid);
        if(tb && !tb.items.length){ b = tb; }
      }
      if(!b){ b = blankBlock(); o.blocks.push(b); }
      b.items = b.items.concat(JSON.parse(JSON.stringify(f.items)));
      b.doses = f.doses;
      b.title = f.title || b.title;
      b.source = t === 'h' ? 'history' : 'common';
      b.fromRxNo = t === 'h' ? (f.no || '') : '';
      if(t === 'c') b.commonId = id;
    }
    closeModal('wpHistModal'); closeModal('wpPrevModal'); reuseLeave();
    save(); renderBlocks(); renderOrderHead(); renderFoot(); recount();
    toast((edit ? '已载入「' : '已复用「') + (f.title || '药方') + '」');
  }
  function getPrevSel(){ return _prevSel.slice(); }
  function updateHistFoot(){
    var f = document.getElementById('wpHistFoot'); if(!f) return;
    var n2 = _prevSel.length;
    f.innerHTML = '<span class="wp-list-count">' + (n2 ? ('已选 ' + n2 + ' 张') : '可勾选多张一起复用') + '</span>'
      + '<button class="btn" type="button" onclick="WPlan.closeModal(\'wpHistModal\')">取消</button>'
      + '<button class="btn pri" type="button" onclick="WPlan.openReusePreview()">复用选中' + (n2 ? '（' + n2 + '）' : '') + '</button>';
  }
  /* 复用选中：先预览，确认后每张药方带入一个药方块 */
  function openReusePreview(){
    if(!_prevSel.length){ toastErr('请先勾选要复用的药方'); return; }
    var body = document.getElementById('wpPrevBody'); if(!body) return;
    var h = '', keys = _prevSel.slice();
    for(var s=0;s<keys.length;s++){
      var key = keys[s], t = key.charAt(0), id = key.slice(2);
      var f = formulaOf(t, id); if(!f) continue;
      var st = itemsStats(f.items), rowsH = '';
      for(var k=0;k<f.items.length;k++){
        var it = f.items[k], sp = splitSfx(it.name || '');
        var qty = n(it.qty), unit = it.unit || it.du || 'g';
        var price = it.zibei ? 0 : (it.price == null ? 0 : n(it.price));
        rowsH += '<tr><td>' + esc(sp.nm) + (sp.sfx ? '<span class="wp-prev-sfx">' + esc(sp.sfx) + '</span>' : '') + '</td>'
          + '<td class="num">' + (it.zibei ? '自备' : qty) + '</td><td>' + (it.zibei ? '' : esc(unit)) + '</td>'
          + '<td class="num">' + (it.zibei ? '' : money(price)) + '</td>'
          + '<td class="num">' + (it.zibei ? '' : money(price * qty)) + '</td></tr>';
      }
      h += '<div class="wp-prev-block"><div class="wp-prev-hd">' + esc(f.title) + ' · ' + f.doses + '付'
        + '<span class="fy">' + (t === 'h' ? (f.date + ' ' + f.tm) : '常用方') + '</span></div>'
        + '<table class="wp-prev-tbl"><thead><tr><th>药名</th><th class="num">数量</th><th>单位</th><th class="num">单价</th><th class="num">金额</th></tr></thead><tbody>'
        + (rowsH || '<tr><td colspan="5">（无药材）</td></tr>') + '</tbody></table>'
        + '<div class="wp-prev-sum">单付 <b>¥' + money(st.per) + '</b> × ' + f.doses + '付 = <b>¥' + money(st.per * f.doses) + '</b></div></div>';
    }
    if(!h){ toastErr('找不到药方内容'); return; }
    _prevSelCopy = keys.slice();
    body.innerHTML = h;
    closeModal('wpHistModal');
    openModal('wpPrevModal');
  }
  function openPreview(nos){
    _prevSel = (nos || []).map(function(no){ return 'h:' + no; });
    openReusePreview();
  }
  function confirmPreview(){
    var o = curOrder(); if(!o) return;
    if(!_prevSelCopy.length){ toastErr('没有可复用的药方'); return; }
    var usedTarget = false, cnt = 0, totalItems = 0;
    for(var s=0;s<_prevSelCopy.length;s++){
      var key = _prevSelCopy[s], p = key.split(':'), t = p[0], id = key.slice(2);
      var f = formulaOf(t, id); if(!f) continue;
      var b = null;
      if(!usedTarget && _prevBid){
        var tb = blockById(_prevBid);
        if(tb && !tb.items.length){ b = tb; usedTarget = true; }
      }
      if(!b){ b = blankBlock(); o.blocks.push(b); }
      b.items = b.items.concat(JSON.parse(JSON.stringify(f.items)));
      b.doses = f.doses;
      b.title = f.title || b.title;
      b.source = t === 'h' ? 'history' : 'common';
      b.fromRxNo = t === 'h' ? (f.no || '') : '';
      if(t === 'c') b.commonId = id;
      cnt++; totalItems += f.items.length;
    }
    _prevSel = []; _prevSelCopy = [];
    closeModal('wpPrevModal');
    save(); renderBlocks(); renderOrderHead(); renderFoot(); recount();
    toast('已复用 ' + cnt + ' 张药方，共 ' + totalItems + ' 味');
  }
  /* 兼容旧调用：直接把一张历史药方追加到指定方块（不经预览） */
  function bringHistory(bid, no){
    _prevBid = bid;
    reuseOne('h', no, false);
  }

  /* ---- 文本制表 ---- */
  function openText(bid){
    _tgt = bid; _imp.inline = false;
    openModal('wpTextModal');
    var ta = document.getElementById('wpText'); if(ta) ta.value = '';
    var ti = document.getElementById('wpTextTitle'); if(ti) ti.value = '';
    var dz = document.getElementById('wpTextDoses'); if(dz) dz.value = '1';
    var mt = document.getElementById('wpTextMatch'); if(mt) mt.style.display = 'none';
  }
  function doText(){
    var ta = document.getElementById('wpText'); var txt = ta ? String(ta.value || '') : '';
    if(!txt.trim()){ toastErr('请先粘贴药方文本'); return; }
    /* 识别标题：第一行不是「药名+剂量」的文本 → 标题 */
    var lines = txt.split(/\r?\n/), title = '', titleLine = '', i;
    for(i=0;i<lines.length;i++){
      var line = String(lines[i] || '').trim();
      if(!line) continue;
      var drugLine = /[一-龥]{1,12}\s*[0-9]+(?:\.[0-9]+)?\s*(g|kg|克|千克|公斤|ml|毫升|片|个|只|袋|盒|瓶)/i.test(line);
      if(drugLine) continue;
      title = line; titleLine = line; break;
    }
    /* 识别付数：30付 / 30包 / 30剂 */
    var dm = txt.match(/([0-9]+)\s*(付|包|剂)/);
    var doses = dm ? Math.max(1, parseInt(dm[1], 10)) : 1;
    var ti = document.getElementById('wpTextTitle'); if(ti) ti.value = title;
    var dz = document.getElementById('wpTextDoses'); if(dz) dz.value = doses;
    /* 标题行不参与药材解析 */
    var bodyTxt = titleLine ? txt.replace(titleLine, ' ') : txt;
    var its = parseItems(bodyTxt);
    if(!its.length){ toastErr('没解析到药材，请检查格式'); return; }
    var rows = [];
    for(i=0;i<its.length;i++){
      var it = its[i];
      if(!it || !it.name) continue;
      var sp = splitSfx(it.name);
      var orig = sp.nm; if(!orig) continue;
      if(/^[0-9.]+$/.test(orig) || /^[0-9]+(付|包|剂|克|g|kg)?$/.test(orig)) continue;
      var unit = String(it.unit || 'g');
      var m = impMatch(orig);
      var d = m.drug, std = d ? String(d.n) : '';
      rows.push({ orig: orig, qty: n(it.qty) || 0, unit: unit, sfx: sp.sfx || '',
        std: std, autoStd: std, autoHow: d ? m.how : 'none', drug: d,
        price: d ? priceFor(std, curGuest(), unit) : null, ok: !!d,
        how: d ? m.how : 'none', rm: '' });
    }
    if(!rows.length){ toastErr('没解析到可导入的药材'); return; }
    _imp.tgt = _tgt; _imp.guest = curGuest(); _imp.rows = rows; _imp.inline = true;
    var mt = document.getElementById('wpTextMatch'); if(mt) mt.style.display = 'block';
    impRender();
  }

  /* ---- 药名内联检索：表格药名输入框直接输药名/拼音，浮层选药自动带价 ---- */
  function BLANK_ITEM(){ return { name:'', qty:0, unit:'g', du:'g', price:null, manual:false, zibei:false, sfx:'', rm:'' }; }
  /* 检索词规范化：去首尾空白、去内部空格、统一小写（“麦 冬”与“麦冬”等价） */
  function acNorm(q){ return String(q == null ? '' : q).replace(/\s+/g, '').toLowerCase(); }
  /* 药名去掉规格后缀（（罐）/（大）/【...】/{...}）后的主体名，用于提高匹配相关性 */
  function acBare(nm){
    return String(nm || '').replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '')
      .replace(/【[^【】]*】/g, '').replace(/\[[^\[\]]*\]/g, '').replace(/\{[^{}]*\}/g, '');
  }
  /* 匹配打分：0-1 完全一致、2-3 前缀、4-5 包含；越小越相关，-1 = 不匹配 */
  function acScore(d, q){
    var nm = String(d.n || '').toLowerCase();
    var py = String(d.py || '').toLowerCase();
    var bare = acBare(nm);
    if(nm === q) return 0;
    if(bare === q) return 1;
    if(py === q) return 1;
    if(nm.indexOf(q) === 0) return 2;
    if(bare.indexOf(q) === 0) return 3;
    if(py.indexOf(q) === 0) return 3;
    if(nm.indexOf(q) > 0) return 4;          /* 药名中间包含：冬 → 麦冬/天冬 */
    if(py.indexOf(q) > 0) return 5;          /* 拼音中间包含 */
    return -1;
  }
  var AC_LIMIT = 60;
  /* 包含匹配 + 相关性排序（检索词由 openAc 按光标位置给出） */
  function acSearch(q){
    var key = acNorm(q);
    var list = drugsList || [], out = [], i, d;
    if(!key){                                 /* 空框：按目录顺序给出常用备选 */
      for(i=0;i<list.length && out.length<AC_LIMIT;i++){ if(list[i]) out.push(list[i]); }
      return out;
    }
    var hits = [];
    for(i=0;i<list.length;i++){
      d = list[i]; if(!d || !d.n) continue;
      var s = acScore(d, key);
      if(s < 0) continue;
      hits.push({ d: d, s: s, len: String(d.n).length, i: i });
    }
    hits.sort(function(a, b){
      if(a.s !== b.s) return a.s - b.s;
      if(a.len !== b.len) return a.len - b.len;   /* 同分则短名优先：麦冬 < 麦冬（罐） < 大川麦冬 */
      return a.i - b.i;
    });
    for(i=0;i<hits.length && out.length<AC_LIMIT;i++) out.push(hits[i].d);
    return out;
  }
  function acEl(){
    var el = document.getElementById('wpAc');
    if(!el){ el = document.createElement('div'); el.id = 'wpAc'; el.className = 'wp-ac'; document.body.appendChild(el); }
    return el;
  }
  function closeAc(){
    _ac = null;
    var el = document.getElementById('wpAc'); if(el) el.style.display = 'none';
  }
  function acRender(){
    if(!_ac || !_ac.list.length){ closeAc(); return; }
    var el = acEl(), h = '';
    for(var j=0;j<_ac.list.length;j++){
      var d = _ac.list[j];
      var pr = (d.p != null && d.p !== '') ? (money(n(d.p)) + '/' + d.u) : '无价';
      h += '<div class="r' + (j === _ac.idx ? ' on' : '') + '" data-nm="' + esc(d.n) + '"><span class="nm">' + esc(d.n) + '</span><span class="pr">' + pr + '</span></div>';
    }
    el.innerHTML = h;
    el.style.display = 'block';
    var rows = el.querySelectorAll('.r');
    for(var k=0;k<rows.length;k++){
      (function(r){ r.onmousedown = function(e){ e.preventDefault(); var pick = _ac && _ac.pick; if(pick) pick(r.getAttribute('data-nm')); }; })(rows[k]);
    }
    /* 定位：按浮层【实际高度】贴着输入框摆放（下方放不下就紧贴上沿翻上去，不再用固定高度估算） */
    var rect = _ac.el.getBoundingClientRect();
    el.style.minWidth = Math.max(rect.width, 220) + 'px';
    acPlace();
  }
  /* 贴着输入框定位：优先下方，下方不足且上方够高则紧贴上沿，两边都不够则取空间大的一侧 */
  function acPlace(){
    if(!_ac) return;
    var el = document.getElementById('wpAc');
    if(!el || el.style.display === 'none') return;
    var rect = _ac.el.getBoundingClientRect();
    var Gap = 2, Pad = 6;
    var h = el.offsetHeight, w = el.offsetWidth;
    var below = window.innerHeight - rect.bottom - Pad;
    var above = rect.top - Pad;
    var top;
    if(h <= below) top = rect.bottom + Gap;                /* 下方放得下：紧贴下沿 */
    else if(h <= above) top = rect.top - h - Gap;          /* 下方放不下、上方放得下：紧贴上沿 */
    else if(above > below) top = Pad;                      /* 两边都放不下：取空间大的一侧并贴边 */
    else top = Math.max(Pad, window.innerHeight - h - Pad);
    var left = rect.left;
    if(left + w > window.innerWidth - Pad) left = Math.max(Pad, window.innerWidth - w - Pad);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  /* 滚动/缩放后跟随；输入框滚出视口则收起 */
  function acFollow(){
    if(!_ac) return;
    var r = _ac.el.getBoundingClientRect();
    if(r.bottom < 6 || r.top > window.innerHeight - 6){ closeAc(); return; }
    acPlace();
  }
  /* 检索词 = 光标之前的文字：光标停在「桔|梗」时搜「桔」，停在「桔梗|」时搜「桔梗」；
     光标在最前面（前面没字）时退回用整串内容。 */
  function acTerm(el){
    var v = String(el.value || '');
    var pos = el.selectionStart;
    if(pos == null || pos < 0 || pos >= v.length) return v;
    var t = v.slice(0, pos);
    if(!acNorm(t)) return v;
    return t;
  }
  /* 按「光标前文字」检索并弹出备选 */
  function openAc(bid, i, el){
    var b = blockById(bid);
    if(b && !b.items[i]) b.items[i] = BLANK_ITEM();   /* 空药方的首行：输入即落账 */
    var term = acTerm(el);
    var list = acSearch(term);
    if(!list.length){                                  /* 光标落在规格括号里（「桔梗（普」/「桔梗（普）」）→ 退一步按主体名搜 */
      var t2 = term.replace(/\s+$/, '').replace(/[（(【\[{][^）)】\]}]*[）)】\]}]?$/, '');
      if(t2 && acNorm(t2) && t2 !== term) list = acSearch(t2);
    }
    if(!list.length){ closeAc(); return; }
    _ac = { bid: bid, i: i, el: el, list: list, idx: 0, term: term, pick: acPick };
    acRender();
  }
  function nameInput(bid, i, el){
    setItemName(bid, i, el.value);
    openAc(bid, i, el);
  }
  /* 聚焦 / 点击输入框任意位置即按「光标前文字」检索；空内容显示全部/常用药材 */
  function nameFocus(bid, i, el){
    if(_acSilent){ _acSilent = false; return; }
    openAc(bid, i, el);
  }
  /* 键盘移动光标（← → Home End 及 Shift 组合）后按新光标位置重新检索 */
  function nameCursor(e, bid, i, el){
    var k = e.key;
    if(k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End' || k === 'ArrowUp' || k === 'ArrowDown'){
      if(k === 'ArrowUp' || k === 'ArrowDown'){ if(_ac && _ac.bid === bid && _ac.i === i) return; }  /* 上下键交给 ac 导航 */
      _acSilent = false;
      openAc(bid, i, el);
    }
  }
  function nameKey(e, bid, i){
    var k = e.key;
    if(_ac && _ac.bid === bid && _ac.i === i && _ac.list.length){
      if(k === 'ArrowDown'){ _ac.idx = (_ac.idx + 1) % _ac.list.length; acRender(); e.preventDefault(); return; }
      if(k === 'ArrowUp'){ _ac.idx = (_ac.idx - 1 + _ac.list.length) % _ac.list.length; acRender(); e.preventDefault(); return; }
      if(k === 'Escape'){ closeAc(); return; }
      if((k === 'Enter' || k === 'Tab') && _ac.el && _ac.el.value.trim() !== ''){
        var d = _ac.list[_ac.idx];
        if(d){ e.preventDefault(); acPick(d.n); }
        return;
      }
    }
    if(k === 'Enter'){ e.preventDefault(); addBlankRow(bid, i); }
  }
  function nameBlur(){ closeAc(); }
  /* 选中备选：回填药名并自动带单价（医生专属价优先）/单位 */
  function acPick(name){
    if(!_ac) return;
    var b = blockById(_ac.bid);
    if(!b){ closeAc(); return; }
    if(!b.items[_ac.i]) b.items[_ac.i] = BLANK_ITEM();
    var it = b.items[_ac.i];
    it.name = name;
    it.disp = null; it.sid = null;     /* 从备选里重新选药 → 以标准药名为准 */
    it.price = priceFor(name, curGuest(), it.du);
    it.unit = it.du;
    it.manual = false;
    var pos = { bid: _ac.bid, i: _ac.i };
    closeAc();
    save(); renderBlocks(); recount();
    var ni = document.querySelector('#wpBlock-' + pos.bid + ' tbody tr:nth-child(' + (pos.i + 1) + ') .wp-nm');
    if(ni){ _acSilent = true; ni.focus(); }
  }
  /* 回车在当前行下方新增一行空白输入行，光标移过去继续录入 */
  function addBlankRow(bid, afterIdx){
    var b = blockById(bid); if(!b) return;
    if(!b.items[afterIdx]) b.items[afterIdx] = BLANK_ITEM();
    b.items.splice(afterIdx + 1, 0, BLANK_ITEM());
    save(); renderBlocks(); recount();
    var ni = document.querySelector('#wpBlock-' + bid + ' tbody tr:nth-child(' + (afterIdx + 2) + ') .wp-nm');
    if(ni) ni.focus();
  }

  /* ---- Excel / CSV 导入（别名智能映射 + 预览校验） ----
     流程：读文件 → 解析行（保留客户原始药名 / 备注）→ 智能匹配仓库标准药
          → 「导入预览与匹配确认」表格（绿=匹配，红=未匹配可下拉选药）
          → 确认后按标准药名 + 仓库价落账；输入框保留客户原名 it.disp，计价/库存仍走标准药名/sid。
     手动选药时，自动把客户药名存为仓库药的【别名】，下次直接命中。 */
  var IMP_TAG_ALTS={
    '炒':['炒','清炒','麸炒'], '麸炒':['麸炒','炒'], '盐':['盐','盐水'],
    '醋':['醋','醋制'], '酒':['酒','酒炙'], '蜜炙':['蜜炙','蜜'], '蜜':['蜜','蜜炙'],
    '姜':['姜','姜制'], '炙':['炙','蜜炙'], '制':['制'], '生':['生'], '炭':['炭'], '煅':['煅']
  };
  var IMP_SYN={
    '牛子':['牛蒡子','炒牛蒡子'], '川仲':['川牛膝'], '故纸':['补骨脂','破故纸'],
    '夜交藤':['首乌藤','夜交藤'], '申姜':['骨碎补'], '银花':['金银花'],
    '二花':['金银花'], '元胡':['延胡索'], '玄胡':['延胡索'], '瓜萎':['瓜蒌'],
    '黄苓':['黄芩'], '厚补':['厚朴'], '紫苑':['紫菀'], '牡丹皮':['丹皮'],
    '辛夷花':['辛夷'], '薏苡仁':['炒薏仁','薏仁','薏米'], '川断':['续断','川续断'],
    '莱菔子':['炒莱菔子','莱菔子'], '莱服子':['炒莱菔子','莱菔子']
  };
  var _imp = { rows: [], tgt: null, guest: '', inline: false };

  /* 药名分段：body（去方括号脚注）/ core（去规格括号）/ tag（括号内容）/ sfx */
  function impSplit(raw){
    var s = String(raw || '').trim(), sfx = '', body = s;
    var m = s.match(/^(.*?)([\[［][^\]］]*[\]］])$/);
    if(m){ body = m[1]; sfx = m[2]; }
    var core = body, tag = '';
    var pm = body.match(/^([^()（）]*)[（(]([^（）()]*)[）)]$/);
    if(pm){ core = pm[1]; tag = pm[2]; }
    return { body: body.trim(), core: core.trim(), tag: tag.trim(), sfx: sfx };
  }
  function impDrugs(){
    var out = [], seen = {};
    for(var i=0;i<drugsList.length;i++){
      var d = drugsList[i];
      if(!d || !String(d.n || '').trim()) continue;
      if((d.cat || '中药') !== '中药') continue;
      var k = normName(d.n); if(seen[k]) continue; seen[k] = 1;
      out.push(d);
    }
    return out;
  }
  function impExactName(name){
    var key = normName(name); if(!key) return null;
    for(var i=0;i<drugsList.length;i++){
      var d = drugsList[i];
      if(d && d.n && normName(d.n) === key) return d;
    }
    return null;
  }
  function impAliasName(name){
    var key = normName(name); if(!key) return null;
    for(var i=0;i<drugsList.length;i++){
      var d = drugsList[i]; if(!d || !d.n) continue;
      var al = Array.isArray(d.al) ? d.al : [];
      for(var j=0;j<al.length;j++){ if(al[j] && normName(al[j]) === key) return d; }
    }
    return null;
  }
  function impContains(core){
    var key = normName(core); if(!key || key.length < 2) return null;
    var arr = impDrugs(), best = null, bl = 0;
    for(var i=0;i<arr.length;i++){
      var k = normName(arr[i].n);
      if(k.length < 2 || k.indexOf(key) < 0) continue;
      /* 取包含核心名的「最短」候选：地黄 → 地黄，而不是熟地黄 */
      if(!best || k.length < bl){ best = arr[i]; bl = k.length; }
    }
    return best;
  }
  /* 智能匹配：返回 { drug, how }；how = exact / alias / dict / tag / core / syn / contain
     顺序原则：原名 → 别名记忆 → 内置别名表 → 「炒/醋/盐…」炮制写法 → 去掉括号的主干
              → 括号内容本身 → 俗称 → 包含兜底。 */
  function impMatch(raw){
    var p = impSplit(raw), d = null, i, j, combos, alts, t;
    /* ① 原名精确 */
    d = impExactName(p.body); if(d) return { drug: d, how: 'exact' };
    /* ② 别名记忆（药物管理里手工存下的别名） */
    d = impAliasName(p.body) || impAliasName(p.core); if(d) return { drug: d, how: 'alias' };
    /* ③ 内置别名表（normKey 已处理 [先煎] 等脚注） */
    if(_idx){ d = _idx[normKey(p.body)]; if(d) return { drug: d, how: 'dict' }; }
    /* ④ 括号内是炮制方式 → 拼成「炒鸡内金 / 醋香附 / 蜜远志」等仓库写法（优先于主干） */
    alts = (p.tag && IMP_TAG_ALTS[p.tag]) ? IMP_TAG_ALTS[p.tag] : [];
    for(i=0;i<alts.length;i++){
      t = alts[i];
      combos = [t + p.core, p.core + t];
      for(j=0;j<combos.length;j++){ d = impExactName(combos[j]); if(d) return { drug: d, how: 'tag' }; }
    }
    /* ⑤ 去掉括号后的主干精确匹配（如 姜半夏（姜水旱半夏）→ 姜半夏） */
    d = impExactName(p.core); if(d) return { drug: d, how: 'core' };
    /* ⑥ 括号内容本身就是仓库药名（故纸（补骨脂）→ 补骨脂、夜交藤（首乌藤）→ 首乌藤） */
    if(p.tag && p.tag.length >= 2){ d = impExactName(p.tag); if(d) return { drug: d, how: 'tag' }; }
    if(_idx){ d = _idx[normKey(p.core)]; if(d) return { drug: d, how: 'dict' }; }
    /* ⑦ 常见俗称 → 正名；炮制词 + 俗称组合（薏苡仁（炒）→ 炒薏仁） */
    var syn = IMP_SYN[p.core] || [];
    for(i=0;i<alts.length;i++){
      for(j=0;j<syn.length;j++){ d = impExactName(alts[i] + syn[j]); if(d) return { drug: d, how: 'syn' }; }
    }
    for(i=0;i<syn.length;i++){ d = impExactName(syn[i]); if(d) return { drug: d, how: 'syn' }; }
    /* ⑧ 兜底：主干被仓库名包含（放宽到最长公共） */
    d = impContains(p.core); if(d) return { drug: d, how: 'contain' };
    return { drug: null, how: 'none' };
  }
  /* 把客户药名存成仓库药（stdName）的别名；已有同名别名/与正名相同则跳过 */
  function impRememberAlias(stdName, alias){
    var a = String(alias || '').trim();
    if(!a) return false;
    var d = null;
    for(var i=0;i<drugsList.length;i++){
      if(drugsList[i] && String(drugsList[i].n || '').trim() === String(stdName || '').trim()){ d = drugsList[i]; break; }
    }
    if(!d || normName(a) === normName(d.n)) return false;
    var al = Array.isArray(d.al) ? d.al : [];
    for(var j=0;j<al.length;j++){ if(normName(al[j]) === normName(a)) return false; }
    al.push(a);
    d.al = al;
    saveDrugsLS();                       /* 落本机 + 触发云端 drugs 整表 upsert */
    return true;
  }
  function impYes(v){ return /^(是|有|要|需要|加|真|true|yes|y|1)$/i.test(String(v || '').trim()); }

  /* 解析 CSV 为行数据（含原始药名、匹配结果、备注） */
  function parseImportRows(text){
    text = String(text || '').replace(/^\ufeff/, '');
    var lines = text.split(/\r?\n/).filter(function(l){ return l.trim(); });
    if(!lines.length) return { rows: [], miss: [] };
    function pl(l){ var out=[], cur='', q=false; for(var i=0;i<l.length;i++){ var c=l[i]; if(q){ if(c==='"'){ if(l[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=c; } else if(c==='"'){ q=true; } else if(c===','){ out.push(cur); cur=''; } else cur+=c; } out.push(cur); return out; }
    var head = pl(lines[0]), idx = {}, hi;
    for(hi=0;hi<head.length;hi++) idx[String(head[hi]).trim()] = hi;
    function col(){
      for(var a=0;a<arguments.length;a++){ if(idx[arguments[a]] != null) return idx[arguments[a]]; }
      for(var key in idx){ for(var m=0;m<arguments.length;m++){ if(idx.hasOwnProperty(key) && key.indexOf(arguments[m]) >= 0) return idx[key]; } }
      return -1;
    }
    var cn = col('药名','名称','品名','药材','药品'), cq = col('数量','克数','重量','剂量','克','量'), cu = col('单位','规格');
    if(cn < 0){ toastErr('没找到药名列（表头需含 药名/名称/品名）'); return null; }
    var cr = col('备注','说明');
    /* 已知列之外的「是否加虫包 / 先来 / 签名…」：除签名等身份列外，值转成备注 */
    var extras = [];
    for(hi=0;hi<head.length;hi++){
      var hd = String(head[hi] || '').trim();
      if(!hd || hi === cn || hi === cq || hi === cu || hi === cr) continue;
      if(/签名|签字|经手|制表|序号|编号|行号|单号/.test(hd)) continue;
      extras.push(hi);
    }
    var rows = lines.slice(1).map(pl).filter(function(a){ return a.length > 1; });
    var out = [], miss = [], cache = {};
    for(var r=0;r<rows.length;r++){
      var nm0 = String(rows[r][cn] || '').trim(); if(!nm0) continue;
      var raw = String(cq >= 0 ? (rows[r][cq] || '') : '').trim();
      var rawU = String(cu >= 0 ? (rows[r][cu] || '') : '').trim();
      var qv = parseFloat(raw); if(isNaN(qv)) qv = 0;
      /* 数量列内联单位：15kg / 10000g / 2千克 / 0.5公斤 —— 与单位列同等对待 */
      var im = raw.match(/^([0-9]*\.?[0-9]+)\s*([^\d\s]+)$/);
      if(im){ qv = parseFloat(im[1]); if(!rawU) rawU = im[2]; }
      /** 单位识别不区分大小写（kg/Kg/KG → kg，g/G → g，千克/公斤 → kg）；识别不到要提示，不静默处理 */
      var u = rawU ? normUnit(rawU) : '';
      if(!u || !KNOWN_UNITS[u]) miss.push('第 ' + (r + 2) + ' 行 ' + nm0 + (rawU ? '（' + rawU + '）' : '（未填单位）'));
      /* 特殊列 → 备注：是否加虫包=是 → 加虫包；先来=先来 → 先来 */
      var notes = [], ei, hv, hdv;
      for(ei=0;ei<extras.length;ei++){
        hv = String(rows[r][extras[ei]] || '').trim(); if(!hv) continue;
        hdv = String(head[extras[ei]] || '').trim();
        if(/^是否/.test(hdv)){ if(impYes(hv)) notes.push(hdv.replace(/^是否/, '')); }
        else notes.push(impYes(hv) ? hdv : hv);
      }
      if(cr >= 0){ hv = String(rows[r][cr] || '').trim(); if(hv) notes.push(hv); }
      var seenNote = {}, uniq = [];
      for(ei=0;ei<notes.length;ei++){ if(notes[ei] && !seenNote[notes[ei]]){ seenNote[notes[ei]] = 1; uniq.push(notes[ei]); } }
      var sp = impSplit(nm0);
      var mk2 = cache[nm0] || (cache[nm0] = impMatch(nm0));
      var d = mk2.drug;
      var std = d ? String(d.n) : '';
      var price = d ? priceFor(std, curGuest(), u || 'g') : null;
      out.push({
        orig: nm0, qty: qv, unit: u || 'g', sfx: sp.sfx || '',
        std: std, autoStd: std, autoHow: d ? mk2.how : 'none', drug: d, price: price, ok: !!d,
        how: d ? mk2.how : 'none', rm: uniq.join('，')
      });
    }
    return { rows: out, miss: miss };
  }
  function openExcel(bid){ _tgt = bid; var f = document.getElementById('wpFile'); if(f) f.click(); }
  function readBuf(file, cb){
    var fr = new FileReader();
    fr.onload = function(){ cb(fr.result); };
    fr.onerror = function(){ toast('读取文件失败'); };
    fr.readAsArrayBuffer(file);
  }
  /* 预览表格：绿=已匹配，红=未匹配。每行都能下拉换药：
     选中即确定该行药品，单价随之重算；与自动匹配结果不同时记作手动指定（确认后存别名）。 */
  function impRender(){
    var body = document.getElementById(_imp.inline ? 'wpTextMatchBody' : 'wpImportBody');
    var sum = document.getElementById(_imp.inline ? 'wpTextMatchSum' : 'wpImportSum');
    if(!body) return;
    var rows = _imp.rows, hits = 0, h = '', i;
    for(i=0;i<rows.length;i++){
      var r = rows[i]; if(r.ok) hits++;
      var cls = r.ok ? 'imp-ok' : 'imp-bad';
      var howTxt = r.ok
        ? (r.how === 'manual' ? '手动指定' : r.how === 'alias' ? '别名记忆' : r.how === 'exact' ? '精确匹配' : '智能匹配')
        : '未匹配';
      var stdCell = '<div class="imp-std">' + impInputHTML(r, i) + (r.ok ? '<span class="imp-tag">' + esc(howTxt) + '</span>' : '') + '</div>';
      var pr = (r.price == null) ? (r.ok ? '<span class="imp-noprice">无价</span>' : '—') : '¥' + money(r.price);
      h += '<tr class="' + cls + '">'
        + '<td>' + esc(r.orig) + '</td>'
        + '<td>' + stdCell + '</td>'
        + '<td><input class="imp-qty" type="number" min="0" step="0.1" value="' + (r.qty == null ? '' : r.qty) + '" oninput="WPlan.impEditQty(' + i + ',this.value)"></td>'
        + '<td><input class="imp-unit" data-ddoptions="' + esc(JSON.stringify(unitOptionsFor(r.std || r.orig))) + '" value="' + esc(r.unit) + '" onchange="WPlan.impEditUnit(' + i + ',this.value)"></td>'
        + '<td class="num">' + pr + '</td>'
        + '<td>' + (r.rm ? esc(r.rm) : '') + '</td>'
        + '</tr>';
    }
    body.innerHTML = h || '<tr><td colspan="6" class="imp-empty">没有可导入的药名行</td></tr>';
    if(sum){
      sum.innerHTML = '共 <b>' + rows.length + '</b> 行 · 已匹配 <b class="ok">' + hits + '</b> 行 · 未匹配 <b class="bad">' + (rows.length - hits) + '</b> 行'
        + '（药名可直接输入药名/拼音搜索，选中的药即为该行确定药品）';
    }
  }
  /* 每行药名格：输入即检索，备选浮层与日常打单完全一致（#wpAc / .wp-ac） */
  function impInputHTML(r, ri){
    return '<input class="imp-nm ' + (r.ok ? 'ok' : 'bad') + '" value="' + esc(r.std || '') + '" autocomplete="off"'
      + ' placeholder="输入药名 / 拼音搜索"'
      + ' onfocus="WPlan.impAcFocus(' + ri + ',this)" onclick="WPlan.impAcFocus(' + ri + ',this)"'
      + ' oninput="WPlan.impAcInput(' + ri + ',this)"'
      + ' onkeydown="WPlan.impAcKey(event,' + ri + ',this)" onkeyup="WPlan.impAcKey(event,' + ri + ',this)"'
      + ' onblur="WPlan.impAcBlur(' + ri + ',this)">';
  }
  /* 打开与打单表格同款的药名备选浮层（按光标前文字检索） */
  function impOpenAc(ri, el){
    var term = acTerm(el);
    var list = acSearch(term);
    if(!list.length){
      var t2 = term.replace(/\s+$/, '').replace(/[（(【\[{][^）)】\]}]*[）)】\]}]?$/, '');
      if(t2 && acNorm(t2) && t2 !== term) list = acSearch(t2);
    }
    if(!list.length){ closeAc(); return; }
    _ac = { imp: ri, el: el, list: list, idx: 0, term: term,
      pick: function(nm){ impPickName(ri, nm); } };
    acRender();
  }
  function impAcFocus(ri, el){ impOpenAc(ri, el); }
  function impAcInput(ri, el){ impOpenAc(ri, el); }
  function impAcBlur(ri, el){
    closeAc();
    var r = _imp.rows[ri];
    if(r) el.value = r.std || '';        /* 没从备选里选 → 恢复为已确定的药，不静默改价 */
  }
  function impAcKey(e, ri, el){
    if(e.type === 'keyup'){
      var ku = e.key;
      if(ku === 'ArrowLeft' || ku === 'ArrowRight' || ku === 'Home' || ku === 'End') impOpenAc(ri, el);
      return;
    }
    var k = e.key;
    if(_ac && _ac.imp !== undefined && _ac.list && _ac.list.length){
      if(k === 'ArrowDown'){ _ac.idx = (_ac.idx + 1) % _ac.list.length; acRender(); e.preventDefault(); return; }
      if(k === 'ArrowUp'){ _ac.idx = (_ac.idx - 1 + _ac.list.length) % _ac.list.length; acRender(); e.preventDefault(); return; }
      if(k === 'Escape'){ closeAc(); impAcBlur(ri, el); return; }
      if(k === 'Enter'){
        var d = _ac.list[_ac.idx];
        if(d){ e.preventDefault(); impPickName(ri, d.n); }
        return;
      }
    }
    if(k === 'Enter') e.preventDefault();
  }
  /* 选中某味药 = 该行确定药品：重算单价、标记手动指定 */
  function impPickName(ri, nm){
    var r = _imp.rows[ri]; if(!r) return;
    var d = null;
    for(var i=0;i<drugsList.length;i++){ if(drugsList[i] && String(drugsList[i].n || '') === String(nm)){ d = drugsList[i]; break; } }
    if(!d) d = impExactName(nm);
    if(!d) return;
    r.drug = d; r.std = String(d.n); r.ok = true;
    r.how = (r.autoStd && normName(r.std) === normName(r.autoStd)) ? (r.autoHow || 'exact') : 'manual';
    r.price = priceFor(r.std, _imp.guest, r.unit);
    closeAc();
    impRender();
  }
  function impEditQty(ri, v){
    var r = _imp.rows[ri]; if(!r) return;
    var q = parseFloat(v); r.qty = isNaN(q) ? 0 : q;
  }
  function impEditUnit(ri, v){
    var r = _imp.rows[ri]; if(!r) return;
    var u = normUnit(v) || 'g';
    r.unit = u;
    if(r.ok && r.std) r.price = priceFor(r.std, _imp.guest, u);
    impRender();
  }
  function impCancel(){
    closeModal('wpImportModal');
    var mt = document.getElementById('wpTextMatch'); if(mt) mt.style.display = 'none';
    _imp.rows = []; _imp.inline = false;
  }
  function impConfirm(){
    var rows = _imp.rows, items = [], i, skipped = 0, aliased = 0, ah = [];
    for(i=0;i<rows.length;i++){
      var r = rows[i];
      if(!r.ok){ skipped++; continue; }
      var std = r.std, sfx = r.sfx || '';
      /* 仓库标准名做计价；[先煎] 等脚注仍单独存 it.sfx，避免与药名重复展示 */
      var it = mk(std, _imp.guest, r.qty, r.unit, true);
      it.sfx = sfx;
      if(r.rm) it.rm = r.rm;
      /* 输入框保留客户原始药名（it.disp）；底层仍用仓库标准药 it.name / sid 计价与扣减 */
      var origBody = impSplit(r.orig).body;
      if(normName(origBody) !== normName(r.std)){ it.disp = origBody; }
      if(r.drug && r.drug.id) it.sid = r.drug.id;
      items.push(it);
      /* 手动匹配 → 记忆别名（下次导入直接命中；脚注不参与别名，避免 [先煎] 变体干扰） */
      if(r.how === 'manual' && r.std){
        if(impRememberAlias(r.std, origBody)){ aliased++; ah.push(r.orig + ' → ' + r.std); }
      }
    }
    var inline = !!_imp.inline, tgtId = _imp.tgt;
    closeModal(inline ? 'wpTextModal' : 'wpImportModal');
    var mt = document.getElementById('wpTextMatch'); if(mt) mt.style.display = 'none';
    _imp.rows = []; _imp.inline = false;
    if(!items.length){ toastErr('没有任何匹配成功的行，未导入'); return; }
    /* 文本制表：标题 / 付数可在识别后手动修改，确认时写回当前药方块 */
    if(inline){
      var b = blockById(tgtId);
      if(b){
        var ti = document.getElementById('wpTextTitle');
        var dz = document.getElementById('wpTextDoses');
        if(ti && String(ti.value || '').trim()) b.title = String(ti.value).trim();
        if(dz && n(dz.value) > 0) b.doses = Math.max(1, Math.round(n(dz.value)));
        b.source = 'text';
      }
    }
    addItems(tgtId, items);
    var msg = '已导入 ' + items.length + ' 行';
    if(skipped) msg += '，跳过 ' + skipped + ' 行未匹配';
    if(aliased) msg += '，已记住 ' + aliased + ' 个别名（' + ah.slice(0, 3).join('、') + (ah.length > 3 ? '…' : '') + '）';
    (skipped ? toastErr : toast)(msg);
  }
  function onExcelFile(fi){
    var f = fi.files && fi.files[0]; fi.value = ''; if(!f) return;
    readBuf(f, function(buf){
      var u = new Uint8Array(buf);
      if(u.length > 2 && u[0] === 0x50 && u[1] === 0x4B){
        toastErr('不支持直接读取 .xlsx/.xls 二进制，请改用 Excel「另存为 → CSV（逗号分隔）」后导入'); return;
      }
      var txt = decodeCsvBuffer(buf);
      var res = parseImportRows(txt);
      if(res === null) return;
      if(!res.rows.length){ toast('没有可导入的药名行'); return; }
      if(res.miss.length){
        var msg = '有 ' + res.miss.length + ' 行未识别到单位：\n' + res.miss.slice(0, 10).join('\n') + (res.miss.length > 10 ? '\n…' : '')
          + '\n\n这些行按「g」导入，继续？\n（点「取消」中止本次导入）';
        if(!confirm(msg)) return;
      }
      _imp.tgt = _tgt; _imp.guest = curGuest();
      _imp.rows = res.rows; _imp.inline = false;
      impRender();
      openModal('wpImportModal');
    });
  }

  /* ---- 弹窗 ---- */
  function openModal(id){ var m = document.getElementById(id); if(m) m.classList.add('on'); }
  function closeModal(id){ var m = document.getElementById(id); if(m) m.classList.remove('on'); }
  function bindBackdrops(){
    ['wpHistModal','wpPrevModal','wpTextModal','wpPayModal','wpImportModal'].forEach(function(id){
      var m = document.getElementById(id);
      if(m) m.onclick = function(e){ if(e.target === m) closeModal(id); };
    });
    /* 页面滚动 / 窗口缩放时浮层继续跟着输入框走（输入框滚出视口才收起） */
    window.addEventListener('scroll', function(e){ if(e.target && e.target.id === 'wpAc') return; acFollow(); }, true);
    window.addEventListener('resize', acFollow);
  }

  function ensure(){
    if(typeof gstLoadCf === 'function'){ try{ gstLoadCf(); }catch(e){} }
    load();
    bindBackdrops();
    renderAll();
  }

  return {
    ensure: ensure, renderAll: renderAll, selectOrder: selectOrder, setCurrent: setCurrent,
    newOrder: newOrder, delOrder: delOrder, delOrderById: delOrderById,
    setFilter: setFilter, setView: setView, showSub: showSub, setSearch: setSearch,
    toggleSel: toggleSel, toggleSelAll: toggleSelAll,
    openPlan: openPlan, closePlan: closePlan, exportPlanWord: exportPlanWord,
    openPay: openPay, copyPay: copyPay, downloadPay: downloadPay,
    exportOrderImage: exportOrderImage, exportBlockImage: exportBlockImage,
    setBlockDate: setBlockDate, setBlockShip: setBlockShip, setBlockSaveCommon: setBlockSaveCommon,
    setGuest: setGuest, commitGuest: commitGuest, setDate: setDate, toggleFy: toggleFy, addBlock: addBlock, delBlock: delBlock,
    priceHover: priceHover, priceLeave: priceLeave, openDrugPeek: openDrugPeek, closeDrugPeek: closeDrugPeek,
    setDish: setDish, setSaveCommon: setSaveCommon,
    saveNow: saveNow, saveAndBack: saveAndBack, backToList: backToList,
    printCur: printCur, printOrder: printOrder,
    setBlockTitle: setBlockTitle, setRemark: setRemark, setItemRemark: setItemRemark, setQty: setQty, setDoses: setDoses, setPrice: setPrice,
    setItemName: setItemName, delItem: delItem, addItems: addItems,
    toggleUnit: toggleUnit, setUnit: setUnit,
    openHistory: openHistory, bringHistory: bringHistory,
    reuseTab: reuseTab, reuseToggle: reuseToggle, reuseDoseSet: reuseDoseSet, reuseOne: reuseOne,
    reuseHover: reuseHover, reuseLeave: reuseLeave, openReusePreview: openReusePreview,
    getPrevSel: getPrevSel, openPreview: openPreview, confirmPreview: confirmPreview,
    openText: openText, doText: doText,
    nameInput: nameInput, nameFocus: nameFocus, nameKey: nameKey, nameCursor: nameCursor, nameBlur: nameBlur, acPick: acPick, addBlankRow: addBlankRow,
    openExcel: openExcel, onExcelFile: onExcelFile, impAcFocus: impAcFocus, impAcInput: impAcInput, impAcKey: impAcKey, impAcBlur: impAcBlur, impEditQty: impEditQty, impEditUnit: impEditUnit, impConfirm: impConfirm, impCancel: impCancel, closeModal: closeModal,
    getCur: function(){ return S.cur; },
    ordersList: function(){ return S.orders; }
  };
})();

/* =====================================================================
   🖨 WPrint · 药方（计划药单）打印模板 + 实时预览 + 打印
   ---------------------------------------------------------------------
   设计原则（用户 2026-10-29）：
   ① 制表数据必须干净 —— 订单里只存 客人/日期/药名/数量/单价，**不存店名地址**；
   ② 店名 / 电话 / 地址 / 单据标题只活在「打印模板」里，渲染时才注入；
   ③ 同一份订单可套不同模板出 发货单 / 销售单 / 小票 / 不带价格版；
   ④ 打印走 window.print()，用 #wpPrintArea + 动态 @page，与旧处方打印互不干扰。
   ===================================================================== */
var WPrint=(function(){
  var LS='rx_wptpl_v1';
  var PAPER={
    a4:{w:210,h:297,label:'A4 210×297mm'},
    a5:{w:148,h:210,label:'A5 148×210mm'},
    '58':{w:58,h:0,label:'小票 58mm'},
    '80':{w:80,h:0,label:'小票 80mm'}
  };
  var TEXTKEYS={title:1,shop:1,tel:1,addr:1,custLabel:1,footNote:1};
  var S={tpls:[], curId:'', order:null, loaded:false};
  function n2(x){ var v=parseFloat(x); return isFinite(v)?v:0; }
  function r2(x){ return Math.round(n2(x)*100)/100; }
  function mm2px(mm){ return Math.round(n2(mm)*96/25.4*100)/100; }

  /* ---------- 模板数据 ---------- */
  function baseTpl(){
    return { id:'', name:'', paper:'a5', orient:'portrait',
      padL:12, padR:12, padT:10, padB:10,
      title:'发货单', shop:'', tel:'', addr:'', custLabel:'顾客', footNote:'',
      showShop:true, showTitle:true, showTel:true, showAddr:true, showIndex:true,
      showSpec:true, showOrigin:false, showPrice:true, showAmount:true, showNote:true, showWeight:true,
      showDish:true, showNo:true, showStamp:true,
      pageMode:'auto', rowsPerPage:20, showPageNo:false,
      fs:11, rh:22, isDefault:false };
  }
  function mk(o){
    var t=baseTpl(), k;
    for(k in o){ if(o.hasOwnProperty(k)) t[k]=o[k]; }
    if(!t.id) t.id=newId();
    return t;
  }
  function newId(){ return 'T'+Date.now().toString(36)+Math.random().toString(36).slice(2,5); }
  function defaults(){
    return [
      mk({id:'T-a5-fh', name:'发货单 · A5（不带价格）', paper:'a5', title:'发货单',
          pageMode:'page', rowsPerPage:20, showPrice:false, showAmount:false, isDefault:true}),
      mk({id:'T-a4-xs', name:'销售单 · A4（带价格）', paper:'a4', title:'销售单',
          padL:18, padR:18, padT:15, padB:15, fs:12, rh:24, pageMode:'auto'}),
      mk({id:'T-a5-xs', name:'销售单 · A5（带价格）', paper:'a5', title:'销售单',
          pageMode:'auto'}),
      mk({id:'T-58-mx', name:'小票 · 58mm', paper:'58', title:'销售单',
          padL:4, padR:4, padT:3, padB:3, fs:9, rh:17,
          showShop:false, showTel:false, showAddr:false, showIndex:false,
          showNote:false, showSpec:false, showWeight:false, custLabel:'顾客'})
    ];
  }
  function load(){
    if(S.loaded) return;
    var a=null;
    try{ a=JSON.parse(RX_STORE.getItem(LS)||'null'); }catch(e){ a=null; }
    if(a && a.length){
      S.tpls=a.map(function(t){
        var d=baseTpl(), k;
        for(k in t){ if(t.hasOwnProperty(k)) d[k]=t[k]; }
        return d;
      });
    } else { S.tpls=defaults(); saveLS(); }
    var dft=null, i;
    for(i=0;i<S.tpls.length;i++){ if(S.tpls[i].isDefault) dft=S.tpls[i]; }
    S.curId=(dft||S.tpls[0]).id;
    S.loaded=true;
  }
  function saveLS(){ try{ RX_STORE.setItem(LS, JSON.stringify(S.tpls)); }catch(e){} }
  function curTpl(){
    load();
    for(var i=0;i<S.tpls.length;i++){ if(S.tpls[i].id===S.curId) return S.tpls[i]; }
    return S.tpls[0];
  }
  function tplById(id){
    for(var i=0;i<S.tpls.length;i++){ if(S.tpls[i].id===id) return S.tpls[i]; }
    return null;
  }
  /* 云端 print_templates 表：以模板名为自然键，整条覆盖写。
     header jsonb 存完整配置（表头内容 店名/地址/电话 + 边距 + 字号 + 行高 + 各显示开关），
     同时同步平列 shop_name / show_price / show_amount / font_size / row_height / is_default，
     方便在 Supabase 后台直接看。 */
  function rowOf(t){
    return { name:t.name,
      shop_name:t.shop||'',
      show_price:!!t.showPrice, show_amount:!!t.showAmount,
      font_size:Math.round(n2(t.fs)), row_height:Math.round(n2(t.rh)),
      is_default:!!t.isDefault,
      header:{ id:t.id, shop:t.shop||'', tel:t.tel||'', addr:t.addr||'',
               pad:{ l:n2(t.padL), r:n2(t.padR), t:n2(t.padT), b:n2(t.padB) },
               cfg:t } };
  }
  /* 同一个模板名的「删 → 写」必须串行：否则新建后立刻删除时，
     POST 会晚于 DELETE 落地，云端留下一条幽灵模板。 */
  var _q={};
  function queue(name, fn){
    _q[name]=((_q[name]||Promise.resolve()).then(fn)).catch(function(e){
      console.warn('模板云端写入失败:', (e&&e.message)||e);
    });
  }
  function pushCloud(t){
    if(typeof SUPA==='undefined' || !SUPA.on || !t) return;
    var row=rowOf(t), nm=t.name;
    queue(nm, function(){
      return SUPA.q('print_templates?name=eq.'+encodeURIComponent(nm), {method:'DELETE'})
        .then(function(){ return SUPA.q('print_templates',{method:'POST', body:row}); });
    });
  }
  function delCloud(name){
    if(typeof SUPA==='undefined' || !SUPA.on) return;
    queue(name, function(){
      return SUPA.q('print_templates?name=eq.'+encodeURIComponent(name),{method:'DELETE'});
    });
  }
  /* 打开面板时以云端为准（模板要在手机 / Mac / Windows 上一致）；云端空则把本机默认推上去 */
  function pullCloud(){
    if(typeof SUPA==='undefined' || !SUPA.on) return;
    SUPA.q('print_templates?select=*&order=id.asc').then(function(rows){
      var valid=[], v;
      for(v=0;v<(rows||[]).length;v++){
        var rr=rows[v];
        /* 只认带完整 cfg 的行；早期测试留下的空壳行直接忽略，也顺手清掉 */
        if(rr && rr.header && rr.header.cfg && rr.header.cfg.paper) valid.push(rr);
        else if(rr && rr.name) delCloud(rr.name);
      }
      if(!valid.length){
        for(var q0=0;q0<S.tpls.length;q0++) pushCloud(S.tpls[q0]);
        return;
      }
      var out=[], i;
      for(i=0;i<valid.length;i++){
        var r=valid[i], h=r.header||{}, cfg=h.cfg||{};
        var t=baseTpl(), k;
        for(k in cfg){ if(cfg.hasOwnProperty(k)) t[k]=cfg[k]; }
        if(!t.id) t.id=h.id||newId();
        t.name=String(r.name||t.name||'模板');
        t.shop=String(r.shop_name==null?(t.shop||''):r.shop_name);
        if(r.show_price!=null) t.showPrice=!!r.show_price;
        if(r.show_amount!=null) t.showAmount=!!r.show_amount;
        if(r.font_size!=null) t.fs=r.font_size;
        if(r.row_height!=null) t.rh=r.row_height;
        t.isDefault=!!r.is_default;
        if(h.tel!=null) t.tel=String(h.tel);
        if(h.addr!=null) t.addr=String(h.addr);
        if(h.pad){ t.padL=n2(h.pad.l); t.padR=n2(h.pad.r); t.padT=n2(h.pad.t); t.padB=n2(h.pad.b); }
        out.push(t);
      }
      if(!out.length) return;
      S.tpls=out; saveLS();
      var dft=null;
      for(i=0;i<S.tpls.length;i++){ if(S.tpls[i].isDefault) dft=S.tpls[i]; }
      S.curId=(dft||S.tpls[0]).id;
      renderList(); syncForm(); renderPreview();
    }).catch(function(){});
  }
  /* ---------- 打开展示 ---------- */

  /* ---------- 打开展示 ---------- */
  function open(){
    var o=null;
    try{ o=WPlan.getCur(); }catch(e){ o=null; }
    /* 没有打开的订单时，自动打开最近一张，别让「打印设置」变成一个死按钮 */
    if(!o){
      var list=[];
      try{ list=WPlan.ordersList()||[]; }catch(e){ list=[]; }
      if(list.length){ try{ WPlan.setCurrent(list[0].id); o=WPlan.getCur(); }catch(e){} }
    }
    if(!o && WPlan && WPlan.ensure){ try{ WPlan.ensure(); o=WPlan.getCur(); }catch(e){} }
    if(!o){ toast('先在订单列表里点开一张单据'); return; }
    load();
    S.order=o;
    var sh=$('wpsSheet'); if(!sh) return;
    sh.classList.add('on');
    renderList(); syncForm(); renderPreview(); pullCloud();
  }
  function close(){ var sh=$('wpsSheet'); if(sh) sh.classList.remove('on'); }
  function isOpen(){ var sh=$('wpsSheet'); return !!(sh && sh.classList.contains('on')); }

  function seg(id, v){
    var box=$(id); if(!box) return;
    var bs=box.querySelectorAll('button');
    for(var i=0;i<bs.length;i++){ bs[i].classList.toggle('on', bs[i].getAttribute('data-v')===v); }
  }
  function setNum(id,v){ var e=$(id); if(e) e.textContent=v; }
  function setVal(id,v){ var e=$(id); if(e) e.value=(v==null?'':v); }
  function setChk(id,v){ var e=$(id); if(e) e.checked=!!v; }

  function renderList(){
    var box=$('wpsTplList'); if(!box) return;
    load();
    var h='', i, t;
    for(i=0;i<S.tpls.length;i++){
      t=S.tpls[i];
      h+='<div class="wps-tpl'+(t.id===S.curId?' on':'')+'" data-id="'+esc(t.id)+'">'
        +'<div class="t"><b>'+esc(t.name)+(t.isDefault?' · 默认':'')+'</b>'
        +'<span>'+esc((PAPER[t.paper]||PAPER.a5).label)+' · '+esc(t.title||'')+'</span></div>'
        +'<button type="button" class="wps-ico" title="重命名" onclick="event.stopPropagation();WPrint.renameTpl(\''+esc(t.id)+'\')">✎</button>'
        +'<button type="button" class="wps-ico del" title="删除模板" onclick="event.stopPropagation();WPrint.delTpl(\''+esc(t.id)+'\')">✕</button>'
        +'</div>';
    }
    box.innerHTML=h;
    var rows=box.querySelectorAll('.wps-tpl');
    for(i=0;i<rows.length;i++){
      rows[i].onclick=function(){ pick(this.getAttribute('data-id')); };
    }
  }
  function pick(id){
    if(!tplById(id)) return;
    S.curId=id; renderList(); syncForm(); renderPreview();
  }
  function syncForm(){
    var t=curTpl();
    setVal('wpsPaperSel',t.paper);
    seg('wpsOrient',t.orient); seg('wpsPageMode',t.pageMode);
    setVal('wpsPadL',t.padL); setNum('wpsPadLv',t.padL);
    setVal('wpsPadR',t.padR); setNum('wpsPadRv',t.padR);
    setVal('wpsPadT',t.padT); setNum('wpsPadTv',t.padT);
    setVal('wpsPadB',t.padB); setNum('wpsPadBv',t.padB);
    setVal('wpsRpp',t.rowsPerPage); setNum('wpsRppv',t.rowsPerPage);
    setChk('wpsShowPageNo',t.showPageNo);
    setVal('wpsTitle',t.title); setVal('wpsShop',t.shop); setVal('wpsTel',t.tel);
    setVal('wpsAddr',t.addr); setVal('wpsCustLabel',t.custLabel); setVal('wpsFoot',t.footNote);
    setChk('wpsSwShop',t.showShop); setChk('wpsSwTitle',t.showTitle);
    setChk('wpsSwTel',t.showTel); setChk('wpsSwAddr',t.showAddr);
    setChk('wpsSwIndex',t.showIndex); setChk('wpsSwSpec',t.showSpec);
    setChk('wpsSwOrigin',t.showOrigin);
    setChk('wpsSwPrice',t.showPrice); setChk('wpsSwAmount',t.showAmount);
    setChk('wpsSwNote',t.showNote); setChk('wpsSwWeight',t.showWeight);
    setChk('wpsSwDish',t.showDish!==false); setChk('wpsSwNo',t.showNo!==false);
    setChk('wpsSwStamp',t.showStamp!==false);
    setVal('wpsFs',t.fs); setNum('wpsFsv',t.fs);
    setVal('wpsRh',t.rh); setNum('wpsRhv',t.rh);
    var rr=$('wpsRppRow'); if(rr) rr.style.display=(t.pageMode==='auto'?'none':'flex');
    var bt=$('wpsBarTpl'); if(bt) bt.textContent=t.name;
    var bm=$('wpsBarMeta');
    if(bm) bm.textContent=(PAPER[t.paper]||PAPER.a5).label+' · '+(t.orient==='landscape'?'横向':'纵向');
  }
  function togglePageSub(){
    var t = curTpl();
    cfg('pageMode', t.pageMode === 'pageSub' ? 'page' : 'pageSub');
  }
  /* 所有左侧控件都走这一个入口：改模板 → 存本地 → 刷预览 */
  function cfg(k,v){
    var t=curTpl();
    var bools={showShop:1,showTitle:1,showTel:1,showAddr:1,showIndex:1,showSpec:1,showOrigin:1,
               showPrice:1,showAmount:1,showNote:1,showWeight:1,showPageNo:1,showDish:1,showNo:1,showStamp:1};
    if(bools[k]) t[k]=!!v;
    else if(TEXTKEYS[k]) t[k]=String(v==null?'':v);
    else if(k==='paper'||k==='orient'||k==='pageMode') t[k]=v;
    else t[k]=n2(v);
    saveLS();
    if(!TEXTKEYS[k]) syncForm();
    renderPreview();
  }

  /* ---------- 模板增删改 ---------- */
  function addTpl(){
    load();
    var c=mk({ name:'新模板 '+(S.tpls.length+1), paper:'a5', title:'发货单' });
    c.isDefault=false;
    S.tpls.push(c); S.curId=c.id; saveLS();
    renderList(); syncForm(); renderPreview(); pushCloud(c);
  }
  function renameTpl(id){
    var t=tplById(id); if(!t) return;
    var nm=prompt('模板名称', t.name);
    if(nm===null) return;
    nm=String(nm).trim(); if(!nm) return;
    var old=t.name;
    t.name=nm; S.curId=id; saveLS();
    if(old!==nm) delCloud(old);
    renderList(); syncForm(); pushCloud(t);
  }
  function delTpl(id){
    load();
    if(S.tpls.length<=1){ toast('至少保留一个模板'); return; }
    var t=tplById(id); if(!t) return;
    if(!confirm('删除模板「'+t.name+'」？')) return;
    var wasDefault=!!t.isDefault, i;
    for(i=0;i<S.tpls.length;i++){ if(S.tpls[i].id===id){ S.tpls.splice(i,1); break; } }
    if(wasDefault && S.tpls.length) S.tpls[0].isDefault=true;
    if(S.curId===id) S.curId=S.tpls[0].id;
    saveLS(); delCloud(t.name);
    renderList(); syncForm(); renderPreview();
    toast('已删除模板');
  }
  function saveTpl(asNew){
    var t=curTpl();
    if(asNew){
      var nm=prompt('新模板名称','副本 · '+(t.title||t.name));
      if(nm===null) return;
      var c=mk(t);
      c.id=newId(); c.name=String(nm||'').trim()||('模板 '+(S.tpls.length+1)); c.isDefault=false;
      S.tpls.push(c); S.curId=c.id; saveLS(); pushCloud(c);
      renderList(); syncForm(); renderPreview();
      toast('已另存为「'+c.name+'」');
      return;
    }
    saveLS(); pushCloud(t); toast('模板已保存');
  }

  /* ---------- 单据内容 ---------- */
  function orderRemark(o){
    var out=[], bs=(o&&o.blocks)||[];
    for(var i=0;i<bs.length;i++){
      if(bs[i].remark && String(bs[i].remark).trim()) out.push(String(bs[i].remark).trim());
    }
    return out.join('；');
  }
  function flatRows(o){
    var out=[], bs=(o&&o.blocks)||[], i, j, b, its, it, doses, q, pr;
    for(i=0;i<bs.length;i++){
      b=bs[i]; doses=n2(b.doses)||1; its=b.items||[];
      for(j=0;j<its.length;j++){
        it=its[j];
        if(!it || !String(it.name==null?'':it.name).trim()) continue;
        q=n2(it.qty)*doses;
        pr=it.zibei?0:n2(it.price);
        var nm=String(it.name).trim();
        /* 产地来自药物目录（打印时才查，订单里不存）；查库用标准药名 */
        var dd=null; try{ dd=findDrug(nm); }catch(e){ dd=null; }
        /* 导入时保留了客户原始叫法：打印显示客户原名，计价/查库仍按标准药 */
        var disp=(it.disp || it.orig) ? String(it.disp || it.orig) : nm;
        out.push({ name:disp, sfx:it.sfx||'',
          unit:(it.du||it.unit||'g'),
          og:(dd&&dd.og)?String(dd.og):'',
          qty:q, price:pr, amount:it.zibei?0:r2(pr*q),
          note:it.rm||'', zibei:!!it.zibei });
      }
    }
    return out;
  }
  function weightOf(rows){
    var w=0, i, u, q;
    for(i=0;i<rows.length;i++){
      u=String(rows[i].unit||'').toLowerCase(); q=n2(rows[i].qty);
      if(u==='g') w+=q/1000;
      else if(u==='kg') w+=q;
      else if(u==='斤') w+=q*0.5;
    }
    return Math.round(w*1000)/1000;
  }
  function fmtQty(v){ return String(Math.round(n2(v)*1000)/1000); }
  function fmtMoney(v){ return String(Math.round(n2(v)*100)/100); }
  /* 人民币大写（发货单/销售单底部的「成交金额大写」） */
  function upperMoney(num){
    var x=n2(num);
    if(x<=0) return '零元整';
    var D=['零','壹','贰','叁','肆','伍','陆','柒','捌','玖'];
    var U=['','拾','佰','仟','万','拾','佰','仟','亿','拾','佰','仟'];
    var i0=Math.floor(x), dec=Math.round((x-i0)*100);
    var str=String(i0), s='', i;
    for(i=0;i<str.length;i++){ s+=D[+str.charAt(i)]+U[str.length-1-i]; }
    s=s.replace(/零[拾佰仟]/g,'零').replace(/零零+/g,'零')
       .replace(/零([万亿])/g,'$1').replace(/^零+/,'').replace(/零+$/,'');
    if(s) s+='元';
    if(!dec) return (s||'零元')+'整';
    var jiao=Math.floor(dec/10), fen=dec%10;
    if(jiao) s+=D[jiao]+'角'; else if(fen) s+='零';
    if(fen) s+=D[fen]+'分';
    return s;
  }
  function rowsPerPageFor(t){
    var user = Math.round(n2(t.rowsPerPage) || 20);
    /* 旧默认 20 行在 A4 上会留大半页空白：按纸张高度自动补足每页行数；
       用户手动改成其它值时尊重手动值 */
    if(user !== 20) return user;
    var p = PAPER[t.paper] || PAPER.a5;
    if(!p.h) return user;
    var hh = (t.orient === 'landscape') ? p.w : p.h;
    var contentPx = mm2px(Math.max(80, hh - n2(t.padT) - n2(t.padB))) - 190;
    var rh = Math.max(14, n2(t.rh) || 22);
    var cap = Math.floor(contentPx / rh);
    return Math.max(20, Math.min(cap, 70));
  }
  function paginate(rows, t){
    var out=[], per=rowsPerPageFor(t);
    if(t.pageMode==='auto' || rows.length<=per){ out.push(rows); return out; }
    for(var i=0;i<rows.length;i+=per) out.push(rows.slice(i, i+per));
    return out;
  }
  function colSpec(t){
    var cols=[], narrow=(t.paper==='58'||t.paper==='80');
    if(t.showIndex) cols.push({k:'i', t:'序号', w:8, cls:'c'});
    cols.push({k:'n', t:'商品名称', w:narrow?46:28});
    if(t.showSpec) cols.push({k:'s', t:'规格', w:11, cls:'c'});
    if(t.showOrigin) cols.push({k:'o', t:'产地', w:narrow?14:12, cls:'c'});
    cols.push({k:'q', t:'数量', w:narrow?17:12, cls:'num'});
    if(t.showPrice) cols.push({k:'p', t:'单价', w:narrow?18:13, cls:'num'});
    if(t.showAmount) cols.push({k:'a', t:'金额', w:narrow?19:13, cls:'num'});
    if(t.showNote) cols.push({k:'m', t:'备注', w:15});
    return cols;
  }
  function pageHtml(o, t, rows, pi, totalPages, grand){
    var h='', i, r, cols=colSpec(t), sum=0, wt=weightOf(rows), colW=0, c;
    var narrow=(t.paper==='58'||t.paper==='80');
    for(i=0;i<cols.length;i++) colW+=cols[i].w;

    /* ---- 表头：店名 / 电话 / 地址 / 标题 全部来自模板 ---- */
    var left='', right='';
    left+='<div>'+esc(t.custLabel||'顾客')+'：'+esc(String(o.guest||'').trim()||'—')+'</div>';
    if(t.showDish !== false) left+='<div>订单名称：'+esc(String(o.dish||'').trim()||'—')+'</div>';
    left+='<div>业务日期：'+esc(o.date||'')+'</div>';
    if(o.no && t.showNo !== false) left+='<div>单号：'+esc(o.no)+'</div>';
    var rmk=orderRemark(o);
    if(rmk) left+='<div>备注：'+esc(rmk)+'</div>';
    if(t.showShop && t.shop) right+='<div>制单：'+esc(t.shop)+'</div>';
    if(t.showTel && t.tel) right+='<div>电话：'+esc(t.tel)+'</div>';
    if(t.showAddr && t.addr) right+='<div>地址：'+esc(t.addr)+'</div>';

    h+='<div class="wpd'+(narrow?' wpd-narrow':'')+'" style="--wpd-rh:'+Math.round(n2(t.rh))+'px">';
    /* 只有第一页显示抬头，后续页直接续表格 */
    if(pi === 0){
      h+='<div class="wpd-h">';
      if(t.showShop && t.shop) h+='<div class="wpd-shop">'+esc(t.shop)+'</div>';
      if(t.showTitle) h+='<div class="wpd-title">'+esc(t.title||'发货单')+'</div>';
      h+='<div class="wpd-metas"><div class="l">'+left+'</div><div class="r">'+right+'</div></div>';
      h+='</div>';
    }

    /* ---- 明细表 ---- */
    h+='<table class="wpd-tbl"><colgroup>';
    for(i=0;i<cols.length;i++){ h+='<col style="width:'+(Math.round(cols[i].w/colW*1000)/10)+'%">'; }
    h+='</colgroup><thead><tr>';
    for(i=0;i<cols.length;i++){
      c=cols[i];
      h+='<th'+(c.cls?' class="'+c.cls+'"':'')+'>'+esc(c.t)+'</th>';
    }
    h+='</tr></thead><tbody>';
    for(i=0;i<rows.length;i++){
      r=rows[i]; sum+=r.amount;
      h+='<tr>';
      if(t.showIndex) h+='<td class="c">'+(pi*Math.max(1,Math.round(n2(t.rowsPerPage)||20))+i+1)+'</td>';
      h+='<td>'+esc(r.name)+(r.sfx?(' '+esc(r.sfx)):'')+'</td>';
      if(t.showSpec) h+='<td class="c">'+esc(r.unit)+'</td>';
      if(t.showOrigin) h+='<td class="c">'+esc(r.og||'')+'</td>';
      h+='<td class="num">'+fmtQty(r.qty)+'</td>';
      if(t.showPrice) h+='<td class="num">'+(r.zibei?'自备':fmtMoney(r.price))+'</td>';
      if(t.showAmount) h+='<td class="num">'+(r.zibei?'—':fmtMoney(r.amount))+'</td>';
      if(t.showNote) h+='<td>'+esc(r.note)+'</td>';
      h+='</tr>';
    }
    h+='</tbody></table>';

    /* ---- 合计：只在整个订单的最后一页出现，放在分页横线上方 ---- */
    if(t.pageMode==='pageSub' && t.showAmount && totalPages>1){
      h+='<div class="wpd-subline">本页小计：'+fmtMoney(sum)+' 元（第 '+(pi+1)+' / '+totalPages+' 页）</div>';
    }
    if(grand && pi === totalPages-1 && (t.showWeight || t.showAmount)){
      h+='<div class="wpd-total">';
      if(t.showWeight) h+='<span>合计重量：'+grand.wt+'kg</span>';
      if(t.showAmount) h+='<span>合计金额：'+fmtMoney(grand.sum)+'</span>';
      h+='</div>';
    }

    /* ---- 页脚：横线下方左侧页码 / 右侧盖章处 ---- */
    h+='<div class="wpd-foot">';
    h+='<div class="wpd-foot-l">';
    if(t.footNote) h+='<div>'+esc(t.footNote)+'</div>';
    if(t.showTel && t.tel) h+='<div>联系方式：'+esc(t.tel)+'</div>';
    if(totalPages>1 || t.showPageNo){
      h+='<div class="wpd-page">'+(t.showPageNo?('第 '+(pi+1)+' / '+totalPages+' 页'):'页：'+(pi+1)+'/'+totalPages)+'</div>';
    }
    h+='</div>';
    if(t.showStamp !== false) h+='<div class="wpd-foot-r"><div class="wpd-stamp">盖章处：</div></div>';
    h+='</div>';
    h+='</div>';
    return h;
  }
  function docHtml(o, t){
    var rows=flatRows(o), pages=paginate(rows,t), h='', i;
    var grand={ sum:0, wt:weightOf(rows) };
    for(i=0;i<rows.length;i++) grand.sum += rows[i].amount;
    for(i=0;i<pages.length;i++) h+=pageHtml(o, t, pages[i], i, pages.length, grand);
    return h;
  }

  /* ---------- 预览 ---------- */
  function renderPreview(){
    var t=curTpl(), o=S.order||{blocks:[]};
    var paper=$('wpsPaper'), stage=$('wpsStage');
    if(!paper) return;
    var p=PAPER[t.paper]||PAPER.a5;
    var w=p.w, hh=(p.h||240);
    if(t.orient==='landscape'){ var tmp=w; w=hh; hh=tmp; }
    var pw=mm2px(w), ph=mm2px(hh);
    var rows=flatRows(o), pages=paginate(rows,t), i;
    var grand={ sum:0, wt:weightOf(rows) };
    for(i=0;i<rows.length;i++) grand.sum += rows[i].amount;
    var pad=n2(t.padT)+'mm '+n2(t.padR)+'mm '+n2(t.padB)+'mm '+n2(t.padL)+'mm';
    var html='';
    /* 所有分页都顺着往下预览，不再只显示第一页 */
    for(i=0;i<pages.length;i++){
      html += '<div class="wps-page" style="width:'+pw+'px;padding:'+pad+'">'
        + pageHtml(o,t,pages[i],i,pages.length,grand) + '</div>';
    }
    paper.style.width=pw+'px';
    paper.style.minHeight='auto';
    paper.style.padding='0';
    paper.style.background='transparent';
    paper.style.boxShadow='none';
    paper.style.fontSize=Math.round(n2(t.fs))+'px';
    paper.innerHTML=html;
    var tot=0, j;
    for(j=0;j<rows.length;j++) tot+=rows[j].amount;
    var avail=(stage?stage.clientWidth:900)-52;
    var sc=avail/pw; if(sc>1) sc=1; if(sc<0.2) sc=0.2;
    paper.style.zoom=Math.round(sc*1000)/1000;
    var bo=$('wpsBarOrder');
    if(bo) bo.textContent=(String(o.guest||'').trim()||'未填客人')+' · '+(o.date||'')+' · '+rows.length+' 味 · '+
      (pages.length>1?('共 '+pages.length+' 页'):'1 页')+' · 合计 ¥'+fmtMoney(tot);
    window.__WPS_LAST={ pages:pages.length, rows:rows.length, total:tot,
      pageW:w, pageH:hh, scale:paper.style.zoom };
  }

  /* ---------- 打印 ---------- */
  function pageSizeCss(t){
    var p=PAPER[t.paper]||PAPER.a5, w=p.w, hh=p.h;
    if(t.orient==='landscape'){ var tmp=w; w=hh||240; hh=tmp; }
    return (hh? (w+'mm '+hh+'mm') : (w+'mm auto'));
  }
  function doPrint(){
    var t=curTpl(), o=S.order;
    if(!o){ toast('没有可打印的订单'); return; }
    var area=$('wpPrintArea'), css=$('wpPrintPageCss');
    if(!area || !css) return;
    var p=PAPER[t.paper]||PAPER.a5;
    var w=p.w;
    if(t.orient==='landscape') w=(p.h||240);
    var s='@page{size:'+pageSizeCss(t)+';margin:0}';
    s+='#wpPrintArea{display:block;width:'+w+'mm}';
    s+='#wpPrintArea .wpd{padding:'+n2(t.padT)+'mm '+n2(t.padR)+'mm '+n2(t.padB)+'mm '+n2(t.padL)+'mm;'
      +'font-size:'+Math.round(n2(t.fs))+'px;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#000}';
    css.textContent=s;
    area.innerHTML=docHtml(o,t);
    document.body.classList.add('wp-printing');
    var done=false;
    function clean(){
      if(done) return; done=true;
      document.body.classList.remove('wp-printing');
      area.innerHTML='';
      css.textContent='';
      window.removeEventListener('afterprint', clean);
    }
    window.addEventListener('afterprint', clean);
    try{ window.print(); }catch(e){ toastErr('调起打印失败：'+((e&&e.message)||e)); }
    setTimeout(clean, 1500);
  }

  /* Esc 关闭面板 */
  document.addEventListener('keydown', function(e){
    if((e.key==='Escape'||e.keyCode===27) && isOpen()) close();
  });

  return { open:open, close:close, isOpen:isOpen, cfg:cfg, pick:pick, togglePageSub:togglePageSub,
    addTpl:addTpl, renameTpl:renameTpl, delTpl:delTpl, saveTpl:saveTpl,
    doPrint:doPrint, renderPreview:renderPreview, docHtml:docHtml,
    upperMoney:upperMoney, flatRows:flatRows, weightOf:weightOf,
    tpls:function(){ load(); return S.tpls; }, cur:curTpl,
    _state:S };
})();

/* ===================== 进货单模块 ===================== */
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

/* =====================================================================
   📅 自建日历（2026-10-31，移植自阿田财务，配色改为药方品牌绿）
   - 全站 date / month 输入框统一转为只读文本框 + 自绘日历
   - 日 / 月 / 年三级联动；日视图带「今天 / 昨天 / 前天」
   - 浮层挂在 body，避免被 overflow 容器裁切
   ===================================================================== */
var RxCal=(function(){
  var _c=null, _outside=null, _key=null, _repos=null;
  function pad2(x){ x=String(x); return x.length<2?'0'+x:x; }
  function dstr(y,m,d){ return y+'-'+pad2(m)+'-'+pad2(d); }
  function mkDate(y,m,d){ var dt=new Date(y,m-1,d); return dstr(dt.getFullYear(),dt.getMonth()+1,dt.getDate()); }
  function todayKey(){ try{ return today(); }catch(e){ var d=new Date(); return dstr(d.getFullYear(),d.getMonth()+1,d.getDate()); } }
  function popEl(){ return document.getElementById('cal-pop'); }
  function close(){
    var p=popEl(); if(p && p.parentNode) p.parentNode.removeChild(p);
    if(_outside){ document.removeEventListener('mousedown',_outside,true); _outside=null; }
    if(_key){ document.removeEventListener('keydown',_key,true); _key=null; }
    if(_repos){ window.removeEventListener('resize',_repos); window.removeEventListener('scroll',_repos,true); _repos=null; }
    _c=null;
  }
  function prepare(){
    var list=document.querySelectorAll('input[type="date"],input[type="month"]');
    for(var i=0;i<list.length;i++){
      var inp=list[i], mode=(inp.getAttribute('type')==='month')?'month':'day';
      inp.type='text';
      inp.readOnly=true;
      inp.classList.add('cal-input');
      inp.setAttribute('data-cal-mode',mode);
      inp.setAttribute('autocomplete','off');
      inp.setAttribute('spellcheck','false');
    }
  }
  function open(inp,mode){
    if(!inp) return;
    mode=mode||inp.getAttribute('data-cal-mode')||'day';
    if(_c && _c.inp===inp){ close(); return; }
    close();
    var now=new Date();
    var c={ inp:inp, mode:mode, view:(mode==='day'?'day':(mode==='month'?'month':'year')),
      y:now.getFullYear(), m:now.getMonth()+1, selY:now.getFullYear(), selM:now.getMonth()+1, selD:now.getDate(), yBase:2000 };
    var attr=(mode==='day'?'data-date':(mode==='month'?'data-month':'data-year'));
    var raw=String(inp.value||'').trim() || String(inp.getAttribute(attr)||'').trim();
    var p=raw.split('-');
    var py=parseInt(p[0],10), pm=parseInt(p[1],10), pd=parseInt(p[2],10);
    if(py){ c.selY=py; c.y=py; }
    if(pm){ c.selM=pm; c.m=pm; }
    if(pd) c.selD=pd;
    c.yBase=2000+Math.floor((c.y-2000)/12)*12;
    _c=c;
    var pop=document.createElement('div');
    pop.className='cal-pop'; pop.id='cal-pop';
    document.body.appendChild(pop);
    render(); position();
    _outside=function(e){ if(pop.contains(e.target) || e.target===inp) return; close(); };
    _key=function(e){ if(e.key==='Escape') close(); };
    _repos=function(){ if(_c) position(); };
    setTimeout(function(){
      document.addEventListener('mousedown',_outside,true);
      document.addEventListener('keydown',_key,true);
      window.addEventListener('resize',_repos);
      window.addEventListener('scroll',_repos,true);
    },0);
  }
  function position(){
    var pop=popEl(); if(!pop || !_c) return;
    var r=_c.inp.getBoundingClientRect();
    var pw=pop.offsetWidth, ph=pop.offsetHeight;
    var left=Math.min(Math.max(8,r.left),window.innerWidth-pw-8);
    var top=r.bottom+8;
    if(top+ph>window.innerHeight-8) top=Math.max(8,r.top-ph-8);
    pop.style.left=left+'px'; pop.style.top=top+'px';
  }
  function commit(kind,val){
    if(!_c) return;
    var inp=_c.inp;
    inp.value=val;
    inp.setAttribute(kind==='day'?'data-date':(kind==='month'?'data-month':'data-year'),val);
    try{ inp.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
    close();
  }
  function render(){
    var pop=popEl(); if(!pop || !_c) return;
    var c=_c, tk=todayKey();
    var chev=function(d){
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
        +(d<0?'<path d="m15 5-7 7 7 7"/>':'<path d="m9 5 7 7-7 7"/>')+'</svg>';
    };
    var head='', body='';
    if(c.view==='day'){
      head='<button type="button" class="cal-nav" data-nav="-1">'+chev(-1)+'</button>'
        +'<button type="button" class="cal-title" data-goto="month">'+c.y+' 年 '+c.m+' 月</button>'
        +'<button type="button" class="cal-nav" data-nav="1">'+chev(1)+'</button>';
      var startDow=(new Date(c.y,c.m-1,1).getDay()+6)%7;
      var dim=new Date(c.y,c.m,0).getDate();
      var prevDim=new Date(c.y,c.m-1,0).getDate();
      var selKey=mkDate(c.selY,c.selM,c.selD);
      var cells='', i, dd, key, out;
      for(i=0;i<42;i++){
        dd=i-startDow+1; out=false;
        if(dd<1){ dd=prevDim+dd; out=true; key=mkDate(c.y,c.m-1,dd); }
        else if(dd>dim){ dd=dd-dim; out=true; key=mkDate(c.y,c.m+1,dd); }
        else { key=mkDate(c.y,c.m,dd); }
        cells+='<button type="button" class="cal-cell'+(out?' out':'')+(key===tk?' today':'')+(key===selKey?' sel':'')+'" data-key="'+key+'">'+dd+'</button>';
      }
      body='<div class="cal-grid"><div class="cal-wd">一</div><div class="cal-wd">二</div><div class="cal-wd">三</div><div class="cal-wd">四</div><div class="cal-wd">五</div><div class="cal-wd">六</div><div class="cal-wd">日</div>'+cells+'</div>'
        +'<div class="cal-foot"><button type="button" class="cal-today-btn" data-quick="0">今天</button><button type="button" class="cal-today-btn" data-quick="1">昨天</button><button type="button" class="cal-today-btn" data-quick="2">前天</button></div>';
    } else if(c.view==='month'){
      head='<button type="button" class="cal-nav" data-nav="-1">'+chev(-1)+'</button>'
        +'<button type="button" class="cal-title" data-goto="year">'+c.y+' 年</button>'
        +'<button type="button" class="cal-nav" data-nav="1">'+chev(1)+'</button>';
      var mc='';
      for(var m=1;m<=12;m++){
        var on=(c.selY===c.y && c.selM===m);
        mc+='<button type="button" class="cal-cell cal-mcell'+(on?' sel':'')+'" data-mon="'+m+'">'+m+' 月</button>';
      }
      body='<div class="cal-mgrid">'+mc+'</div><div class="cal-foot"><button type="button" class="cal-today-btn" data-gomon="1">本月</button></div>';
    } else {
      head='<button type="button" class="cal-nav" data-nav="-1">'+chev(-1)+'</button>'
        +'<div class="cal-title cal-title-static">'+c.yBase+' - '+(c.yBase+11)+'</div>'
        +'<button type="button" class="cal-nav" data-nav="1">'+chev(1)+'</button>';
      var yc='';
      for(var y=0;y<12;y++){
        var yy=c.yBase+y, onY=(c.selY===yy);
        yc+='<button type="button" class="cal-cell cal-ycell'+(onY?' sel':'')+'" data-year="'+yy+'">'+yy+'</button>';
      }
      body='<div class="cal-ygrid">'+yc+'</div><div class="cal-foot"><button type="button" class="cal-today-btn" data-goyear="1">今年</button></div>';
    }
    pop.innerHTML='<div class="cal-card"><div class="cal-head">'+head+'</div>'+body+'</div>';
    var btns=pop.querySelectorAll('[data-nav]');
    for(var b=0;b<btns.length;b++){
      btns[b].onclick=function(){
        var d=Number(this.getAttribute('data-nav')), cc=_c;
        if(cc.view==='day'){
          var dt=new Date(cc.y,cc.m-1+d,1); cc.y=dt.getFullYear(); cc.m=dt.getMonth()+1;
        } else if(cc.view==='month'){ cc.y+=d; }
        else { cc.yBase+=d*12; cc.y=cc.yBase; }
        render();
      };
    }
    var gt=pop.querySelectorAll('[data-goto]');
    for(var g=0;g<gt.length;g++){
      gt[g].onclick=function(){ _c.view=this.getAttribute('data-goto'); render(); };
    }
    var ks=pop.querySelectorAll('[data-key]');
    for(var k=0;k<ks.length;k++){
      ks[k].onclick=function(){ commit('day',this.getAttribute('data-key')); };
    }
    var ms=pop.querySelectorAll('[data-mon]');
    for(var mi=0;mi<ms.length;mi++){
      ms[mi].onclick=function(){
        var mm=Number(this.getAttribute('data-mon')), cc=_c;
        if(cc.mode==='month'){ commit('month', cc.y+'-'+pad2(mm)); return; }
        cc.selY=cc.y; cc.selM=mm; cc.m=mm; cc.view='day'; render();
      };
    }
    var ys=pop.querySelectorAll('[data-year]');
    for(var yi=0;yi<ys.length;yi++){
      ys[yi].onclick=function(){
        var yy=Number(this.getAttribute('data-year')), cc=_c;
        if(cc.mode==='year'){ commit('year',String(yy)); return; }
        cc.selY=yy; cc.y=yy; cc.view='month'; render();
      };
    }
    var qs=pop.querySelectorAll('[data-quick]');
    for(var qi=0;qi<qs.length;qi++){
      qs[qi].onclick=function(){
        var d=new Date(); d.setDate(d.getDate()-Number(this.getAttribute('data-quick')));
        commit('day', dstr(d.getFullYear(),d.getMonth()+1,d.getDate()));
      };
    }
    var gm=pop.querySelector('[data-gomon]');
    if(gm) gm.onclick=function(){
      var cc=_c, now=new Date();
      if(cc.mode==='month'){ commit('month', now.getFullYear()+'-'+pad2(now.getMonth()+1)); return; }
      cc.selY=now.getFullYear(); cc.selM=now.getMonth()+1; cc.y=cc.selY; cc.m=cc.selM; cc.view='day'; render();
    };
    var gy=pop.querySelector('[data-goyear]');
    if(gy) gy.onclick=function(){
      var cc=_c, now=new Date().getFullYear();
      if(cc.mode==='year'){ commit('year',String(now)); return; }
      cc.selY=now; cc.y=now; cc.view='month'; render();
    };
  }
  /* 所有日期框统一走自绘日历（点击 / 回车 / 空格打开） */
  document.addEventListener('click',function(e){
    var inp=e.target && e.target.closest ? e.target.closest('input.cal-input') : null;
    if(inp){ e.preventDefault(); open(inp); }
  });
  document.addEventListener('keydown',function(e){
    var inp=e.target;
    if(inp && inp.classList && inp.classList.contains('cal-input') && (e.key==='Enter'||e.key===' ')){
      e.preventDefault(); open(inp);
    }
  });
  return { prepare:prepare, open:open, close:close };
})();

try{ RxCal.prepare(); }catch(e){ console.warn('Calendar prepare', e); }

/* 全站搜索框：输入内容后右侧出现红色圆形 X，点击清空并触发原列表重置 */
(function(){
  function wrapOne(inp){
    if(!inp || inp.__schWrap) return;
    var wrap=document.createElement('span');
    wrap.className='sch-wrap';
    if(inp.classList.contains('wp-search')){ wrap.style.flex='1 1 220px'; wrap.style.minWidth='160px'; }
    else if(inp.classList.contains('gst-mini-search')){ wrap.style.flex='0 0 auto'; }
    else if(inp.id==='dSearch'){ wrap.style.flex='1 1 auto'; wrap.style.minWidth='0'; }
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    var btn=document.createElement('button');
    btn.type='button'; btn.className='sch-x'; btn.setAttribute('aria-label','清空搜索词');
    btn.innerHTML='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    wrap.appendChild(btn);
    inp.__schWrap=wrap;
    function sync(){ wrap.classList.toggle('has', !!inp.value); }
    inp.addEventListener('input', sync);
    inp.addEventListener('change', sync);
    btn.addEventListener('click', function(){
      inp.value='';
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      inp.dispatchEvent(new Event('change', {bubbles:true}));
      inp.focus();
      sync();
    });
    sync();
  }
  function initSch(){
    var ins=document.querySelectorAll('input.sch');
    for(var i=0;i<ins.length;i++) wrapOne(ins[i]);
  }
  /* 主脚本位于页面末尾，搜索框此时已解析完，直接执行；再挂一次 DOMContentLoaded 兜底（重复无害） */
  try{ initSch(); }catch(e){ console.warn('Search clear init', e); }
  document.addEventListener('DOMContentLoaded', function(){ try{ initSch(); }catch(e){} });
})();

/* =====================================================================
   启动：先把 Supabase 云端 KV 载入内存，再初始化页面。
   任何失败都按「空数据」启动 —— 绝不回退到本机 localStorage / 内置数据文件。
   ===================================================================== */
function rxMigrateLegacyLocalData(){
  /* 一次性迁移（只读一次，迁移后立即从浏览器删除）：
     旧版本有些业务数据（设置/后缀/药方打印订单/常用方/模板/修改记录/墓碑）
     只存在本机。先转存到 Supabase KV，再清除本机，避免升级后数据凭空消失。
     处方/药价/客人/地址/备注/进货单已有独立云端表，不在迁移范围内。 */
  var ls=null;
  try{ ls=window.localStorage; }catch(e){ return; }
  if(!ls) return;
  var CORE={rx_saved_v3:1, rx_drugs_v3:1, rx_doctors_v1:1, rx_addr_v1:1,
            rx_notes_v1:1, rx_guests_cache_v1:1, rx_purchases_v1:1, rx_costlog_v1:1};
  var TECH={};   /* 旧构建/同步标记也一并清掉：新版本不再使用任何本地存储 */
  var keys=[];
  try{ for(var i=0;i<ls.length;i++){ var k=ls.key(i); if(k&&k.indexOf('rx_')===0) keys.push(k); } }catch(e){ return; }
  var imported=[];
  keys.forEach(function(k){
    if(TECH[k]||CORE[k]) return;
    var v=null; try{ v=ls.getItem(k); }catch(e){}
    if(v==null) return;
    if(k==='rx_deleted_v3'){
      var old={}, loc={};
      try{ old=JSON.parse(RX_STORE.getItem(k)||'{}')||{}; }catch(e){ old={}; }
      try{ loc=JSON.parse(v)||{}; }catch(e){ loc={}; }
      var m={}; for(var a in old) m[a]=old[a]; for(var b in loc) m[b]=loc[b];
      RX_STORE.setItem(k, JSON.stringify(m));
      imported.push(k);
      return;
    }
    if(RX_STORE.getItem(k)==null){ RX_STORE.setItem(k,v); imported.push(k); }
  });
  /* 清空浏览器里的旧业务键（技术标记保留给构建脚本使用） */
  keys.forEach(function(k){ if(!TECH[k]){ try{ ls.removeItem(k); }catch(e){} } });
  if(imported.length) console.info('[迁移] 已把本机旧业务数据转存 Supabase，并清除本地：'+imported.join('、'));
}
(function(){
  var started=false;
  function start(){
    if(started) return; started=true;
    try{ rxMigrateLegacyLocalData(); }catch(e){ console.warn('旧数据迁移跳过:', e&&e.message); }
    try{ init(); }catch(e){ console.error('页面初始化失败:', e); }
  }
  if(typeof SUPA==='undefined'){ start(); return; }
  SUPA.ping()
    .then(function(){ return RX_STORE.load(); })
    .then(function(n){
      try{ console.info('[Supabase] 已加载 '+n+' 个云端 KV 键'); }catch(e){}
      start();
    })
    .catch(function(e){
      console.warn('Supabase KV 加载失败，页面按空数据启动：', e&&e.message);
      start();
    });
})();

/* ===================================================================
   滚动条：只为「正在滚」的元素显示 2px 主题绿滚动条，停手 800ms 隐去。
   scroll 事件不冒泡，用捕获阶段接；document 级别的滚动落到 <html> 上。
   =================================================================== */
(function(){
  document.addEventListener('scroll',function(e){
    var el=e.target;
    if(!el || el.nodeType!==1) el=document.scrollingElement||document.documentElement;
    if(!el || !el.classList) return;
    if(el.classList.contains('sc-on')){
      clearTimeout(el.__scT);
    }else{
      el.classList.add('sc-on');
    }
    el.__scT=setTimeout(function(){ el.classList.remove('sc-on'); },800);
  },true);
})();
