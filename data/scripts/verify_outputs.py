#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
交付物自检：校验 stations.json、分省 geojson、合并 cnrailway.geojson 的结构与关键字段。

合并文件 100 MB 级，用流式解析逐条读取 feature，避免一次性载入内存。
"""
import json
import os
import collections
import math

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(BASE, '..'))
CHUNK = 1 << 20


def stream_features(path):
    """流式产出 (header_dict, feature_iter) 中的 feature。"""
    dec = json.JSONDecoder()
    f = open(path, encoding='utf-8')
    buf = f.read(CHUNK)
    # 定位 features 数组起点
    idx = buf.find('"features"')
    while idx < 0:
        more = f.read(CHUNK)
        if not more:
            raise ValueError('未找到 features 数组')
        buf += more
        idx = buf.find('"features"')
    pos = buf.find('[', idx) + 1
    eof = False
    while True:
        while pos < len(buf) and buf[pos] in ' \n\r\t,':
            pos += 1
        if pos >= len(buf) or buf[pos] == ']':
            if not eof:
                more = f.read(CHUNK)
                if more:
                    buf = buf[pos:] + more
                    pos = 0
                    eof = False
                    continue
                eof = True
                break
            break
        try:
            obj, end = dec.raw_decode(buf, pos)
        except ValueError:
            if eof:
                raise
            more = f.read(CHUNK)
            if not more:
                raise
            buf = buf[pos:] + more
            pos = 0
            continue
        yield obj
        pos = end


def check_merged(path):
    cnt = 0
    prov = collections.Counter()
    types = collections.Counter()
    for ft in stream_features(path):
        cnt += 1
        p = (ft.get('properties') or {}).get('province')
        prov[p] += 1
        types[(ft.get('geometry') or {}).get('type')] += 1
        if p is None:
            raise SystemExit('要素缺少 province 标记：%s' % str(ft)[:120])
    return cnt, prov, types


def main():
    ok = True

    # ---- stations.json ----
    sp = os.path.join(OUT, 'stations.json')
    doc = json.load(open(sp, encoding='utf-8'))
    sts = doc['stations']
    need = ('telecode', 'name', 'full_name', 'province', 'city', 'address',
            'longitude', 'latitude', 'longitude_gcj02', 'latitude_gcj02')
    miss = [(r.get('telecode'), [k for k in need if k not in r]) for r in sts if any(k not in r for k in need)]
    badgeo = [r['telecode'] for r in sts if not (3 < r['latitude'] < 54 and 73 < r['longitude'] < 136)]
    dup = [k for k, v in collections.Counter(r['telecode'] for r in sts).items() if v > 1]
    print('[stations.json] 记录 %d 条，无坐标 %d 条，字段缺失 %d 条，坐标越界 %d 条，电报码重复 %d 个'
          % (len(sts), len(doc['pending_stations']), len(miss), len(badgeo), len(dup)))
    ok &= not miss and not badgeo and not dup

    # WGS84 与原始 GCJ-02 的偏移量：应为 0~1000 m，中位数数百米（说明两者确实不同基准）
    offs = []
    for r in sts:
        dy = (r['latitude'] - r['latitude_gcj02']) * 111320.0
        dx = (r['longitude'] - r['longitude_gcj02']) * 111320.0 * math.cos(math.radians(r['latitude']))
        offs.append(math.hypot(dx, dy))
    offs.sort()
    med = offs[len(offs) // 2]
    print('  WGS84 与 GCJ-02 偏移：中位 %.0f m，最大 %.0f m（应全部 > 0 且 < 1000 m）'
          % (med, offs[-1]))
    ok &= 100 < med < 800 and offs[0] > 0 and offs[-1] < 1000

    # ---- 分省 geojson ----
    idx = json.load(open(os.path.join(OUT, 'provinces_index.json'), encoding='utf-8'))
    total = 0
    for item in idx['provinces']:
        p = os.path.join(OUT, item['file'].replace('/', os.sep))
        d = json.load(open(p, encoding='utf-8'))
        assert d['type'] == 'FeatureCollection'
        assert d['province']['adcode'] == item['adcode']
        assert len(d['features']) == item['feature_count'], p
        assert all(f['properties'].get('province') == item['province'] for f in d['features']), p
        total += len(d['features'])
    print('[分省 geojson] %d 个文件，要素合计 %d，省份标注全部一致' % (len(idx['provinces']), total))

    # ---- 合并文件 ----
    cnt, prov, types = check_merged(os.path.join(OUT, 'cnrailway.geojson'))
    print('[cnrailway.geojson] 要素 %d 条，覆盖省份 %d 个，几何类型 %s'
          % (cnt, len(prov), dict(types)))
    top = prov.most_common(3)
    print('  要素最多的省份：%s' % '，'.join('%s %d' % t for t in top))
    ok &= len(prov) == len(idx['provinces'])
    print('\n结论：%s' % ('全部通过' if ok else '存在问题，请检查'))


if __name__ == '__main__':
    main()
