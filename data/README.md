# 交付说明 · 国铁车站资料与分省铁路线路数据

本目录是基于 `CRTrainRoute-main`（中国铁路算路器，OSM 铁路网几何 + 12306 车站资料）整理后的**交付数据集**，可直接用于列车驾驶模拟器的线路、车站初始化。

- 整理日期：2026-10-28
- 坐标参考系：**WGS84 / EPSG:4326**（十进制经纬度），车站与线路完全同一套坐标系，可直接叠加
- ⚠️ 注意基准来源不同：**线路**源自 OSM，本就是 WGS84；**车站**源自 12306 接口，原始为 **GCJ-02**，交付时已反算为 WGS84（原始值另存 `*_gcj02` 字段）。实测依据见 2.5 节
- 全部文件均为 UTF-8 无 BOM 编码

---

## 一、目录结构

```
outputs/
├─ README.md                 本说明
├─ stations.json             车站资料（标准化后，单一 JSON，856 KB）
├─ provinces_index.json       分省线路清单（省份、adcode、要素数、文件大小）
├─ cnrailway.geojson          全国铁路线路合并文件（324,045 条要素，124 MB）
├─ geojson/                   分省线路 GeoJSON（33 个文件，125 MB）
│   ├─ 110000-北京市.geojson
│   ├─ 330000-浙江省.geojson
│   ├─ 150000-内蒙古自治区.geojson
│   ├─ 540000-西藏自治区.geojson
│   ├─ 230000-黑龙江省.geojson
│   └─ … 共 33 个，按行政区划代码升序
└─ scripts/                   生成与自检脚本（可复现，仅用 Python 标准库）
    ├─ build_stations.py      由原始 stations.json + station_names.json 生成交付版
    ├─ build_geojson.py       分省标注、另存、合并为 cnrailway.geojson
    ├─ check_datum.py         坐标基准探测（判定 WGS84 / GCJ-02，需 numpy + scipy）
    └─ verify_outputs.py      交付物结构与字段自检
```

---

## 二、`stations.json` —— 车站资料

### 2.1 规模

| 项目 | 数量 |
|---|---|
| 车站记录（含经纬度） | **2,879** 条 |
| 仅站名、暂无坐标 | 525 条（`pending_stations`） |
| 覆盖省级行政区 | 32 个（澳门无国铁车站；台湾源数据未涉及） |
| 地级行政区 | 352 个 |

### 2.2 结构

```json
{
  "type": "station_dataset",
  "metadata": { "station_count": 2879, "fields": { … } },
  "stations": [
    {
      "telecode": "IZQ",
      "name": "广州南",
      "full_name": "广州南站",
      "province": "广东省",
      "city": "广州市",
      "city_raw": "广州市",
      "address": "广东省广州市番禺区南站北路",
      "longitude": 113.263758,
      "latitude": 22.991130,
      "longitude_gcj02": 113.269078,
      "latitude_gcj02": 22.988395
    }
  ],
  "pending_stations": [
    { "telecode": "COE", "name": "重庆东" }
  ]
}
```

### 2.3 字段说明

| 字段 | 含义 | 说明 |
|---|---|---|
| `telecode` | **电报码** | 12306 车站电报码（3 位大写字母），全表唯一，可作主键 |
| `name` | **标准化站名** | 去掉“站”字后缀的官方简称，如 `广州南`、`香港西九龙` |
| `full_name` | **站名**（全称） | 含“站”字，如 `广州南站` |
| `province` | 省级行政区 | 全称，如 `内蒙古自治区` |
| `city` | **城市** | 统一到地级行政区并补齐后缀（`哈尔滨市`），直辖市/特别行政区取自身 |
| `city_raw` | 原始城市名 | 12306 返回的原值，保留便于溯源对比 |
| `address` | **具体地址** | 12306 车站地址原文，含区县与道路门牌 |
| `longitude` | **经度** | **WGS84**，十进制度，保留 6 位小数，与线路数据同基准 |
| `latitude` | **纬度** | **WGS84**，十进制度，保留 6 位小数，与线路数据同基准 |
| `longitude_gcj02` | 经度（GCJ-02） | 12306 接口原始值，等价于原坐标系；**高德/腾讯底图直接打点用这个** |
| `latitude_gcj02` | 纬度（GCJ-02） | 同上 |
| `name_alt` | 另一写法 | **仅 36 条**改名/异名车站出现，如 `引镇`（旧称 `西安南`） |
| `province_inferred` / `city_inferred` | 补齐标记 | **仅 3 条**地址缺失车站出现，表示由城市名或邻近车站反推 |

### 2.4 整理规则（做了什么）

