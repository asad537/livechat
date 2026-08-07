# LiveChat — Build Specification (single source of truth)

Premium multi-tenant live chat platform: one business account hosts many **websites**, each
with its own branding; an embeddable **widget** for customers; a unified **dashboard** for
CSRs/leads/admins; realtime messaging, secure file sharing, audio/video calls, transfers,
monitoring and reporting.

**Read first:** `packages/shared/src/index.ts` (types + all Socket.IO event names + API paths)
and `apps/server/src/core/*` (config, db adapter, auth, presence, deps). These are FROZEN —
import them, do not modify them. Do NOT run `npm install`; all dependencies are installed.
Do NOT add new dependencies.

Import shared code as `@livechat/shared` (alias configured in every tsconfig/vite config).
Server files import each other with explicit `.js` extensions NOT required (moduleResolution
bundler + tsx runtime — extensionless or `.js` both fine; core files use `.js`, keep that style).

## Runtime layout

- Server: Express + Socket.IO on **:4000** (`apps/server`, run via tsx, ESM, strict TS).
- Dashboard: React+Vite dev server on **:5173**, proxies `/api` and `/socket.io` to :4000.
- Widget: Preact IIFE bundle → `apps/widget/dist/widget.js`, served by the server at
  `http://localhost:4000/widget.js`. Demo business pages in `apps/widget/demo/*.html` are
  served at `http://localhost:4000/demo/<name>.html`.
- DB: MySQL (XAMPP) by default, SQLite fallback — via the `Db` adapter. **Portable SQL only**:
  `?` placeholders, ISO-string timestamps via `nowIso()`, ids via `newId()`, booleans 0/1.
  No `RETURNING`, no upsert syntax, no dialect-specific functions. SELECT after INSERT instead.
  MySQL returns numbers for INTEGER columns; SQLite may return them as numbers too — but
  always wrap counts with `Number(...)`.

## File ownership (each builder owns ONLY its directories)

| Owner | Paths |
|---|---|
| Agent HTTP      | `apps/server/src/http/**` |
| Agent REALTIME  | `apps/server/src/realtime/**`, `apps/server/src/domain/**` |
| Agent FEATURES  | `apps/server/src/features/**` (files + calls) |
| Agent WIDGET    | `apps/widget/src/**`, `apps/widget/demo/**` |
| Agent DASHBOARD | `apps/dashboard/src/**` |

Frozen (already written): `core/**`, `index.ts`, `seed.ts`, `schema.sql`, all configs.

## Cross-module contracts (exact signatures — implement/import EXACTLY these)

### `src/http/router.ts` (Agent HTTP)
```ts
import type { AppDeps } from '../core/deps.js';
import { Router } from 'express';
export function buildApiRouter(deps: AppDeps): Router;
```
Mounts all REST endpoints (below) AND `buildFilesRouter(deps)` + `buildCallsRouter(deps)`
from `../features/files/index.js` and `../features/calls/index.js`.

### `src/realtime/index.ts` (Agent REALTIME)
```ts
export function attachRealtime(deps: AppDeps): void;
```
Creates both namespaces, auth middleware, all chat/socket logic. Calls
`registerWidgetCallHandlers(deps, socket)` / `registerAgentCallHandlers(deps, socket)`
from `../features/calls/index.js` inside the respective connection handlers.

### `src/domain/messages.ts` (Agent REALTIME — used by HTTP + FEATURES too)
```ts
export interface PostMessageInput {
  conversationId: string;
  senderType: SenderType;
  senderUserId?: string | null;
  body: string;
  kind?: MessageKind;            // default 'TEXT'
  fileId?: string | null;
  callId?: string | null;
  tempId?: string;
}
export async function postMessage(deps: AppDeps, input: PostMessageInput): Promise<ChatMessage>;
export async function hydrateMessages(deps: AppDeps, rows: MessageRow[]): Promise<ChatMessage[]>;
export interface MessageRow { /* snake_case columns of messages table */ }
```
`postMessage`: INSERT → hydrate (attach file/call/sender) → emit `EV.ChatMessage` to
`conv:{id}` room in BOTH namespaces → if the counterpart is online (presence), set
`delivered_at` + emit `EV.ChatReceipt` → also `emitInboxUpdate`. Returns hydrated message
(including `tempId` echo for optimistic UI).

