#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
历史计划单 → 黄婉媚专属价 + 历史成交价 导入脚本
==================================================

用途：
  遍历本机某个文件夹（默认 ~/Desktop，可包含 2025 / 2026 子文件夹）下的
  .csv / .xlsx 计划单，按「药名 + 单位」提取最新一次成交单价与全部历史价格，
  然后写回 Supabase：
    1) doctors 表           → 「黄婉媚」的重要客人价格（prices）
    2) price_logs 表        → 每次历史成交价（日期 / 药名 / 价格 / 来源单号）

用法：
    python3 tools/import_plan_prices.py --root ~/Desktop --guest 黄婉媚
    python3 tools/import_plan_prices.py --root ~/Desktop --dry-run   # 只打印，不写库

依赖：
    .xlsx 需要 openpyxl（pip install openpyxl）；.csv 无依赖。

表头要求（任一包含即可，顺序不限）：
    药名 / 药品名称 / 品名 / 药材
    单价 / 价格 / 成交价
    数量（可选，用金额换算时必需） 单位 日期 单号 / 编号
"""
import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import urllib.parse
import urllib.error
import urllib.request

SUPA_URL = 'https://ikrhpxbnnfqvotnquziy.supabase.co'
SUPA_KEY = 'sb_publishable_22DqGTvSYu2QjtMq53fB4Q_QiF9wITb'

NAME_KEYS = ['药名', '药品名称', '品名', '药材', '商品名称', '名称']
PRICE_KEYS = ['单价', '价格', '成交价', '售价']
QTY_KEYS = ['数量', '克数', '重量', '剂量']
UNIT_KEYS = ['单位', '规格']
DATE_KEYS = ['日期', '开单日期', '下单日期', '时间']
NO_KEYS = ['单号', '订单号', '编号', '计划单号']
AMOUNT_KEYS = ['金额', '小计', '合计']

TAG_ALTS = {
    '炒': ['炒', '清炒', '麸炒'], '盐': ['盐', '盐水'], '醋': ['醋', '醋制'],
    '蜜炙': ['蜜炙', '蜜'], '蜜': ['蜜', '蜜炙'], '姜': ['姜', '姜制'],
    '炙': ['炙', '蜜炙'], '制': ['制'], '生': ['生'], '炭': ['炭'], '煅': ['煅'],
}
SYN = {
    '牛子': ['牛蒡子'], '川仲': ['川牛膝'], '故纸': ['补骨脂'], '夜交藤': ['首乌藤'],
    '申姜': ['骨碎补'], '银花': ['金银花'], '二花': ['金银花'], '元胡': ['延胡索'],
    '玄胡': ['延胡索'], '瓜萎': ['瓜蒌'], '黄苓': ['黄芩'], '厚补': ['厚朴'],
    '紫苑': ['紫菀'], '牡丹皮': ['丹皮'], '辛夷花': ['辛夷'], '薏苡仁': ['炒薏仁', '薏仁'],
    '川断': ['续断'],
}


def http(path, method='GET', body=None, prefer=None):
    url = SUPA_URL + '/rest/v1/' + path
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    hdr = {
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Content-Type': 'application/json',
    }
    if prefer:
        hdr['Prefer'] = prefer
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            txt = r.read().decode('utf-8')
            return json.loads(txt) if txt else None
    except urllib.error.HTTPError as e:
        raise RuntimeError('HTTP %s %s' % (e.code, e.read().decode('utf-8')[:200]))


def q_all(path):
    """PostgREST 单次最多 1000 行，按 offset 翻页。"""
    sep = '&' if '?' in path else '?'
    out, offset, page = [], 0, 1000
    while True:
        rows = http(path + sep + 'limit=%d&offset=%d' % (page, offset)) or []
        out.extend(rows)
        if len(rows) < page:
            return out
        offset += page
        if offset > 50000:
            return out


def norm_name(s):
    s = str(s or '')
    s = s.replace('（', '(').replace('）', ')').replace('【', '[').replace('】', ']')
    return re.sub(r'\s+', '', s).strip()


def split_name(raw):
    s = str(raw or '').strip()
    sfx = ''
    m = re.match(r'^(.+?)([\[［][^\]］]*[\]］])$', s)
    if m:
        s, sfx = m.group(1), m.group(2)
    core, tag = s, ''
    pm = re.match(r'^([^()（）]*)[（(]([^（）()]*)[）)]$', s)
    if pm:
        core, tag = pm.group(1), pm.group(2)
    return s.strip(), core.strip(), tag.strip(), sfx


def pick_col(headers, keys):
    hs = [norm_name(h) for h in headers]
    for k in keys:
        for i, h in enumerate(hs):
            if h == k:
                return i
    for k in keys:
        for i, h in enumerate(hs):
            if k in h:
                return i
    return -1


def norm_unit(u):
    u = str(u or '').strip().lower()
    if u in ('', '克', 'g', 'ｇ'):
        return 'g'
    if u in ('kg', '千克', '公斤', '㎏'):
        return 'kg'
    if u == '斤':
        return '斤'
    return u


UNIT_COEF = {('kg', 'g'): 0.001, ('斤', 'g'): 0.002, ('g', 'kg'): 1000, ('g', '斤'): 500}


def to_base_price(price, from_u, base_u):
    if from_u == base_u:
        return price
    return price * UNIT_COEF.get((from_u, base_u), 1.0)


def parse_date(v, fallback):
    s = str(v or '').strip()
    m = re.search(r'(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})', s)
    if m:
        return '%04d-%02d-%02d' % (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r'(\d{4})(\d{2})(\d{2})', s)
    if m:
        return '%s-%s-%s' % (m.group(1), m.group(2), m.group(3))
    return fallback


def guess_date_from_path(path):
    s = os.path.basename(path)
    d = parse_date(s, '')
    if d:
        return d
    return dt.datetime.fromtimestamp(os.path.getmtime(path)).strftime('%Y-%m-%d')


def read_table(path):
    """返回 [(sheet名, 行列表)]；CSV 编码自动兼容 UTF-8 / GBK。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.csv', '.txt'):
        raw = None
        for enc in ('utf-8-sig', 'gbk', 'gb18030'):
            try:
                raw = open(path, 'r', encoding=enc, newline='').read()
                break
            except UnicodeDecodeError:
                continue
        if raw is None:
            return []
        rows = list(csv.reader(raw.splitlines()))
        return [(os.path.basename(path), rows)]
    if ext in ('.xlsx', '.xlsm'):
        try:
            import openpyxl
        except ImportError:
            print('  ! 跳过 %s（缺 openpyxl，请 pip install openpyxl）' % path)
            return []
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        out = []
        for ws in wb.worksheets:
            rows = []
            for row in ws.iter_rows(values_only=True):
                rows.append(['' if c is None else str(c) for c in row])
            out.append((ws.title, rows))
        return out
    return []


