
/* ===== 统一下拉组件（select / datalist 都用同一套浮层，参考图1风格） ===== */
(function(){
  if(window.__uiDropBound) return;
  window.__uiDropBound = 1;
  var panel = null, _dd = null;

  function esc2(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function ensurePanel(){
    if(panel) return panel;
    panel = document.createElement('div');
    panel.className = 'ui-drop';
    panel.id = 'uiDropPanel';
    document.body.appendChild(panel);
    panel.addEventListener('mousedown', function(e){
      var it = e.target.closest ? e.target.closest('.it') : null;
      if(!it || !_dd) return;
      e.preventDefault();
      pick(parseInt(it.getAttribute('data-i'), 10));
    });
    panel.addEventListener('mousemove', function(e){
      var it = e.target.closest ? e.target.closest('.it') : null;
      if(!it || !_dd) return;
      var i = parseInt(it.getAttribute('data-i'), 10);
      if(i !== _dd.idx){ _dd.idx = i; render(); }
    });
    return panel;
  }
  function render(){
    if(!_dd) return;
    var el = ensurePanel(), h = '';
    if(!_dd.items.length){
      h = '<div class="empty">无匹配选项</div>';
    }else{
      for(var i=0;i<_dd.items.length;i++){
        h += '<div class="it' + (i === _dd.idx ? ' on' : '') + '" data-i="' + i + '"><span class="tx">'
          + esc2(_dd.items[i].text) + '</span><span class="chk">✓</span></div>';
      }
    }
    el.innerHTML = h;
    el.classList.add('on');
    place(el);
  }
  function place(el){
    if(!_dd || !_dd.target) return;
    var r = _dd.target.getBoundingClientRect();
    var w = Math.max(r.width, 190);
    el.style.width = Math.min(Math.max(w, 190), 360) + 'px';
    var left = r.left;
    if(left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - Math.min(w, 360) - 8);
    el.style.left = left + 'px';
    var h = el.offsetHeight || 0, top = r.bottom + 6;
    if(top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.style.top = top + 'px';
  }
  function close(){
    _dd = null;
    if(panel){ panel.classList.remove('on'); panel.innerHTML = ''; }
  }
  function show(target, type, items, listId){
    var sel = -1;
    for(var i=0;i<items.length;i++){ if(items[i].on){ sel = i; break; } }
    _dd = { target: target, type: type, items: items, listId: listId || '', idx: sel >= 0 ? sel : 0 };
    render();
  }
  function openSelect(sel){
    if(!sel || sel.disabled || sel.multiple) return;
    var items = [], i, o;
    for(i=0;i<sel.options.length;i++){
      o = sel.options[i];
      if(o.disabled) continue;
      items.push({ value: o.value, text: o.textContent || o.value, on: i === sel.selectedIndex });
    }
    show(sel, 'select', items);
  }
  function openInput(inp){
    var rawOpts = inp.getAttribute ? inp.getAttribute('data-ddoptions') : '';
    var listId = (inp.getAttribute && inp.getAttribute('data-ddlist')) || (_dd && _dd.target === inp ? _dd.listId : '');
    if(!listId && !rawOpts) return;
    var q = String(inp.value || '').trim().toLowerCase();
    var items = [], i, o, tx;
    if(rawOpts){
      try{
        var arr = JSON.parse(rawOpts) || [];
        for(i=0;i<arr.length;i++){
          tx = String(arr[i] || '').trim();
          if(!tx) continue;
          items.push({ value: tx, text: tx, on: tx === String(inp.value || '').trim() });
        }
      }catch(e){}
    }else{
      var dl = document.getElementById(listId);
      if(dl && dl.options){
        for(i=0;i<dl.options.length;i++){
          o = dl.options[i];
          tx = String(o.value || o.textContent || '').trim();
          if(!tx) continue;
          if(q && tx.toLowerCase().indexOf(q) < 0) continue;
          items.push({ value: tx, text: tx, on: tx === String(inp.value || '').trim() });
          if(items.length >= 80) break;
        }
      }
    }
    show(inp, 'input', items, listId);
  }
  function pick(i){
    if(!_dd) return;
    var item = _dd.items[i];
    if(!item){ return; }
    var t = _dd.target, type = _dd.type;
    close();
    if(!t || !t.isConnected) return;
    if(type === 'select'){
      t.value = item.value;
      try{ t.dispatchEvent(new Event('change', { bubbles: true })); }catch(e){}
    }else{
      t.value = item.value;
      try{ t.dispatchEvent(new Event('input', { bubbles: true })); }catch(e){}
      try{ t.dispatchEvent(new Event('change', { bubbles: true })); }catch(e){}
    }
  }
  function move(d){
    if(!_dd || !_dd.items.length) return;
    _dd.idx = (_dd.idx + d + _dd.items.length) % _dd.items.length;
    render();
  }

  document.addEventListener('mousedown', function(e){
    var t = e.target;
    if(t && t.tagName === 'SELECT' && !t.disabled && !t.multiple){
      e.preventDefault();
      e.stopPropagation();
      openSelect(t);
      return;
    }
    if(panel && panel.contains(t)) return;
    if(_dd && t !== _dd.target) close();
  }, true);

  document.addEventListener('focusin', function(e){
    var t = e.target;
    if(!t || !t.tagName) return;
    if(t.tagName === 'SELECT' && !t.disabled && !t.multiple){ openSelect(t); return; }
    if(t.tagName === 'INPUT' && (t.getAttribute('data-ddlist') || t.getAttribute('data-ddoptions') || (_dd && _dd.target === t))) openInput(t);
  });

  document.addEventListener('input', function(e){
    var t = e.target;
    if(!t || t.tagName !== 'INPUT') return;
    if(_dd && _dd.type === 'input' && _dd.target === t){ openInput(t); return; }
    if(t.getAttribute('data-ddlist') || t.getAttribute('data-ddoptions')) openInput(t);
  });

  document.addEventListener('focusout', function(e){
    var t = e.target;
    if(!_dd || _dd.target !== t) return;
    setTimeout(function(){ if(_dd && _dd.target === t) close(); }, 120);
  });

  document.addEventListener('keydown', function(e){
    if(!_dd) return;
    var k = e.key;
    if(k === 'ArrowDown'){ move(1); e.preventDefault(); return; }
    if(k === 'ArrowUp'){ move(-1); e.preventDefault(); return; }
    if(k === 'Enter'){ pick(_dd.idx); e.preventDefault(); return; }
    if(k === 'Escape'){ close(); e.preventDefault(); return; }
    if(k === 'Tab'){ close(); }
  }, true);

  window.addEventListener('scroll', function(e){
    if(!_dd) return;
    if(panel && e.target && panel.contains(e.target)) return;
    close();
  }, true);
  window.addEventListener('resize', function(){ if(_dd) close(); });
})();
