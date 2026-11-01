import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import cesium from 'vite-plugin-cesium';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function railwayData(): Plugin {
  const files = ['stations.json', 'provinces_index.json', 'geojson'];
  return {
    name: 'railway-data',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/data/')) return next();
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const relative = pathname.slice('/data/'.length);
        if (relative.includes('..')) return next();
        const file = resolve(__dirname, 'data', relative);
        try {
          const { createReadStream } = await import('node:fs');
          const { stat } = await import('node:fs/promises');
          const info = await stat(file);
          if (!info.isFile()) return next();
          res.setHeader('Content-Type', file.endsWith('.geojson') || file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream');
          createReadStream(file).pipe(res);
        } catch {
          next();
        }
      });
    },
    async closeBundle() {
      for (const file of files) {
        const target = resolve(__dirname, 'dist/data', file);
        await mkdir(resolve(target, '..'), { recursive: true });
        await cp(resolve(__dirname, 'data', file), target, { recursive: true });
      }
      await cp(resolve(__dirname, 'data/README.md'), resolve(__dirname, 'dist/data/README.md'));
      await writeFile(resolve(__dirname, 'dist/.nojekyll'), '');
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [vue(), cesium(), railwayData()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
  },
});
