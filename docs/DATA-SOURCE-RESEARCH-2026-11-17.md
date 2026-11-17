# 数据源与存储选型调研（neo 分支基础文档）

> 调研日期：2026-11-17。本文档是 `neo` 分支"数据扩充与优化版"开发的调研基础，分两部分：
> 一、存储层开源数据库选型；二、铁路数据本身的补充来源。
> 结论服务于同一目标：在不破坏"纯前端静态应用、GitHub Pages 部署、正式数据 `data/` 不改字段"三条架构红线的前提下扩充数据并优化加载。

---

## 0. 项目现状与缺口（调研前提）

架构约束：

- 纯前端静态应用（Vue 3 + TS + Vite + CesiumJS），部署 GitHub Pages 子路径，无后端、无账号。
- 数据现状：33 省共 124MB GeoJSON 按需加载；运行时禁用 124MB 全国合并文件。
- 存储现状：IndexedDB（存档 V1）+ localStorage（设置）+ 内存派生拓扑（惰性计算，刷新即失）。
- 正式数据 `data/` 字段由用户提供，保持原字段与含义；派生信息只放内存或独立文件。

数据缺口（对应 AGENTS.md 第 9 节已知边界）：

| # | 缺口 | 现状 |
|---|---|---|
| G1 | 限速 | V1 不生成虚构限速，HUD 显示"未配置" |
| G2 | 电气化 / 轨距 / 股道数 | 数据未包含 |
| G3 | 股道 / 站场 / 正线侧线 | 完全没有，站场区域靠最近线路近似 |
| G4 | 行别（上/下行） | 无法从数据判定，只显示地理方位 |
| G5 | 真实纵断面 | DEM 采样 ≠ 铁路路基纵断面，桥隧无模型；30×/50× 倍速下坡度滞后 |
| G6 | 车站补充字段 | 525 个 pending 车站无坐标；无铁路局/等级等属性 |
| G7 | 几何断点 | 江苏 1,722 个孤立端点未逐个核验 |
| G8 | 时刻表 / 站间关系 | 无 |

---

## 1. 存储层：开源数据库选型

### 1.1 结论

本项目**没有后端**，"选什么数据库"分三层看，最贴合的答案不是传统数据库：

| 层 | 场景 | 推荐 |
|---|---|---|
| A. 数据载体 | 124MB 分省 GeoJSON 的加载与查询 | **FlatGeobuf**（驾驶路径）/ **GeoParquet + DuckDB-WASM**（分析场景） |
| B. 浏览器内持久化 | 派生拓扑缓存、存档 | **SQLite WASM (OPFS)**；存档维持 IndexedDB 不动 |
| C. 后端 | 未来若加云存档/联机 | **PostGIS**（PostgreSQL 扩展） |

核心判断：**最值钱的是 A 层"换格式"，而不是引入数据库引擎。**

### 1.2 A 层：线路数据载体

严格说是"格式"而非数据库，但解决的正是"大文件、慢解析、按需读取"，且完全兼容 GitHub Pages 静态托管：

| 方案 | 特点 | 对本项目 |
|---|---|---|
| **FlatGeobuf** | 二进行式 + Hilbert R-tree，浏览器端 `@flatgeobuf/gis` 的 `deserialize(url, rect)` 靠 HTTP Range 只拉取视窗 bbox 内要素 | ★ 首选。与"列车周围按半径显示轨道、行驶 2.5 km 后台重绘"的模式天然吻合；无需服务器；体积缩数倍、免全量 JSON.parse |
| **GeoParquet** | 列式存储 + DuckDB/Arrow 生态，压缩收益最大 | 适合分析型查询（检查页全国统计）；配 DuckDB-WASM 浏览器内直接 SQL |
| PMTiles | Z/X/Y 瓦片归档 | 不适合要素级查询（Protomaps 官方说明），适合预渲染矢量瓦片底图或离线瓦片 |
| GeoPackage | OGC 标准 SQLite 单文件 | JS 生态弱，不优先 |

注意点：

- DuckDB-WASM 的 spatial 扩展可加载但社区实测不及原生完整；稳妥路径是 **Parquet 直读 + 前端算几何**（`src/utils/geo.ts` 已有全部米制几何工具）。
- 数据仍是 WGS84，换格式不影响现有 GCJ-02 显示副本流程。
- FlatGeobuf 依赖 HTTP Range 请求，GitHub Pages（Fastly CDN）需实测验证。
- 转换一次性完成：`ogr2ogr -f FlatGeobuf` 或 DuckDB `COPY TO`。

### 1.3 B 层：浏览器内嵌入式数据库

| 方案 | 持久化 | 评价 |
|---|---|---|
| **SQLite WASM**（官方构建） | OPFS（需 Worker） | ★ 嵌入式 SQL 首选。最现实用途：**持久化派生拓扑**（节点/边界/出口表），刷新后免重算 |
| DuckDB-WASM | OPFS（2026-09 官方支持） | 分析查询强，OLTP 弱 |
| PGlite（Postgres WASM） | IndexedDB（`idb://`）+ pgvector | 功能最全但 WASM 最重，本项目过度设计 |
| RxDB / PouchDB | IndexedDB 等 | 为多端同步而生，当前无后端用不上 |
| IndexedDB（现状） | — | 存档 V1 规模合适，**不迁移** |

