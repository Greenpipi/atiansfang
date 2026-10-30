#!/usr/bin/env node
/* =============================================================================
   药物管理表 · 药名后缀清洗脚本
   -----------------------------------------------------------------------------
   目标：把错录在「药名」里的煎服法后缀（先煎 / 后下 / 另包 / 打碎…）剥掉。
     · 剥完若库里已有纯净名 → 把带后缀那行的数据**合并**过去（规格并集、库存累加），再删掉那行；
     · 剥完库里没有纯净名 → 就地改名（py 里的后缀码一起截掉）；
     · 括号内不是煎服法（[3元1克] / [外用] / [斤] / [三十头] …）→ 一律不动。

   用法：
     node clean_drug_suffix.js                 # 只扫描 + 出报告（默认，不写库）
     node clean_drug_suffix.js --offline       # 用 _clean/drugs_raw.json 跑（不联网，调试用）
     node clean_drug_suffix.js --apply         # 真正执行：改名 / 合并 / 删除（自动跳过冲突项）
     node clean_drug_suffix.js --apply --include="斑蝥[另包],龟甲胶[烊化]"
                                              # 冲突项里点名确认后再一起执行
     node clean_drug_suffix.js --apply --force-conflicts
                                              # 全部冲突按默认策略（保留纯净名的价）强制执行

   产物：_clean/report.json（机器可读）、_clean/report.md（人工复核）、
        执行时先写 _clean/backup_<时间>.json 全表备份。
   ============================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const SUPA = {
  url: 'https://ikrhpxbnnfqvotnquziy.supabase.co',
  key: 'sb_publishable_22DqGTvSYu2QjtMq53fB4Q_QiF9wITb'
};
const OUT = path.join(__dirname, '_clean');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 规则表 ---------------- */
/* 1) 需要剥离的煎服法后缀（整段精确匹配） */
const STRIP = ['先煎', '后下', '包煎', '另包', '另煎', '烊化', '冲服', '打碎', '打', '研碎', '研粉', '打粉', '煎汤代水'];
/* 组合写法：「打另包」「打后下」「另包打碎」等 —— 由 STRIP 里的词拼出来，允许中间夹「打/另」 */
const STRIP_TOKEN = /^(?:打)?(?:先煎|后下|包煎|另包|另煎|烊化|冲服|打碎|打|研碎|研粉|打粉|煎汤代水)(?:打)?$/;

/* 2) 明确要保留的备注（价格说明 / 用法） */
const KEEP_PATTERNS = [
  /^\d+(?:\.\d+)?\s*元\s*\/?\s*克$/,        /* 3元1克 / 3元/克 */
  /^[一二三四五六七八九十百]+元\s*\/?\s*克$/, /* 三元/克 */
  /^\d+(?:\.\d+)?\s*元$/,
  /^外用$/,
  /^每克.*/
];
/* 3) 不宜自动处理的（改名会改变药品身份，必须人工确认） */
const UNIT_WORDS = ['斤', '个', '罐', '盒', '条', '把', '袋', '只', '副', '片', '对', '桶', '箱', '粒', '支', '瓶', '包', '块'];
const GRADE_RE = /^(?:特大|中大|大|小|中|统|选|[一二三四五六七八九十百]+十?头|\d+头|[一二三四五六七八九十]?七爪|旱|黑草|带壳|去皮|无皮)$/;
const PROCESS_RE = /^(?:切|去皮|去心|去毛|去刺|去壳|炒|炙|煅|醋|盐|酒|蜜|姜|蒸|煮|晒|烘|焙|捣)$/;
const USAGE_RE = /^(?:内服|外用|食|自备|冲)$/;

/* 药名末尾的括号（半/全角方括号和圆括号都算） */
const TAIL_BRACKET = /^(.*?)\s*[\[［(（]\s*([^\]］)）]*)\s*[\]］)）]\s*$/;
/* 中间随便哪里出现的括号（本轮数据为 0，留个兜底提示） */
const ANY_BRACKET = /[\[［(（][^\]］)）]*[\]］)）]/;

