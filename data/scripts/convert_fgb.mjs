#!/usr/bin/env node
// convert_fgb.mjs — 增强分省 GeoJSON → FlatGeobuf（体积与解析双优化）。
//
// 输入：data/enriched/geojson/<adcode>-<省>.geojson（enrich_osm_tags.py 产物）
// 输出：data/enriched/fgb/<adcode>-<省>.fgb（同文件名，R-tree 内建）
//
// flatgeobuf 4.x 的 serialize 按“全部特征”推导列集合，逐特征缺省的键会落空列，
// 不会串列；转换后用 --verify 抽样反序列化核对特征数与属性键。
//
// 用法：
//   node data/scripts/convert_fgb.mjs                 # 全部已生成的增强文件
//   node data/scripts/convert_fgb.mjs --verify        # 转换并抽样校验
//   node data/scripts/convert_fgb.mjs --only 320000   # 只转某省

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, deserialize } from 'flatgeobuf/geojson';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = resolve(root, 'data/enriched/geojson');
const destDir = resolve(root, 'data/enriched/fgb');

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

mkdirSync(destDir, { recursive: true });

const names = readdirSync(srcDir).filter(name => name.endsWith('.geojson') && (!only || name.startsWith(only)));
let totalJson = 0;
let totalFgb = 0;

for (const name of names) {
  const source = resolve(srcDir, name);
  const json = JSON.parse(readFileSync(source, 'utf8'));
  // flatgeobuf 的列集合由特征集推导，逐特征独有的键若不先对齐会被整列丢弃：
  // 先求全部特征的属性键并集，缺失键统一补 null（运行时 null/undefined 等价处理）。
  const unionKeys = new Set();
  for (const feature of json.features) {
    for (const key of Object.keys(feature.properties ?? {})) unionKeys.add(key);
  }
  for (const feature of json.features) {
    feature.properties ??= {};
    for (const key of unionKeys) {
      if (!(key in feature.properties)) feature.properties[key] = null;
    }
  }
  const bytes = serialize(json);
  const dest = resolve(destDir, name.replace(/\.geojson$/, '.fgb'));
  writeFileSync(dest, bytes);
  const jsonSize = readFileSync(source).length;
  totalJson += jsonSize;
  totalFgb += bytes.length;
  const ratio = jsonSize > 0 ? (bytes.length / jsonSize).toFixed(2) : 'n/a';
  process.stdout.write(`${name}: ${jsonSize} -> ${bytes.length} bytes (${ratio}x)\n`);

  if (verify) {
    const iterator = deserialize(new Uint8Array(bytes));
    let count = 0;
    let propsChecked = 0;
    for await (const feature of iterator) {
      count += 1;
      const original = json.features[count - 1];
      if (original?.properties && feature.properties) {
        for (const [key, value] of Object.entries(original.properties)) {
          const got = feature.properties[key];
          // FGB 列的缺省值是 null；undefined 与 null 视为一致。
          if ((value === undefined || value === null) ? !(got === undefined || got === null) : got !== value) {
            process.stderr.write(`属性不一致 ${name} #${count - 1} ${key}: ${JSON.stringify(value)} != ${JSON.stringify(got)}\n`);
            process.exitCode = 1;
          }
        }
        propsChecked += 1;
      }
    }
    if (count !== json.features.length) {
      process.stderr.write(`特征数不一致 ${name}: ${count} != ${json.features.length}\n`);
      process.exitCode = 1;
    }
    process.stdout.write(`  verify: ${count} features, ${propsChecked} properties checked\n`);
  }
}

if (totalJson > 0) {
  process.stdout.write(`total: ${totalJson} -> ${totalFgb} bytes (${(totalFgb / totalJson).toFixed(2)}x)\n`);
} else {
  process.stdout.write('没有可转换的增强 GeoJSON 文件\n');
}
