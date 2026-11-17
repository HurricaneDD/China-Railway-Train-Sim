# 铁路地形与默认建模：实验结果

日期：2026-11-17（Asia/Shanghai）。本轮完成研究原型与测试，供 GLM5.3 Flash 开发使用；没有把原型接入正式驾驶逻辑。

## 结论与可交付物

“独立铁路纵断面 + 局部地形替换”在本机 Cesium 1.127 中可以工作；直接把它应用到所有铁路会错误处理隧道。实际最显著的高程差位于已有 tunnel 标签的区段，不能把它认定为卫星扫描鼓包。默认车辆的转向架、轮轴、车窗和车顶结构可以用少量共享几何建立，比长方体更容易辨认，但正式车型、轮轨精度和材质仍需要后续实现。

- 开发任务与接口要求：[GLM 交接说明](GLM53FLASH-DEVELOPMENT-HANDOFF.md)。
- 独立原型：`dev/terrain-lab/`；原始线路提取脚本：`scripts/terrain-lab-route.ts`。
- 自动逻辑测试：`tests/terrain-lab.test.ts`。
- 可复跑浏览器检查：`scripts/terrain-lab-browser-check.mjs`。
- 本报告生成器：`scripts/terrain-lab-report.py`。
- 数值原件、截图、环境与质量门禁：`output/playwright/terrain-lab/`；输出目录在 Git 中忽略，但包含在交接 ZIP 内。

## 基线和工作区

