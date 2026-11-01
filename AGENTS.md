# AGENTS.md — 国铁列车驾驶模拟器

> **从今往后，每次开始开发前，请你先读取 AGENTS.md，了解项目内容和文件结构。若要对该应用做出修改，修改后，请你在 AGENTS.md 中添加相关说明。**
>
> 修改代码时必须同步更新本文的“当前实现”“已知边界”或“更新日志”，避免文档与实际代码脱节。

## 1. 项目概况

- 中文名：国铁列车驾驶模拟器。
- 英文名：China-Railway-Train-Sim。
- 目标：在真实中国铁路地理数据上运行可驾驶列车，而不是静态地图演示。
- 架构：Vue 3 + TypeScript + Vite + CesiumJS 的纯前端静态应用。
- 运行与存档均在浏览器本地完成；无后端、无账号、无云数据库、无 Cookie 进度。
- 部署目标：GitHub Pages 仓库子路径。Vite `base` 为 `./`，不硬编码仓库名。
- 当前版本：V1（首次完整实现），首次开发日期 2026-11-01。

## 2. 开发命令与依赖

要求 Node.js 22 或兼容的新版本。

```bash
npm install       # 安装项目依赖
npm run dev       # Vite 开发环境
npm run build     # vue-tsc 类型检查 + Vite 构建 + 复制运行数据
npm test          # Vitest 核心逻辑测试
npm run preview   # 本地预览 dist，仅用于开发验证
```

主要版本：

| 依赖 | 版本 |
|---|---|
| Vue | 3.5.13 |
| CesiumJS | 1.127.0 |
| Vite | 6.1.0 |
| TypeScript | 5.7.3 |
| vite-plugin-cesium | 1.2.23 |
| Vitest | 3.0.5 |

启动修复后通过 `package.json.overrides` 固定 Cesium 子依赖为 `@cesium/engine 15.0.0`、`@cesium/widgets 11.0.0` 和 `@zip.js/zip.js 2.7.57`，并同步锁文件。避免 widgets 引入另一套 engine，以及新版 ZIP 包取消旧导出路径导致 Vite 开发模式失败。跨系统复制项目后使用 `npm ci`，不要复用其他系统的 `node_modules`。

2026-11-01 构建验证使用系统临时目录中的便携版 Node 22.14.0 / npm 10.9.2，未修改系统 Node 配置。已生成 `package-lock.json`，并完成 `npm install`、`npm run build`、`npm test` 和 `dist/` 静态浏览器验证，结果见第 8 节。

## 3. 文件结构

