#!/usr/bin/env node
/**
 * Guard the GitHub Pages artifact against the "raw Vite source" white screen.
 *
 * `dist/index.html` must be the built entry (hashed module + Cesium tags), never
 * the repository's source `index.html` with `/src/main.ts`. The Pages workflow
 * runs this after `vite build`; it also fails when data, media, Cesium runtime
 * files or the nested inspector entry are missing from the uploaded directory.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const errors = [];

async function requireFile(relative, minimumBytes = 0) {
  const path = resolve(dist, relative);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    errors.push(`缺少文件：dist/${relative}`);
    return null;
  }
  if (info.size < minimumBytes) {
    errors.push(`文件过小：dist/${relative}（${info.size} B < ${minimumBytes} B）`);
  }
  return readFile(path);
}

async function requireDirectory(relative) {
  const path = resolve(dist, relative);
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) {
    errors.push(`缺少目录：dist/${relative}`);
    return null;
  }
  return path;
}

function requireMatch(html, pattern, description) {
  if (!pattern.test(html)) errors.push(`构建入口不符合预期：${description}`);
}

const mainHtml = await requireFile('index.html', 500);
if (mainHtml) {
  const html = mainHtml.toString('utf8');
  if (html.includes('/src/main.ts')) {
    errors.push('dist/index.html 仍是 Vite 源码入口（/src/main.ts），不能发布到 GitHub Pages');
  }
  requireMatch(html, /<script[^>]+src="\.\/assets\/main-[^"]+\.js"/, '缺少 ./assets/main-*.js 构建产物');
  requireMatch(html, /href="cesium\/Widgets\/widgets\.css"/, '缺少 Cesium 样式');
  requireMatch(html, /src="cesium\/Cesium\.js"/, '缺少 Cesium 运行库');
}

const inspectorHtml = await requireFile('dev/railway-check/index.html', 200);
if (inspectorHtml) {
  const html = inspectorHtml.toString('utf8');
  if (/cesium/i.test(html)) errors.push('检查页仍注入 Cesium 标签');
  requireMatch(html, /src="\.\.\/\.\.\/assets\/railwayCheck-[^"]+\.js"/, '检查页缺少 ../../assets/railwayCheck-*.js');
}

await requireFile('.nojekyll');
await requireFile('cesium/Cesium.js', 1_000_000);
await requireFile('cesium/Widgets/widgets.css', 10_000);
await requireDirectory('cesium/Workers');
await requireDirectory('cesium/Assets');
await requireFile('data/stations.json', 100_000);
await requireFile('data/provinces_index.json', 1_000);
await requireFile('data/README.md');
await requireFile('media/index/04-trunk-lines.png', 100_000);

const geojsonDir = await requireDirectory('data/geojson');
if (geojsonDir) {
  const files = (await readdir(geojsonDir)).filter(name => name.endsWith('.geojson'));
  if (files.length !== 33) errors.push(`dist/data/geojson 应有 33 个省级文件，实际 ${files.length} 个`);
}

const mergedData = await stat(resolve(dist, 'data/cnrailway.geojson')).catch(() => null);
if (mergedData) errors.push('dist/data/cnrailway.geojson 不应进入运行包（体积过大）');

if (errors.length) {
  console.error('verify-dist: 失败');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('verify-dist: 通过（主应用构建入口、33 个省级数据、Cesium 资源、背景图与检查页入口完整）');
