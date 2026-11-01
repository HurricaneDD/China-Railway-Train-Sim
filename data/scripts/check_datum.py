#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
坐标基准探测：判断车站坐标究竟是 WGS84 还是 GCJ-02。

思路：
  OSM 铁路几何是确定的 WGS84。若车站坐标同为 WGS84，则车站到最近线路顶点的
  距离应集中在几十米量级、且位移向量无系统性方向；若车站是 GCJ-02（火星坐标），
  则整体存在 300~600 m 系统性偏移，此时把车站按 GCJ-02 -> WGS84 反算后，
  距离才会明显下降。

  对原始 12306 坐标的实测结论：原样中位 343 m，反算后 103 m，78.6% 的车站
  反算后更贴近线路 -> 12306 原始坐标为 GCJ-02，现已在本项目交付数据中转换为
  WGS84。交付后复跑本脚本，应当“原样”一栏最优、平均位移趋近 0，即为正常。
"""
import json
import math
import os

import numpy as np
from scipy.spatial import cKDTree

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, '..', '..'))
PKL = os.path.join(ROOT, 'CRTrainRoute-main', 'data', 'rail_graph.pkl')
ST = os.path.join(ROOT, 'outputs', 'stations.json')

# ---------- GCJ-02 ----------
A = 6378245.0
EE = 0.00669342162296594323


def _tlat(x, y):
    r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * np.sqrt(np.abs(x))
    r += (20.0 * np.sin(6.0 * x * np.pi) + 20.0 * np.sin(2.0 * x * np.pi)) * 2.0 / 3.0
    r += (20.0 * np.sin(y * np.pi) + 40.0 * np.sin(y / 3.0 * np.pi)) * 2.0 / 3.0
    r += (160.0 * np.sin(y / 12.0 * np.pi) + 320 * np.sin(y * np.pi / 30.0)) * 2.0 / 3.0
    return r


def _tlng(x, y):
    r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * np.sqrt(np.abs(x))
    r += (20.0 * np.sin(6.0 * x * np.pi) + 20.0 * np.sin(2.0 * x * np.pi)) * 2.0 / 3.0
    r += (20.0 * np.sin(x * np.pi) + 40.0 * np.sin(x / 3.0 * np.pi)) * 2.0 / 3.0
    r += (150.0 * np.sin(x / 12.0 * np.pi) + 300.0 * np.sin(x / 30.0 * np.pi)) * 2.0 / 3.0
    return r


def wgs2gcj(lng, lat):
    dlat = _tlat(lng - 105.0, lat - 35.0)
    dlng = _tlng(lng - 105.0, lat - 35.0)
    rad = lat / 180.0 * np.pi
    magic = 1 - EE * np.sin(rad) ** 2
    sq = np.sqrt(magic)
    dlat = (dlat * 180.0) / ((A * (1 - EE)) / (magic * sq) * np.pi)
    dlng = (dlng * 180.0) / (A / sq * np.cos(rad) * np.pi)
    return lng + dlng, lat + dlat


def gcj2wgs(lng, lat, iters=6):
    """迭代反算，精度优于 0.5 m。注意：必须拷贝输入，否则原地减法会污染调用方数组。"""
    wlng = np.array(lng, dtype=np.float64, copy=True)
    wlat = np.array(lat, dtype=np.float64, copy=True)
    for _ in range(iters):
        glng, glat = wgs2gcj(wlng, wlat)
        wlng -= (glng - lng)
        wlat -= (glat - lat)
    return wlng, wlat


def haversine(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def nearest(tree, lons, lats, qlon, qlat, k=8):
    """KD 树在角度空间取 k 个候选，再用球面距离取真最近。"""
    _, idx = tree.query(np.column_stack([qlon, qlat]), k=k)
    dist = haversine(qlat[:, None], qlon[:, None], lats[idx], lons[idx])
    j = dist.argmin(axis=1)
    rows = np.arange(len(qlon))
    nl, nt = lons[idx[rows, j]], lats[idx[rows, j]]
    return nl, nt, dist[rows, j]


def main():
    import pickle
    g = pickle.load(open(PKL, 'rb'))
    lons = np.asarray(g['lons'], dtype=np.float64)
    lats = np.asarray(g['lats'], dtype=np.float64)
    print('OSM 线路顶点：%d 个' % len(lons))
    tree = cKDTree(np.column_stack([lons, lats]))

    doc = json.load(open(ST, encoding='utf-8'))
    sts = doc['stations']
    slon = np.array([s['longitude'] for s in sts])
    slat = np.array([s['latitude'] for s in sts])

    cases = {}
    # 假设 A：原始坐标即 WGS84
    cases['原样 (视为 WGS84)'] = (slon, slat)
    # 假设 B：原始坐标是 GCJ-02，反算成 WGS84 再比对
    blon, blat = gcj2wgs(slon, slat)
    cases['按 GCJ-02 反算'] = (blon, blat)
    # 参照组：把 WGS84 正向转成 GCJ-02（若原样已是最优，此项应显著变差）
    clon, clat = wgs2gcj(slon, slat)
    cases['按 WGS84 正转 GCJ-02'] = (clon, clat)

    print('\n%-24s %8s %8s %8s %8s' % ('假设', '中位数', '均值', 'P90', '<100m占比'))
    results = {}
    for name, (qlon, qlat) in cases.items():
        nl, nt, d = nearest(tree, lons, lats, qlon, qlat)
        results[name] = d
        print('%-24s %6.1fm %6.1fm %6.1fm %7.1f%%'
              % (name, np.median(d), d.mean(), np.percentile(d, 90), (d < 100).mean() * 100))

    # 方向性：原样假设下车站在最近线路顶点的哪个方位
    nl, nt, d = nearest(tree, lons, lats, slon, slat)
    dy = (slat - nt) * 111320.0
    dx = (slon - nl) * 111320.0 * np.cos(np.radians(slat))
    print('\n原样假设下 车站相对最近线路顶点的平均位移：东向 %+.0f m，北向 %+.0f m'
          % (dx.mean(), dy.mean()))
    print('（GCJ-02 在华东一带约为 东偏 +300~+500 m、北偏 +100~+200 m）')

    for code in ('BJP', 'IZQ', 'SHH', 'HCP'):
        i = next(k for k, s in enumerate(sts) if s['telecode'] == code)
        print('  %s %-6s 原样 %5.0f m | GCJ 反算 %5.0f m'
              % (code, sts[i]['name'], results['原样 (视为 WGS84)'][i],
                 results['按 GCJ-02 反算'][i]))

    # ---------- 方向相关性检验 ----------
    # 若车站本身是 GCJ-02，则“车站 - 最近线路顶点”的位移向量应包含 GCJ 偏移分量，
    # 与该点理论 GCJ 偏移向量强相关（斜率接近 1）；若车站本就是 WGS84，则二者无关。
    print('\n方向相关性检验（位移向量 vs 该点理论 GCJ 偏移量）')
    for name, (qlon, qlat) in cases.items():
        nl, nt, _ = nearest(tree, lons, lats, qlon, qlat)
        kx = 111320.0 * np.cos(np.radians(qlat))
        mx = (qlon - nl) * kx
        my = (qlat - nt) * 111320.0
        glon, glat = wgs2gcj(qlon, qlat)
        tx = (glon - qlon) * kx
        ty = (glat - qlat) * 111320.0
        rx, ry = np.corrcoef(mx, tx)[0, 1], np.corrcoef(my, ty)[0, 1]
        sx, sy = np.polyfit(tx, mx, 1)[0], np.polyfit(ty, my, 1)[0]
        print('  %-24s 东向 r=%+.2f 斜率=%+.2f | 北向 r=%+.2f 斜率=%+.2f'
              % (name, rx, sx, ry, sy))
    print('  判读：r 高且斜率≈1 → 位移主要由 GCJ 偏移构成；r≈0 → 已是同一基准')


if __name__ == '__main__':
    main()