```text
China-Railway-Train-Sim-Kimi/
├─ index.html                    页面入口与中文元信息
├─ package.json                  脚本和固定版本依赖
├─ package-lock.json             可复现依赖锁文件，Actions 使用 npm ci
├─ tsconfig.json                 TS/DOM/路径别名配置
├─ vite.config.ts                Vue/Cesium、相对 base、开发数据中间件、构建复制
├─ AGENTS.md                     本说明，后续开发必读
├─ .github/workflows/deploy.yml  GitHub Pages 自动构建部署
├─ data/                         用户提供的正式数据，保持原字段和含义
│  ├─ README.md                  数据权威说明
│  ├─ stations.json              有坐标车站及 pending_stations
│  ├─ provinces_index.json       33 个分省文件索引
│  ├─ geojson/                   按需加载的正式分省线路
│  ├─ cnrailway.geojson          全国合并文件，浏览器和构建均不使用
│  └─ scripts/                   数据生成/自检脚本，不进入运行包
├─ src/
│  ├─ main.ts                    Vue 启动
│  ├─ App.vue                    页面流程、键盘、存档和模块协调
│  ├─ config.ts                  ion Token、车辆、物理、拓扑、相机等集中参数
│  ├─ types.ts                   原始数据、派生拓扑、运行状态、存档类型
│  ├─ style.css                  黑白扁平化界面、荧光绿状态色和响应式布局
│  ├─ components/
│  │  ├─ MapView.vue             Cesium 生命周期
│  │  ├─ StartMenu.vue           开始/继续/设置入口
│  │  ├─ NewGamePanel.vue        车站搜索、地区选择、地图选点
│  │  ├─ DrivingHud.vue          速度、坡度、制动、黏着、换向等 HUD
│  │  ├─ JunctionDialog.vue      必须主动选择的分岔弹窗
│  │  ├─ SavePanel.vue           读取、删除、导入、导出和手动保存
│  │  └─ SettingsPanel.vue       设置、键位说明、数据来源与许可
│  ├─ data/
│  │  ├─ stations.ts             车站读取、筛选、搜索、pending 处理
│  │  └─ railway.ts              分省加载、GeoJSON 适配、空间索引、派生拓扑
│  ├─ core/
│  │  ├─ session.ts              固定步长循环、线路推进、分岔、编组路径历史
│  │  ├─ dynamics.ts             与 Cesium 解耦的一维纵向动力学
│  │  ├─ elevation.ts            Cesium 地形采样、缓存、坡度估计
│  │  ├─ storage.ts              IndexedDB 存档、localStorage 设置、V1 校验
│  │  └─ audio.ts                Web Audio 合成鸣笛，可独立替换
│  ├─ map/
│  │  ├─ CesiumMap.ts            地球、影像、地形、站点、相机与地图拾取
│  │  ├─ RailRenderer.ts         双钢轨和批量轨枕 Primitive
│  │  └─ TrainRenderer.ts        浅绿机车、深绿车厢、位置与朝向回调
│  └─ utils/
│     ├─ assets.ts               GitHub Pages 兼容的数据 URL 与 fetch
│     └─ geo.ts                  米制距离、方位角、线段投影、里程插值、轨距偏移
└─ tests/
   ├─ geo.test.ts                线段投影和里程
   ├─ dynamics.test.ts           制动、惯性、坡度、黏着与撒砂
   └─ storage.test.ts            错误存档拒绝
```

## 4. 核心实现方法

### 4.1 数据流与加载

1. 启动仅并行读取 `stations.json` 和 `provinces_index.json`。
2. 选站或选省后才加载对应 `geojson/<adcode>-<省份>.geojson`；同一省份的并发请求复用 Promise。
3. 运行时不读取 `cnrailway.geojson`，构建也不复制该文件及数据脚本。
4. 列车靠近省界时，以周边车站所属省份发现相邻省份并最多预载两个；成功加载的省份进入同一派生拓扑。
5. 轨道只在当前位置周围按设置半径显示；行驶距上次绘制中心超过 2.5 km 时后台重绘，不阻塞物理循环。

### 4.2 铁路适配与派生拓扑

- 默认保留 `properties.code === 6101`；仅当 `code` 缺失时以 `fclass === 'rail'` 补充。
- 逐个解析 `MultiLineString` 的每个 part，绝不把不连续 part 拼成一条线。
- 保留 `osm_id/layer/name/bridge/tunnel/province`；`bridge/tunnel` 仅在字符串严格等于 `T` 时为真。
- 以 `(osm_id, layer)` 去重；同一个 Feature 的各 part 使用不同派生区段 ID。
- 原始文件不添加节点字段。程序内部生成 `node-*` 节点和 `<adcode>:<feature>:<part>` 区段 ID。
- 端点使用米制距离容差（默认 2 m），并要求 `layer/bridge/tunnel` 一致，避免把地面、高架、隧道直接连通。
- 节点记录全部关联区段；排除来路后只有一个后续区段时自动续行，多个后续区段才是分岔。
- 端点连接容差是几何近似，不是真实铁路联锁或信号系统。

### 4.3 最近点、车站与地图选点