def extract(path):
    """从一张表里取出 [{drug,unit,price,date,source}]。"""
    recs = []
    fdate = guess_date_from_path(path)
    for sheet, rows in read_table(path):
        header_i = -1
        for i, row in enumerate(rows[:15]):
            if pick_col(row, NAME_KEYS) >= 0 and pick_col(row, PRICE_KEYS) >= 0:
                header_i = i
                break
        if header_i < 0:
            continue
        headers = rows[header_i]
        cn = pick_col(headers, NAME_KEYS)
        cp = pick_col(headers, PRICE_KEYS)
        cq = pick_col(headers, QTY_KEYS)
        cu = pick_col(headers, UNIT_KEYS)
        cd = pick_col(headers, DATE_KEYS)
        cno = pick_col(headers, NO_KEYS)
        ca = pick_col(headers, AMOUNT_KEYS)
        for row in rows[header_i + 1:]:
            if not any(str(c).strip() for c in row):
                continue
            def cell(idx):
                return str(row[idx]).strip() if 0 <= idx < len(row) else ''
            drug = cell(cn)
            if not drug or drug in NAME_KEYS:
                continue
            unit = norm_unit(cell(cu)) if cu >= 0 else ''
            price = None
            if cp >= 0:
                m = re.search(r'[0-9]+(?:\.[0-9]+)?', cell(cp).replace(',', ''))
                if m:
                    price = float(m.group(0))
            if price is None and ca >= 0 and cq >= 0:
                qm = re.search(r'[0-9]+(?:\.[0-9]+)?', cell(cq))
                am = re.search(r'[0-9]+(?:\.[0-9]+)?', cell(ca).replace(',', ''))
                if qm and am and float(qm.group(0)) > 0:
                    price = float(am.group(0)) / float(qm.group(0))
                    if not unit:
                        unit = 'g'
            if price is None or price <= 0:
                continue
            date = parse_date(cell(cd), fdate) if cd >= 0 else fdate
            no = cell(cno) if cno >= 0 else ''
            recs.append({'drug': drug, 'unit': unit or 'g', 'price': price,
                         'date': date, 'source': no or (os.path.basename(path) + '/' + sheet)})
    return recs