仓库：[HurricaneDD/China-Railway-Train-Sim](https://github.com/HurricaneDD/China-Railway-Train-Sim)。本轮 fetch 后远端 drive 为 `9c4abd0`。原目录当前 main 为 `f3a5324`，未切换或改写。本轮在独立工作树 `../China-Railway-Train-Sim-terrain-lab`、分支 `codex/terrain-lab-20261117` 完成；实验内容尚未提交、推送或合并。

正式 `src/`、`data/` 和 V1 存档未修改。现有默认构建保持实验入口关闭；仅设置 `CRTS_TERRAIN_LAB=1` 时把原型编入多页面产物。Vite 另为实验嵌套页修正 Cesium 资源相对 URL；tsconfig 包含实验 TS 以进行类型检查。

## 样本与测量方法

- 从正式江苏 GeoJSON 派生 5,000 m 测试路径，跨 6 个区段，每 10 m 取一点，共 501 点；没有改原坐标。
- 抽样标签：255 点 bridge、42 点 tunnel、204 点普通；它们是 OSM 属性，不是经现场确认的结构清单。
- 测试路径遇到一个多出口位置，实验脚本选择最直的有效出口，并写入 `route.json.choices`；该策略不参与正式驾驶，不代表真实行别/站场/运营路线。
- 轨面方向按测试路径组织。原型拟合整条路径，保持 250 m 分块接缝使用同一全局高程。
- 地表横断面每 20 m 一排、每排 8 点，加上中心线共 2,509 个查询点。在线请求四路并发、每批 100 点。
- 人工源为解析函数：2‰ 基础坡道上叠加高 22 m 的高斯鼓包，用来证明算法面对明确异常时的行为，不当作真实地形观察。
- 真实源为本机现有 ion 访问下的 Cesium World Terrain 在线采样。原型不下载卫星影像，使用自绘网格贴图便于观察几何。
- 当前项目基线另复用未修改的 ElevationService：采样六个原始区段的 48 个顶点，再用 railHeight 及 refreshSlope 原有跨度/端点截断公式计算。它是 owning source 的数值复现，不是完整驾驶 UI 或网络延迟行为验收。

## 量化结果

| 测量 | 人工鼓包 | 在线真实地表 |
|---|---:|---:|
| 10 m 地表采样最大局部坡度 | 414.26‰ | 513.26‰ |
| 实验拟合后最大局部坡度 | 35.00‰ | 35.00‰ |
| 最大高程修正 | 16.08 m | 45.11 m |
| 拟合后相邻坡度最大变化（10 m 间隔） | 38.65‰ | 69.75‰ |
| 本次采样耗时 | 1 ms | 5174 ms |
| 本次 501 点拟合耗时 | 3.7 ms | 3 ms |

当前生产高程代码复现的最大坡度输入为 **84.85‰**，48 个原始顶点均有有效采样。不要将表内地表的 513.26‰ 写成主程序 HUD 或动力学的实测最大值：采样点、跨度和插值方法不同。

真实最大高程修正位于测试里程 **3230 m**，区段 `320000:485:0`，`tunnel=true`，WGS84 `118.76334039, 31.95673538`：

- 地表高程 80.201 m。
- 实验推定轨面 35.087 m。
- 差值 45.114 m。

这个结果支持“需要隧道独立轨面”的判断，不证明该山体的 DEM 是错的，也不证明拟合后的轨面就是实际隧道标高。

## 实际画面对比

人工源：

- [A：轨道跟着鼓包爬升](../output/playwright/terrain-lab/synthetic-A-final.png)。
- [B：只修轨面，列车/线路被地形遮挡](../output/playwright/terrain-lab/synthetic-B-final.png)。
- [C：裁剪冲突地形并补地面，线路重新可见](../output/playwright/terrain-lab/synthetic-C-final.png)。
- [驾驶员眼点检查](../output/playwright/terrain-lab/synthetic-driver-eye.png)，只检查观察位置；实验没有完整 CabRenderer 内饰。

在线真实地形的隧道位置：

- [A：按地表生成线路](../output/playwright/terrain-lab/world-tunnel-A-final.png)。
- [B：降低轨面但山体保留](../output/playwright/terrain-lab/world-tunnel-B-final.png)。
- [C：统一走廊裁剪把山体打开，属于错误处理示范](../output/playwright/terrain-lab/world-tunnel-C-final.png)。

截图只是这些视点的证据，不是所有视角、LOD 或全线视觉通过。初版 C 的边界出现黑色细缝，2 m 网格覆盖余量改善了本场景；端盖、任意跨块/跨线接缝仍未验收。外部相机低角度还可能被走廊外的山坡遮住，必须把遮挡与轨面错误区分。

## 物理、查询与几何的经验

1. 对人工鼓包，使用现有 60 Hz 动力学、沿里程前后各 150 m 求坡度、不传陡坡辅助状态的 180 s 对照中，最大坡道力从 254,829.94 N 降到 88,814.05 N，约下降 65.15%。但末里程从 7,164.30 m 变为 7,162.10 m，略少约 2.21 m。平滑重新分配上/下坡的重力作用，不能要求“跑得更快”才算通过。这个物理对照的轨面是人工解析样本，不是上述原始顶点生产代码复现。
2. 若把 250 m 块分别拟合并锁定端点，鼓包顶点作为块端点会把错误保留下来；本次切到 1,000–1,250 m 时还会因端点差过大而使 35‰ 约束无解。先建立连续 profile，再切渲染块。
3. 当前 fitter 是“中值 + 三角权重平滑 + 相邻坡度约束”的小原型，仍是折线纵断面；最大坡度达标不能替代竖曲线平顺性要求。
4. 裁剪后，测试点的 `globe.getHeight` 为 80.185 m，原在线采样为 80.201 m，实验轨面为 35.087 m。shader 裁剪不修改源网格高程查询；正式坡度应读取自己的 profile。
5. 本机支持 WebGL 2 clipping polygons。实验使用 58 m 半宽裁剪、60 m 半宽补面，只证明这段局部替换可显示。普通路基、桥梁和隧道必须有不同策略，不能全国固定宽度削地。
6. 嵌套实验页最初因 `cesium/` 相对地址读取到 HTML，出现 image decode/JSON parse 和 Rendering has stopped；修正页内资源基址、构建注入的相对路径后通过。以后新增嵌套 Cesium 工具页也要单独检查 Workers/Assets。
7. 源切换采用采样、拟合全部成功后再提交 provider 和数据；失败时保留此前场景。`requestedSource` 与实际 `source` 分开记录，防止把旧人工数据错标为真实地形。

## 资源、性能与失败测试

- 两种源各完成 12 轮 raw/smooth/replace 切换，Entity 数量均维持 29；末态自有 Primitive 为 5、裁剪多边形为 1，新 Primitive 已 ready。
- 各完成 202 个采样视点的 5 km 前进/返回巡检。人工源 p95 帧间隔约 31.3 ms，真实源约 34.6 ms。
- 该巡检每个视点重建示意车辆，包含实验开销，且完整 5 km 几何已提前建立；不能据此宣称生产流式加载达到同样性能，也不能推断手机或长时间 GPU 内存无泄漏。
- 对新页面的 ion provider 请求主动断网：请求失败被捕获，`source=synthetic`、`requestedSource=world`，原 501 点数据和场景保留；应用渲染错误为 0。此用例覆盖 provider 连接失败，不等于已穷尽每种单瓦片失败/采样超时。
- 真实源、人工源和失败回退的最终记录中应用渲染错误均为 0。浏览器有 favicon.ico 404，不属于应用渲染错误。
- 可见 Chrome，GPU：ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)；视口 1440×900；硬件 Apple M5 / arm64。浏览器 User-Agent 的 Intel 字样不代表机器是 Intel。
- 使用实验开启构建后的静态预览，在 `/rail-lab/dev/terrain-lab/` 实际切换 C 模式并读取 Cesium Assets，返回 200；该测试覆盖仓库子路径和嵌套实验页。另打开 `/rail-lab/` 检查正式主页启动，不代表完整驾驶金路径回归。