### 1.4 C 层：未来若加后端

- **PostGIS**：开源空间数据库事实标准；自托管开源版 Supabase 可快速起步。
- **libSQL / Turso**：SQLite 开源分叉，可自托管，但原生空间能力弱。
- **CouchDB + RxDB/PouchDB**：离线优先多端同步。

### 1.5 痛点对应

| 痛点 | 建议 |
|---|---|
| GeoJSON 解析内存峰值大、按省加载 | FlatGeobuf 替换驾驶数据路径（bbox 流式） |
| 派生拓扑刷新即失 | 先试 IndexedDB 存派生表（带版本号失效机制）；不够再上 SQLite WASM+OPFS |
| 无离线瓦片缓存 | Cache API / PMTiles，不是 SQL 问题 |
| 存档 | IndexedDB 维持现状 |

---

## 2. 数据层：铁路数据补充来源

### 2.1 结论（缺口 → 来源）

| 缺口 | 首选补充来源 | 可行性 |
|---|---|---|
| G1 限速 / G2 电气化 / 轨距 | **OSM 原始标签重新提取**（maxspeed / electrified / gauge / tracks） | ★ 零新来源，现有管线小改 |
| G3 股道 / 站场 / 正线侧线 | **OSM 站场股道**（Overpass API，`service=yard/siding/spur` + `usage=main`） | 唯一公开来源，大枢纽覆盖较好 |
| G4 行别 / G8 时刻表 | **12306 系开源数据集**（chinese-railway-gtfs、Parse12306、grab12306） | 可用；许可灰色，走"脚本开源、数据自取" |
| G5 真实纵断面 | **Copernicus DEM GLO-30**（免费无限制） | 离线预采样可行；桥隧仍是边界 |
| G7 断点核对 | **天地图目录 1:100 万铁路层**（原 webmap.cn 已迁移至 mulu.tianditu.gov.cn） | 权威但粗，只做"此处是否有线"校验 |
| G6 无坐标车站 | OSM 站点节点 / 和鲸 3000 站数据集 / 高德 POI | 注意 GCJ-02/BD-09 → WGS84 转换方向 |

**核心判断：性价比最高的一步是"重新从 OSM 提取"——现有 GeoJSON 只保留 8 个字段，OSM 源头本就带着限速、电气化、轨距、股道用途标签，不引入任何新数据源即可补掉一半缺口。**

### 2.2 OSM 生态（现有数据同源增强，最便宜）