- `utils/geo.ts` 在局部等距近似平面上计算点到**每个折线线段**的投影，再转为 WGS84 经纬度。
- 最近结果包含派生区段 ID、区段里程、投影点和偏差距离；不是最近顶点吸附。
- 地图选点最大吸附 5 km；车站最大吸附 2.5 km。超阈值明确失败，不随机传送。
- `pending_stations` 可检索但禁用出发按钮，不赋予 `(0,0)` 或任何虚构位置。
- Cesium 始终使用 `longitude/latitude` 和 GeoJSON 的 `[lon,lat]`；`*_gcj02` 不参与三维地图。

### 4.4 列车运动与编组跟随

- 当前位置由 `segmentId + offset + direction` 表示，动力学不依赖长方体模型。
- 有符号速度决定沿区段前进或后退；跨节点时根据共享端点重设新区段方向和里程。
- 分岔预告距离 120 m，距节点 35 m 时冻结运行推进并显示选项；玩家选择前没有默认分岔路径。
- 每次实际移动记录路线历史和累计里程。每节车厢按“机车中心距离 + 车钩间距 + 车辆半长”在历史路径上回溯取值，因此过弯时逐节转向。
- 历史保留最近 2,500 m，超出后裁剪；区段衔接沿用同一累计里程。

### 4.5 驾驶动力学

`core/dynamics.ts` 使用固定 1/60 秒步长，与渲染帧率无关。整列车质量为机车和全部车厢之和。

- 牵引：手柄比例 × 最大牵引力 × 随速度下降的简化曲线，再受黏着上限约束。
- 黏着：默认系数 0.20，仅机车质量计入黏着质量；需求超限时显示“黏着不足”。撒砂仅在此时有效，8 秒内增加 0.12。
- 制动：按住空格时指令以 25 个百分点/秒增长，4 秒到 100%；松开按独立 4 秒行程释放。实际制动力再追随指令，列车管压力简化为 `600 - 1.7 × 实际制动百分比` kPa。
- 合力：有符号牵引力 − 制动阻力 − Davis 型运行阻力 − 坡道重力分力。
- 坡度：地形采样前后点高差/水平里程，正值为当前行驶方向上坡。
- 换向：仅绝对速度 ≤ 0.5 km/h；切换时速度清零，不用换向制造瞬间反向。
- 限速：保留车辆/线路扩展空间，但 V1 不生成全国虚构限速，HUD 显示“未配置”。

键位：Shift/Ctrl 牵引增减（55 ms 重复、每次 1%）、Space 制动、H 鸣笛、X 撒砂。HUD 也提供鼠标和触摸控件。

### 4.6 Cesium 场景

- Vue 侧使用 `shallowRef<CesiumMap>` 保存地图实例，不深度代理 Cesium Viewer、地形 provider 和内部四叉树，避免原始对象与代理对象混用破坏引用一致性。
- `createWorldTerrainAsync` 加载 ion 地形，`createWorldImageryAsync` 加载卫星影像。
- 高程使用 `sampleTerrainMostDetailed`，每批最多 100 点并缓存；失败时保留已有高度/零高度降级，不每帧请求。
- 轨道中心线两侧按 1.435 m 轨距偏移生成钢轨；每 12 m 生成简化轨枕。
- 钢轨和轨枕分别合批为 Cesium `Primitive`，不是每根轨枕一个 Entity；单轮轨枕上限 1,800。
- 轨道显示高度有微小偏移，动力学使用未加显示偏移的采样高程。
- 机车与车厢是独立 Entity，但位置和朝向由共享会话回调更新。
- 默认第一人称驾驶室：视点沿机车朝向前移 7 m、轨面上方 3.2 m，使用近水平视线，平滑转向并关闭地图自由拖动；驾驶室中隐藏占位编组模型，显示轻量窗框、雨刷和驾驶台。参数集中在 config.ts。
- HUD 顶栏可切换外部视角；第三人称首次进入使用配置的斜向角度，避免继承选站地图的垂直俯视角。外部视角支持左键旋转、滚轮缩放、35–900 m 距离限制和地形最低高度修正。
- `lookAt` 会建立目标点局部参考系；地形修正得到的世界坐标必须通过 `worldToCameraCoordinatesPoint` 转回该参考系后再写入 `camera.position`，防止相机瞬移和渲染中断。

