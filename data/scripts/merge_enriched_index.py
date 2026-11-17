#!/usr/bin/env python3
"""merge_enriched_index.py — 合并多 worker 的增强索引分片。

enrich_osm_tags.py 用 --index-out 产出 provinces_index.partN.json 分片
（并行 worker 各写各的），本脚本合并为最终 provinces_index.json：
按 adcode 去重（后写覆盖先写），metadata 汇总各分片来源。

用法：python3 merge_enriched_index.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "enriched"


def main() -> int:
    parts = sorted(OUT.glob("provinces_index.part*.json"))
    if not parts:
        print("没有找到 provinces_index.part*.json 分片", file=sys.stderr)
        return 1
    merged: dict[str, dict] = {}
    sources: list[str] = []
    osm_base = ""
    for part in parts:
        payload = json.loads(part.read_text(encoding="utf-8"))
        for entry in payload.get("provinces", []):
            merged[entry["adcode"]] = entry
        sources.append(part.name)
        osm_base = osm_base or str(payload.get("metadata", {}).get("osm_base_timestamp", ""))
        part.unlink()
    provinces = sorted(merged.values(), key=lambda item: item["adcode"])
    final = {
        "type": "enriched_province_index",
        "metadata": {
            "title": "OSM 标签增强分省索引（neo）",
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "Overpass API (OpenStreetMap), ODbL 1.0 — © OpenStreetMap contributors",
            "osm_base_timestamp": osm_base,
            "merged_from": sources,
            "tag_keys": ["maxspeed", "electrified", "voltage", "frequency", "gauge", "usage", "service", "tracks", "railway:ref"],
            "note": "几何与要素顺序与正式 data/geojson 完全一致，仅 properties 追加存在的 OSM 标签键。",
        },
        "provinces": provinces,
    }
    dest = OUT / "provinces_index.json"
    dest.write_text(json.dumps(final, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"merged {len(parts)} parts -> {dest.name}: {len(provinces)} provinces")
    return 0


if __name__ == "__main__":
    sys.exit(main())
