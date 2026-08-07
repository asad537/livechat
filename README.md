# LiveChat — Premium Multi‑Tenant Live Chat Platform

Ek business account, multiple websites — har website ka apna branded chat widget, aur sab
CSRs ke liye aik unified dashboard. Realtime messaging, secure file sharing, audio/video
calls, transfers, monitoring aur reporting ke saath.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js + TypeScript + Express + Socket.IO |
| Database | **MySQL/MariaDB** (XAMPP ready) — SQLite auto‑fallback, PostgreSQL supported |
| Scaling | Redis adapter (optional, `REDIS_URL`) |
| Dashboard | React 18 + Vite |
| Widget | Preact (single ~embeddable `widget.js`, Shadow DOM) |
| Calls | WebRTC — built‑in P2P (default) ya Daily.co (`DAILY_API_KEY`) |
| Files | Quarantine → virus scan (ClamAV hook) → gzip → private authorized download |

## Chalane ka tareeqa

XAMPP MySQL start karein (optional — na ho to SQLite par chal jata hai), phir:

```bash
npm install
```

```bash
npm run dev
```

- **Demo shops (customer side):** http://localhost:4000/demo/acme.html aur http://localhost:4000/demo/tech.html
- **Agent dashboard:** http://localhost:5173

### Demo logins

| Email | Password | Role |
|---|---|---|
| admin@demo.com | admin123 | Admin — sab websites/teams/chats/reports |
| lead@demo.com | lead123 | Team Lead — apni team ki monitoring |
| sara@demo.com | csr123 | CSR |
| ali@demo.com | csr123 | CSR |

## Apni website par lagana

Dashboard → Admin → Websites → apni website add karein (naam, domain, brand color,
greeting). Widget key milegi; yeh snippet apni site ke `</body>` se pehle paste karein:

```html
<script src="https://YOUR-SERVER/widget.js" data-livechat-key="wk_XXXXXXXX" async></script>
```

Har website ki apni branding widget mein automatically load hoti hai (logo, color, greeting),
aur domain validation sirf allowed domains par widget chalne deta hai.

## Production

- `.env` mein `DATABASE_URL=mysql://user:pass@host:3306/livechat`, strong `JWT_SECRET`,
  `PUBLIC_URL` set karein.
- Scaling ke liye `REDIS_URL` (Socket.IO redis adapter khud enable ho jata hai —
  `npm i ioredis @socket.io/redis-adapter -w apps/server`).
- File scanning ke liye server par ClamAV (`clamdscan`) install karein; `SCAN_MODE=strict`
  scanner na hone par uploads block kar deta hai.
- Calls ke liye `DAILY_API_KEY` dene par Daily.co rooms + webhooks use hote hain; warna
  built‑in P2P WebRTC (STUN) chalta hai.
- `npm run build` → widget + dashboard production bundles; dashboard `apps/dashboard/dist`
  kisi bhi static host par, server `npm start`.

## Scaling (jitne marzi users)

Built-in optimizations: gzip + caching, har hot query par DB index, bounded
message-history loads, single-query agent routing, per-socket rate limiting
(20 msg/10s) + 4000-char message cap, configurable MySQL pool (`DB_POOL_SIZE`).

Load barhne par yeh seerhi charhein:

1. **~2,000 concurrent visitors tak** — kuch nahi karna; single Node process +
   MySQL kafi hai. `pm2 start ecosystem.config.cjs` se chalayein.
2. **~10,000 tak** — `REDIS_URL` set karein (Socket.IO redis adapter khud on
   ho jata hai: `npm i ioredis @socket.io/redis-adapter -w apps/server`),
   MySQL ko `DB_POOL_SIZE=50` dein.
3. **Us se upar** — kai Node instances alag machines/ports par + load balancer
   with **sticky sessions** (nginx `ip_hash` / cookie) + shared Redis + MySQL
   read tuning. `widget.js` ko CDN (Cloudflare) ke peeche rakh dein.

## Architecture

- `apps/server` — Express REST API (`/api/*`), Socket.IO namespaces `/widget` + `/agent`,
  assignment engine (least‑loaded online CSR, capacity per agent, waiting queue + auto drain),
  transfers with history, lead/admin monitoring, reports.
- `apps/widget` — self‑contained embeddable widget (Shadow DOM, brand theming, receipts,
  typing, files, calls).
- `apps/dashboard` — CSR/lead/admin SPA (inbox, visitors, monitoring, reports, admin CRUD).
- `packages/shared` — types + socket event contract, dono clients aur server share karte hain.
- `apps/server/schema.sql` — portable schema (MySQL/SQLite/Postgres).

Flow details ke liye `SPEC.md` dekhein.