### 4.7 存档与设置

- IndexedDB 数据库 `china-railway-train-sim`，对象仓库 `saves`，主键 `id`。
- V1 存档包含名称、时间、位置、区段、里程、方向、速度、牵引、制动、管压、编组、累计时间及真实路线历史 `routeHistory`；恢复时沿用该历史，避免车厢瞬移或堆叠。
- 自动存档每 30 秒及切换后台时执行，固定 ID `autosave`；不依赖 `beforeunload` 异步写入。
- 手动保存生成独立 ID；导入先检查版本、必要字段、所有驾驶数值、路线历史、数值范围和换向值，再写入。
- 导出为单个 JSON 文件；删除需用户在界面确认。
- `localStorage` 只存音效、自动保存、相机距离和轨道显示范围。

## 5. GitHub Pages 构建与部署

1. 仓库 GitHub Settings → Pages → Source 选择 **GitHub Actions**。
2. 推送 `main` 或手动运行 `Deploy to GitHub Pages` workflow。
3. workflow 使用 Node 22 和锁文件缓存，执行 `npm ci --no-audit --no-fund` 与 `npm run build`，上传 `dist`。
4. `base: './'` 让应用可部署在 `/<仓库名>/`，`assets.ts` 通过 `document.baseURI + import.meta.env.BASE_URL` 解析数据地址。
5. `vite-plugin-cesium` 负责 Cesium Workers/Assets/Widgets 等静态资源；不得只复制 JS 而漏掉这些文件。
6. 自定义 Vite 插件仅复制 `stations.json`、`provinces_index.json`、`geojson/` 和数据说明，并生成 `.nojekyll`。
7. 不启用历史路由，刷新不存在服务端路由回退问题。
8. 已生成并保留 `package-lock.json`；Actions 使用 `npm ci` 和 setup-node 的 npm 缓存，依赖变化时须同步更新锁文件。

## 6. Cesium ion Token

Token 集中在 `src/config.ts` 的 `APP_CONFIG.cesiumIonToken`，初始化时赋给 `Ion.defaultAccessToken`。这是纯前端应用的公开运行时配置，不能视作服务端秘密。若更换 Token，需允许 GitHub Pages 域名并确认有卫星影像和地形权限。

## 7. 开发踩坑与必须遵守的约束

| 问题 | 当前处理 / 后续注意 |
|---|---|
| 全国 GeoJSON 约 124 MB，解析可能占 1.5–2 GB | 永远不要把它放进启动流程或默认构建资源；按省加载。 |
| 车站原始坐标含 GCJ-02，Cesium 使用 WGS84 | 禁止二次坐标转换；正式字段已校正。 |
| `MultiLineString` 含多个不连续 part | 每 part 独立成区段，不能只读第一段或全部拼接。 |
| `bridge: 'F'` 在 JS 中仍是 truthy | 必须严格比较 `'T'`，不可 `Boolean(raw.bridge)`。 |
| 经纬度固定差值不是全国统一米制容差 | 节点和吸附均用实际米制距离。 |
| 二维相交不一定连通 | 端点连接同时校验 layer、bridge、tunnel；不能只按空间相交建边。 |
| 同名线路不代表同一要素 | 去重使用 osm_id + layer，不按名称删除。 |
| 车站和 OSM 线路无外键 | 每次选站动态求最近线段，失败要明示；不得虚构关联字段。 |
| 无坐标车站 | 独立标记、只检索，不上图、不选为出生点。 |
| 大量轨枕 Entity 会造成渲染压力 | 使用批量 Primitive 和数量/距离上限。 |
| 地形采样异步且可能失败 | 采样集中管理、缓存、分批；不要在每帧物理循环中请求。 |
| 帧率会直接改变列车速度 | 物理采用固定步长和帧差上限，渲染只读取状态。 |
| 相机 `lookAt` 会改变相机参考框架 | 自由飞行前先恢复 `Matrix4.IDENTITY`，跟随期间保留用户朝向。 |
| 在 `lookAt` 后直接写入世界坐标导致相机抽搐 | `camera.position` 使用当前参考系坐标；世界坐标修正值必须先用 `worldToCameraCoordinatesPoint` 转换，不得直接赋值。 |
| GitHub Pages 子路径和中文文件名 | 使用相对 base 和标准 URL 编码，不拼接硬编码根路径。 |
| Actions 的 npm 缓存通常要求 lockfile | 已提交 `package-lock.json`，使用 `npm ci` 并启用 setup-node 的 npm 缓存；依赖变化时同步更新锁文件。 |
| 浏览器关闭时 IndexedDB 异步保存不可靠 | 周期自动保存、后台保存和手动导出共同保障。 |

