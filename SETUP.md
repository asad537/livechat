# LiveChat — Developer Setup

Multi-tenant live chat SaaS. Monorepo (npm workspaces):

| Folder | What it is |
|---|---|
| `apps/server` | Node/Express + Socket.IO API (port **4000**), serves the built dashboard at `/app` and `widget.js` |
| `apps/dashboard` | React agent dashboard (Vite) |
| `apps/widget` | Embeddable chat widget (Preact, single-file `widget.js`) |
| `packages/shared` | Types + socket event names shared by all three |

## Prerequisites

- **Node.js 20.12+** (22/24 fine) and npm
- **MySQL or MariaDB** running locally — XAMPP works out of the box
  (PostgreSQL also supported; SQLite fallback needs nothing at all)
- Git access to this repository

## 1. Clone + install

```bash
git clone https://github.com/asad537/livechat.git
cd livechat
npm install
```

## 2. Database

Create an empty database (default name `livechat`):

```sql
CREATE DATABASE livechat;
```

That's it — **all tables are created/migrated automatically** from
`apps/server/schema.sql` every time the server boots (idempotent).

> Optional: if you were given a `livechat-db.sql` dump and want the same
> data as the sender, import it instead:
> `mysql -u root livechat < livechat-db.sql`

## 3. Environment

```bash
cp .env.example .env
```

Defaults work for XAMPP (`mysql://root@127.0.0.1:3306/livechat`).
Edit `.env` if your MySQL has a password or a different port.
Everything else (AI greeter key, SMTP, Daily.co) is **optional** — the app
runs without them. Ask the project owner for the production keys; never
commit `.env`.

## 4. Run (development)

```bash
npm run dev
```

Starts all three with hot reload:

- **API/server** → http://localhost:4000
- **Dashboard (Vite HMR)** → http://localhost:5173 (proxies `/api` + sockets to 4000)
- **Widget** → rebuilt on change, served at http://localhost:4000/widget.js

## 5. Seed the team + log in

```bash
npm run seed:team -w apps/server
```

Creates the full roster (safe to re-run). All seeded logins use password
**`12345678`**:

| Role | Example login |
|---|---|
| Admin | `amir@customboxes.com` |
| Manager (view-only) | `ben@thecustomboxes.com` |
| Team Lead | `joshuaross@thecustomboxes.com` |
| CSR | `markeast@thecustomboxes.com` |

Open the dashboard → http://localhost:5173 (dev) or http://localhost:4000/app (built).

## 6. Try the widget as a visitor

Demo pages that embed the widget: http://localhost:4000/demo/acme.html
(or add the embed snippet from **Admin → Integrations** to any page).
Chat as a visitor there, answer it as an agent in the Inbox.

## Production build

```bash
npm run build          # widget + dashboard + server typecheck
npm start              # serves API + dashboard at :4000 (use pm2 in prod)
```

Deploy flow used on the VPS:

```bash
cd ~/livechat && git pull && npm run build -w apps/widget && npm run build -w apps/dashboard && pm2 restart livechat
```

## Roles (quick reference)

- **ADMIN** — everything, including Admin section (agents, departments, workflows, integrations)
- **MANAGER** — sees every chat/report/admin page, can change nothing (view-only, server-enforced)
- **TEAM LEAD** — sees + can reply in own CSRs' chats; reports scoped to own CSRs
- **CSR** — own chats + queue; each CSR is assigned under one Team Lead (Admin → Agents → Edit)

## Troubleshooting

- **Port 4000 busy** → set `PORT` in `.env`
- **MySQL unreachable** → server logs a warning and falls back to SQLite (`apps/server/data/`); fix `DATABASE_URL` and restart for MySQL
- **Widget shows old version** → `widget.js` is cached 5 min; hard refresh the embed page
- **AI bot not replying** → set `AI_PROVIDER=groq` + `AI_API_KEY=gsk_...` (free key from console.groq.com), or it uses the built-in canned replies
