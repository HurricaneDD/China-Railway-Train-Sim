# 国铁列车驾驶模拟器

Vue 3 + TypeScript + Vite + CesiumJS 的纯前端自由驾驶 demo，使用中国铁路分省地理数据。默认驾驶室前向视角，可切换外部视角；存档保存在浏览器本地。

## 本地运行

使用 Node.js 22 或兼容的新版本：

```bash
npm ci
npm run dev
```

```bash
npm test        # 核心逻辑测试
npm run build  # 类型检查、构建并复制运行数据
npm run preview
```

不要跨操作系统复用 node_modules。Cesium 子依赖通过 overrides 与锁文件固定兼容版本。地形和卫星影像通过 Cesium ion 后台加载，失败时可用基础地球继续并重试，公开前端运行配置位于 src/config.ts。

## 数据与部署

运行按需读取 data/geojson/ 下的 33 个分省文件，不读取全国合并文件。超过 GitHub 单文件限制的 data/cnrailway.geojson 不纳入 Git，已有本地副本不受影响。数据字段、来源和许可见 [data/README.md](data/README.md)。

仓库包含 GitHub Pages Actions 工作流。仓库设置中将 Pages Source 设为 GitHub Actions 后，推送 main 会触发构建部署。应用使用相对 base，支持仓库子路径。

## 线路人工检查

新增只读检查页 `dev/railway-check/`，按省读取当前正式 GeoJSON，用红色标出存在被过滤连接的断点、橙色标出邻近未接入、灰色标出孤立端点，并显示桥梁/隧道区段和弱连通分量。检查页可切换街道/卫星底图；底图采用 WGS84 基准的 Web Mercator（EPSG:3857），线路与断点按同一投影直接叠加，不做 GCJ-02 偏移。开发环境访问 `http://localhost:8062/dev/railway-check/`；生产构建输出 `dist/dev/railway-check/index.html`。详细说明见 [检查页 README](dev/railway-check/README.md) 和 [拓扑规则](docs/RAILWAY-TOPOLOGY.md)。

桥隧只由 OSM 标签 `bridge === 'T'` / `tunnel === 'T'` 识别，不做结构检测。2026-11-02 修正了共享端点因桥隧/`layer` 标签差异被误断的问题；江苏实测弱连通分量由 469 降至 100，但仍有站场尽端、原始缺口等孤立端点需要人工核查。

## 当前状态

Demo 0.2 开放全国已有数据的车站出发与地图选点，默认展示江苏。原始 GeoJSON 不修改；程序按原始共享位置续接，遇分岔主动选择。机车为 20×3.3×4.7 m 长方体，提供驾驶室与外部视角、编组跟随、驻车、暂停、保存恢复及导入导出。驾驶 HUD 支持 1× / 5× / 10× / 20× 模拟速度，便于人工检查线路；分岔和线路中断仍会暂停。

起步：松开驻车，用 Shift/Ctrl 或滑杆调整牵引；按住 Space 制动，松开后缓解。P/Esc 暂停，停稳后可换向。可以自由探索，也可完成“行驶 1 km 后停稳”的练习。

全国开放不代表每个任意路线均已验收。地形不是铁路纵断面，站房等仍为平面影像，车辆和道床为简化表现。具体检查结果与边界见 [Demo 验收记录](docs/DEMO-ACCEPTANCE-2026-11-02.md)。

开发前阅读 [AGENTS.md](AGENTS.md)，详细审查见 [项目审查报告](docs/PROJECT-AUDIT-2026-11-01.md)。