## 8. 数据检查结果

2026-11-01 使用现有 Python 执行：

```bash
D:/APPS/miniconda3/python.exe data/scripts/verify_outputs.py
```

结果：全部通过。

- 有坐标车站 2,879 条，无坐标 525 条。
- 电报码重复 0，字段缺失 0，坐标越界 0。
- WGS84/GCJ-02 偏移中位 543 m，最大 677 m。
- 分省 GeoJSON 33 个，Feature 合计 324,634，省份标注一致。
- 全国合并文件 Feature 324,045，几何均为 MultiLineString。
- 原始数据未作任何修改。

### 构建与静态部署验证

2026-11-01 使用便携版 Node 22.14.0 / npm 10.9.2 实际执行：

- `npm install`：成功，生成 `package-lock.json`。
- `npm run build`：`vue-tsc` 类型检查和 Vite 构建通过，成功生成 `dist/`。
- `npm test`：3 个测试文件、7 个 Vitest 用例全部通过。
- `dist/` 共 414 个文件，约 136.48 MB；包含 33 个分省 GeoJSON 及完整 Cesium Workers/Assets/Widgets，不包含 `data/cnrailway.geojson`。
- 使用同一个 Python 静态服务器直接托管 `dist/`，浏览器验证开始页、Cesium 初始化、新游戏面板、搜索“广州南”、选择 `IZQ 广州南` 并进入驾驶 HUD 均成功，浏览器控制台无错误。
- 上述验证针对本地静态部署产物，不等同于已在远程 GitHub Pages 实际发布。

## 9. 当前已知边界（不是已完成能力）

- 派生拓扑基于几何端点近似，不包含真实道岔联锁、信号、站场股道或调度。
- 相邻省份发现依赖附近车站提示；没有车站覆盖的省界附近可能需后续增加显式省份邻接表。
- 已加载省份会保留在当前会话内；`maxCachedProvinces` 参数尚预留，未实现内存压力下的自动卸载。
- 地形高程不等于真实铁路纵断面，桥梁和隧道高程也未做专用模型。
- 编组采用固定演示车辆参数；存档保留编组字段，但尚未开放不同车型和编组编辑器。
- 鸣笛使用 Web Audio 合成，不依赖外部音频文件；后续可在 `audio.ts` 替换机车专属音效。
- 第一版没有真实车辆模型、站房、站台、真实空气制动和限速报警，符合需求范围。
- 驾驶室目前为 CSS 前景与真实三维前向相机的组合，不是精细三维机车内饰；外部车型仍是长方体占位。沿用地形/卫星影像，站房与桥梁等不会成为真实立体场景，轨道高程和连通性仍受前述数据边界影响。
- 早期静态浏览器验证处于 `hidden` 状态。启动修复后已在可见开发浏览器确认进入广州南驾驶、物理时间和里程推进、牵引与制动输入有效，并在本次观察中推进约 166 米；不代表持续驾驶通过。地图选点、换向、分岔、保存恢复、导入导出及长时间稳定性仍待完整回归。
- 当前开发范围收缩为“启动可靠、可以进入驾驶并观察基础输入”。路网拓扑、编组历史、倒车跨节点、坡度及其他审查项保留为后续工作，详见 `docs/PROJECT-AUDIT-2026-11-01.md`，本轮不新增玩法或重构这些模块。

