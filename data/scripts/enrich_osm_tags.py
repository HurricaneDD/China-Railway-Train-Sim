#!/usr/bin/env python3
"""enrich_osm_tags.py — 按 osm_id 从 Overpass API 重查 OSM 原始标签，生成分省增强 GeoJSON。

背景：data/geojson 的分省文件只保留 8 个简化字段（province/osm_id/code/fclass/
name/layer/bridge/tunnel），OSM 源头的 maxspeed/electrified/gauge/usage/service/
tracks 等标签在上游 CRTrainRoute-main 整理时被丢弃且该上游不在本仓库内。
本脚本以正式数据里的 osm_id 为键回查 Overpass，把标签补回。

输出（不修改正式 data/ 任何文件）：
  data/enriched/cache/batch-*.json   原始标签缓存（按全局唯一 osm_id 分批，可断点续跑）
  data/enriched/geojson/<adcode>-<省份>.geojson   原 8 字段不动，末尾追加存在的标签键
  data/enriched/provinces_index.json   镜像主索引 + 每省标签覆盖率统计
  data/enriched/README.md   来源、时间戳与 ODbL 署名说明

用法：
  python3 enrich_osm_tags.py                       # 全部省份
  python3 enrich_osm_tags.py --provinces 320000    # 只处理江苏
  python3 enrich_osm_tags.py --batch-size 2000 --sleep 3

约束：
  - 只增列不删改：正式文件的原字段与 features 顺序逐字节保持（重新序列化不改值），
    因此运行时派生区段 ID（<adcode>:<feature>:<part>）不变，存档 V1 兼容。
  - 单线程 + 请求间延时，尊重公共 Overpass 实例；失败指数退避并轮换端点。
  - 仅依赖 Python 3.9+ 标准库。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
OUT = DATA / "enriched"
CACHE = OUT / "cache"

TAG_KEYS = ["maxspeed", "electrified", "voltage", "frequency", "gauge", "usage", "service", "tracks", "railway:ref"]

COVERAGE_KEY = {
    "maxspeed": "with_maxspeed",
    "electrified": "with_electrified",
    "voltage": "with_voltage",
    "frequency": "with_frequency",
    "gauge": "with_gauge",
    "usage": "with_usage",
    "service": "with_service",
    "tracks": "with_tracks",
    "railway:ref": "with_railway_ref",
}

DEFAULT_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

USER_AGENT = "China-Railway-Train-Sim-Neo/0.1 (one-off OSM tag enrichment; local script)"
CACHE_VERSION = 1


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {message}", flush=True)


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))


def collect_ids(path: Path) -> list[str]:
    """Pass 1: collect every feature's osm_id, preserving file order."""
    payload = load_json(path)
    ids: list[str] = []
    for feature in payload.get("features", []):
        raw = feature.get("properties", {}).get("osm_id")
        if raw is None:
            continue
        text = str(raw).strip()
        if text:
            ids.append(text)
    return ids


def overpass_query(endpoint: str, ids: list[str], timeout_s: int):
    id_list = ",".join(ids)
    query = f"[out:json][timeout:{timeout_s}];way(id:{id_list});out tags;"
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST")
    request.add_header("User-Agent", USER_AGENT)
    request.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(request, timeout=timeout_s + 30) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_batch(endpoint_state: dict, ids: list[str], args, batch_index: int) -> dict[str, dict]:
    """Fetch one batch with cache, retries, endpoint rotation. Returns {osm_id: tags}."""
    # Content-addressed cache key: identical id chunks reuse cache regardless of province subsets.
    digest = hashlib.sha1((",".join(ids)).encode("utf-8")).hexdigest()[:12]
    cache_path = CACHE / f"batch-{batch_index:04d}-{digest}.json"
    if cache_path.exists():
        cached = load_json(cache_path)
        if cached.get("version") == CACHE_VERSION and cached.get("ids") == ids:
            log(f"batch {batch_index}: cached ({len(ids)} ids)")
            return cached.get("tags", {})

    endpoints = [e.strip() for e in args.endpoints.split(",") if e.strip()]
    delays = [min(args.retry_backoff * (2**attempt), 120) for attempt in range(args.retries)]
    result: dict[str, dict] = {}
    errors: list[str] = []

    for attempt in range(args.retries):
        endpoint = endpoints[(endpoint_state["round"] + attempt) % len(endpoints)]
        try:
            payload = overpass_query(endpoint, ids, args.overpass_timeout)
            elements = payload.get("elements", [])
            for element in elements:
                tags = element.get("tags")
                if element.get("type") == "way" and tags:
                    result[str(element["id"])] = tags
            endpoint_state["round"] = (endpoint_state["round"] + attempt) % len(endpoints)
            osm_base = str(payload.get("osm3s", {}).get("timestamp_osm_base", ""))
            if osm_base:
                endpoint_state["osm_base"] = osm_base
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            write_json(cache_path, {"version": CACHE_VERSION, "ids": ids, "tags": result})
            log(f"batch {batch_index}: {len(result)}/{len(ids)} ways matched via {endpoint}")
            return result
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            errors.append(f"{endpoint}: {exc}")
            wait = delays[min(attempt, len(delays) - 1)]
            log(f"batch {batch_index}: attempt {attempt + 1} failed on {endpoint} ({exc}); wait {wait:.0f}s")
            time.sleep(wait)

    raise RuntimeError(f"batch {batch_index} failed after {args.retries} attempts:\n" + "\n".join(errors))