### `src/domain/conversations.ts` (Agent REALTIME — used by HTTP + FEATURES too)
```ts
export async function loadSummary(deps: AppDeps, conversationId: string): Promise<ConversationSummary | undefined>;
export async function emitInboxUpdate(deps: AppDeps, conversationId: string): Promise<void>;
export async function findEligibleCsr(deps: AppDeps, websiteId: string, excludeUserId?: string): Promise<string | null>;
export async function activateConversation(deps: AppDeps, conversationId: string): Promise<void>;
export async function closeConversation(deps: AppDeps, conversationId: string): Promise<void>;
export async function transferConversation(deps: AppDeps, conversationId: string, fromUserId: string | null, toUserId: string): Promise<void>;
export async function drainQueue(deps: AppDeps, websiteId?: string): Promise<void>;
export async function userCanAccessWebsite(deps: AppDeps, userId: string, role: Role, websiteId: string): Promise<boolean>;
```
- `findEligibleCsr`: online (presence) member of the website's team whose count of ACTIVE
  conversations < `max_chats`; pick least-loaded.
- `emitInboxUpdate`: emit `EV.InboxUpdate {conversation: summary}` to `/agent` rooms:
  `user:{assignedUserId}` (if any) and `website:{websiteId}` (watchers = team members incl.
  leads + admins who joined).
- `drainQueue`: for each WAITING unassigned conversation (oldest first), `findEligibleCsr`
  → assign (`assigned_user_id`, history reason `AUTO`) → inbox update. Called on agent
  connect, on close, on transfer.

### Socket rooms (pin these names)
- `conv:{conversationId}` — in `/widget` AND `/agent`
- `user:{userId}` — `/agent`
- `website:{websiteId}` — `/agent` (visitor-list + inbox watchers)
- `socket.data` on `/widget`: `{ visitorId: string, websiteId: string, conversationId: string | null }`
- `socket.data` on `/agent`: `{ userId: string, role: Role, name: string }`

