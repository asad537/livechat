import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { loadConfig } from './core/config.js';
import { createDb } from './core/db.js';
import { createPresence } from './core/presence.js';
import type { AppDeps } from './core/deps.js';
import { ensureSeed } from './seed.js';
import { buildApiRouter } from './http/router.js';
import { attachRealtime } from './realtime/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDb(config);
  await ensureSeed(db, config);
  const presence = createPresence();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Optional Redis adapter → multi-node fan-out (production scaling)
  if (config.redisUrl) {
    try {
      const [{ createAdapter }, { default: Redis }] = await Promise.all([
        import('@socket.io/redis-adapter' as string),
        import('ioredis' as string),
      ]);
      const pub = new Redis(config.redisUrl);
      const sub = pub.duplicate();
      io.adapter(createAdapter(pub, sub));
      console.log('[redis] Socket.IO redis adapter enabled');
    } catch {
      console.warn('[redis] REDIS_URL set but ioredis/@socket.io/redis-adapter not installed — running single-node');
    }
  }

  const deps: AppDeps = { config, db, presence, io };

  app.use(buildApiRouter(deps));
  attachRealtime(deps);

  // Embeddable widget bundle + demo business sites
  const widgetDist = path.join(config.repoRoot, 'apps', 'widget', 'dist');
  const demoDir = path.join(config.repoRoot, 'apps', 'widget', 'demo');
  app.get('/widget.js', (_req, res) => {
    const file = path.join(widgetDist, 'widget.js');
    if (!fs.existsSync(file)) {
      res.status(404).type('text/plain').send('// widget not built yet — run: npm run build -w apps/widget');
      return;
    }
    res.sendFile(file);
  });
  app.use('/demo', express.static(demoDir));
  app.get('/health', (_req, res) => res.json({ ok: true, db: db.dialect }));
  app.get('/', (_req, res) => res.redirect('/demo/acme.html'));

  server.listen(config.port, () => {
    console.log(`[livechat] server    → ${config.publicUrl}`);
    console.log(`[livechat] demo shop → ${config.publicUrl}/demo/acme.html`);
    console.log(`[livechat] database  → ${db.dialect}`);
  });
}

main().catch((err) => {
  console.error('[livechat] fatal:', err);
  process.exit(1);
});
