#!/usr/bin/env python3
"""fetch_dem_corridor.py — 沿线路走廊采样开源 DEM 高程（独立于 Cesium 的纵断面参考）。

数据源：AWS Open Data 的 Terrarium 高程瓦片（elevation-tiles-prod，聚合
SRTM/NED/EU-DEM 等，公开无密钥）。PNG 编码：elevation = R*256 + G + B/256 − 32768。
纯标准库实现 PNG 解码（8-bit RGB 无隔行），不依赖 GDAL/rasterio。

定位：为“离线参考纵断面”提供原型工具。运行时纵断面已由
RailProfileService + IndexedDB 持久化缓存覆盖（见 src/core/railProfileService.ts），
本脚本用于离线核对或生成独立纵断面数据集，不进入运行时加载链。

用法：
  python3 fetch_dem_corridor.py --lat1 31.968 --lon1 118.797 --lat2 32.050 --lon2 118.920 --step 500
  python3 fetch_dem_corridor.py --tile-z12 12  # 打印南京附近瓦片元信息（演示）

注意：Terrarium 是地表高程（含植被/建筑），不代表铁路路基纵断面；桥隧不建模。
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
USER_AGENT = "China-Railway-Train-Sim-Neo/0.1 (DEM corridor sampling; local script)"
TILE_PIXELS = 256


def decode_png_rgb(data: bytes) -> tuple[int, int, int, list[list[tuple[int, int, int]]]]:
    """最小 PNG 解码：8-bit RGB（color type 2）、非隔行。返回 (宽, 高, 位深, 像素行)。"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG 文件")
    width = height = bit_depth = color_type = interlace = None
    idat = bytearray()
    position = 8
    while position < len(data):
        length, chunk = struct.unpack(">I4s", data[position : position + 8])
        body = data[position + 8 : position + 8 + length]
        if chunk == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif chunk == b"IDAT":
            idat.extend(body)
        elif chunk == b"IEND":
            break
        position += 12 + length
    if bit_depth != 8 or color_type != 2 or interlace != 0:
        raise ValueError(f"不支持的 PNG 形式：depth={bit_depth} color={color_type} interlace={interlace}")
    raw = zlib.decompress(bytes(idat))
    stride = width * 3
    rows: list[list[tuple[int, int, int]]] = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        line = bytearray(raw[offset : offset + stride])
        offset += stride
        for index in range(stride):
            left = line[index - 3] if index >= 3 else 0
            up = previous[index]
            upleft = previous[index - 3] if index >= 3 else 0
            if filter_type == 1:
                line[index] = (line[index] + left) & 0xFF
            elif filter_type == 2:
                line[index] = (line[index] + up) & 0xFF
            elif filter_type == 3:
                line[index] = (line[index] + ((left + up) >> 1)) & 0xFF
            elif filter_type == 4:
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                predictor = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upleft)
                line[index] = (line[index] + predictor) & 0xFF
        rows.append([(line[i * 3], line[i * 3 + 1], line[i * 3 + 2]) for i in range(width)])
        previous = line
    return width, height, bit_depth, rows


class TileCache:
    def __init__(self) -> None:
        self.tiles: dict[tuple[int, int, int], list[list[tuple[int, int, int]]]] = {}

    def fetch(self, zoom: int, x: int, y: int) -> list[list[tuple[int, int, int]]]:
        key = (zoom, x, y)
        if key not in self.tiles:
            request = urllib.request.Request(TILE_URL.format(z=zoom, x=x, y=y))
            request.add_header("User-Agent", USER_AGENT)
            with urllib.request.urlopen(request, timeout=60) as response:
                width, height, _, rows = decode_png_rgb(response.read())
            if width != TILE_PIXELS or height != TILE_PIXELS:
                raise ValueError(f"瓦片尺寸异常 {width}x{height}")
            self.tiles[key] = rows
        return self.tiles[key]

    def elevation(self, zoom: int, lat: float, lon: float) -> float:
        n = 2**zoom
        fx = (lon + 180.0) / 360.0 * n * TILE_PIXELS
        fy = (1.0 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n * TILE_PIXELS
        tx, ty = int(fx // TILE_PIXELS), int(fy // TILE_PIXELS)
        rows = self.fetch(zoom, tx, ty)
        px, py = fx - tx * TILE_PIXELS, fy - ty * TILE_PIXELS
        x0, y0 = min(int(px), TILE_PIXELS - 2), min(int(py), TILE_PIXELS - 2)
        dx, dy = px - x0, py - y0
        corners: list[float] = []
        for dy_i in (0, 1):
            for dx_i in (0, 1):
                r, g, b = rows[y0 + dy_i][x0 + dx_i]
                corners.append(r * 256 + g + b / 256 - 32768)
        top = corners[0] * (1 - dx) + corners[1] * dx
        bottom = corners[2] * (1 - dx) + corners[3] * dx
        return top * (1 - dy) + bottom * dy


def main() -> int:
    parser = argparse.ArgumentParser(description="沿线路走廊采样 Terrarium DEM 高程")
    parser.add_argument("--lat1", type=float, required=True)
    parser.add_argument("--lon1", type=float, required=True)
    parser.add_argument("--lat2", type=float, required=True)
    parser.add_argument("--lon2", type=float, required=True)
    parser.add_argument("--step", type=float, default=500.0, help="采样步距（米）")
    parser.add_argument("--zoom", type=int, default=12, help="瓦片级别（12 ≈ 38 m/像素）")
    args = parser.parse_args()

    cache = TileCache()
    length = math.hypot((args.lat2 - args.lat1) * 110_540, (args.lon2 - args.lon1) * 111_320 * math.cos(math.radians(args.lat1)))
    steps = max(1, math.ceil(length / args.step))
    print(f"走廊长度约 {length:.0f} m，采样 {steps + 1} 点（zoom {args.zoom}）")
    print("里程_m\t纬度\t经度\t高程_m")
    for index in range(steps + 1):
        fraction = index / steps
        lat = args.lat1 + (args.lat2 - args.lat1) * fraction
        lon = args.lon1 + (args.lon2 - args.lon1) * fraction
        elevation = cache.elevation(args.zoom, lat, lon)
        print(f"{fraction * length:.0f}\t{lat:.6f}\t{lon:.6f}\t{elevation:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