## 10. 后续开发流程

1. 先读本文件和 `data/README.md`，再读相关模块。
2. 不修改正式数据字段、坐标和含义；派生信息只放内存或独立存档。
3. 修改物理时保持其不依赖 Cesium/Vue，并补 Vitest。
4. 修改数据结构时更新存档版本及迁移/校验，不让错误导入覆盖有效存档。
5. 修改部署配置后检查仓库子路径、中文 GeoJSON URL 和 Cesium 静态资源。
6. 修改 UI 后实际测试：开始新游戏、车站出发、地图选点、牵引/制动/换向、分岔、保存恢复、导入导出。
7. 完成后在下方更新日志追加日期、变更和验证结果；发现新限制同步更新第 9 节。

## 11. 更新日志

### 2026-11-01 — V1 首次开发

- 建立 Vue 3、TypeScript、Vite、CesiumJS 静态工程和 GitHub Pages Actions。
- 接入全国车站、分省索引与 33 个分省 GeoJSON 的按需加载。
- 实现站名/全称/电报码/旧称搜索、省市筛选、pending 禁用、车站与地图选点吸附。
- 实现 MultiLineString 全量解析、国铁过滤、分层端点拓扑、连续区段续行和主动分岔选择。
- 实现双钢轨、批量轨枕、地形高程、坡度、浅绿机车、深绿车厢与曲线编组跟随。
- 实现固定步长动力学、牵引曲线、制动 4 秒施加/释放、惯性、阻力、坡道、换向、鸣笛、黏着和撒砂。
- 实现第三人称相机、完整中文黑白 HUD、开始页、选区选站、设置和响应式布局。
- 实现 IndexedDB 自动/手动存档、恢复、删除、V1 JSON 导入导出和 localStorage 设置。
- 增加几何、动力学、存档校验 Vitest 用例。
- 正式数据自检全部通过；便携版 Node 环境下构建、7 个 Vitest 用例及 `dist/` 静态浏览器基础流程验证通过。
- 代码复查修正：列车朝向回调返回 Quaternion、运行中按里程增量绘制轨道、无 lockfile 的 Actions 安装方式、初始化失败时安全销毁 Viewer。
- 静态审查修正：Viewer 创建前访问 terrainProvider 的启动阻断、恢复存档立即预载邻省、路线历史随存档恢复、换向保留编组历史、短区段沿唯一来路回溯、全部 HUD 数值的存档校验、相机距离设置即时生效。
- 参数与显示修正：基础黏着系数调整为 0.20，使黏着不足和撒砂实际可触发；可见编组历史补采样地形高度；快速按 Shift/Ctrl 立即改变 1%，长按再按固定间隔重复；继续游戏会应用已保存的观察距离。
- 实际构建修正：补齐设置与最近距离的可变数值类型，适配 Cesium 1.127 的 `terrainProvider`、`ColorGeometryInstanceAttribute`、`PolylineColorAppearance` 和 `CallbackPositionProperty` API；修正制动测试的四秒目标值。
- 生成并保留 `package-lock.json`，GitHub Actions 改用 `npm ci` 和 npm 缓存；静态产物经实际 HTTP 托管验证可运行。

### 2026-11-01 — 相机抖动修复

- 复现进入驾驶后画面剧烈跳动及 Cesium `Rendering has stopped` 错误，定位为地形最低高度修正把 ECEF 世界坐标直接写入 `lookAt` 局部参考系下的 `camera.position`。
- 修正 `CesiumMap.follow`：先构造修正后的世界坐标，再用 `worldToCameraCoordinatesPoint` 转为当前相机参考系坐标，保留地形防穿透能力。
- `npm run build` 与全部 7 项 Vitest 用例通过；在浏览器中对广州南和新疆线路分别执行连续 600 个物理/相机跟随步，未出现非有限坐标或异常跳变。完整可见浏览器中的长时间驾驶和其他 UI 金路径仍按第 9 节待验证。

