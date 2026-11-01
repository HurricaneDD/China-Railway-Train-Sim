#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
整理 12306 车站资料 -> outputs/stations.json

输出字段（每条记录）：
    telecode     电报码（3 位大写字母，12306 电报码）
    name         标准化站名（去掉“站”字后缀，官方通用简称）
    full_name    站名全称（12306 返回的 stationName，含“站”）
    province     省级行政区全称（由具体地址前缀识别）
    city         地级行政区（标准化，直辖市取市名）
    city_raw     12306 原始 cityName，保留用于溯源
    address      具体地址
    longitude    经度（WGS84 十进制，与 cnrailway.geojson 同基准）
    latitude     纬度（WGS84 十进制，与 cnrailway.geojson 同基准）
    longitude_gcj02 / latitude_gcj02   12306 原始 GCJ-02 坐标（供高德/腾讯底图使用）
"""
import json
import math
import os
import re
import collections

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, '..', '..'))
SRC = os.path.join(ROOT, 'CRTrainRoute-main', 'data')
OUT = os.path.join(ROOT, 'outputs')

# 省级行政区：全称 -> 简称
PROVINCE_FULL = {
    '北京市': '北京', '天津市': '天津', '上海市': '上海', '重庆市': '重庆',
    '河北省': '河北', '山西省': '山西', '辽宁省': '辽宁', '吉林省': '吉林',
    '黑龙江省': '黑龙江', '江苏省': '江苏', '浙江省': '浙江', '安徽省': '安徽',
    '福建省': '福建', '江西省': '江西', '山东省': '山东', '河南省': '河南',
    '湖北省': '湖北', '湖南省': '湖南', '广东省': '广东', '海南省': '海南',
    '四川省': '四川', '贵州省': '贵州', '云南省': '云南', '陕西省': '陕西',
    '甘肃省': '甘肃', '青海省': '青海', '台湾省': '台湾',
    '内蒙古自治区': '内蒙古', '广西壮族自治区': '广西', '西藏自治区': '西藏',
    '宁夏回族自治区': '宁夏', '新疆维吾尔自治区': '新疆',
    '香港特别行政区': '香港', '澳门特别行政区': '澳门',
}
# 直辖市 / 特别行政区：地级即自身
MUNICIPALITY = {'北京市', '天津市', '上海市', '重庆市', '香港特别行政区', '澳门特别行政区'}
# 简称 -> 全称（处理地址省略“省/自治区”的写法）
PROVINCE_SHORT = {v: k for k, v in PROVINCE_FULL.items()}
# 内蒙古三盟白名单（避免“联盟大街”之类误命中“盟”）
MENG_WHITELIST = ('兴安盟', '锡林郭勒盟', '阿拉善盟')

PREFECTURE_RE = re.compile(r'^(.{2,15}?)(自治州|自治县|地区|市|州)')
CITY_SUFFIXES = ('市', '县', '区', '州', '盟', '旗', '地区')


def split_province(addr):
    """从地址前缀识别省，返回 (省全称, 剩余地址)。"""
    for full in sorted(PROVINCE_FULL, key=len, reverse=True):
        if addr.startswith(full):
            return full, addr[len(full):]
    for short in sorted(set(PROVINCE_FULL.values()), key=len, reverse=True):
        if addr.startswith(short):
            return PROVINCE_SHORT[short], addr[len(short):]
    return None, addr


def norm_city_raw(raw):
    """把 12306 的 cityName 规整成带行政后缀的形式。"""
    raw = (raw or '').strip()
    if not raw or raw == '无':
        return None
    if raw in PROVINCE_FULL:
        return raw
    if raw.endswith(CITY_SUFFIXES):
        return raw
    if raw in PROVINCE_SHORT:
        return PROVINCE_SHORT[raw]
    return raw + '市'


def derive_city(province, addr, city_raw):
    """推断地级行政区。"""
    if province in MUNICIPALITY:
        return province
    rest = addr[len(province):] if province and addr.startswith(province) else addr
    m = PREFECTURE_RE.match(rest)
    if m and not re.search(r'[路街道号镇乡村]', m.group(1)):
        cand = m.group(1) + m.group(2)
        # “盟”需白名单校验
        if m.group(2) == '盟':
            hit = next((w for w in MENG_WHITELIST if rest.startswith(w)), None)
            if not hit:
                return norm_city_raw(city_raw)
            return hit
        if cand.endswith('自治州') or cand.endswith('地区') or cand.endswith('市'):
            return cand
        return cand
    return norm_city_raw(city_raw)


def norm_station_name(full_name):
    """标准化站名：去尾部“站”，去空白，保留“香港西九龙”这类复合名。"""
    name = (full_name or '').strip()
    name = re.sub(r'\s+', '', name)
    if name.endswith('站') and len(name) > 1:
        name = name[:-1]
    return name


# ---------- GCJ-02 <-> WGS84 ----------
# 12306 返回的车站坐标为 GCJ-02（火星坐标），与 OSM 线路（WGS84）不同基准。
# 实测：车站到最近线路顶点的中位距离，原样 343 m，反算后 103 m，
# 78.6% 的车站反算后更贴近线路 —— 详见 scripts/check_datum.py。
_GCJ_A = 6378245.0
_GCJ_EE = 0.00669342162296594323


def _tlat(x, y):
    r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    r += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return r


def _tlng(x, y):
    r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    r += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    r += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return r


def wgs2gcj(lng, lat):
    dlat = _tlat(lng - 105.0, lat - 35.0)
    dlng = _tlng(lng - 105.0, lat - 35.0)
    rad = lat / 180.0 * math.pi
    magic = 1 - _GCJ_EE * math.sin(rad) ** 2
    sq = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_GCJ_A * (1 - _GCJ_EE)) / (magic * sq) * math.pi)
    dlng = (dlng * 180.0) / (_GCJ_A / sq * math.cos(rad) * math.pi)
    return lng + dlng, lat + dlat


def gcj2wgs(lng, lat, iters=8):
    """迭代反算，残差 < 0.5 m。"""
    wlng, wlat = lng, lat
    for _ in range(iters):
        glng, glat = wgs2gcj(wlng, wlat)
        wlng -= (glng - lng)
        wlat -= (glat - lat)
    return wlng, wlat


def main():
    stations = json.load(open(os.path.join(SRC, 'stations.json'), encoding='utf-8'))
    name_map = json.load(open(os.path.join(SRC, 'station_names.json'), encoding='utf-8'))

    records = []
    no_addr = 0
    for code, s in stations.items():
        addr = (s.get('addr') or '').strip()
        if addr in ('', '无'):
            addr = None
            no_addr += 1
        province = None
        if addr:
            province, _ = split_province(addr)
        city_raw = s.get('city')
        city = derive_city(province, addr or '', city_raw)

        full_name = s.get('name') or ''
        name = norm_station_name(name_map.get(code) or full_name)
        full_name_norm = norm_station_name(full_name)
        alt = None
        if name != full_name_norm:
            alt = full_name_norm  # 站名存在改名/异名，保留另一写法

        glon, glat = float(s['lon']), float(s['lat'])
        wlon, wlat = gcj2wgs(glon, glat)
        rec = {
            'telecode': code,
            'name': name,
            'full_name': full_name_norm + '站' if full_name_norm else None,
            'province': province,
            'city': city,
            'city_raw': city_raw,
            'address': addr,
            'longitude': round(wlon, 6),
            'latitude': round(wlat, 6),
            'longitude_gcj02': round(glon, 6),
            'latitude_gcj02': round(glat, 6),
        }
        if alt:
            rec['name_alt'] = alt
        records.append(rec)

    records.sort(key=lambda r: r['telecode'])

    # 少数车站地址缺失（12306 返回空/“无”），用城市名反查省份补齐并标注
    city2prov = {}
    for r in records:
        if r['province'] and r['city']:
            city2prov.setdefault(r['city'], r['province'])
    for r in records:
        if not r['city'] and r['city_raw']:
            r['city'] = norm_city_raw(r['city_raw'])
            r['city_inferred'] = True
        if not r['province'] and r['city'] in city2prov:
            r['province'] = city2prov[r['city']]
            r['province_inferred'] = True
    # 仍缺省份的（城市名为县级市、他处未出现过），用最近 3 座已知省份车站投票
    known = [r for r in records if r['province']]
    for r in records:
        if r['province'] or not known:
            continue
        near = sorted(known, key=lambda x: (x['longitude'] - r['longitude']) ** 2
                      + (x['latitude'] - r['latitude']) ** 2)[:3]
        r['province'] = collections.Counter(x['province'] for x in near).most_common(1)[0][0]
        r['province_inferred'] = True

    # 仅存在于 station_names.json、缺少坐标记录的车站
    pending = []
    for code, nm in name_map.items():
        if code in stations:
            continue
        pending.append({'telecode': code, 'name': norm_station_name(nm)})
    pending.sort(key=lambda r: r['telecode'])

    prov_cnt = collections.Counter(r['province'] or '未知' for r in records)
    city_cnt = len({r['city'] for r in records if r['city']})

    doc = {
        'type': 'station_dataset',
        'metadata': {
            'title': '中国铁路车站资料（标准化）',
            'source': 'CRTrainRoute-main/data/stations.json + station_names.json',
            'source_note': '坐标与地址源自 12306 车站地址接口，电报码映射源自 12306 站名库',
            'coordinate_system': 'WGS84 (EPSG:4326)，单位为十进制度',
            'datum_note': '12306 接口原始坐标为 GCJ-02（火星坐标）。longitude/latitude 已反算为 WGS84，'
                          '与 cnrailway.geojson 同基准，可直接叠加；原始值保留在 '
                          'longitude_gcj02/latitude_gcj02，用于高德/腾讯底图直接打点。',
            'generated_at': '2026-10-28',
            'station_count': len(records),
            'pending_count': len(pending),
            'province_count': len([p for p in prov_cnt if p != '未知']),
            'city_count': city_cnt,
            'fields': {
                'telecode': '电报码（12306 车站电报码，3 位大写字母）',
                'name': '标准化站名（去“站”字后的官方简称）',
                'full_name': '站名全称（含“站”）',
                'name_alt': '同一车站的另一写法（仅改名/异名车站出现）',
                'province': '省级行政区全称',
                'city': '地级行政区（标准化；直辖市与特别行政区取自身）',
                'city_raw': '12306 原始 cityName（保留溯源）',
                'address': '具体地址',
                'longitude': '经度（WGS84，与线路数据同基准）',
                'latitude': '纬度（WGS84，与线路数据同基准）',
                'longitude_gcj02': '经度（GCJ-02，12306 原始值，供高德/腾讯底图使用）',
                'latitude_gcj02': '纬度（GCJ-02，12306 原始值，供高德/腾讯底图使用）',
                'province_inferred': '省份由城市名反查补齐（仅地址缺失的极少数车站出现）',
                'city_inferred': '城市由 12306 cityName 规整补齐（仅地址缺失的极少数车站出现）',
            },
            'pending_note': 'pending_stations 为站名库中存在、但未取到坐标的车站，仅含电报码与站名',
        },
        'stations': records,
        'pending_stations': pending,
    }

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, 'stations.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)

    print('车站 %d 条，无坐标 %d 条，省份 %d 个，城市 %d 个，无地址 %d 条'
          % (len(records), len(pending), doc['metadata']['province_count'], city_cnt, no_addr))
    print('省份分布：', prov_cnt.most_common(6))
    miss = [r for r in records if not r['city'] or not r['province']]
    print('字段缺失：', len(miss), [m['telecode'] for m in miss][:5])
    print('→', path)


if __name__ == '__main__':
    main()