/* 后缀文字 → 拼音首字母（与前端 SFX_PY 一致，用来把 py 里的后缀码截掉） */
const PY = {
  '先': 'x', '煎': 'j', '后': 'h', '下': 'x', '包': 'b', '另': 'l', '烊': 'y', '化': 'h',
  '冲': 'c', '服': 'f', '研': 'y', '粉': 'f', '汤': 't', '代': 'd', '水': 's', '打': 'd', '碎': 's',
  '泡': 'p', '炖': 'd', '焗': 'j', '调': 't', '含': 'h', '嚼': 'j', '温': 'w', '冷': 'l',
  '饭': 'f', '前': 'q', '睡': 's', '觉': 'j', '外': 'w', '用': 'y', '洗': 'x', '熏': 'x',
  '汁': 'z', '榨': 'z', '末': 'm', '茶': 'c', '饮': 'y', '兑': 'd', '入': 'r', '蒸': 'z'
};
function pyByChar(s) {
  let out = '';
  for (const ch of String(s || '').trim()) {
    if (!PY[ch]) return '';
    out += PY[ch];
  }
  return out;
}

/* ---------------- 分类 ---------------- */
/* 返回 {act:'strip'|'keep'|'ambiguous', why} */
function classify(inner) {
  const t = String(inner || '').trim();
  if (!t) return { act: 'keep', why: '空括号' };
  if (STRIP.includes(t) || STRIP_TOKEN.test(t)) return { act: 'strip', why: '煎服法后缀' };
  for (const re of KEEP_PATTERNS) if (re.test(t)) return { act: 'keep', why: '价格/用法备注' };
  if (UNIT_WORDS.includes(t)) return { act: 'unit', why: '计量单位 → 转为同名药的子规格' };
  if (GRADE_RE.test(t)) return { act: 'ambiguous', why: '等级/品质标注（属于药品身份）' };
  if (PROCESS_RE.test(t)) return { act: 'ambiguous', why: '加工方式，可能改变药品身份' };
  if (USAGE_RE.test(t)) return { act: 'ambiguous', why: '用法/来源说明' };
  return { act: 'keep', why: '未识别的特殊备注' };
}

/* ---------------- 规格（units）合并 ---------------- */
function unitKey(u) { return String((u && u.unit) || 'g').trim() || 'g'; }
function num(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }
function isEmpty(v) { return v == null || v === ''; }
/* 把 src 的主规格也当成一条 entries，参与并集比较 */
function entriesOf(row) {
  const list = [];
  /* amt = 该规格的常用量：主规格取 drugs.usage，子规格取 units[].amt */
  const main = { unit: String(row.unit || 'g').trim() || 'g', retail: row.price, cost: row.cost,
                 daily: row.daily_price, stock: null, amt: row.usage, __main: 1 };
  list.push(main);
  for (const u of (Array.isArray(row.units) ? row.units : [])) list.push(Object.assign({}, u));
  return list;
}
/* 合并 rules：同单位 → 库存累加；零售/成本一方为空取另一方；两方都有且不同 → 冲突 */
function mergeUnits(tgt, srcs) {
  const notes = [], conflicts = [];
  const merged = [];                       /* [{unit, retail, cost, daily, stock, amt, wp, sg}] */
  const idx = {};
  const add = (e, from) => {
    const k = unitKey(e);
    if (idx[k] == null) {
      idx[k] = merged.length;
      merged.push({
        unit: k,
        retail: e.retail, cost: e.cost, daily: e.daily, stock: e.stock,
        amt: e.amt, wp: e.wp, sg: e.sg, __main: !!e.__main, __src: [from]
      });
      return;
    }
    const t = merged[idx[k]];
    /* 库存累加（两方都是数字才加，空当 0） */
    const s1 = num(t.stock), s2 = num(e.stock);
    if (s1 || s2) {
      t.stock = String(s1 + s2);
      notes.push(`规格「${k}」库存累加 ${num(t.stock) - s2} + ${s2} = ${s1 + s2}`);
    }
    /* 零售价：一致就过；一方空取另一方；两方不同 → 冲突 */
    const cmp = (label, a, b) => {
      const ea = isEmpty(a), eb = isEmpty(b);
      if (ea && eb) return 'same';
      if (ea) return 'fill';
      if (eb) return 'same';
      return (Math.abs(num(a) - num(b)) < 1e-6 && String(a) === String(b)) ? 'same' : (Math.abs(num(a) - num(b)) < 1e-6 ? 'same' : 'diff');
    };
    for (const f of ['retail', 'cost', 'daily']) {
      const r = cmp(f, t[f], e[f]);
      if (r === 'fill') { t[f] = e[f]; notes.push(`规格「${k}」${f} 取源值 ${e[f]}`); }
      else if (r === 'diff') {
        if (PREFER === 'high') {
          const hi = num(t[f]) >= num(e[f]) ? t[f] : e[f];
          if (String(hi) !== String(t[f])) notes.push(`规格「${k}」${f} 取高价 ${hi}（原 ${t[f]}）`);
          else notes.push(`规格「${k}」${f} 保留高价 ${hi}（另一行 ${e[f]} 较低）`);
          t[f] = hi;
        } else if (!(e.__main && t.__main)) conflicts.push(`规格「${k}」的 ${f} 不一致：目标 ${t[f]} / 待合并 ${e[f]}`);
      }
    }
    /* 常用量（amt）空取非空 */
    if (isEmpty(t.amt) && !isEmpty(e.amt)) t.amt = e.amt;
    t.__src.push(from);
  };
  entriesOf(tgt).forEach(e => add(e, tgt.name));
  for (const s of srcs) entriesOf(s).forEach(e => add(e, s.name));
  return { merged, notes, conflicts };
}