def build_enriched_file(source: Path, dest: Path, tags_by_id: dict[str, dict]) -> dict:
    """Pass 2: reload province file, append present tag keys, keep everything else identical."""
    payload = load_json(source)
    stats = {"features_total": 0, "unmatched_ids": 0, **{value: 0 for value in COVERAGE_KEY.values()}}
    seen_ids: set[str] = set()
    for feature in payload.get("features", []):
        stats["features_total"] += 1
        raw_id = feature.get("properties", {}).get("osm_id")
        if raw_id is None:
            continue
        osm_id = str(raw_id).strip()
        seen_ids.add(osm_id)
        tags = tags_by_id.get(osm_id)
        if not tags:
            stats["unmatched_ids"] += 1
            continue
        properties = feature.get("properties")
        if isinstance(properties, dict):
            for key in TAG_KEYS:
                value = tags.get(key)
                if value is not None and value != "":
                    properties[key] = value
                    stats[COVERAGE_KEY[key]] += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="按 osm_id 重查 OSM 标签，生成分省增强 GeoJSON")
    parser.add_argument("--provinces", default="", help="逗号分隔 adcode 列表，默认全部")
    parser.add_argument("--batch-size", type=int, default=2000)
    parser.add_argument("--sleep", type=float, default=3.0, help="请求间延时秒数")
    parser.add_argument("--retries", type=int, default=6)
    parser.add_argument("--retry-backoff", type=float, default=5.0, help="重试退避基数秒数（按 2 的幂增长，上限 120s）")
    parser.add_argument("--rounds", type=int, default=5, help="失败省份的整体重试轮数")
    parser.add_argument("--time-budget-minutes", type=float, default=170.0, help="总运行时间预算（分钟），超时优雅退出可续跑")
    parser.add_argument("--overpass-timeout", type=int, default=180)
    parser.add_argument("--endpoints", default=",".join(DEFAULT_ENDPOINTS))
    parser.add_argument("--no-write", action="store_true", help="只抓标签写缓存，不生成增强文件")
    args = parser.parse_args()

    index = load_json(DATA / "provinces_index.json")
    provinces = index.get("provinces", [])
    if args.provinces:
        wanted = {code.strip() for code in args.provinces.split(",") if code.strip()}
        provinces = [entry for entry in provinces if entry.get("adcode") in wanted]
    if not provinces:
        log("no province selected")
        return 1

    CACHE.mkdir(parents=True, exist_ok=True)

    # 逐省增量处理：抓完一省立即产出增强文件；单省失败不阻断其他省份，
    # 由多轮重试兜底（缓存内容寻址，重跑已完成省份几乎零成本）。
    endpoint_state = {"round": 0, "osm_base": ""}
    tags_by_id: dict[str, dict] = {}
    batch_counter = 0
    deadline = time.monotonic() + args.time_budget_minutes * 60

    def process(entry: dict) -> dict:
        nonlocal batch_counter
        source = DATA / entry["file"]
        dest = OUT / entry["file"]  # data/enriched/geojson/<adcode>-<省>.geojson
        ids = collect_ids(source)
        seen: set[str] = set()
        ordered: list[str] = []
        for text in ids:
            if not text.isdigit():
                log(f"{entry['province']}: skip non-numeric osm_id {text!r}")
                continue
            if text not in seen:
                seen.add(text)
                ordered.append(text)
        ordered.sort(key=int)
        for start in range(0, len(ordered), args.batch_size):
            batch_counter += 1
            chunk = ordered[start : start + args.batch_size]
            tags_by_id.update(fetch_batch(endpoint_state, chunk, args, batch_counter))
            time.sleep(args.sleep)
        log(f"{entry['province']}: {len(ordered)} ids fetched")
        if args.no_write:
            return {}
        stats = build_enriched_file(source, dest, tags_by_id)
        log(f"{entry['province']}: enriched -> {dest.name} (maxspeed {stats['with_maxspeed']}/{stats['features_total']})")
        return {
            "adcode": entry["adcode"],
            "province": entry["province"],
            "file": f"enriched/{entry['file']}",
            "feature_count": stats["features_total"],
            "tag_coverage": {key: stats[value] for key, value in COVERAGE_KEY.items()},
            "unmatched_ids": stats["unmatched_ids"],
        }

    enriched_entries: list[dict] = []
    pending = list(provinces)
    for round_index in range(1, args.rounds + 1):
        failed: list[dict] = []
        for entry in pending:
            if time.monotonic() > deadline:
                log("时间预算用尽，本轮停止（缓存已保留，重跑脚本即可续抓）")
                break
            try:
                result = process(entry)
                if result:
                    enriched_entries.append(result)
            except Exception as exc:  # 无人值守：单省失败不阻断后续省份
                log(f"{entry['province']}: 第 {round_index} 轮失败（{exc}）")
                failed.append(entry)
        pending = failed
        if not pending or time.monotonic() > deadline:
            break
        log(f"第 {round_index} 轮结束，{len(pending)} 个省份稍后重试（60s）")
        time.sleep(60)

    if pending:
        log(f"注意：{len(pending)} 个省份经 {args.rounds} 轮仍未完成（可重跑续抓）：{', '.join(item['province'] for item in pending)}")

    if not args.no_write:
        index_payload = {
            "type": "enriched_province_index",
            "metadata": {
                "title": "OSM 标签增强分省索引（neo）",
                "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "source": "Overpass API (OpenStreetMap), ODbL 1.0 — © OpenStreetMap contributors",
                "osm_base_timestamp": endpoint_state.get("osm_base", ""),
                "tag_keys": TAG_KEYS,
                "note": "几何与要素顺序与正式 data/geojson 完全一致，仅 properties 追加存在的 OSM 标签键。",
            },
            "provinces": enriched_entries,
        }
        write_json(OUT / "provinces_index.json", index_payload)
        log("enriched index written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
