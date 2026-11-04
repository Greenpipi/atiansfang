# -*- coding: utf-8 -*-
"""把「产地.xlsx」的药名对到药物库 drugs 上"""
import json, re, csv
from collections import Counter

SRC = json.load(open('/workspace/.tmp/origin_src.json', encoding='utf-8'))
DRUGS = json.load(open('/workspace/.tmp/drugs_full.json', encoding='utf-8'))

LIB = {}
for d in DRUGS:
    LIB.setdefault(d['name'], d)
ALIAS = {}
for d in DRUGS:
    for a in (d.get('aliases') or []):
        a = str(a).strip()
        if a and a not in LIB:
            ALIAS.setdefault(a, d['name'])

PREP = {
    '蜜': ['蜜', '炙'], '蜜炙': ['蜜', '炙'], '炒': ['炒'], '酒': ['酒'], '盐': ['盐'],
    '生': ['生'], '熟': ['熟'], '醋': ['醋'], '姜': ['姜'], '煅': ['煅'], '焦': ['焦'],
    '制': ['制'], '蒸': ['蒸'], '九蒸九晒': ['九制'], '酒炒': ['酒', '炒'],
    '盐酒炒': ['盐酒'], '盐炒': ['盐'], '麸炒': ['麸炒'], '土炒': ['土炒'],
    '清炒': ['清'], '砂炒': ['砂'], '炙': ['炙'], '泡': ['泡'], '法': ['法'], '清': ['清'],
}
DROP = {'厚皮', '去皮', '带皮', '好', '大', '小', '中', '片', '条', '丝', '段', '粒', '硬',
        '野生', '进口', '国产', '旱', '双', '单', 'A', 'B', 'C', 'a', 'b', 'c', '自备', '无硫'}
MAN = {
    '川仲': '盐杜仲', '川仲（厚皮）': '盐杜仲',
    '生半夏（旱）': '生半夏', '半夏（旱）': '姜旱半夏',
    '黄精（生）': '生黄精', '黄精（九蒸九晒）': '九制黄精',
    '熟地（九蒸九晒）': '九制熟地',
    '钩藤（双）': '双钩藤', '钩藤（单）': '单钩藤',
    '西洋参（进口）': '西洋参', '西洋参（国产）': '西洋参',
    '玛卡（国产）': '玛卡', '薄荷冰': '薄荷脑',
    '椿根皮': '椿根皮', '金刚藤': '菝葜', '七枝莲': '重楼',
    '白牵牛': '黑白丑', '香薷': '香薷', '党参条': '党参',
    '天花粉（B）': '天花粉', '射干（好）': '射干', '羌活（野生）': '羌活',
    '花椒（好）': '好花椒', '浮萍（小）': '浮萍', '骨碎补（硬）': '骨碎补',
    '辛夷花（小）': '辛夷', '辛夷花（大）': '辛夷', '人中白（片）': '人中白',
    '紫菀（蜜）': '炙紫菀', '苍术（炒）': '炒苍术', '大黄（酒）': '酒大黄',
    '益智仁（盐）': '益智仁', '益智仁（炒）': '炒益智仁', '槟榔（炒）': '炒槟榔',
    '神曲（炒）': '焦神曲', '知母（酒炒）': '酒知母', '黄柏（酒炒）': '酒黄柏',
    '杜仲（酒炒）': '酒杜仲', '牛膝（酒炒）': '酒牛膝', '小茴香（盐酒炒）': '盐酒小茴香',
    '补骨脂（酒炒）': '酒补骨脂', '仙茅（盐）': '盐仙茅', '锁阳（盐）': '盐锁阳',
    '赤小豆（炒）': '炒赤小豆', '牛蒡子（炒）': '炒牛蒡子', '桃仁（去皮）': '桃仁[去皮]',
    '远志（炙）': '蜜远志', '远志（蜜炙）': '蜜远志',
    '田七20头': '田七[二十头]', '田七30头': '田七[三十头]', '田七40头': '田七[四十头]',
    '阿胶（东阿）': '东阿阿胶', '阿胶（福牌）': '阿胶福牌',
    '马钱子（生）': '生马钱子', '莪术（生）': '生莪术', '郁金（生）': '生郁金',
    '鸡内金（生）': '鸡内金',
    # —— 异体字 / 别名 / 简称 ——
    '莲子心': '莲心', '橘皮': '陈皮', '荜拨': '荜茇', '白藓皮': '白鲜皮',
    '白藓皮（B级）': '白鲜皮', '豨签草': '豨莶草',
    '薏苡仁': '薏仁', '薏苡仁（炒）': '炒薏仁',
    '栀子': '山栀子', '浙贝': '浙贝母', '浙贝（打粗粉）': '浙贝母',
    '苏梗': '紫苏梗', '莱菔子': '生莱菔子', '豆豉': '淡豆豉',
    '煅自然铜': '自然铜', '藏红花A': '藏红花', '麦冬A': '麦冬',
    '好黄精': '生黄精', '好人参': '人参', '冬花': '款冬花', '醋鳖甲': '鳖甲',
    '新会陈皮': '陈皮', '九制陈皮': '制陈皮', '五指牛奶': '五指毛桃',
    '鹿茸蜡片': '鹿茸腊片', '西洋参薄片': '西洋参', '西洋参厚片': '西洋参',
    '野生葛根': '葛根', '田七粉': '三七粉', '紫花地丁': '地丁',
    '石膏': '生石膏', '苏子': '紫苏子', '牡丹皮': '丹皮', '蒺藜': '刺蒺藜',
    '川贝母': '川贝', '川连': '黄连', '大枸杞子': '大枸杞',
    '甘菊（野菊花）': '野菊花', '法夏（打粗粉分包）': '法半夏',
    '黑草': '鬼羽箭[黑草]', '九晒首乌': '九制首乌', '铁落': '生铁落',
    '雪上一支蒿': '雪上一枝蒿', '岗梅根': '岗梅', '黑蚂蚁': '大黑蚂蚁',
    '川仲（盐）': '盐杜仲',
}
# 需要人工再看一眼的
MAN_Q = {
    '生附片': '炮附子', '好乌': '乌蛇', '阿胶（东语）': '东阿阿胶',
    '接骨木': '接骨草', '石楠叶': '石楠藤', '血茸': '鹿茸',
    '金英根': '金樱子', '黄明胶': '阿胶普通',
    '黄精': '生黄精', '黄贡菊': '菊花', '田七60头': '三七',
}
NONDRUG = {'75%酒精', '氮酮', '二甲基亚矾', '水溶性辣椒碱（自备）', '水溶性氨酮',
           '麝香草酚', '薄荷油', '冬青油', '姜汁', '冰糖', '白糖', '红糖', '酸梅粉',
           '茶籽', '苦荞麦', '七付中药打粉', '十付中药打细粉', '水丸', '包装瓶',
           '封口塑料袋', '包装袋', '无纺布袋子', '闪送费', '打粗粉', '辣了',
           '杀虫片', '鹿茸菇'}

