/** Reproducible headed browser checks via the installed Playwright CLI skill; no Playwright test runner. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const wrapper = process.env.PLAYWRIGHT_CLI_WRAPPER ?? join(homedir(), '.codex/skills/playwright/scripts/playwright_cli.sh');
const url = process.env.TERRAIN_LAB_URL ?? 'http://localhost:8063/dev/terrain-lab/';
const folder = resolve('output/playwright/terrain-lab');
mkdirSync(folder, { recursive: true });
const log = [];
function cli(...args) {
  const output = execFileSync(wrapper, ['--session', 'terrain-lab-check', ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  log.push(output); writeFileSync(join(folder, 'browser-check.log'), log.join('\n'));
  if (output.includes('### Error')) throw new Error(output);
  return output;
}
cli('open', url, '--headed'); cli('resize', '1440', '900'); cli('snapshot');

// This function runs in Playwright CLI's Node sandbox; app data is read only inside page.evaluate.
async function check(page) {
  const folder = ARTIFACT_FOLDER;
  const pauseFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function save(name, value) {
    const pending = page.waitForEvent('download');
    if (value === undefined) await page.getByRole('button', { name: '导出证据 JSON' }).click();
    else await page.evaluate(data => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'lab-evidence.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, value);
    await (await pending).saveAs(`${folder}/${name}.json`);
  }
  await page.waitForFunction(() => window.terrainLab?.evidence().sampleCount === 501);
  const environment = await page.evaluate(() => {
    const gl = window.terrainLab.viewer.scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      viewport: { width: innerWidth, height: innerHeight }, visibility: document.visibilityState };
  });
  await save('environment', environment);
  for (const [value, name] of [['raw', 'A'], ['smooth', 'B'], ['replace', 'C']]) {
    await page.getByRole('combobox', { name: /对比/ }).selectOption(value); await pauseFrame();
    await page.screenshot({ path: `${folder}/synthetic-${name}-final.png` });
  }
  await page.getByRole('button', { name: '驾驶员眼点' }).click(); await pauseFrame();
  await page.screenshot({ path: `${folder}/synthetic-driver-eye.png` });
  await page.getByRole('button', { name: '外部视角' }).click();
  await page.evaluate(async () => await window.terrainLab.stress());
  await page.evaluate(async () => await window.terrainLab.tour());
  const synthetic = await page.evaluate(() => window.terrainLab.evidence());
  if (synthetic.renderErrors.length || synthetic.tourResult.beforeEntities !== synthetic.tourResult.afterEntities || synthetic.ownedPrimitiveCount !== 5) throw new Error('synthetic rendering/resource check failed');
  await save('synthetic-evidence');

  await page.getByRole('combobox', { name: /数据/ }).selectOption('world');
  await page.waitForFunction(() => !document.getElementById('source').disabled, undefined, { timeout: 85000 });
  const world = await page.evaluate(() => window.terrainLab.evidence());
  if (world.source !== 'world') throw new Error(`World terrain unavailable: ${JSON.stringify(world.loadErrors)}`);
  await page.getByRole('slider', { name: /里程/ }).fill('3230');
  for (const [value, name] of [['raw', 'A'], ['smooth', 'B'], ['replace', 'C']]) {
    await page.getByRole('combobox', { name: /对比/ }).selectOption(value); await pauseFrame();
    await page.screenshot({ path: `${folder}/world-tunnel-${name}-final.png` });
  }
  await page.evaluate(async () => await window.terrainLab.stress());
  await page.evaluate(async () => await window.terrainLab.tour());
  await save('world-evidence-final');

  // Reproduce the CURRENT owning-source interpolation and slope sampling formula, separately from our fitter.
  const baseline = await page.evaluate(async () => {
    const { RailNetwork } = await import('/src/data/railway.ts');
    const { ElevationService } = await import('/src/core/elevation.ts');
    const index = await (await fetch('/data/provinces_index.json')).json();
    const network = new RailNetwork(async path => await (await fetch(`/data/${path}`)).json());
    await network.loadProvince(index.provinces.find(p => p.adcode === '320000'));
    const data = window.terrainLab.exportData(), elevation = new ElevationService();
    elevation.setProvider(window.terrainLab.viewer.terrainProvider);
    const vertices = [...new Set(data.samples.map(p => p.segmentId))].flatMap(id => network.segments.get(id).points);
    const started = performance.now(); await elevation.sample(vertices);
    const unknown = vertices.filter(p => !elevation.hasHeight(p)).length;
    if (unknown) throw new Error('incomplete original vertex sampling');
    const samples = data.samples.map(p => {
      const segment = network.segments.get(p.segmentId), span = Math.min(150, segment.length / 2);
      const ahead = Math.max(0, Math.min(segment.length, p.offset + span * p.direction));
      const behind = Math.max(0, Math.min(segment.length, p.offset - span * p.direction));
      return { ...p, currentRailHeight: elevation.railHeight(segment, p.offset),
        currentSessionGradePermille: (elevation.railHeight(segment, ahead) - elevation.railHeight(segment, behind)) / Math.abs(ahead - behind) * 1000 };
    });
    return { baseCommit: '9c4abd0', method: 'unmodified ElevationService.railHeight + exact refreshSlope span/clamping formula; no production driving UI run',
      sampleMs: performance.now() - started, sourceVertices: vertices.length, unknownVertices: unknown,
      maxAbsCurrentSessionGradePermille: Math.max(...samples.map(p => Math.abs(p.currentSessionGradePermille))), samples };
  });
  await save('current-production-profile', baseline);
  // Shader clipping does not change the terrain provider's heights.
  const query = await page.evaluate(() => {
    const data = window.terrainLab.exportData(), p = data.samples[323];
    return { mode: data.mode, mileage: p.s, originalSampleHeight: data.rawProfile[323].h, inferredRailHeight: data.fittedProfile[323].h,
      globeHeightAfterClipping: window.terrainLab.viewer.scene.globe.getHeight({ longitude: p.lon * Math.PI / 180, latitude: p.lat * Math.PI / 180, height: 0 }),
      note: 'getHeight may refer to loaded LOD and still reports original terrain, not replacement mesh' };
  });
  await save('clipping-height-query', query);

  // A fresh page removes the cached provider. Abort the provider request and check atomic fallback.
  await page.route('https://api.cesium.com/**', route => route.abort());
  await page.reload();
  await page.waitForFunction(() => window.terrainLab?.evidence().sampleCount === 501);
  const before = await page.evaluate(() => window.terrainLab.evidence());
  await page.getByRole('combobox', { name: /数据/ }).selectOption('world');
  await page.waitForFunction(() => !document.getElementById('source').disabled, undefined, { timeout: 25000 });
  const failure = await page.evaluate(() => window.terrainLab.evidence());
  if (failure.source !== 'synthetic' || !failure.loadErrors.length || failure.renderErrors.length || failure.raw.maxHeight !== before.raw.maxHeight) throw new Error('failure fallback corrupted provenance or scene');
  await save('network-failure', failure);
  await page.unroute('https://api.cesium.com/**');
}
const code = check.toString().replace('ARTIFACT_FOLDER', JSON.stringify(folder));
cli('run-code', code);
console.log(`Browser checks completed. Evidence: ${folder}`);
