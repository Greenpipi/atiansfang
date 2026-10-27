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
SUPA.hdr=function(){
  return {'apikey':SUPA.key,'Authorization':'Bearer '+SUPA.key,'Content-Type':'application/json'};
};
SUPA.q=function(path, opt){
  opt=opt||{};
  return fetch(SUPA.url+'/rest/v1/'+path, {
    method: opt.method||'GET',
    headers: Object.assign(SUPA.hdr(), opt.headers||{}),
    body: opt.body?JSON.stringify(opt.body):undefined
  }).then(function(r){
    if(!r.ok) throw new Error('HTTP '+r.status+' '+r.statusText);
    if(r.status===204) return null;
    return r.text().then(function(t){ return t?t.json():null; });
  });
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
    n:r.name||'', s:r.sex||'', j:r.jishu||1, m:m,
    f:f.f||'', e:f.e||'', g:f.g||'', o:f.o||'', fw:f.fw||'', w:f.w||'',
    dt:r.dt||'', tm:r.tm||'', no:r.no||'', b:r.note||'', fy:r.fayao?"【发】":"",
    c:r.category||'中医', __supa:true
  };
}
/* 页面记录 → 数据库行 */
function supaRecToRow(rec, isHist){
  var items=splitItemsToJson(rec.m);
  return {
    no:rec.no, dt:rec.dt, tm:rec.tm||'', name:rec.n||'', sex:rec.s||'',
    age:rec.a||'', jishu:(parseInt(rec.j,10)||1), items:items,
    fee:{f:rec.f||'',e:rec.e||'',g:rec.g||'',o:rec.o||'',fw:rec.fw||'',w:rec.w||''},
    note:rec.b||'', fayao:!!rec.fy, category:rec.c||'中医', is_hist:!!isHist
  };
}
function splitItemsToJson(m){
  var out=[];
  if(!m) return out;
  var re=/([^\s]+)\s*(\d+(?:\.\d+)?)\s*(g|克|kg|KG|ml|ML|个|片|袋|支|瓶)?|自备/g, mm;
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

/* ---------- 1. 拉取全部历史处方，替换页面内置数据 ---------- */
SUPA.loadHist=function(){
  return SUPA.q('prescriptions?select=*&is_hist=eq.true&order=dt.asc&limit=6000')
  .then(function(rows){
    if(!rows||!rows.length) throw new Error('云端没有历史处方');
    HISTORY_ORIG=rows.map(supaRowToRec);
    SUPA.on=true;
    return HISTORY_ORIG.length;
  });
};
/* ---------- 2. 拉取药价目录 ---------- */
SUPA.loadDrugs=function(){
  return SUPA.q('drugs?select=*&order=name&limit=6000')
  .then(function(rows){
    if(!rows||!rows.length) throw new Error('云端没有药价');
    drugsList=rows.map(function(r){
      return {n:r.name,u:r.unit||'g',c:r.usage||'',tc:r.tccat||'',py:r.py||'',
              dw:'',cat:r.category||'中药',bp:r.cost==null?'':String(r.cost),
              p:r.price==null?'':String(r.price),st:''};
    });
    saveDrugsLS();
    return drugsList.length;
  });
};
/* ---------- 3. 新处方写入（upsert，按处方编号）---------- */
SUPA.saveRx=function(rec){
  return SUPA.q('prescriptions?on_conflict=no', {method:'POST', body:supaRecToRow(rec,false)});
};
/* ---------- 4. 历史处方改后写回（update，按处方编号）---------- */
SUPA.updateHist=function(rec){
  return SUPA.q('prescriptions?no=eq.'+encodeURIComponent(rec.no),
                {method:'PATCH', body:supaRecToRow(rec,true)});
};
/* ---------- 5. 只改发药状态 ---------- */
SUPA.setFayao=function(no, on){
  return SUPA.q('prescriptions?no=eq.'+encodeURIComponent(no), {method:'PATCH', body:{fayao:!!on}});
};
/* ---------- 6. 药价改价（upsert 按药名，同时记改价历史）---------- */
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
/* ---------- 8. 连通性探测（决定顶栏显示什么）---------- */
SUPA.ping=function(){
  return SUPA.q('drugs?select=name&limit=1').then(function(){ SUPA.on=true; return true; });
};