- 现有 `data/geojson` 只保留 `osm_id/layer/name/bridge/tunnel/fclass/code` 等字段；OSM 原始铁路要素还有：`maxspeed`（限速）、`electrified`（电气化及电压/频率）、`gauge`（轨距，套轨分号分隔）、`usage`（main/branch/industrial/military）、`service`（yard/siding/spur/crossover）、`tracks`（股道数）、`railway:ref`（线路编号）。
- 中国大陆标记规范：OSM Wiki《OpenRailwayMap/Tagging in China》（含高铁/普速/城轨约定）；[OpenRailwayMap](https://www.openrailwaymap.org) 可作"应填标签"对照。
- 提取途径：Overpass API 按省/按 osm_id 查询；Geofabrik 中国提取。
- 打包现成下载：HDX《Railways of China》（OSM 铁路线+车站点，开放许可）。
- **股道/站场**：国铁无官方开放数据，OSM 枢纽站内逐条数字化股道是唯一公开来源。
- 许可：ODbL，项目已在用，继续署名即可。
- 已知限制：中国区 `maxspeed/electrified` 填充率参差，高铁正线 maxspeed 常缺失，需人工或后处理兜底；缺失区段运行时仍如实显示"未配置"。

### 2.3 12306 系（时刻表、行别、车站）

| 项目 | 内容 | 价值 |
|---|---|---|
| chinese-railway-gtfs | 国铁 **GTFS 格式**时刻表：线路走向、车站名+坐标、时刻 | ★ 标准格式工具链现成；行别由车次经停顺序推定；站间时分反推平均速度上限 |
| Parse12306 | 12306 全国车次+电报码时刻表采集 | 全量车次采集常用工具 |
| grab12306 | 某日全量车站/车次/时刻 → JSON | 全量约 20–30 分钟 |
| TrainCrawler | 12306+火车票网车站/车次/余票 | 补充参考 |
| China-rail-way-stations-data | 12306 官方 JS 资源的车站+运行数据 | 与现有 stations.json（电报码）同源 |

⚠️ **合规**：12306 无官方开放数据许可，批量抓取属灰色地带。沿用本项目模式——**脚本进 `data/scripts`、数据文件不进仓库、由使用者自行生成**，界面/文档注明"时刻数据由 12306 生成，非官方授权"。

### 2.4 官方权威地理数据（交叉校验）

- 原 webmap.cn 已停用，数据下载迁移到**天地图目录服务系统**（mulu.tianditu.gov.cn）；**1:100 万公众版基础地理数据（2021）**免费注册下载，含全国铁路点/线要素，CGCS2000（与 WGS84 差异厘米级，本项目精度下可视为一致）。
- geodata.cn 亦有 1:100 万铁路 shp。
- 定位：比例尺太粗，**不能替代 OSM 几何**；价值在于核对孤立断点——"天地图有而 OSM 断了"是真实缺口，"两边都没有"是 OSM 误标。分发许可条款下载时确认。

### 2.5 高程 / 纵断面

- **Copernicus DEM GLO-30**：2020-12 起免费无限制，30 m，精度优于 SRTM（约 4 m vs 16 m）；AWS Open Data 批量拉取，OpenTopography 在线框选走廊下载。
- 用法：**离线沿线路预采样 DEM 生成"参考纵断面"数据集**，与运行时 Cesium 地形采样解耦——同时缓解"30×/50× 倍速下坡度滞后"边界。
- 边界不变：DEM 是地表（DSM，含植被建筑），不是路基纵断面；桥隧高程仍无真实模型。

### 2.6 无坐标车站（pending_stations 525 个）

- OSM `railway=station/halt` 节点（同源、许可干净，优先）。
- 和鲸社区 3000 站数据集（含铁路局、类别；**BD-09 需转 WGS84**，人工抽查后才可入库）。
- 高德/百度 POI API：有 key 可用但非开源许可；GCJ-02 逆转换已有 `gcj02.ts`，只用于校正源、不写显示坐标。

---

## 3. neo 分支开发路线（建议）

原则：正式 `data/` 不改；新数据进独立文件/目录；每步带验证。

1. **阶段一（数据扩充·零新来源）**：`data/scripts` 新增 OSM 标签增强脚本，为分省 GeoJSON 附加 `maxspeed/electrified/gauge/usage/service/tracks` 等字段，输出到独立目录（如 `data/geojson-enriched/`）；先试点江苏。运行时按增强字段渲染限速/电气化，缺失仍显示"未配置"。
2. **阶段二（行别与时刻）**：接入 12306 系生成器（GTFS 或 JSON），产出派生文件（不进正式 `data/`），用于行别推定与站间时分。
3. **阶段三（纵断面）**：Copernicus GLO-30 沿线预采样，生成参考纵断面，替换/补充运行时实时坡度采样。
4. **阶段四（加载优化）**：江苏试点 FlatGeobuf 加载路径，对比体积/解析时间/内存，再决定是否推 33 省；派生拓扑持久化先用 IndexedDB（版本号失效机制），二期评估 SQLite WASM+OPFS。
5. **穿插**：天地图 1:100 万核对断点；OSM 站点节点补 pending 坐标。

每阶段完成需更新 `AGENTS.md`（当前实现/已知边界/更新日志）并跑 `npm test` / `npm run build`。

---

## 4. 参考链接

**存储/格式**

- FlatGeobuf: <https://flatgeobuf.org> ；JS 指南 <https://guide.cloudnativegeo.org/flatgeobuf/flatgeobuf-in-js.html>
- PMTiles 适用边界: <https://protomaps.com/blog/you-might-not-want-pmtiles>
- SQLite WASM 持久化: <https://sqlite.org/wasm/doc/trunk/persistence.md> ；Chrome 介绍 <https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system>
- DuckDB-WASM 扩展: <https://duckdb.org/docs/2.0/clients/wasm/extensions.html> ；OPFS 持久化 <https://duckdb.org/2026/09/18/opfs-wasm.html>
- PGlite: <https://pglite.dev/docs/about>
- RxDB 对比: <https://rxdb.info/alternatives.html>
- PostGIS: <https://postgis.net> ；libSQL <https://github.com/tursodatabase/libsql>

**铁路数据**

- OSM Wiki 中国铁路标记: <https://wiki.openstreetmap.org/wiki/Zh-hans:OpenRailwayMap/Tagging_in_China>
- OpenRailwayMap: <https://www.openrailwaymap.org>
- HDX Railways of China: <https://data.humdata.org/dataset/hotosm_chn_railways>
- chinese-railway-gtfs: <https://github.com/wensimehrp/chinese-railway-gtfs>
- Parse12306: <https://github.com/metromancn/Parse12306> ；grab12306: <https://github.com/sjfkai/grab12306> ；TrainCrawler: <https://github.com/MogicianXD/TrainCrawler> ；China-rail-way-stations-data: <https://github.com/listenzcc/China-rail-way-stations-data>
- 天地图目录服务: <https://mulu.tianditu.gov.cn> ；geodata.cn: <https://www.geodata.cn>
- Copernicus DEM: <https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM> ；OpenTopography GLO-30 <https://portal.opentopography.org/raster?opentopoID=OTSDEM.032021.4326.3> ；AWS Open Data <https://registry.opendata.aws/copernicus-dem>
- 和鲸 3000 站数据集: <https://www.heywhale.com/mw/dataset/600555c17ed5ab0015f00244>
