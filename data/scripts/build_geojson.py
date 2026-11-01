#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
整理分省铁路 GeoJSON -> outputs/geojson/*.geojson + outputs/cnrailway.geojson

处理内容：
  1. 按行政区划代码标注省份：顶层 name/province/adcode，且每条 feature 的 properties 加 province；
  2. 逐省另存一份交付副本，文件名 <adcode>-<省份简称>.geojson；
  3. 按省合并为全国 cnrailway.geojson（跨省重复要素默认去重，可用 --keep-dup 保留）；
  4. 输出 outputs/provinces_index.json 省份清单。

为保证内存占用可控，合并采用“逐省读入 - 逐条写出”的流式写盘方式。
"""
import argparse
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, '..', '..'))
SRC = os.path.join(ROOT, 'CRTrainRoute-main', 'data', 'geojson')
OUT = os.path.join(ROOT, 'outputs')
OUT_GJ = os.path.join(OUT, 'geojson')

CRS = {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:OGC:1.3:CRS84'}}

# (adcode, 省级全称, 简称, 类型)
PROVINCES = [
    ('110000', '北京市', '北京', '直辖市'),
    ('120000', '天津市', '天津', '直辖市'),
    ('130000', '河北省', '河北', '省'),
    ('140000', '山西省', '山西', '省'),
    ('150000', '内蒙古自治区', '内蒙古', '自治区'),
    ('210000', '辽宁省', '辽宁', '省'),
    ('220000', '吉林省', '吉林', '省'),
    ('230000', '黑龙江省', '黑龙江', '省'),
    ('310000', '上海市', '上海', '直辖市'),
    ('320000', '江苏省', '江苏', '省'),
    ('330000', '浙江省', '浙江', '省'),
    ('340000', '安徽省', '安徽', '省'),
    ('350000', '福建省', '福建', '省'),
    ('360000', '江西省', '江西', '省'),
    ('370000', '山东省', '山东', '省'),
    ('410000', '河南省', '河南', '省'),
    ('420000', '湖北省', '湖北', '省'),
    ('430000', '湖南省', '湖南', '省'),
    ('440000', '广东省', '广东', '省'),
    ('450000', '广西壮族自治区', '广西', '自治区'),
    ('460000', '海南省', '海南', '省'),
    ('500000', '重庆市', '重庆', '直辖市'),
    ('510000', '四川省', '四川', '省'),
    ('520000', '贵州省', '贵州', '省'),
    ('530000', '云南省', '云南', '省'),
    ('540000', '西藏自治区', '西藏', '自治区'),
    ('610000', '陕西省', '陕西', '省'),
    ('620000', '甘肃省', '甘肃', '省'),
    ('630000', '青海省', '青海', '省'),
    ('640000', '宁夏回族自治区', '宁夏', '自治区'),
    ('650000', '新疆维吾尔自治区', '新疆', '自治区'),
    ('710000', '台湾省', '台湾', '省'),
    ('810000', '香港特别行政区', '香港', '特别行政区'),
    ('820000', '澳门特别行政区', '澳门', '特别行政区'),
]

# 源文件名与 adcode 不完全一致的少数文件
SOURCE_ALIAS = {}  # 已改为按 adcode 前缀自动匹配


def source_path(adcode):
    """按 adcode 定位源文件；部分源文件带中文后缀（如 620000-甘肃.geojson）。"""
    exact = os.path.join(SRC, adcode + '.geojson')
    if os.path.exists(exact):
        return exact
    for name in sorted(os.listdir(SRC)):
        if name.endswith('.geojson') and name.split('-')[0] == adcode:
            return os.path.join(SRC, name)
    return None


def write_json(path, obj, indent=None):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':') if indent is None else None,
                  indent=indent)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep-dup', action='store_true', help='合并时保留跨省重复要素')
    args = ap.parse_args()

    os.makedirs(OUT_GJ, exist_ok=True)

    # ---------- 阶段一：逐省标注并另存 ----------
    index = []
    total_feat = 0
    total_seg = 0
    for adcode, prov, short, kind in PROVINCES:
        src = source_path(adcode)
        if not src:
            print('  [缺失] %s %s' % (adcode, prov))
            continue
        with open(src, encoding='utf-8') as f:
            data = json.load(f)

        feats = data.get('features') or []
        seg = 0
        for ft in feats:
            ft.setdefault('properties', {})
            # 把 province 放在 properties 首位，便于人工查看
            props = {'province': prov}
            props.update(ft['properties'])
            ft['properties'] = props
            g = ft.get('geometry') or {}
            if g.get('type') == 'LineString':
                seg += len(g.get('coordinates') or [])
            else:
                for line in g.get('coordinates') or []:
                    seg += len(line)

        doc = {
            'type': 'FeatureCollection',
            'name': prov,
            'province': {
                'adcode': adcode,
                'name': prov,
                'short_name': short,
                'type': kind,
            },
            'crs': CRS,
            'features': feats,
        }
        dst_name = '%s-%s.geojson' % (adcode, prov)
        dst = os.path.join(OUT_GJ, dst_name)
        write_json(dst, doc)

        size = os.path.getsize(dst)
        index.append({
            'adcode': adcode,
            'province': prov,
            'short_name': short,
            'type': kind,
            'file': 'geojson/' + dst_name,
            'source_file': os.path.basename(src),
            'feature_count': len(feats),
            'point_count': seg,
            'size_bytes': size,
        })
        total_feat += len(feats)
        total_seg += seg
        print('  %s %-8s 要素 %6d  顶点 %8d  %6.1f MB  -> %s'
              % (adcode, short, len(feats), seg, size / 1048576, dst_name))

    write_json(os.path.join(OUT, 'provinces_index.json'), {
        'type': 'province_index',
        'metadata': {
            'title': '分省铁路线路 GeoJSON 清单',
            'source': 'CRTrainRoute-main/data/geojson',
            'generated_at': '2026-10-28',
            'province_count': len(index),
            'feature_total': total_feat,
            'coordinate_system': 'WGS84 (EPSG:4326)',
            'missing': ['710000 台湾省（源数据未提供）'],
        },
        'provinces': index,
    })

    # ---------- 阶段二：流式合并 ----------
    merged_path = os.path.join(OUT, 'cnrailway.geojson')
    seen = set()
    dup = 0
    kept = 0
    header = {
        'type': 'FeatureCollection',
        'name': 'cnrailway',
        'title': '中国铁路线路（分省合并）',
        'crs': CRS,
        'metadata': {
            'source': 'CRTrainRoute-main/data/geojson',
            'generated_at': '2026-10-28',
            'coordinate_system': 'WGS84 (EPSG:4326)',
            'province_count': len(index),
            'dedup': not args.keep_dup,
            'dedup_key': 'osm_id + layer',
            'note': '每条 feature 的 properties.province 标注所属省级行政区',
        },
        'provinces': [
            {'adcode': x['adcode'], 'name': x['province'], 'feature_count': x['feature_count']}
            for x in index
        ],
    }
    head_txt = json.dumps(header, ensure_ascii=False)[:-1]  # 去掉末尾 }

    with open(merged_path, 'w', encoding='utf-8') as out:
        out.write(head_txt)
        out.write(',"features":[')
        first = True
        for adcode, prov, short, kind in PROVINCES:
            src = source_path(adcode)
            if not src:
                continue
            with open(src, encoding='utf-8') as f:
                data = json.load(f)
            buf = []
            for ft in data.get('features') or []:
                props = ft.get('properties') or {}
                key = (props.get('osm_id'), props.get('layer'))
                if not args.keep_dup and key in seen:
                    dup += 1
                    continue
                seen.add(key)
                newprops = {'province': prov}
                newprops.update(props)
                ft['properties'] = newprops
                buf.append(json.dumps(ft, ensure_ascii=False, separators=(',', ':')))
                kept += 1
                if len(buf) >= 5000:
                    out.write((',' if not first else '') + ','.join(buf))
                    first = False
                    buf = []
            if buf:
                out.write((',' if not first else '') + ','.join(buf))
                first = False
            del data
        out.write(']}')

    size = os.path.getsize(merged_path)
    print('\n合并完成：%d 条要素（去重 %d 条），%.1f MB -> %s'
          % (kept, dup, size / 1048576, merged_path))
    print('分省文件 %d 个，合计要素 %d（含跨省重复），合计顶点 %d'
          % (len(index), total_feat, total_seg))


if __name__ == '__main__':
    main()