def build_drug_index(drugs):
    idx, cores = {}, {}
    for d in drugs:
        n = str(d.get('name') or '').strip()
        if not n:
            continue
        idx.setdefault(norm_name(n), d)
        c = split_name(n)[1]
        cores.setdefault(norm_name(c), d)
    return idx, cores


def match_drug(raw, idx, cores, drugs):
    body, core, tag, _ = split_name(raw)
    key_body, key_core = norm_name(body), norm_name(core)
    if key_body in idx:
        return idx[key_body]
    # 炮制词（炒/盐/醋/蜜炙…）优先拼成仓库写法：鸡内金（炒）→ 炒鸡内金
    if tag in TAG_ALTS:
        for a in TAG_ALTS[tag]:
            for cand in (a + core, core + a):
                d = idx.get(norm_name(cand))
                if d:
                    return d
    d = idx.get(key_core) or cores.get(key_core)
    if d:
        return d
    # 括号内容本身是仓库药名：故纸（补骨脂）→ 补骨脂
    if tag and len(tag) >= 2:
        d = idx.get(norm_name(tag))
        if d:
            return d
    for s in SYN.get(core, []):
        d = idx.get(norm_name(s)) or cores.get(norm_name(s))
        if d:
            return d
    if len(key_core) >= 2:
        best = None
        for d in drugs:
            k = norm_name(d.get('name'))
            if key_core in k and (best is None or len(k) < len(norm_name(best.get('name')))):
                best = d
        if best:
            return best
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=os.path.expanduser('~/Desktop'), help='计划单所在文件夹')
    ap.add_argument('--guest', default='黄婉媚', help='专属价客人名')
    ap.add_argument('--dry-run', action='store_true', help='只打印结果，不写库')
    ap.add_argument('--limit', type=int, default=0, help='最多处理多少个文件（调试用）')
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        sys.exit('找不到文件夹：%s（请用 --root 指定计划单目录）' % args.root)

    files = []
    for base, _, names in os.walk(args.root):
        for fn in names:
            if fn.lower().endswith(('.csv', '.xlsx', '.xlsm')):
                files.append(os.path.join(base, fn))
    files.sort()
    if args.limit:
        files = files[:args.limit]
    if not files:
        sys.exit('目录里没有找到 .csv / .xlsx 计划单：%s' % args.root)

    print('== 扫描到 %d 个文件 ==' % len(files))
    recs = []
    for f in files:
        try:
            part = extract(f)
        except Exception as e:
            print('  ! %s 解析失败：%s' % (f, e))
            continue
        print('  %s → %d 条' % (os.path.basename(f), len(part)))
        recs.extend(part)

    print('== 读取云端药品目录 ==')
    drugs = q_all('drugs?select=name,unit,price,cost,aliases')
    idx, cores = build_drug_index(drugs)
    print('  药品目录 %d 味' % len(drugs))

    matched, unmatched = [], []
    for r in recs:
        d = match_drug(r['drug'], idx, cores, drugs)
        if not d:
            unmatched.append(r)
            continue
        base_u = norm_unit(d.get('unit') or 'g')
        r2 = dict(r)
        r2['std'] = str(d.get('name'))
        r2['base_unit'] = base_u
        r2['base_price'] = to_base_price(r['price'], r['unit'], base_u)
        matched.append(r2)

    print('== 匹配 %d 条，未匹配 %d 条 ==' % (len(matched), len(unmatched)))
    for r in unmatched[:15]:
        print('  ✗ %s（%s %.2f 元/%s %s）' % (r['drug'], r['source'], r['price'], r['unit'], r['date']))
    if len(unmatched) > 15:
        print('  … 另有 %d 条未匹配' % (len(unmatched) - 15))

    latest = {}
    for r in matched:
        key = (r['std'], r['unit'])
        if key not in latest or r['date'] > latest[key]['date']:
            latest[key] = r

    print('\n== 最新成交价（将写入「%s」专属价） ==' % args.guest)
    for (std, unit), r in sorted(latest.items(), key=lambda x: x[0][0]):
        print('  %-16s %8.2f 元/%s  (%s  %s)' % (std, r['price'], unit, r['date'], r['source']))

    if args.dry_run:
        print('\n--dry-run：未写库。')
        return

    print('\n== 写入 doctors 表（%s 专属价） ==' % args.guest)
    rows = http('doctors?select=name,prices&name=eq.' + urllib.parse.quote(args.guest)) or []
    prices = (rows[0].get('prices') if rows else {}) or {}
    for (std, unit), r in latest.items():
        prices[std.strip().lower().replace(' ', '')] = round(r['base_price'], 6)
    http('doctors?on_conflict=name', method='POST',
         body=[{'name': args.guest, 'prices': prices}],
         prefer='resolution=merge-duplicates,return=minimal')
    print('  已写入 %d 味专属价' % len(latest))

    print('== 写入 price_logs 历史成交（%d 条） ==' % len(matched))
    # 去重：同一客人 + 药名 + 价格 + 来源单号 + 日期 已经存在就跳过（脚本可安全重跑）
    existing = q_all('price_logs?select=drug,to_price,rx_no,created_at&doctor=eq.'
                     + urllib.parse.quote(args.guest)) or []
    keys = set()
    for r in existing:
        keys.add((norm_name(r.get('drug')), round(float(r.get('to_price') or 0), 4),
                  str(r.get('rx_no') or ''), str(r.get('created_at') or '')[:10]))
    todo = []
    for r in matched:
        k = (norm_name(r['std']), round(r['price'], 4), str(r['source'])[:120], r['date'])
        if k in keys:
            continue
        keys.add(k)
        todo.append(r)
    print('  新增 %d 条，重复跳过 %d 条' % (len(todo), len(matched) - len(todo)))
    B = 300
    for i in range(0, len(todo), B):
        chunk = todo[i:i + B]
        payload = [{
            'doctor': args.guest,
            'drug': r['std'],
            'from_price': None,
            'to_price': round(r['price'], 4),
            'rx_no': str(r['source'])[:120],
            'created_at': r['date'] + 'T12:00:00+08:00',
        } for r in chunk]
        http('price_logs', method='POST', body=payload, prefer='return=minimal')
        print('  已写入 %d / %d' % (min(i + B, len(todo)), len(todo)))

    print('\n完成。打开页面 → 订单详情 → 单价悬停即可看到历史价格；')


if __name__ == '__main__':
    main()