1. **站名标准化**：以 12306 站名库（`station_names.json`）为准去除“站”字，得到 `name`；同时保留原始 `full_name`。两者不一致的 36 条以 `name_alt` 标出旧称，便于做别名匹配。
2. **省份识别**：从 `address` 前缀匹配 34 个省级行政区全称/简称，识别成功率 2,876/2,879。
3. **城市标准化**：原始 `city` 混用了“哈尔滨 / 南充 / 澄迈县 / 涞水县”等不同层级写法。现按“地址前缀 → 地级行政区”重新推导并补齐后缀，统一为 `XX市 / XX自治州 / XX地区 / XX盟`；直辖市与特别行政区直接取省名；海南省等省直辖县级单位保留县级原名。
4. **缺失补齐**：3 座车站 12306 未返回地址（乐平北、南昌东、吴家川），省份按“同名城市反查 → 最近 3 站投票”补齐，并置 `province_inferred` 标记，不静默修改。
5. **排序**：按 `telecode` 升序，保证多次生成结果稳定可 diff。
6. **坐标基准校正**：12306 接口返回的是 **GCJ-02（火星坐标）**，而 OSM 线路是 WGS84，两者在中国境内相差 300–700 m。交付前已逐点反算为 WGS84，原始值保留在 `*_gcj02` 字段。判定过程见下节。

### 2.5 坐标基准实测（为什么必须做 GCJ-02 反算）

不能靠字段声明或直觉判断，用 OSM 线路几何做参照物实测：车站就在线路旁边，**同一基准下车站到最近线路顶点的距离应只有几十米；不同基准则会出现几百米的系统性偏移**。

以 2879 座车站对 168 万个线路顶点求最近距离，三种假设的结果：

| 假设 | 距离中位数 | 均值 | P90 | <100 m 占比 |
|---|---|---|---|---|
| 原样（当作 WGS84） | 343 m | 368 m | 617 m | 12.6% |
| **按 GCJ-02 反算成 WGS84** | **103 m** | **186 m** | **394 m** | **49.1%** |
| 按 WGS84 再正转 GCJ-02 | 616 m | 635 m | 1100 m | 6.8% |

- 反算后 **78.6%** 的车站更贴近线路，中位距离降到 1/3；
- 分省一致（黑龙江 360→50 m、广东 442→66 m、西藏 271→51 m、香港 171→24 m），仅新疆因 GCJ 偏移本身仅 ~100 m 而改善有限（168→155 m）；
- 方向检验：原样假设下车站相对线路的平均位移为 **东 +177 m / 北 −48 m**，与 GCJ-02“东偏为主”的特征吻合；反算后降为 **东 +3 m / 北 −1 m**，系统性偏移消失；
- 位移向量与该点理论 GCJ 偏移量的相关性，反算后由 r≈0.14/0.29 降至 r≈0（斜率 0.38/0.43 → −0.04/0.01）。

旁证：源项目 `index.html` 把线路几何做了 `wgs84ToGcj02` 转换后上图，但站点点位 `position: [st.lon, st.lat]` 直接放到高德底图 —— 说明作者默认车站已是 GCJ-02。

> 复测方法：`python outputs/scripts/check_datum.py`（需 numpy + scipy）。交付后运行，"原样"一栏应为最优、平均位移趋近 0。

### 2.6 用法示例

```python
import json
d = json.load(open('outputs/stations.json', encoding='utf-8'))

# 电报码查站
by_code = {s['telecode']: s for s in d['stations']}
print(by_code['BJP'])          # 北京站

# 站名查站（兼容“广州南”“广州南站”两种写法）
def find(name):
    name = name.rstrip('站')
    return [s for s in d['stations'] if s['name'] == name]

# 按省份/城市筛选
gd = [s for s in d['stations'] if s['province'] == '广东省']

# 选哪套坐标：
#   与线路/OSM/离线仿真叠加 -> s['longitude'], s['latitude']            (WGS84)
#   在高德/腾讯底图上打点   -> s['longitude_gcj02'], s['latitude_gcj02'] (GCJ-02)
```

---

## 三、`geojson/` —— 分省线路数据

### 3.1 命名规则

`<行政区划代码>-<省级行政区全称>.geojson`，例如 `330000-浙江省.geojson`、`150000-内蒙古自治区.geojson`。
省份信息**三重标注**（任一方式都能识别）：

1. 文件名（`330000-浙江省`）
2. 顶层字段 `name`（`浙江省`）与 `province` 对象（`adcode / name / short_name / type`）
3. **每条 feature 的 `properties.province`**（合并或裁剪后仍不丢失省份归属）