CLOSERS = ['件', '中', '大', '小', '好', '盐', '炒', '炙', '生', '熟', '炭', '片', '条',
           '丝', '段', '粒', '尖', '粉', '干', '鲜']


def norm(s):
    s = str(s or '').strip().replace('\u200c', '').replace(' ', '')
    s = s.replace('(', '（').replace(')', '）')
    return s


def split_paren(nm):
    m = re.match(r'^([^（]+)（([^）]*)）$', nm)
    if not m:
        m = re.match(r'^（([^）]*)）([^（]+)$', nm)
        if m:
            return m.group(2), m.group(1)
        return nm, ''
    return m.group(1), m.group(2)


def match(name, note):
    nm = norm(name)
    out, tried = [], []

    def add(x):
        x = norm(x)
        if x and x not in out:
            out.append(x)

    add(nm)
    if nm in MAN:
        add(MAN[nm])
    if nm in MAN_Q:
        add(MAN_Q[nm])
    base, suf = split_paren(nm)
    if suf:
        for p in PREP.get(suf, []):
            add(p + base)
            add(base + p)
            add(base + '[' + suf + ']')
            add(p + base + '[' + suf + ']')
        if suf in DROP:
            add(base)
        add(base + suf)
        add(base)
    else:
        for c in CLOSERS:
            if nm.endswith(c) and len(nm) > 2:
                add(nm[:-len(c)])
    for token in re.split(r'[、，,；;/|]+', norm(note)):
        token = norm(token)
        if not token or re.match(r'^[A-Za-z]{2,3}\d', token):
            continue
        add(token)
        b2, s2 = split_paren(token)
        if s2:
            if s2 in DROP:
                add(b2)
            for p in PREP.get(s2, []):
                add(p + b2)
        if token in MAN:
            add(MAN[token])
        if token in MAN_Q:
            add(MAN_Q[token])
    for c in out:
        tried.append(c)
        if c in LIB:
            d = LIB[c]
            how = '同名' if c == nm else '还原/改名'
            if nm in MAN_Q:
                how = '待确认'
            return c, how, tried
        if c in ALIAS:
            return ALIAS[c], '别名', tried
    return '', '', tried


rows = []
for s in SRC:
    nm = norm(s['name'])
    hit, how, tried = match(s['name'], s['note'])
    if nm in NONDRUG:
        status = '非药材/辅料'
        hit, how = '', ''
    elif hit:
        status = '待确认' if how == '待确认' else '已匹配'
    else:
        status = '仓库无此药'
    rows.append({
        '产地表名称': s['name'],
        '条码': s.get('barcode', ''),
        '单位': s.get('unit', ''),
        '进货价(元/kg)': s.get('cost', ''),
        '产地': s.get('origin', ''),
        '备注': s.get('note', ''),
        '仓库药名': hit,
        '匹配方式': how,
        '状态': status,
        '候选尝试': ' / '.join(tried[:6]),
    })

with open('/workspace/产地_药名对照表.csv', 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

print('总数', len(rows))
print(Counter(r['状态'] for r in rows))
print(Counter(r['匹配方式'] for r in rows))
print('有产地', sum(1 for r in rows if str(r['产地']).strip()))
print('有产地且已匹配', sum(1 for r in rows if str(r['产地']).strip() and r['仓库药名']))
miss = [r for r in rows if not r['仓库药名']]
print('\n未匹配：', len(miss))
for r in miss:
    print('|', r['产地表名称'], '|', r['进货价(元/kg)'], '|', r['备注'], '|', r['候选尝试'])
json.dump(rows, open('/workspace/.tmp/origin_match.json', 'w'), ensure_ascii=False)