### `src/features/files/index.ts` (Agent FEATURES)
```ts
export function buildFilesRouter(deps: AppDeps): Router;
```
Routes: `POST /api/uploads` (multer, field `file`, body/query: `conversationId`, `token`) and
`GET /api/files/:id/download?token=...`. Token = agent JWT **or** visitor token
(`verifyToken` from core/auth). Authorize: participant of the conversation (visitor of it, or
assigned agent, or LEAD of the website's team, or ADMIN).

Upload pipeline (mirror of the flowchart): authorize → write to
`{storageDir}/quarantine/{fileId}` → extension/size guard (`BLOCKED_EXTENSIONS`,
`MAX_FILE_BYTES`) → scan: if `clamdscan`/`clamscan` binary exists use it, else
`SCAN_MODE=permissive` marks CLEAN (log a note) / `strict` marks BLOCKED → if BLOCKED:
delete file, update row, post SYSTEM message "File blocked by security scan" → if CLEAN:
gzip → `{storageDir}/private/{fileId}.gz`, delete quarantine file, update row, then
`postMessage(kind:'FILE', fileId)`. Download: authorize → gunzip stream →
`Content-Disposition` original filename. `FileMeta.downloadUrl` = `/api/files/{id}/download`.

### `src/features/calls/index.ts` (Agent FEATURES)
```ts
export function buildCallsRouter(deps: AppDeps): Router;   // POST /api/calls/daily-webhook
export function registerWidgetCallHandlers(deps: AppDeps, socket: Socket): void;
export function registerAgentCallHandlers(deps: AppDeps, socket: Socket): void;
```
Provider: `DAILY` if `config.dailyApiKey` set (create private room via api.daily.co, short-lived
meeting tokens, webhook records join/leave/end into `call_events`); otherwise `BUILTIN` —
P2P WebRTC, signaling relayed over Socket.IO, STUN `stun:stun.l.google.com:19302`.

BUILTIN signaling: keep a module-level `Map<callId, Map<peerId, { socket, label }>>` where
`peerId = socket.id`. Flow: `EV.AgentCallStart {conversationId, kind}` → insert calls row
(INVITED) + call_events INVITED + `postMessage(kind:'CALL', callId, body:'Audio call'|'Video call')`
+ emit `EV.CallInvite` to the widget `conv` room. Accept (`EV.WidgetCallAccept`) → status
ACTIVE + `EV.CallStatus` both sides. Each participant emits `EV.CallJoin {callId}` → server
adds to peer map, records JOIN event, replies `EV.CallPeers {callId, peers}` (existing peers),
broadcasts `EV.CallJoin {callId, peerId, label}` to others. `EV.CallSignal {callId, to, data}`
→ relay to that peer's socket with `from` = sender peerId (works across namespaces because
sockets are held directly). `EV.CallLeave` / disconnect → remove, record LEAVE, broadcast;
when map empty → status ENDED + `ended_at` + END event + `EV.CallStatus`.
Decline → DECLINED + DECLINE event + `EV.CallStatus`.
Conference: `EV.AgentCallInvite {callId, userId}` → authorize (ADMIN or member of the
website's team) → `EV.CallInvite` to `/agent` room `user:{userId}` → invitee joins via
`EV.CallJoin` (mesh topology).

## REST API (Agent HTTP) — all JSON, `requireAgent` unless noted

- `POST /api/auth/login {email,password}` → `{token, user: UserPublic}` (no auth)
- `GET  /api/me` → `{user, websites: Website[], teams: Team[]}` (websites scoped: ADMIN=all,
  else via team membership)
- `GET  /api/users` (ADMIN) / `POST /api/users {email,name,password,role,maxChats}` (ADMIN)
- `GET  /api/teams` (ADMIN/LEAD: own) / `POST /api/teams {name}` (ADMIN) /
  `POST /api/teams/:id/members {userId,isLead}` (ADMIN) / `DELETE /api/teams/:id/members/:userId` (ADMIN)
- `GET  /api/websites` (scoped) / `POST /api/websites {name,domains[],primaryColor,greeting,logoUrl,teamId}`
  (ADMIN; generate `widget_key` = `wk_` + 12 hex) / `PATCH /api/websites/:id` (ADMIN)
- `GET  /api/websites/:id/visitors` → online visitors (presence) merged with visitor rows
- `GET  /api/conversations?websiteId=&status=&scope=mine|team|all` — scope guard:
  CSR→mine (+unassigned WAITING/OFFERED of accessible sites), LEAD→team, ADMIN→all.
  Returns `ConversationSummary[]` (with visitor, website branding, lastMessage, unreadCount
  = messages from VISITOR with `read_at IS NULL`).
- `GET  /api/conversations/:id/messages` → hydrated `ChatMessage[]` (authorize access)
- `GET  /api/conversations/:id/history` → `AssignmentRecord[]` with user names
- `GET  /api/reports/overview?websiteId=` (LEAD/ADMIN) → `{ totals: {active,waiting,closed,missed},
  avgFirstResponseSeconds, perAgent: [{user, closed, active}] }`
- `GET  /api/widget/boot?key=` (no auth) → `{website: WebsiteBranding}` or 404

## Realtime flows (Agent REALTIME) — mirror the flowchart exactly

**/widget handshake** `auth: { widgetKey, visitorToken?, page? }` → validate widget key →
domain check: `Origin` header hostname must be in website `domains` (comma list; empty =
allow all — dev) else reject connection → visitor: verify token / else create row + sign new
token → mark presence online, join `visitor:{id}`-free; find open conversation (status
WAITING/OFFERED/ACTIVE) → join `conv:{id}`, load messages (hydrated) →
emit `EV.WidgetReady { visitorToken, visitor, website: branding, conversation, messages, agent }`
(`agent` = assigned agent's `{name, avatarColor}` or null) → broadcast `EV.VisitorsUpdate`
to `website:{id}` in `/agent`. On disconnect: presence remove → `EV.VisitorsUpdate`; if
conversation OFFERED and visitor never replied, start 10-min timer → mark MISSED
(cancel timer on reconnect).

**Customer sends first message** (`EV.WidgetMessage`): no conversation yet → create WAITING
conversation, join room, `postMessage` → `findEligibleCsr` → found: assign + history AUTO +
inbox update (CSR gets new-chat notification badge; conversation stays WAITING until CSR
accepts) → none: stays unassigned in queue (leads/admins see it), visitor gets SYSTEM message
"You're in the queue — an agent will be with you shortly."

**CSR accepts** (`EV.AgentAccept`): must be assignee (or LEAD/ADMIN taking over → also record
history) → `activateConversation` → ACTIVE + `activated_at` → both sides `EV.ChatStatus` +
`EV.ChatAgent` → agent socket joins `conv` room.

**CSR starts chat** (`EV.AgentStartChat {websiteId, visitorId, body}`): verify
`userCanAccessWebsite` → create OFFERED conversation assigned to CSR + history OFFER +
`postMessage` (AGENT) → widget receives message + status. Customer replies while OFFERED →
`activateConversation` (no accept step). 

**Messages both directions**: guard participant; visitor messages allowed in any non-closed
conversation; agent messages require assignee or ADMIN. Typing + read events relay to the
other side (`EV.ChatTyping`, set `read_at` on `EV.WidgetRead`/`EV.AgentRead` + emit receipts).

**Transfer** (`EV.AgentTransfer`): assignee/LEAD/ADMIN → target must be eligible (online,
capacity, team member) → `transferConversation`: history TRANSFER, reassign, force previous
assignee's sockets to leave the `conv` room (`io.of('/agent').in('user:{prev}').socketsLeave('conv:{id}')`),
SYSTEM message "Transferred to {name}", inbox updates to both, `EV.ChatAgent` to widget.

**Close** (`EV.AgentClose`): assignee/LEAD/ADMIN → `closeConversation` → CLOSED +
`closed_at` + SYSTEM message "Conversation closed" + `EV.ChatStatus` + `drainQueue()`
(freed capacity picks up waiting chats). Transcript/files/calls/history stay in DB (reporting).

**Monitoring** (`EV.AgentWatchWebsite {websiteId}`): verify access (`userCanAccessWebsite`;
LEAD limited to own team's sites, ADMIN all, CSR allowed for visitor list) → join
`website:{id}` → immediately send `EV.VisitorsUpdate` + current inbox snapshot is fetched
via REST. `EV.AgentOpen {conversationId}` (ack callback): verify assignee OR lead-of-team OR
admin → join `conv` room → ack `{conversation, messages, history}` (leads/admins can watch
any team chat live; only assignee/admin may send).

**Agent connect/disconnect**: presence add/remove → broadcast `EV.PresenceUpdate` to `/agent`
→ on connect emit `EV.AgentReady` (`me`, scoped websites, teams w/ members incl. online flag)
+ auto-join `user:{id}` + `drainQueue()`. On disconnect: presence remove + `EV.PresenceUpdate`.

## Widget UI (Agent WIDGET) — `apps/widget/src/**`, Preact, Shadow DOM

Self-executing embed: reads its own `<script>` tag:
```html
<script src="http://localhost:4000/widget.js" data-livechat-key="wk_acme_demo" async></script>
```
`data-livechat-server` optional (defaults to the script's own origin). Persist
`visitorToken` per widget key in `localStorage`. All styles are template strings injected in a
Shadow DOM root (NO css imports — lib build must emit a single JS file).

Premium look: floating round launcher (website `primaryColor`, white chat icon, unread badge,
subtle pulse on new message), panel 380×600 rounded-2xl, soft shadows, header with brand
color + website name/logo + assigned agent chip (avatar dot, name, online dot), messages
area (visitor right/brand color, agent left/white cards, SYSTEM centered small, timestamps,
✓ sent / ✓✓ grey delivered / ✓✓ colored read), typing dots, date separators, greeting bubble
from website config shown before first message, optional name/email mini-form (emits
`EV.WidgetInfo`), composer: textarea auto-grow, attach button (file → POST `/api/uploads`
with visitorToken; render FILE messages as download cards hitting `downloadUrl` + token
query), Enter to send with optimistic render via `tempId`. Status strip for
WAITING ("Finding an agent…"), queue message, CLOSED (show "Start new conversation" button →
next message creates a fresh conversation — reconnect socket).
Calls: on `EV.CallInvite` show incoming call card (accept/decline); in-call overlay:
local+remote `<video>` tiles (audio-only → avatar tiles), mute/cam/hangup buttons, uses
`RTCPeerConnection` + `EV.CallJoin/CallPeers/CallSignal` mesh (see calls contract), STUN
google. Mobile responsive (full-screen panel < 480px).

Demo pages (`apps/widget/demo/acme.html`, `tech.html`): two polished fake business landing
pages (inline CSS, no external assets) embedding the widget with their respective keys —
`wk_acme_demo` (green) and `wk_tech_demo` (blue) — so multi-tenant branding is visibly
different. Cross-link the two pages.

## Dashboard UI (Agent DASHBOARD) — `apps/dashboard/src/**`, React+TS

Premium SaaS look: hand-rolled CSS (one `styles.css` imported in `main.tsx`, CSS variables,
Inter/system font stack, #0f172a sidebar, indigo #6366f1 accents, light content area, rounded
cards, subtle shadows/transitions; inline SVG icons only). React Router routes:

- `/login` — centered card, demo credentials hint. Store JWT in localStorage; REST via small
  `api.ts` helper; one Socket.IO connection to `/agent` after login (`auth: {token}`).
- `/` **Inbox** — 3-pane: conversation list (tabs: Mine / Queue / All-per-role, status pills,
  unread badges, last message preview, live via `EV.InboxUpdate`); center chat pane
  (`EV.AgentOpen` ack → messages; send via `EV.AgentMessage` optimistic w/ tempId; typing;
  read receipts ✓/✓✓; file attach → `/api/uploads`; FILE cards w/ download; CALL messages;
  Accept button on WAITING assigned-to-me; header: visitor name/email, website chip, buttons:
  audio call, video call, transfer (modal listing eligible online CSRs w/ capacity), close);
  right panel: visitor info + assignment history timeline (`/history`).
- `/visitors` — website switcher; live visitor cards (`EV.AgentWatchWebsite` +
  `EV.VisitorsUpdate`, current page shown); "Start chat" → modal with first message →
  `EV.AgentStartChat`.
- `/monitoring` (LEAD/ADMIN) — every team/website conversation w/ filters (website, agent,
  status); click to watch live (read-only banner for leads on chats not theirs).
- `/reports` (LEAD/ADMIN) — stat cards (active/waiting/closed/missed, avg first response),
  per-agent table. Simple inline bar chart (divs), no chart libs.
- `/admin` (ADMIN) — tabs: Websites (list + create/edit form: name, domains, color picker,
  greeting, logo URL; show widget key + copyable embed snippet), Teams (members, lead
  toggle), Users (create CSR/LEAD, max chats, role) — all via REST.
- Call UI: same WebRTC mesh pattern as widget; incoming `EV.CallInvite` toast anywhere in
  app; in-call floating window (draggable optional); "Add participant" → online CSR list →
  `EV.AgentCallInvite`.
- Global: presence dots via `EV.PresenceUpdate`; toast on new chat assignment
  (`EV.InboxUpdate` where I'm newly assigned + WAITING); browser tab title unread counter.

## Verification commands

- `npm run typecheck` (root — all workspaces)
- `npm run build -w apps/widget` and `-w apps/dashboard`
- `npm run dev -w apps/server` then `curl localhost:4000/health`

## Demo credentials

admin@demo.com/admin123 · lead@demo.com/lead123 · sara@demo.com/csr123 · ali@demo.com/csr123
