# 国铁列车驾驶模拟器

Vue 3 + TypeScript + Vite + CesiumJS 的纯前端驾驶原型，使用中国铁路分省地理数据。默认驾驶室前向视角，可切换外部视角；存档保存在浏览器本地。

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

不要跨操作系统复用 node_modules。Cesium 子依赖通过 overrides 与锁文件固定兼容版本。地形和卫星影像需要访问 Cesium ion，公开前端运行配置位于 src/config.ts。

## 数据与部署

运行按需读取 data/geojson/ 下的 33 个分省文件，不读取全国合并文件。超过 GitHub 单文件限制的 data/cnrailway.geojson 不纳入 Git，已有本地副本不受影响。数据字段、来源和许可见 [data/README.md](data/README.md)。

仓库包含 GitHub Pages Actions 工作流。仓库设置中将 Pages Source 设为 GitHub Actions 后，推送 main 会触发构建部署。应用使用相对 base，支持仓库子路径。

## 当前状态

目前为开发原型：已验证开发启动、构建、7 个核心测试、进入驾驶及基础输入。驾驶室为轻量界面和三维前向相机，外部车辆仍为占位模型。路网连通、编组跟随、倒车跨节点等存在已知缺陷，尚未完成长距离驾驶验收。

开发前阅读 [AGENTS.md](AGENTS.md)，详细审查见 [项目审查报告](docs/PROJECT-AUDIT-2026-11-01.md)。
