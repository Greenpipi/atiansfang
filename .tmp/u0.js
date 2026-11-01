
(function(){
  /* 旧版 WorkBuddy 加密同步层已移除（2026-10-31）。
     它把 RX_STORE 当主存储、再往 rx_sync 做加密镜像，既与「云端唯一数据源」冲突，
     也会在换设备/清缓存时出现合并覆盖。业务数据现在一律由 Supabase 读写。 */
  function dbBadge(){
    try{
      var host=document.getElementById('rxSyncBar');
      if(!host){ host=document.createElement('span'); var tb=document.querySelector('.topbar'); if(!tb) return; tb.appendChild(host); }
      var d=document.createElement('span');
      d.id='rxSyncBadge'; d.className='rxchrome';
      d.style.cssText='font-size:11px;margin-left:10px;white-space:nowrap;font-weight:400;color:var(--aux)';
      if(location.protocol==='file:'){
        d.textContent='⚠ 本地文件·未连数据库';
        d.title='浏览器禁止本地文件访问网络。请改用网址打开。';
      }else{
        d.textContent='正在连接数据库…';
        var tries=0;
        (function probe(){
          if(typeof SUPA==='undefined'){ d.textContent='⚠ 未连接数据库'; return; }
          SUPA.ping().then(function(){
            d.style.color='var(--pri-deep)'; d.textContent='✓ 已连接数据库';
            d.title='数据存在你自己的 Supabase 里，所有设备看到同一份';
          }).catch(function(e){
            tries++;
            if(tries<3){ setTimeout(probe,1500); return; }
            d.textContent='⚠ 数据库连不上';
            d.title='连不上 Supabase：'+e.message+'\n页面会按空数据显示，不会读取本机旧缓存。';
          });
        })();
      }
      host.appendChild(d);
    }catch(e){}
  }
  window.addEventListener('DOMContentLoaded',function(){
    try{ injectActionIcons(); }catch(e){}
    dbBadge();
  });
})();

/* =====================================================================
   🎨 关键操作图标（纯装饰）
   内联 SVG，不引外部资源、不改任何 onclick 与 id。
   ===================================================================== */
var RX_ICONS={
  save:'<path d="M3 3h9l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M5 3v4h5V3"/><rect x="4.5" y="10" width="7" height="4.5"/>',
  print:'<path d="M4.5 6V2.5h7V6"/><rect x="2" y="6" width="12" height="5.5" rx="1"/><path d="M4.5 10h7v4.5h-7z"/>',
  search:'<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/>',
  copy:'<rect x="5" y="5" width="8.5" height="9" rx="1"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"/>',
  image:'<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1"/><path d="M2.6 11.5 6 8.2l2.5 2.4L11 8.4l2.4 3.1"/>',
  receipt:'<path d="M3 2.5v11l1.6-.9 1.5.9 1.5-.9 1.5.9 1.5-.9 1.4.9v-11l-1.4.9-1.5-.9-1.5.9-1.5-.9-1.5.9L3 3.4"/><path d="M5.5 6.5h5M5.5 9h5"/>',
  plus:'<path d="M8 3.5v9M3.5 8h9"/>',
  trash:'<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  calc:'<rect x="3.5" y="1.5" width="9" height="13" rx="1"/><path d="M6 4.5h4M6.2 8h.01M8 8h.01M9.8 8h.01M6.2 10.5h.01M8 10.5h.01M9.8 10.5h.01M6.2 13h.01M8 13h3.8"/>',
  chart:'<path d="M2.5 14h11"/><rect x="4" y="8" width="2.2" height="4"/><rect x="7" y="5" width="2.2" height="7"/><rect x="10" y="2.5" width="2.2" height="9.5"/>',
  book:'<path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h4v11H4a1.5 1.5 0 0 0-1.5 1.5z"/><path d="M13.5 3.5A1.5 1.5 0 0 0 12 2H8v11h4a1.5 1.5 0 0 1 1.5 1.5z"/>',
  gear:'<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>',
  send:'<path d="M14 2 7 9"/><path d="M14 2 9.5 14 7 9 2 6.5z"/>',
  /* ---- 清单工具专用：细线条版（2026-07 用户嫌 image/print 太粗）----
     画法要点：外框用 13×13 居中（留 1.5px 边距），
     内部元素少而简，避免小尺寸下笔画挤在一起显糊。 */
  imgLite:'<rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1.6"/><path d="M1.9 10.6 5.4 7.4l2.2 2 2.6-2.4 4 3.6"/><circle cx="5.6" cy="5.7" r="1"/>',
  printLite:'<path d="M4.4 6.2V2.6h7.2v3.6"/><rect x="1.9" y="6.2" width="12.2" height="5.3" rx="1.4"/><path d="M4.4 9.6h7.2v3.8H4.4z"/><path d="M11.8 8.1h.01"/>'
};
function rxIcon(name){
  var d=RX_ICONS[name]; if(!d) return '';
  return '<svg class="rxi" viewBox="0 0 16 16" aria-hidden="true">'+d+'</svg>';
}
/* 给指定按钮加图标（幂等：已有 .rxi 就跳过） */
function addIcon(id,name){
  var b=document.getElementById(id); if(!b) return;
  if(b.querySelector('.rxi')) return;
  b.insertAdjacentHTML('afterbegin',rxIcon(name));
  b.classList.add('rxi-btn');
}
/* 关键操作图标：保存 / 打印 / 搜索 / 复制 / 新建 / 计算 / 删除 */
function injectActionIcons(){
  var map={
    btnSave:'save',
    btnPrint:'print',
    /* 2026-10-08 已移除「打印小票」按钮，btnPrintR 不再存在 */
    /* 2026-07 用户嫌图标粗：清单工具用细线条专用版 */
    plPrint:'printLite',
    hQuery:'search',
    btnCopy:'copy',
    btnShot:'image', btnShotR:'receipt',
    /* plShot/plPrint 2026-10-07 改成标题栏图标按钮；
       2026-07 用户嫌线条粗 → 换 imgLite / printLite 细线条专用版（见 RX_ICONS 末尾） */
    plShot:'imgLite',
    btnNew:'plus', dmAdd:'plus', docAdd:'plus',
    dmSave:'save',
    plAuto:'calc',
    dmDel:'trash', dmWipe:'trash',
    plFa:'send'
  };
  for(var id in map) addIcon(id,map[id]);
  /* 药品目录搜索框也加一个放大镜前缀（纯装饰）
     ⚠ 输入框会在启动时被 .sch-wrap 包一层，ds.parentNode 已经变成 .sch-wrap；
       图标必须放进 .dsearch 容器（has-ico 也加在它上面），否则放大镜会压在「柴胡」上。 */
  var ds=document.getElementById('dSearch');
  var dsr=ds?(ds.closest('.dsearch')||ds.parentNode):null;
  if(dsr && !dsr.querySelector('.dsearch-ico')){
    dsr.insertAdjacentHTML('afterbegin','<span class="dsearch-ico">'+rxIcon('search')+'</span>');
    dsr.classList.add('has-ico');
  }
}
/* 尾缀 → 语义类别（用于彩色标签配色） */
function sfxKind(sfxTxt){
  var s=String(sfxTxt||'').replace(/[\[\]{}]/g,'');
  if(!s) return '';
  if(/先煎|先下/.test(s)) return 'xj';
  if(/后下|后下服/.test(s)) return 'hx';
  if(/另包|包煎|自备|嚼服/.test(s)) return 'lb';
  return '';
}