## 自动验证与复跑

基线：24 文件、146 项测试通过，普通生产构建成功。实验后：25 文件、152 项测试通过；`CRTS_TERRAIN_LAB=1 npm run build` 类型检查和构建成功。另执行普通 `npm run build`，确认实验页不进入默认产物。

```bash
# 在实验工作树/正确基线中；新机器先 npm ci
npx vite-node scripts/terrain-lab-route.ts
npm test
CRTS_TERRAIN_LAB=1 npm run build
npm run dev -- --port 8063
# 另一个终端，需安装 Playwright CLI skill 对应包装脚本与 Chrome
node scripts/terrain-lab-browser-check.mjs
# 包装脚本路径可通过 PLAYWRIGHT_CLI_WRAPPER 指定
# 实验地址可通过 TERRAIN_LAB_URL 指定（完整 browser-check 需要 dev 下的 /src 模块）
npm run preview -- --port 8064 --base /rail-lab/
# 浏览器访问 http://localhost:8064/rail-lab/dev/terrain-lab/ 做子路径检查
python3 scripts/terrain-lab-report.py
```

报告生成器读取已有 evidence，不替代浏览器测试。首次复跑要先导出/生成 `production-subpath.json`；交接包已包含本次文件。在线地形、缓存冷热和浏览器前后台会改变耗时，以新导出的 JSON 为准。逻辑测试依赖人工源，避免在线服务漂移导致随机失败。

## 明确没有完成的能力

- 连续竖曲线、官方/实测纵断面、真实桥面标高与隧道埋深。
- 保留山体的完整隧道洞体、桥墩/桥面及正确的多线路场地整合。
- 把 profile 接入生产 GameSession、RailRenderer、SceneryManager、编组历史和 CabRenderer。
- 正式车辆资产、轮轨接触精度、车轮滚动、悬挂及生产 LOD。
- 真实轨旁建筑/站场、PBR 资产库和离线地形管线。
- 全国流式加载、1×/30×/50×生产驾驶验收、长时间内存趋势、真实手机、远端 Pages。

本轮成果用于选路和暴露风险，后续开发责任与验收矩阵见交接说明。
