#!/usr/bin/env python3
"""build_timetable.py — 把 chinese-railway-gtfs 的 GTFS 时刻表转换为轻量派生数据。

来源仓库：https://github.com/wensimehrp/chinese-railway-gtfs（CC-BY-4.0，数据源自
12306 公开接口，非官方授权数据集）。每日有 release，取 output_gtfs.zip 解压后
用本脚本转换；本仓库不提交上游原始 GTFS，只提交转换后的派生文件。

下载方式（任选其一）：
  gh release download <tag> -R wensimehrp/chinese-railway-gtfs -p output_gtfs.zip
  # 或浏览器从 GitHub Releases 下载

用法：
  python3 build_timetable.py --gtfs-dir /path/to/gtfs

输出：data/enriched/timetable/trains.json
  trains: [[车次, [经停电报码...]], ...]
  行别不落盘：车次号数字位奇偶即行别（双数=上行/向北京，单数=下行），
  运行时按需推定相邻站间方向，见 src/data/trainDirection.ts。

约束：只输出派生文件，不修改正式 data/；依赖 Python 3.9+ 标准库。
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> int:
    parser = argparse.ArgumentParser(description="GTFS → 轻量时刻表派生数据")
    parser.add_argument("--gtfs-dir", default="gtfs", help="解压后的 GTFS 目录（含 routes/trips/stop_times.txt）")
    parser.add_argument("--out", default=str(ROOT / "data/enriched/timetable/trains.json"))
    args = parser.parse_args()

    gtfs = Path(args.gtfs_dir)
    for name in ("routes.txt", "trips.txt", "stop_times.txt"):
        if not (gtfs / name).exists():
            print(f"缺少 {gtfs / name}；请先下载并解压 output_gtfs.zip", file=sys.stderr)
            return 1

    route_code: dict[str, str] = {}
    for row in read_rows(gtfs / "routes.txt"):
        route_code[row["route_id"]] = row["route_short_name"].strip()

    # route_id → 停站序列。同一车次可能有多个 service 的 trip，站序应一致，保留最长一份。
    route_stops: dict[str, list[str]] = {}
    trip_route: dict[str, str] = {}
    for row in read_rows(gtfs / "trips.txt"):
        trip_route[row["trip_id"]] = row["route_id"]

    by_trip: dict[str, list[tuple[int, str]]] = {}
    for row in read_rows(gtfs / "stop_times.txt"):
        trip_id = row["trip_id"]
        if trip_id in trip_route:
            by_trip.setdefault(trip_id, []).append((int(row["stop_sequence"]), row["stop_id"]))

    for trip_id, route_id in trip_route.items():
        entries = by_trip.get(trip_id)
        if not entries:
            continue
        stops = [stop for _, stop in sorted(entries)]
        current = route_stops.get(route_id)
        if current is None or len(stops) > len(current):
            route_stops[route_id] = stops

    trains: list[list] = []
    skipped = 0
    for route_id, stops in route_stops.items():
        code = route_code.get(route_id, "")
        if not code or len(stops) < 2:
            skipped += 1
            continue
        trains.append([code, stops])
    trains.sort(key=lambda item: item[0])

    pair_count = sum(len(stops) - 1 for _, stops in trains)
    payload = {
        "type": "timetable_dataset",
        "metadata": {
            "title": "中国铁路时刻表派生数据（neo）",
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "chinese-railway-gtfs (GTFS, CC-BY-4.0) — 经 12306 公开接口整理，非官方授权",
            "train_count": len(trains),
            "stop_pair_count": pair_count,
            "note": "车次号数字位奇偶即行别（双数=上行，单数=下行）；行别推定在运行时完成，只作参考提示。",
        },
        "trains": trains,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"trains: {len(trains)} (skipped {skipped}), adjacent stop pairs: {pair_count} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