### 2026-11-01 — 运行与实施审查（未修改应用代码）

- 审查报告见 `docs/PROJECT-AUDIT-2026-11-01.md`，区分已复现故障、静态审查风险和待验收能力。
- macOS arm64 发现随目录携带的 Windows node_modules 导致权限/原生模块错误；保留锁文件执行 npm ci 后，build 和现有 7 项测试通过，但 dev 仍因 zip.js 2.24.0 不导出 zip-no-worker.js 而退出，不能继续以 build 成功代表开发环境可运行。
- 可见浏览器日志出现 TileAvailability rectangles 异常和 Rendering has stopped；独立 Cesium/Vue 对照实验复现深度代理混用原始引用导致同类异常，App.vue 的 ref<CesiumMap> 应优先改为非深度响应式实例，并完成项目内 A/B 回归。
- 真实广东数据拓扑审查发现大量桥隧/层级标签不同的同坐标断端候选；不能把严格属性一致连接规则当作已验证路网。
- 核心脚本复现车厢路线历史不持续追加及倒车跨区段错误；分岔回调绑定、坡度符号、轨道地形采样、存档事务完成等仍需修复/回归。以上均为当前已知问题，不是已完成修复。

### 2026-11-01 — 缩小范围并恢复开发启动

- 按用户要求仅处理开发启动与 Cesium 实例边界：固定兼容的 engine/widgets/zip.js 子依赖，更新 package-lock.json；App.vue 地图引用改为 shallowRef。
- macOS Node 24.19.0 / npm 11.17.0 下，Vite 开发服务器成功启动并实际提供页面、Vue 模块和分省数据；npm run build 与全部 7 个现有测试通过。
- 可见浏览器完成开始新游戏、搜索广州南、进入驾驶和牵引/空格制动输入检查，确认物理时间与里程推进；读取地图和 Viewer 均非 Vue 深度代理，观察期间 Cesium 渲染循环保持启用、无错误面板。
- 启动修复不包含网络失败降级及全部审查项；可见浏览器累计推进约 65 秒仿真时间、166 米里程，无渲染中止，但尚未通过连续驾驶或全部 UI 金路径验收。

### 2026-11-01 — 默认驾驶室视角

- 用户反馈驾驶画面为俯视矩形后，针对表现层调整：默认使用朝线路前方的第一人称相机，驾驶室隐藏长方体占位编组；增加窗框、驾驶台、雨刷及桌面/手机仪表布局。
- 顶栏增加驾驶室/外部视角切换；第三人称首次进入不再沿用地图俯视角。此次未修改动力学、正式数据、路网或存档结构。
- build 与全部 7 项现有测试通过；可见浏览器从广州南进入驾驶，确认驾驶室 pitch 约 -0.07 rad、占位车体显示数为 0、渲染循环正常；实际检查视角切换、牵引与空格制动，以及 390×844 手机布局。截图位于 output/playwright/cab-desktop.png 与 cab-mobile.png。
- 此轮为驾驶视角和轻量驾驶台，不代表精细车型、真实轨旁环境或长距离驾驶验收完成。

### 2026-11-01 — 推送 GitHub 仓库

- 将本地目录接入 HurricaneDD/China-Railway-Train-Sim，保留远端 main 原有历史和许可证，补充 README 运行说明。
- Git 排除 node_modules、dist、浏览器调试日志、output 及超过 GitHub 单文件限制且不参与运行的 data/cnrailway.geojson；正式 33 个分省数据与车站/索引继续纳入版本控制，本地全国合并文件保留。
- 本次仅整理版本控制与文档，运行验证沿用本轮构建、7 项测试及可见浏览器驾驶检查；远端 Actions/Pages 状态需以推送后的实际结果为准。