### 3.2 文件结构

```json
{
  "type": "FeatureCollection",
  "name": "浙江省",
  "province": { "adcode": "330000", "name": "浙江省", "short_name": "浙江", "type": "省" },
  "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },
  "features": [
    {
      "type": "Feature",
      "properties": {
        "province": "浙江省",
        "osm_id": "7370291",
        "code": 6101,
        "fclass": "rail",
        "name": "沪昆线",
        "layer": 0,
        "bridge": "F",
        "tunnel": "F"
      },
      "geometry": { "type": "MultiLineString", "coordinates": [ [ [120.1964688, 30.3175903], … ] ] }
    }
  ]
}
```

### 3.3 属性字段

| 字段 | 含义 |
|---|---|
| `province` | 所属省级行政区全称（本次新增） |
| `osm_id` | OSM 原始航线要素 ID，跨文件唯一性可用于去重 |
| `code` | 线路类别代码（6101 国铁正线、6102 城市轨道等） |
| `fclass` | 要素类别：`rail` 铁路、`light_rail` 轻轨/地铁、`subway` 等 |
| `name` | 线路名称（`沪昆线`、`京广高速线`…），部分为空 |
| `layer` | 上下层关系（-1 地下 / 0 地面 / 1 高架），可用于立交分层 |
| `bridge` / `tunnel` | 是否为桥（`T`）/ 隧道（`F` 表示否），模拟器可用于切换桥梁隧道场景 |

几何类型全部为 `MultiLineString`：`coordinates[i][j] = [经度, 纬度]`。

### 3.4 各省规模

| 代码 | 省份 | 要素数 | 代码 | 省份 | 要素数 |
|---|---|---|---|---|---|
| 110000 | 北京市 | 11,986 | 420000 | 湖北省 | 12,649 |
| 120000 | 天津市 | 6,191 | 430000 | 湖南省 | 13,030 |
| 130000 | 河北省 | 28,535 | 440000 | 广东省 | 17,057 |
| 140000 | 山西省 | 14,430 | 450000 | 广西壮族自治区 | 9,190 |
| 150000 | 内蒙古自治区 | 14,293 | 460000 | 海南省 | 1,825 |
| 210000 | 辽宁省 | 12,311 | 500000 | 重庆市 | 7,265 |
| 220000 | 吉林省 | 5,103 | 510000 | 四川省 | 13,969 |
| 230000 | 黑龙江省 | 13,834 | 520000 | 贵州省 | 9,791 |
| 310000 | 上海市 | 5,416 | 530000 | 云南省 | 9,386 |
| 320000 | 江苏省 | 12,325 | 540000 | 西藏自治区 | 1,551 |
| 330000 | 浙江省 | 11,070 | 610000 | 陕西省 | 11,975 |
| 340000 | 安徽省 | 8,240 | 620000 | 甘肃省 | 9,741 |
| 350000 | 福建省 | 8,488 | 630000 | 青海省 | 3,464 |
| 360000 | 江西省 | 9,840 | 640000 | 宁夏回族自治区 | 2,069 |
| 370000 | 山东省 | 16,994 | 650000 | 新疆维吾尔自治区 | 8,519 |
| 410000 | 河南省 | 11,969 | 810000 | 香港特别行政区 | 2,063 |
|  |  |  | 820000 | 澳门特别行政区 | 65 |

合计 **324,634** 条要素、约 240 万个坐标顶点。逐文件精确数值见 `provinces_index.json`。

---

## 四、`cnrailway.geojson` —— 全国合并文件

- 33 个省级单元合并为**单个 FeatureCollection**，324,045 条要素（124 MB）
- 顶层保留 `provinces` 数组（各省 adcode、名称、要素数），便于前端做省份列表
- 每条 feature 带 `properties.province`，用一行即可按省筛选
- **去重说明**：合并时按 `(osm_id, layer)` 去重，仅剔除 **589** 条在相邻省份文件中重复出现的同一 OSM 要素（跨省边界线被两侧同时收录）。因此合并文件比"分省文件要素之和 324,634"少 589 条，属预期行为；若需要与分省文件逐条一致，可用 `python scripts/build_geojson.py --keep-dup` 重新生成。

**读取建议**：文件较大，直接 `json.load` 约需 1.5–2 GB 内存。

```python
import json
d = json.load(open('outputs/cnrailway.geojson', encoding='utf-8'))   # 内存充足时
zj = [f for f in d['features'] if f['properties']['province'] == '浙江省']
```

内存受限时按行流式读取，或直接按省加载 `geojson/` 下的单省文件（最大的河北省仅 10 MB）。

