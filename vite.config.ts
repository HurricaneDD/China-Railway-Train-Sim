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
      // A missing trailing slash would otherwise fall through to Vite's SPA
      // fallback and open the main simulator instead of the inspector.
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/dev/raliway-check') {
          res.statusCode = 302;
          res.setHeader('Location', `/dev/raliway-check/${url.search}`);
          res.end();
          return;
        }
        next();
      });
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

/** The standalone inspector does not import Cesium; remove injected tags under its nested URL. */
function railwayCheckHtml(): Plugin {
  return {
    name: 'railway-check-html',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const path = (context.filename || context.path || '').replace(/\\/g, '/');
        if (!path.endsWith('dev/raliway-check/index.html')) return html;
        return html
          .replace(/\s*<link[^>]+cesium[^>]*>/gi, '')
          .replace(/\s*<script[^>]+cesium[^>]*>\s*<\/script>/gi, '');
      },
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [vue(), cesium(), railwayCheckHtml(), railwayData()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: {
    host: '0.0.0.0',
    port: 8062,
    strictPort: true,
    // Allow reverse proxies and external hostnames to reach the dev server.
    // This only affects `vite dev`; production output is unaffected.
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        railwayCheck: resolve(__dirname, 'dev/raliway-check/index.html'),
      },
    },
  },
});
