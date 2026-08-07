// Quick load test: N concurrent widget connections → measures handshake time.
//   node tools/loadtest.mjs [N]
import { io } from 'socket.io-client';

const N = Number(process.argv[2] || 150);
const SERVER = process.env.SERVER || 'http://localhost:4000';
const KEY = process.env.KEY || 'wk_acme_demo';

const results = [];
const visitorIds = [];
let failures = 0;

await Promise.all(
  Array.from({ length: N }, (_, i) =>
    new Promise((resolve) => {
      setTimeout(() => {
        const t0 = performance.now();
        let settled = false;
        const s = io(`${SERVER}/widget`, {
          auth: { widgetKey: KEY, page: '/loadtest' },
          transports: ['websocket'],
          reconnection: false,
        });
        const done = () => { if (!settled) { settled = true; s.disconnect(); resolve(); } };
        s.on('widget:ready', (p) => {
          results.push(performance.now() - t0);
          if (p?.visitor?.id) visitorIds.push(p.visitor.id);
          done();
        });
        s.on('connect_error', () => { failures++; done(); });
        setTimeout(() => { if (!settled) failures++; done(); }, 10_000);
      }, i * 8); // slight stagger — all connect within ~1.2s
    }),
  ),
);

results.sort((a, b) => a - b);
const pct = (p) => results[Math.min(results.length - 1, Math.floor(results.length * p))]?.toFixed(0) ?? '-';
console.log(JSON.stringify({
  requested: N,
  connected: results.length,
  failures,
  handshake_ms: { p50: pct(0.5), p95: pct(0.95), max: results.at(-1)?.toFixed(0) ?? '-' },
}));
console.log('VISITORS:' + visitorIds.join(','));
process.exit(0);
