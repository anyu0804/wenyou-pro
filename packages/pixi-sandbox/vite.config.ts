import { defineConfig } from 'vite';
import { loadWorldPayload } from './world-data.mjs';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    rollupOptions: {
      output: {
        // pixi.js 单独成 chunk：业务代码迭代时这约 400 KB 不必重新下载（配合 server 的 immutable 缓存）
        manualChunks: {
          pixi: ['pixi.js'],
        },
      },
    },
  },
  plugins: [
    {
      name: 'wenyou-worlds-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/api/worlds/')) {
            const worldId = req.url.replace('/api/worlds/', '').split('?')[0].trim();
            if (!['immortal-game1', 'civ4-game2'].includes(worldId)) {
              res.statusCode = 404;
              res.end('Unknown world');
              return;
            }
            try {
              const payload = loadWorldPayload(worldId);
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify(payload));
              return;
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: err?.message || 'Failed to read world data' }));
              return;
            }
          }
          next();
        });
      },
    },
  ],
});