命令行按省抽片（需 jq）：

```bash
jq -c '{type:"FeatureCollection",features:[.features[]|select(.properties.province=="浙江省")]}' \
   outputs/cnrailway.geojson > 浙江省.geojson
```

---

## 五、数据说明与已知问题

1. **台湾省无数据**：源仓库 `data/geojson/` 未提供 `710000`，故分省文件与合并文件均缺台湾省，`provinces_index.json` 的 `metadata.missing` 中已声明。
2. **青海省源文件名易误读**：源文件名为 `630000-西宁.geojson`，但 `630000` 是**青海省**代码（西宁为其省会），因此交付文件命名为 `630000-青海省.geojson`，内容为青海全省线路。同理 `620000-甘肃`、`640000-宁夏`、`650000-新疆` 等带中文后缀的源文件已按 adcode 正确归位。
3. **525 座车站只有站名、没有坐标**：这些是 12306 站名库中存在、但地址接口未返回坐标的车站（多为新线、城际或已停办车站），单独放在 `pending_stations`，**未混入** `stations`，避免模拟器出现坐标 (0,0) 的假站点。
4. **3 座车站缺地址**：乐平北（LKG）、南昌东（NUG）、吴家川（WCJ），其 `address` 为 `null`，省份为推断值并带 `*_inferred` 标记。
5. **坐标系提醒**：交付数据统一为 **WGS84**（车站已由 GCJ-02 反算），与 GeoJSON 线路同基准，可直接叠加。
   - 用 OpenStreetMap、Mapbox、Cesium、QGIS、CARLA/UE 等：直接用，无需转换。
   - 用高德 / 腾讯 / 百度底图：线路需 WGS84 → GCJ-02 正向转换（源项目 `index.html` 里的 `wgs84ToGcj02` 可直接复用）；而车站可直接取 `longitude_gcj02` / `latitude_gcj02` 两个字段，省一次转换。注意百度是 BD-09，还需再转一层。
   - 别把已转换的 `longitude` 再送进 `wgs84ToGcj02`，那是二次偏移。
6. **线路与车站非强关联**：车站坐标来自 12306 地址接口，线路来自 OSM 几何，二者无外键关系。做"车站吸附到线路"时，建议以坐标最近点匹配（源项目 `server.py` 中的 snap 逻辑即为此思路，吸附偏移量通常 50–200 m）。
7. **`fclass` 含城市轨道**：源数据按省级行政区切分，包含地铁/轻轨要素（如澳门 65 条多为轻轨）。只要国铁正线时，用 `properties.code == 6101` 或 `fclass == 'rail'` 过滤。

---

## 六、重新生成

脚本只依赖 Python 3.9+ 标准库，无需安装第三方包。在项目根目录（`CRTrainRoute-main` 的上一级）执行：

```bash
python outputs/scripts/build_stations.py    # 生成 stations.json（约 3 秒，含坐标基准反算）
python outputs/scripts/build_geojson.py     # 生成 geojson/ 与 cnrailway.geojson（约 20 秒）
python outputs/scripts/verify_outputs.py    # 自检：字段完整性、坐标范围、省份标注、基准偏移量
python outputs/scripts/check_datum.py       # 可选，坐标基准探测（需 numpy + scipy，约 15 秒）
```

脚本默认从 `CRTrainRoute-main/data/` 读取原始数据，输出固定写入 `outputs/`，可重复执行；`build_geojson.py` 支持 `--keep-dup` 保留跨省重复要素。

最近一次自检结果：

```
[stations.json] 记录 2879 条，无坐标 525 条，字段缺失 0 条，坐标越界 0 条，电报码重复 0 个
  WGS84 与 GCJ-02 偏移：中位 543 m，最大 677 m（应全部 > 0 且 < 1000 m）
[分省 geojson] 33 个文件，要素合计 324634，省份标注全部一致
[cnrailway.geojson] 要素 324045 条，覆盖省份 33 个，几何类型 {'MultiLineString': 324045}
  要素最多的省份：河北省 28427，广东省 17044，山东省 16965
结论：全部通过
```

---

## 七、数据来源与许可

- 车站资料：12306 车站地址接口（经 `CRTrainRoute-main/data/stations.json`、`station_names.json` 汇总）
- 线路几何：OpenStreetMap 铁路数据（按省级行政区切分，经 `CRTrainRoute-main/data/geojson/` 提供）
- 源项目：CRTrainRoute（MIT License，见 `CRTrainRoute-main/LICENSE`）
- OSM 数据遵循 **ODbL 1.0**，二次分发与衍生作品需保留相同许可并署名 OpenStreetMap 贡献者。