/* ---------------- 主流程 ---------------- */
function arg(name, def) {
  const hit = process.argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
}
const OFFLINE = arg('offline', false);
const APPLY = arg('apply', false);
const FORCE = arg('force-conflicts', false);
let PREFER = String(arg('prefer', 'target') || 'target');   /* target=保留纯净名已有价（默认） / src=用带后缀那行的价 / high=两边取高价 */
const INCLUDE = String(arg('include', '') || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);

async function fetchAll() {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SUPA.url}/rest/v1/drugs?select=*&order=name.asc&limit=1000&offset=${off}`, {
      headers: { apikey: SUPA.key, Authorization: 'Bearer ' + SUPA.key }
    });
    if (!r.ok) throw new Error('拉取失败 HTTP ' + r.status + ' ' + await r.text());
    const d = await r.json();
    rows.push(...d);
    if (d.length < 1000) break;
    if (off > 50000) break;
  }
  return rows;
}
function loadLocal() {
  const f = String(arg('file', '') || '');
  const p = f ? path.resolve(f) : path.join(OUT, 'drugs_raw.json');
  if (!fs.existsSync(p)) throw new Error('缺少 ' + p + '（先联网跑一次或手动导出一份）');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* 生成计划：rename / merge / conflict / keep / ambiguous */
function buildPlan(rows) {
  const byName = new Map(rows.map(r => [r.name, r]));
  const plan = { rename: [], merge: [], mergeGroups: [], conflict: [], keep: [], ambiguous: [], unitSpecs: [], bracketCount: 0 };
  /* 先找出所有需要剥离的源行 */
  const sources = [];
  for (const r of rows) {
    const m = TAIL_BRACKET.exec(r.name);
    if (!m) {
      if (ANY_BRACKET.test(r.name)) { plan.bracketCount++; plan.ambiguous.push({ name: r.name, inner: '', why: '括号不在末尾，脚本不动，请人工判断' }); }
      continue;
    }
    plan.bracketCount++;
    const base = m[1].trim(), inner = m[2].trim();
    const c = classify(inner);
    if (c.act === 'keep') { plan.keep.push({ name: r.name, inner, why: c.why }); continue; }
    if (c.act === 'ambiguous') { plan.ambiguous.push({ name: r.name, base, inner, why: c.why, price: r.price, usage: r.usage }); continue; }
    if (c.act === 'unit') {
      /* 计量单位：整行（unit=斤/个/罐…，price=每单位价）搬成 base 的子规格 */
      plan.unitSpecs.push({ name: r.name, base, inner, unit: r.unit, price: r.price, cost: r.cost, usage: r.usage,
                            hasBase: byName.has(base) });
      r.__unitSpec = 1;
    }
    sources.push({ row: r, base, inner });
  }
  /* 目标：纯净名已存在 → merge；不存在 → rename（多条同基名时第一条改名，其余并到它身上） */
  const claimed = new Map();                 /* base -> 改名后的代表行 */
  const groups = new Map();                  /* base -> {出组：代表行 + 所有待合并源行} */
  const groupOf = (base, tgt) => {
    let g = groups.get(base);
    if (!g) { g = { to: base, tgt, srcs: [] }; groups.set(base, g); }
    return g;
  };
  for (const s of sources) {
    const { row, base, inner } = s;
    if (byName.has(base)) {
      groupOf(base, byName.get(base)).srcs.push({ row, inner });
      continue;
    }
    if (claimed.has(base)) {
      groupOf(base, claimed.get(base)).srcs.push({ row, inner, dup: true });
      continue;
    }
    claimed.set(base, { name: base, unit: row.unit, price: row.price, cost: row.cost,
                        daily_price: row.daily_price, usage: row.usage, origin: row.origin,
                        aliases: row.aliases || [], units: row.units || [], __from: row.name });
    /* 若括号里的单位与行自身的 unit 不一致（玉竹[斤] 却记成 g），改名时把主单位一并纠正 */
    const unitFix = row.__unitSpec && unitKey(row) !== inner ? inner : null;
    plan.rename.push({ from: row.name, to: base, inner, py: row.py, newPy: stripPy(row.py, inner),
                       unitFix, isUnit: !!row.__unitSpec, row });
  }
  /* 合并组展开成给人看的条目：一组一条（把同基名的多条源行写在一起） */
  for (const g of groups.values()) {
    plan.merge.push({
      from: g.srcs.map(x => x.row.name).join('、'),
      to: g.to, tgt: g.tgt, srcs: g.srcs.map(x => x.row), src: g.srcs[0].row,
      names: g.srcs.map(x => x.row.name)
    });
  }
  return plan;
}
function stripPy(py, inner) {
  const code = pyByChar(inner);
  const p = String(py || '');
  if (code && p.toLowerCase().endsWith(code)) return p.slice(0, p.length - code.length);
  return p;
}

/* 逐条检查冲突（价格 / 规格 / 常用量）
   规则：① 只有「同一个计量单位」才比主规格价（大枣 个 0.2 与会 大枣[斤] 15 不冲突）；
        ② 单位类源行（[斤]/[个]/[罐]）的价格落在子规格里，不参与行级比较；
        ③ --prefer=high 时两方都有价且不同 → 取高价，不报冲突。 */
function analyze(plan) {
  for (const m of plan.merge) {
    const tgt = m.tgt, srcs = m.srcs || [m.src];
    const issues = [], notes = [];
    for (const src of srcs) {
      if (src.__unitSpec) continue;
      if (unitKey(src) !== unitKey(tgt)) continue;
      for (const [f, label] of [['price', '零售价'], ['cost', '进货价']]) {
        if (isEmpty(src[f]) || isEmpty(tgt[f])) continue;
        if (Math.abs(num(src[f]) - num(tgt[f])) <= 1e-9) continue;
        const hi = num(src[f]) >= num(tgt[f]) ? src[f] : tgt[f];
        if (PREFER === 'high') notes.push(`${label}取高价 ${hi}（已有 ${tgt[f]} / ${src.name} ${src[f]}）`);
        else issues.push(`${label}不一致：已有「${tgt[f]}」 / ${src.name}「${src[f]}」`);
      }
    }
    const u = mergeUnits(tgt, srcs);
    issues.push(...u.conflicts);
    m.unitNotes = u.notes.concat(notes);
    m.mergedUnits = u.merged;
    m.issues = issues;
    if (issues.length) plan.conflict.push(m);
  }
  return plan;
}

/* ---------------- 打印报告 ---------------- */
function report(plan, rows) {
  const L = [];
  const p = s => L.push(s);
  const total = rows.length;
  p('============================================================');
  p(' 药物管理 · 药名后缀清理预览报告（未写入数据库）');
  p('============================================================');
  p(`扫描药品 ${total} 味；药名带括号 ${plan.bracketCount} 味`);
  p(`  ├─ 自动重命名（库内无同名纯净药）  ${plan.rename.length} 条`);
  p(`  ├─ 自动合并（库内已有纯净药）      ${plan.merge.length - plan.conflict.length} 组（共 ${plan.merge.reduce((a, m) => a + (m.srcs ? m.srcs.length : 1), 0) - plan.conflict.reduce((a, m) => a + (m.srcs ? m.srcs.length : 1), 0)} 条）`);
  p(`  ├─ 计量单位 → 转子规格（内含于上面）  ${plan.unitSpecs.length} 条`);
  p(`  ├─ 冲突待确认（价格/规格对不上）    ${plan.conflict.length} 组${PREFER === 'high' ? '（当前 --prefer=high：取高价，不报冲突）' : ''}`);
  p(`  ├─ 需人工判断（等级/加工/用法）     ${plan.ambiguous.length} 条`);
  p(`  └─ 保留不动（价格/特殊备注）        ${plan.keep.length} 条`);
  p('');

  p('---- 一、将重命名（去后缀，py 同步截掉后缀码）----');
  for (const r of plan.rename)
    p(`  ${r.from.padEnd(16)} → ${r.to}${r.py && r.py !== r.newPy ? `    (py ${r.py} → ${r.newPy})` : ''}`);
  p('');

  p('---- 二、将合并到已有纯净药（规格并集 / 库存累加）----');
  for (const m of plan.merge) {
    const tag = m.issues && m.issues.length ? '  ⚠ 冲突' : '';
    const u = (m.mergedUnits || []).map(x => `${x.unit}${isEmpty(x.stock) ? '' : '·库存' + x.stock}`).join(' + ');
    p(`  ${m.from.padEnd(16)} → ${m.to}    规格[${u || '-'}]${tag}`);
    for (const n of (m.unitNotes || [])) p(`        · ${n}`);
  }
  p('');

  p('---- 二·补、括号里是计量单位 → 转成该药的子规格 ----');
  if (!plan.unitSpecs.length) p('  （无）');
  for (const u of plan.unitSpecs) {
    const priceTxt = isEmpty(u.price) ? '无价（留空待填）' : `零售 ${u.price} 元/${u.inner}`;
    p(`  ${u.name.padEnd(14)} → ${u.base} 的子规格「${u.inner}」   ${priceTxt}` +
      (u.hasBase ? '' : '  ℹ 库内暂无纯净名，将直接改名并把主单位设为该单位'));
  }
  p('');

  p('---- 三、冲突，需人工确认（脚本默认不动）----');
  if (!plan.conflict.length) p('  （无）');
  for (const m of plan.conflict) {
    p(`  ${m.from} → ${m.to}`);
    for (const s of m.issues) p(`        ✗ ${s}`);
  }
  p('');

  p('---- 四、等级/品质/加工/用法，脚本不动（改名会改变药品身份）----');
  if (!plan.ambiguous.length) p('  （无）');
  for (const a of plan.ambiguous)
    p(`  ${a.name.padEnd(16)} 括号内「${a.inner}」 —— ${a.why}` + (isEmpty(a.price) ? '' : `（现价 ${a.price}）`));
  p('');

  p('---- 五、保留不动 ----');
  if (!plan.keep.length) p('  （无）');
  for (const k of plan.keep) p(`  ${k.name.padEnd(16)} 括号内「${k.inner}」 —— ${k.why}`);
  p('');
  p('提示：确认无误后执行 `node clean_drug_suffix.js --apply`；');
  p('      冲突条目在 `--apply` 时默认跳过，若同意按默认策略（保留已有纯净名的价格）处理，');
  p('      可加 `--include="药名[后缀],药名[后缀]"` 或 `--force-conflicts`。');
  return L.join('\n');
}

/* ---------------- 执行 ---------------- */
const PRINT_ONLY = arg('print', false);   /* 只打印将要发出的请求，不真正写库 */
async function patch(name, body) {
  const url = `${SUPA.url}/rest/v1/drugs?name=eq.${encodeURIComponent(name)}`;
  if (PRINT_ONLY) { console.log(`  [PATCH] ${name}\n         ${JSON.stringify(body)}`); return; }
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { apikey: SUPA.key, Authorization: 'Bearer ' + SUPA.key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`PATCH ${name} 失败 HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function del(name) {
  const url = `${SUPA.url}/rest/v1/drugs?name=eq.${encodeURIComponent(name)}`;
  if (PRINT_ONLY) { console.log(`  [DELETE] ${name}`); return; }
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { apikey: SUPA.key, Authorization: 'Bearer ' + SUPA.key, Prefer: 'return=minimal' }
  });
  if (!r.ok) throw new Error(`DELETE ${name} 失败 HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
function uniq(arr) { return Array.from(new Set(arr.filter(x => x != null && x !== ''))); }

async function run() {
  const rows = OFFLINE ? loadLocal() : await fetchAll();
  const plan = analyze(buildPlan(rows));
  const text = report(plan, rows);
  console.log(text);

  const dump = {
    generatedAt: new Date().toISOString(),
    offline: !!OFFLINE,
    total: rows.length,
    counts: {
      rename: plan.rename.length, merge: plan.merge.length,
      conflict: plan.conflict.length, ambiguous: plan.ambiguous.length, keep: plan.keep.length
    },
    rename: plan.rename.map(r => ({ from: r.from, to: r.to, py: r.py, newPy: r.newPy, isUnit: !!r.isUnit, unitFix: r.unitFix })),
    merge: plan.merge.map(m => ({ from: m.from, to: m.to, issues: m.issues || [], units: m.mergedUnits || [], notes: m.unitNotes || [] })),
    conflict: plan.conflict.map(m => ({ from: m.from, to: m.to, issues: m.issues })),
    unitSpecs: plan.unitSpecs,
    ambiguous: plan.ambiguous,
    keep: plan.keep,
    prefer: PREFER
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(dump, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'report.md'), '```\n' + text + '\n```\n', 'utf8');

  if (!APPLY) {
    console.log('\n[dry-run] 报告已写入 _clean/report.json，数据库未改动。');
    return;
  }
  if (OFFLINE) throw new Error('--offline 不能配合 --apply（避免误写库）');

  /* 备份全表 */
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = path.join(OUT, `backup_${stamp}.json`);
  if (!PRINT_ONLY) {
    fs.writeFileSync(bak, JSON.stringify(rows, null, 1), 'utf8');
    console.log('\n已备份全表 → ' + bak);
  }

  const allowed = FORCE ? plan.merge
    : plan.merge.filter(m => !m.issues.length || (m.names || [m.from]).some(n => INCLUDE.includes(n)));
  const skipped = plan.merge.filter(m => !allowed.includes(m));

  /* 1) 先做合并（写目标 + 删源），再做改名（改名不会和别的冲突） */
  let done = 0;
  for (const m of allowed) {
    const tgt = m.tgt, srcs = m.srcs || [m.src];
    const units = (m.mergedUnits || []).map(u => {
      /* 只重构已知字段，未知字段原样带走（防止把前端新加的字段洗掉） */
      const o = {};
      for (const k in u) {
        if (k === '__src' || k === '__main') continue;
        if (!isEmpty(u[k])) o[k] = u[k];
      }
      o.unit = u.unit;
      return o;
    });
    /* 主规格那条（与 drugs.unit 同名）不进 units 的「多单位」列表，但库存必须留一条镜像 */
    const mainUnit = String(tgt.unit || 'g').trim() || 'g';
    const main = (m.mergedUnits || []).find(u => unitKey(u) === mainUnit);
    const subUnits = units.filter(u => u.unit !== mainUnit);
    /* 行级字段只在「同一个计量单位」的源行之间比，单位类源行（[斤]/[个]…）不参与 */
    const rowSrcs = srcs.filter(s => !s.__unitSpec && unitKey(s) === unitKey(tgt));
    const pickNum = (f) => {
      let best = tgt[f];
      for (const s of rowSrcs) {
        if (isEmpty(s[f])) continue;
        if (isEmpty(best)) { best = s[f]; continue; }
        if (PREFER === 'high' && num(s[f]) > num(best)) best = s[f];
        else if (PREFER === 'src') best = s[f];
      }
      return best;
    };
    const pickAny = (f) => {
      if (!isEmpty(tgt[f])) return tgt[f];
      for (const s of rowSrcs) if (!isEmpty(s[f])) return s[f];
      return tgt[f];
    };
    const body = {
      units: subUnits,
      price: pickNum('price'), cost: pickNum('cost'), daily_price: pickNum('daily_price'),
      usage: pickAny('usage'), origin: pickAny('origin'),
      aliases: uniq([].concat(tgt.aliases || [], ...srcs.map(s => s.aliases || []))),
      updated_at: new Date().toISOString()
    };
    if (main && !isEmpty(main.stock)) {
      /* 主规格库存只能存在 units 的镜像条目里（与前端 dmMainMirror 一致） */
      body.units = subUnits.concat([{ unit: mainUnit, stock: main.stock }]);
    }
    await patch(tgt.name, body);
    for (const s of srcs) { await del(s.name); done++; }
    console.log(`  合并 ${srcs.map(s => s.name).join('、')} → ${tgt.name}  ✔`);
  }

  /* 2) 改名 */
  for (const r of plan.rename) {
    const body = { name: r.to, py: r.newPy || r.py, updated_at: new Date().toISOString() };
    if (r.unitFix) body.unit = r.unitFix;
    await patch(r.from, body);
    done++;
    console.log(`  改名 ${r.from} → ${r.to}${r.unitFix ? `（主单位 ${r.unitFix}）` : ''}  ✔`);
  }

  if (skipped.length) {
    console.log(`\n跳过 ${skipped.length} 条冲突项（未处理）：` + skipped.map(s => s.from).join('、'));
  }
  console.log(`\n完成：共处理 ${done} 条。`);
  if (PRINT_ONLY) { console.log('（--print 模式：只打印请求，数据库未改动）'); return; }

  /* 3) 自检：重新拉一遍，确认自动清理项已归零 */
  const after = await fetchAll();
  const check = analyze(buildPlan(after));
  console.log(`自检：剩余药品 ${after.length} 味；`
    + `可自动重命名 ${check.rename.length} 条 / 可自动合并 ${check.merge.length - check.conflict.length} 组 / `
    + `冲突 ${check.conflict.length} 组 / 人工判断 ${check.ambiguous.length} 条 / 保留 ${check.keep.length} 条`);
  if (check.rename.length === 0 && (check.merge.length - check.conflict.length) === 0) console.log('✔ 干净了，没有残留的煎服法后缀。');
  else console.log('⚠ 仍有可自动处理的条目，再跑一次 --apply 或检查日志。');
}

/* ---------------- 自检（不联网、不写库）---------------- */
function selftest() {
  let bad = 0;
  const eq = (name, a, b) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (!ok) { bad++; console.log('FAIL ' + name + ' → ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); }
    else console.log('PASS ' + name);
  };
  eq('先煎=剥离', classify('先煎').act, 'strip');
  eq('打另包=剥离', classify('打另包').act, 'strip');
  eq('打后下=剥离', classify('打后下').act, 'strip');
  eq('三元/克=保留', classify('三元/克').act, 'keep');
  eq('3元1克=保留', classify('3元1克').act, 'keep');
  eq('外用=保留', classify('外用').act, 'keep');
  eq('斤=计量单位', classify('斤').act, 'unit');
  eq('罐=计量单位', classify('罐').act, 'unit');
  eq('三十头=人工', classify('三十头').act, 'ambiguous');
  eq('切=人工', classify('切').act, 'ambiguous');
  eq('自备=人工', classify('自备').act, 'ambiguous');

  /* 单位类 → 子规格（大枣 主单位「个」0.2，大枣[斤] 15 元/斤） */
  const plUnit = analyze(buildPlan([
    { name: '大枣', unit: '个', price: 0.2, usage: '1', units: [], aliases: [] },
    { name: '大枣[斤]', unit: '斤', price: 15, usage: '1', units: [], aliases: [] }
  ]));
  eq('单位类进 unitSpecs', plUnit.unitSpecs.length, 1);
  eq('单位类不报冲突', plUnit.conflict.length, 0);
  eq('转成子规格「斤」15', plUnit.merge[0].mergedUnits.find(x => x.unit === '斤').retail, 15);
  eq('主单位「个」仍 0.2', plUnit.merge[0].mergedUnits.find(x => x.unit === '个').retail, 0.2);
  eq('规格数 2（个 + 斤）', plUnit.merge[0].mergedUnits.length, 2);

  eq('py 截后缀码 ygflb-另包', stripPy('ygflb', '另包'), 'ygf');
  eq('py 截后缀码 hssxj-先煎', stripPy('hssxj', '先煎'), 'hss');
  eq('py 无后缀码不动', stripPy('hss', '先煎'), 'hss');

  /* 库存累加 + 同规格合并不报冲突 */
  const tgt = { name: '白附子', unit: 'g', price: 0.15, units: [{ unit: '盒', retail: '400', stock: '2' }] };
  const src = { name: '白附子[先煎]', unit: 'g', price: 0.15, units: [{ unit: '盒', retail: '400', stock: '3' }] };
  const u1 = mergeUnits(tgt, [src]);
  eq('同规格库存累加 2+3', u1.merged.find(x => x.unit === '盒').stock, '5');
  eq('同规格同价不报冲突', u1.conflicts.length, 0);

  /* 价格不一致 → 冲突（主规格的价在行级比对，mergeUnits 只管子规格） */
  const pl2 = analyze(buildPlan([
    { name: '斑蝥', unit: 'g', price: 2.5, units: [], aliases: [] },
    { name: '斑蝥[另包]', unit: 'g', price: 5, units: [], aliases: [] }
  ]));
  eq('主规格价格不一致报冲突', pl2.conflict.length, 1);
  eq('冲突原因写明', /零售价不一致/.test(pl2.conflict[0].issues.join()), true);

  /* 计划生成 */
  const rows = [
    { name: '白附子', unit: 'g', price: 0.15, units: [], aliases: [] },
    { name: '白附子[先煎]', unit: 'g', price: 0.15, units: [], aliases: [] },
    { name: '寒水石[先煎]', unit: 'g', price: 0.02, units: [], aliases: ['寒水'], py: 'hssxj' },
    { name: '鹿茸[三元/克]', unit: 'g', price: 3, units: [], aliases: [] },
    { name: '玉竹[斤]', unit: 'g', price: 40, units: [], aliases: [] }
  ];
  const pl = analyze(buildPlan(rows));
  eq('已有纯净名 → 合并', pl.merge.length, 1);
  eq('无纯净名 → 改名（寒水石 + 玉竹）', pl.rename.length, 2);
  eq('改名目标正确', pl.rename[0].to, '寒水石');
  eq('改名 py 同步', pl.rename[0].newPy, 'hss');
  eq('价格备注 → 保留', pl.keep.length, 1);
  eq('单位后缀不再归「人工」', pl.ambiguous.length, 0);
  eq('单位类源行记进 unitSpecs', pl.unitSpecs.length, 1);
  eq('单位行主单位被纠正为「斤」', pl.rename[1].unitFix, '斤');
  eq('带括号总数', pl.bracketCount, 4);

  /* --prefer=high：两家都有价且不同 → 取高价，不报冲突 */
  PREFER = 'high';
  const plH = analyze(buildPlan([
    { name: '斑蝥', unit: 'g', price: 2.5, cost: 20, units: [], aliases: [] },
    { name: '斑蝥[另包]', unit: 'g', price: 5, cost: 130, units: [], aliases: [] }
  ]));
  eq('高价模式不报冲突', plH.conflict.length, 0);
  eq('高价模式记下取高价', /取高价 5/.test(plH.merge[0].unitNotes.join()), true);
  PREFER = 'target';

  console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
  process.exit(bad ? 1 : 0);
}
if (arg('selftest', false)) { selftest(); }

run().catch(e => { console.error('出错：' + e.message); process.exit(1); });
