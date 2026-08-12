import type { Namespace, Socket } from 'socket.io';
import {
  AGENT_NAMESPACE,
  WIDGET_NAMESPACE,
  EV,
  type Role,
  type Team,
  type Visitor,
  type Website,
} from '@livechat/shared';
import type { AppDeps } from '../core/deps.js';
import { newId, nowIso } from '../core/db.js';
import {
  signVisitorToken,
  toUserPublic,
  verifyToken,
  type AgentTokenPayload,
  type UserRow,
  type VisitorTokenPayload,
} from '../core/auth.js';
import { hydrateMessages, postMessage, type MessageRow } from '../domain/messages.js';
import { maybeBotReply } from '../features/aibot/index.js';
import { sendTranscriptEmail } from '../features/email/index.js';
import { captureVisitorInfo } from '../features/capture/index.js';
import { clientIp, updateVisitorGeo } from '../features/geo/index.js';
import { ipAllowed } from '../core/ip.js';
import {
  activateConversation,
  closeConversation,
  drainQueue,
  emitConversationAgent,
  emitConversationStatus,
  emitInboxUpdate,
  findEligibleCsr,
  hasCapacity,
  loadSummary,
  recordAssignment,
  setVisitorRefresh,
  toBranding,
  toVisitor,
  transferConversation,
  userCanAccessWebsite,
  type ConversationRow,
  type VisitorRow,
  type WebsiteRow,
} from '../domain/conversations.js';
import {
  registerAgentCallHandlers,
  registerWidgetCallHandlers,
} from '../features/calls/index.js';

// ─── Socket data (pinned shapes, see SPEC "Socket rooms") ────

interface WidgetSocketData {
  visitorId: string;
  websiteId: string;
  conversationId: string | null;
}

interface AgentSocketData {
  userId: string;
  role: Role;
  name: string;
}

/** Extra per-socket context resolved during the handshake (not part of the pinned socket.data contract). */
const widgetCtx = new WeakMap<Socket, { visitorToken: string; page: string | null; websiteRow: WebsiteRow }>();
const agentCtx = new WeakMap<Socket, { user: UserRow }>();

const convRoom = (id: string): string => `conv:${id}`;
const userRoom = (id: string): string => `user:${id}`;
const websiteRoom = (id: string): string => `website:${id}`;

const MISSED_TIMEOUT_MS = 10 * 60 * 1000;
const QUEUE_MESSAGE = "You're in the queue — an agent will be with you shortly.";

// Scale/abuse guards
const MAX_MESSAGE_CHARS = 4000;
const MSG_RATE_MAX = 20; // messages per window per socket
const MSG_RATE_WINDOW_MS = 10_000;

/** Cheap sliding-window rate limiter, one per socket. */
function makeLimiter(max: number, windowMs: number): () => boolean {
  let count = 0;
  let resetAt = 0;
  return () => {
    const now = Date.now();
    if (now > resetAt) {
      count = 0;
      resetAt = now + windowMs;
    }
    return ++count <= max;
  };
}

// ─── Small utilities ─────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Wrap a handler so a bad payload / runtime error never crashes the server. */
function safe(
  socket: Socket,
  handler: (...args: never[]) => void | Promise<void>,
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    Promise.resolve()
      .then(() => (handler as (...a: unknown[]) => void | Promise<void>)(...args))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Unexpected error';
        console.error('[realtime]', message);
        socket.emit(EV.AppError, { message });
      });
  };
}

function hostnameOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ─── Missed-conversation timers (OFFERED → MISSED) ───────────

const missedTimers = new Map<string, NodeJS.Timeout>();

function cancelMissedTimer(conversationId: string): void {
  const timer = missedTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    missedTimers.delete(conversationId);
  }
}

/** OFFERED + visitor gone: after 10 minutes without a reply or reconnect, mark MISSED. */
function scheduleMissedTimer(deps: AppDeps, conversationId: string): void {
  cancelMissedTimer(conversationId);
  const timer = setTimeout(() => {
    missedTimers.delete(conversationId);
    void (async () => {
      const conv = await deps.db.get<ConversationRow>(
        'SELECT * FROM conversations WHERE id = ?',
        [conversationId],
      );
      if (!conv || conv.status !== 'OFFERED') return;
      if (deps.presence.isVisitorOnline(conv.visitor_id)) return;
      const replied = await deps.db.get<{ id: string }>(
        "SELECT id FROM messages WHERE conversation_id = ? AND sender_type = 'VISITOR' LIMIT 1",
        [conversationId],
      );
      if (replied) return;
      await deps.db.run("UPDATE conversations SET status = 'MISSED', closed_at = ? WHERE id = ?", [
        nowIso(),
        conversationId,
      ]);
      await emitConversationStatus(deps, conversationId);
      await emitInboxUpdate(deps, conversationId);
    })().catch((err: unknown) => console.error('[realtime] missed-timer', err));
  }, MISSED_TIMEOUT_MS);
  missedTimers.set(conversationId, timer);
}

// ─── Visitor list broadcast ──────────────────────────────────

async function buildVisitorList(deps: AppDeps, websiteId: string): Promise<Visitor[]> {
  const online = deps.presence.onlineVisitors(websiteId);
  if (online.length === 0) return [];
  const ids = online.map((o) => o.visitorId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await deps.db.all<VisitorRow>(
    `SELECT * FROM visitors WHERE id IN (${placeholders})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Pages viewed + chats per visitor (grouped, one query each).
  const pageCounts = await deps.db.all<{ visitor_id: string; n: number }>(
    `SELECT vp.visitor_id, COUNT(*) AS n FROM visitor_pages vp
       JOIN visitors v ON v.id = vp.visitor_id
      WHERE vp.visitor_id IN (${placeholders})
        AND vp.created_at >= COALESCE(v.session_started_at, v.created_at)
      GROUP BY vp.visitor_id`,
    ids,
  );
  const chatCounts = await deps.db.all<{ visitor_id: string; n: number }>(
    `SELECT visitor_id, COUNT(*) AS n FROM conversations
      WHERE visitor_id IN (${placeholders}) GROUP BY visitor_id`,
    ids,
  );
  // Current open conversation per visitor (+ its agent name) — for the live
  // "busy with another agent" hint, independent of history scoping.
  const openRows = await deps.db.all<{
    visitor_id: string;
    id: string;
    status: string;
    assigned_user_id: string | null;
    agent_name: string | null;
  }>(
    `SELECT c.visitor_id, c.id, c.status, c.assigned_user_id, u.name AS agent_name
       FROM conversations c
       LEFT JOIN users u ON u.id = c.assigned_user_id
      WHERE c.visitor_id IN (${placeholders})
        AND c.status IN ('WAITING', 'OFFERED', 'ACTIVE')`,
    ids,
  );
  const pagesBy = new Map(pageCounts.map((r) => [r.visitor_id, Number(r.n)]));
  const chatsBy = new Map(chatCounts.map((r) => [r.visitor_id, Number(r.n)]));
  const openBy = new Map(openRows.map((r) => [r.visitor_id, r]));
  return online.map((o) => {
    const row = byId.get(o.visitorId);
    const base: Visitor = row
      ? toVisitor(row, true, o.page)
      : {
          id: o.visitorId,
          websiteId,
          name: null,
          email: null,
          lastSeenAt: nowIso(),
          online: true,
          currentPage: o.page,
        };
    base.sessionPages = pagesBy.get(o.visitorId) ?? 0;
    base.chats = chatsBy.get(o.visitorId) ?? 0;
    const open = openBy.get(o.visitorId);
    base.activeConversation = open
      ? {
          id: open.id,
          status: open.status as NonNullable<Visitor['activeConversation']>['status'],
          assignedUserId: open.assigned_user_id,
          agentName: open.agent_name,
        }
      : null;
    return base;
  });
}

async function broadcastVisitors(deps: AppDeps, websiteId: string): Promise<void> {
  const visitors = await buildVisitorList(deps, websiteId);
  deps.io.of(AGENT_NAMESPACE).to(websiteRoom(websiteId)).emit(EV.VisitorsUpdate, {
    websiteId,
    visitors,
  });
}

// ─── Assignment history (for agent-open ack) ─────────────────

interface HistoryRow {
  id: string;
  conversation_id: string;
  from_user_id: string | null;
  to_user_id: string;
  reason: 'AUTO' | 'OFFER' | 'TRANSFER';
  created_at: string;
}

async function loadHistory(deps: AppDeps, conversationId: string) {
  const rows = await deps.db.all<HistoryRow>(
    'SELECT * FROM assignment_history WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId],
  );
  const userIds = [
    ...new Set(
      rows.flatMap((r) => [r.from_user_id, r.to_user_id]).filter((v): v is string => !!v),
    ),
  ];
  const users = userIds.length
    ? await deps.db.all<UserRow>(
        `SELECT * FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
        userIds,
      )
    : [];
  const byId = new Map(users.map((u) => [u.id, toUserPublic(u)]));
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    reason: r.reason,
    createdAt: r.created_at,
    fromUser: r.from_user_id ? (byId.get(r.from_user_id) ?? null) : null,
    toUser: byId.get(r.to_user_id) ?? null,
  }));
}

// ─── Access helpers ──────────────────────────────────────────

/** Is `userId` the Team Lead of the user the conversation is assigned to? */
async function isLeadOfAssignee(deps: AppDeps, conv: ConversationRow, userId: string): Promise<boolean> {
  if (!conv.assigned_user_id) return false;
  const csr = await deps.db.get<{ id: string }>(
    'SELECT id FROM users WHERE id = ? AND team_lead_id = ?',
    [conv.assigned_user_id, userId],
  );
  return !!csr;
}

/**
 * Assignee or ADMIN may manage (accept/close/transfer/send); a Team Lead may
 * manage their own CSRs' chats and the unassigned queue of accessible sites.
 * MANAGER never manages — view-only.
 */
async function canManageConversation(
  deps: AppDeps,
  conv: ConversationRow,
  userId: string,
  role: Role,
): Promise<boolean> {
  if (role === 'ADMIN') return true;
  if (role === 'MANAGER') return false;
  if (conv.assigned_user_id === userId) return true;
  if (role === 'LEAD') {
    if (conv.assigned_user_id) return isLeadOfAssignee(deps, conv, userId);
    return userCanAccessWebsite(deps, userId, role, conv.website_id);
  }
  return false;
}

/** Assignee, ADMIN, or the assignee's own Team Lead may send agent messages. */
async function canSendAsAgent(
  deps: AppDeps,
  conv: ConversationRow,
  userId: string,
  role: Role,
): Promise<boolean> {
  if (role === 'ADMIN' || conv.assigned_user_id === userId) return true;
  if (role === 'LEAD') return isLeadOfAssignee(deps, conv, userId);
  return false;
}

async function getConversation(
  deps: AppDeps,
  conversationId: string | null,
): Promise<ConversationRow | undefined> {
  if (!conversationId) return undefined;
  return deps.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [conversationId]);
}

// ─── attachRealtime ──────────────────────────────────────────

export function attachRealtime(deps: AppDeps): void {
  attachWidgetNamespace(deps, deps.io.of(WIDGET_NAMESPACE));
  attachAgentNamespace(deps, deps.io.of(AGENT_NAMESPACE));

  // Assignment/status changes → refresh the live visitor list for that site
  // (coalesced per website so a burst produces one broadcast).
  const pendingVisitorRefresh = new Map<string, NodeJS.Timeout>();
  setVisitorRefresh((websiteId) => {
    if (pendingVisitorRefresh.has(websiteId)) return;
    const t = setTimeout(() => {
      pendingVisitorRefresh.delete(websiteId);
      void broadcastVisitors(deps, websiteId).catch((err) =>
        console.error('[realtime] visitor refresh', err),
      );
    }, 150);
    t.unref?.();
    pendingVisitorRefresh.set(websiteId, t);
  });

  // Fires once the visitor-offline grace period expires (not on every page
  // navigation) — only then do agents see them drop out of "Online now".
  deps.presence.setVisitorOfflineListener((websiteId, visitorId) => {
    void (async () => {
      await deps.db.run('UPDATE visitors SET last_seen_at = ? WHERE id = ?', [
        nowIso(),
        visitorId,
      ]);
      await broadcastVisitors(deps, websiteId);

      // Visitor left during an OFFERED conversation they never replied to →
      // give them 10 minutes to come back before marking it MISSED.
      const offered = await deps.db.get<ConversationRow>(
        "SELECT * FROM conversations WHERE visitor_id = ? AND status = 'OFFERED' ORDER BY created_at DESC LIMIT 1",
        [visitorId],
      );
      if (offered) {
        const replied = await deps.db.get<{ id: string }>(
          "SELECT id FROM messages WHERE conversation_id = ? AND sender_type = 'VISITOR' LIMIT 1",
          [offered.id],
        );
        if (!replied) scheduleMissedTimer(deps, offered.id);
      }
    })().catch((err: unknown) => console.error('[realtime] visitor offline', err));
  });
}

// ═════════════════════════════ /widget ═══════════════════════

function attachWidgetNamespace(deps: AppDeps, ns: Namespace): void {
  ns.use((socket, next) => {
    void (async () => {
      const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
      const widgetKey = asString(auth.widgetKey);
      if (!widgetKey) return next(new Error('Missing widget key'));

      const website = await deps.db.get<WebsiteRow>(
        'SELECT * FROM websites WHERE widget_key = ?',
        [widgetKey],
      );
      if (!website) return next(new Error('Invalid widget key'));

      // Domain check: Origin hostname must appear in the website's domain list
      // (comma-separated; empty = allow all, for dev).
      const domains = (website.domains ?? '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      if (domains.length > 0) {
        const host = hostnameOf(socket.handshake.headers.origin);
        if (!host || !domains.includes(host)) return next(new Error('Domain not allowed'));
      }

      // Resolve or create the visitor.
      let visitorRow: VisitorRow | undefined;
      const rawToken = asString(auth.visitorToken);
      if (rawToken) {
        const payload = verifyToken<VisitorTokenPayload>(deps.config, rawToken);
        if (payload && payload.typ === 'visitor' && payload.websiteId === website.id) {
          visitorRow = await deps.db.get<VisitorRow>('SELECT * FROM visitors WHERE id = ?', [
            payload.sub,
          ]);
        }
      }
      let visitorToken = rawToken ?? '';
      if (!visitorRow) {
        const id = newId();
        const now = nowIso();
        await deps.db.run(
          'INSERT INTO visitors (id, website_id, name, email, created_at, last_seen_at) VALUES (?, ?, NULL, NULL, ?, ?)',
          [id, website.id, now, now],
        );
        visitorRow = await deps.db.get<VisitorRow>('SELECT * FROM visitors WHERE id = ?', [id]);
        if (!visitorRow) return next(new Error('Failed to create visitor'));
        visitorToken = signVisitorToken(deps.config, id, website.id);
      }

      const data = socket.data as WidgetSocketData;
      data.visitorId = visitorRow.id;
      data.websiteId = website.id;
      data.conversationId = null;
      widgetCtx.set(socket, {
        visitorToken,
        page: asString(auth.page),
        websiteRow: website,
      });

      // ── Visit/session tracking (Zendesk-style) ──
      const now = nowIso();
      const gapMs = Date.now() - Date.parse(visitorRow.last_seen_at || visitorRow.created_at);
      // "Visits" counts analytics-style (30-min idle = new visit)…
      const newVisit = !visitorRow.session_started_at || gapMs > 30 * 60 * 1000;
      // …but the live "On site" timer restarts whenever the visitor actually
      // went offline and came back (page navigation keeps them online via the
      // presence grace, so the timer keeps running across pages). The 30-min
      // idle gap is a belt: even if presence somehow says "online", a visitor
      // idle that long starts a fresh session — no absurd hours-long timers.
      const newSession =
        !visitorRow.session_started_at ||
        !deps.presence.isVisitorOnline(visitorRow.id) ||
        gapMs > 30 * 60 * 1000;
      await deps.db.run(
        `UPDATE visitors SET
           last_seen_at = ?,
           user_agent = ?,
           referrer = CASE WHEN ? != '' THEN ? ELSE referrer END,
           total_visits = total_visits + ?,
           session_started_at = CASE WHEN ? = 1 THEN ? ELSE COALESCE(session_started_at, ?) END
         WHERE id = ?`,
        [
          now,
          (asString(socket.handshake.headers['user-agent'] as string) ?? '').slice(0, 500) || null,
          asString(auth.referrer)?.slice(0, 500) ?? '',
          asString(auth.referrer)?.slice(0, 500) ?? '',
          newVisit ? 1 : 0,
          newSession ? 1 : 0,
          now,
          now,
          visitorRow.id,
        ],
      );
      // Page journey entry for this page load.
      const pageUrl = asString(auth.page)?.slice(0, 1000) ?? null;
      if (pageUrl) {
        await deps.db.run(
          'INSERT INTO visitor_pages (id, visitor_id, url, title, created_at) VALUES (?, ?, ?, ?, ?)',
          [newId(), visitorRow.id, pageUrl, asString(auth.pageTitle)?.slice(0, 500) ?? null, now],
        );
      }
      // Capture IP + city/country (best-effort, non-blocking).
      updateVisitorGeo(deps, visitorRow.id, clientIp(socket));
      next();
    })().catch((err: unknown) => {
      next(err instanceof Error ? err : new Error('Widget handshake failed'));
    });
  });

  ns.on('connection', (socket) => {
    const data = socket.data as WidgetSocketData;
    const ctx = widgetCtx.get(socket);
    if (!ctx) {
      socket.disconnect(true);
      return;
    }

    void onWidgetConnected(deps, socket, data, ctx).catch((err: unknown) => {
      console.error('[realtime] widget connect', err);
      socket.emit(EV.AppError, { message: 'Failed to initialise chat' });
    });

    // ── Visitor sends a message ──
    const allowVisitorMsg = makeLimiter(MSG_RATE_MAX, MSG_RATE_WINDOW_MS);
    socket.on(
      EV.WidgetMessage,
      safe(socket, async (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const body = asString(p.body)?.trim().slice(0, MAX_MESSAGE_CHARS);
        const tempId = asString(p.tempId) ?? undefined;
        if (!body) return;
        if (!allowVisitorMsg()) {
          socket.emit(EV.AppError, { message: 'You are sending messages too quickly — please slow down.' });
          return;
        }

        let conv = await getConversation(deps, data.conversationId);
        if (conv && (conv.status === 'CLOSED' || conv.status === 'MISSED')) conv = undefined;
        if (!conv) {
          // Another tab may already have an open conversation for this visitor.
          conv = await deps.db.get<ConversationRow>(
            "SELECT * FROM conversations WHERE visitor_id = ? AND status IN ('WAITING','OFFERED','ACTIVE') ORDER BY created_at DESC LIMIT 1",
            [data.visitorId],
          );
        }

        let isNew = false;
        if (!conv) {
          isNew = true;
          const id = newId();
          await deps.db.run(
            "INSERT INTO conversations (id, website_id, visitor_id, status, assigned_user_id, created_at, activated_at, closed_at) VALUES (?, ?, ?, 'WAITING', NULL, ?, NULL, NULL)",
            [id, data.websiteId, data.visitorId, nowIso()],
          );
          conv = await deps.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [
            id,
          ]);
          if (!conv) throw new Error('Failed to create conversation');
        }

        data.conversationId = conv.id;
        await socket.join(convRoom(conv.id));
        cancelMissedTimer(conv.id);

        const wasOffered = conv.status === 'OFFERED';
        await postMessage(deps, {
          conversationId: conv.id,
          senderType: 'VISITOR',
          body,
          tempId,
        });

        // Auto-capture contact details the visitor typed (email / phone / name).
        if (await captureVisitorInfo(deps, data.visitorId, body)) {
          await emitInboxUpdate(deps, conv.id);
          void broadcastVisitors(deps, data.websiteId);
        }

        if (wasOffered) {
          // Customer replied to a CSR-initiated offer → ACTIVE, no accept step.
          await activateConversation(deps, conv.id);
          return;
        }

        if (isNew) {
          const csrId = await findEligibleCsr(deps, conv.website_id);
          if (csrId) {
            // Assign (stays WAITING until the CSR accepts) + history AUTO.
            await deps.db.run('UPDATE conversations SET assigned_user_id = ? WHERE id = ?', [
              csrId,
              conv.id,
            ]);
            await recordAssignment(deps, conv.id, null, csrId, 'AUTO');
            await emitInboxUpdate(deps, conv.id);
          } else {
            await postMessage(deps, {
              conversationId: conv.id,
              senderType: 'SYSTEM',
              kind: 'SYSTEM',
              body: QUEUE_MESSAGE,
            });
          }
          await emitConversationStatus(deps, conv.id);
        }

        // AI greeter keeps queued visitors company until an agent joins
        // (it re-checks WAITING + unassigned internally, so always safe).
        maybeBotReply(deps, conv.id);
      }),
    );

    // ── Visitor ends the chat ──
    socket.on(
      EV.WidgetEndChat,
      safe(socket, async () => {
        const conv = await getConversation(deps, data.conversationId);
        if (!conv || conv.status === 'CLOSED' || conv.status === 'MISSED') return;
        if (conv.visitor_id !== data.visitorId) return;
        await closeConversation(deps, conv.id);
      }),
    );

    // ── Visitor asks for the transcript by email (widget ⋯ menu) ──
    let lastTranscriptAsk = 0;
    socket.on(
      EV.WidgetEmailTranscript,
      safe(socket, async (_payload: unknown, ack?: unknown) => {
        const reply = typeof ack === 'function' ? (ack as (r: unknown) => void) : () => {};
        if (!deps.config.smtpHost) {
          reply({ error: 'Email is not set up yet — please ask the agent for a copy.' });
          return;
        }
        const now = Date.now();
        if (now - lastTranscriptAsk < 60_000) {
          reply({ error: 'Transcript already sent — check your inbox (and spam).' });
          return;
        }
        const conv = await getConversation(deps, data.conversationId);
        if (!conv || conv.visitor_id !== data.visitorId) {
          reply({ error: 'Start a chat first, then request the transcript.' });
          return;
        }
        const vis = await deps.db.get<{ email: string | null }>(
          'SELECT email FROM visitors WHERE id = ?',
          [data.visitorId],
        );
        if (!vis?.email) {
          reply({ error: 'no-email' }); // widget opens the contact form
          return;
        }
        lastTranscriptAsk = now;
        void sendTranscriptEmail(deps, conv.id);
        reply({ ok: true, email: vis.email });
      }),
    );

    // ── CSAT rating (after close) ──
    socket.on(
      EV.WidgetRate,
      safe(socket, async (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const rating = Math.round(Number(p.rating));
        const comment = asString(p.comment)?.trim().slice(0, 500) || null;
        if (!Number.isFinite(rating) || rating < 1 || rating > 5) return;

        // Rate the visitor's current chat (agent may request feedback
        // mid-conversation) or the most recently closed one — once.
        const conv = await deps.db.get<ConversationRow>(
          `SELECT * FROM conversations WHERE visitor_id = ? AND status IN ('ACTIVE', 'CLOSED')
            ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
          [data.visitorId],
        );
        if (!conv || conv.rating != null) return; // only rate once

        await deps.db.run('UPDATE conversations SET rating = ?, rating_comment = ? WHERE id = ?', [
          rating,
          comment,
          conv.id,
        ]);
        await postMessage(deps, {
          conversationId: conv.id,
          senderType: 'SYSTEM',
          kind: 'SYSTEM',
          body: `Customer rated this chat ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}${comment ? ` — “${comment}”` : ''}`,
        });
        await emitInboxUpdate(deps, conv.id);
      }),
    );

    // ── Typing indicator → agent side ──
    socket.on(
      EV.WidgetTyping,
      safe(socket, (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        if (!data.conversationId) return;
        deps.io
          .of(AGENT_NAMESPACE)
          .to(convRoom(data.conversationId))
          .emit(EV.ChatTyping, {
            conversationId: data.conversationId,
            from: 'VISITOR',
            typing: p.typing === true,
          });
      }),
    );

    // ── Read receipts (visitor read agent messages) ──
    socket.on(
      EV.WidgetRead,
      safe(socket, async (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const messageIds = asStringArray(p.messageIds);
        if (!data.conversationId || messageIds.length === 0) return;
        const readAt = nowIso();
        await deps.db.run(
          `UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_type != 'VISITOR' AND read_at IS NULL AND id IN (${messageIds.map(() => '?').join(',')})`,
          [readAt, data.conversationId, ...messageIds],
        );
        const receipt = { conversationId: data.conversationId, messageIds, readAt };
        deps.io.of(AGENT_NAMESPACE).to(convRoom(data.conversationId)).emit(EV.ChatReceipt, receipt);
        deps.io.of(WIDGET_NAMESPACE).to(convRoom(data.conversationId)).emit(EV.ChatReceipt, receipt);
      }),
    );

    // ── Visitor identifies themselves ──
    socket.on(
      EV.WidgetInfo,
      safe(socket, async (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const name = asString(p.name)?.trim();
        const email = asString(p.email)?.trim();
        if (!name && !email) return;
        if (name) {
          await deps.db.run('UPDATE visitors SET name = ? WHERE id = ?', [name, data.visitorId]);
        }
        if (email) {
          await deps.db.run('UPDATE visitors SET email = ? WHERE id = ?', [email, data.visitorId]);
        }
        await broadcastVisitors(deps, data.websiteId);
        if (data.conversationId) await emitInboxUpdate(deps, data.conversationId);
      }),
    );

    // ── Calls (contract implemented by the features agent) ──
    registerWidgetCallHandlers(deps, socket);

    // ── Disconnect ──
    // A page reload/navigation closes this socket for a second — the presence
    // store keeps the visitor online through a grace window, and the real
    // offline handling lives in the setVisitorOfflineListener callback.
    // last_seen_at is stamped HERE too, so "Last seen" stays truthful even if
    // a server restart wipes the pending grace timer.
    socket.on('disconnect', () => {
      void deps.db
        .run('UPDATE visitors SET last_seen_at = ? WHERE id = ?', [nowIso(), data.visitorId])
        .catch(() => undefined);
      deps.presence.removeVisitor(data.websiteId, data.visitorId, socket.id);
    });
  });
}

async function onWidgetConnected(
  deps: AppDeps,
  socket: Socket,
  data: WidgetSocketData,
  ctx: { visitorToken: string; page: string | null; websiteRow: WebsiteRow },
): Promise<void> {
  deps.presence.addVisitor(data.websiteId, data.visitorId, socket.id, ctx.page);
  await deps.db.run('UPDATE visitors SET last_seen_at = ? WHERE id = ?', [
    nowIso(),
    data.visitorId,
  ]);

  // Heartbeat: long visits keep last_seen_at fresh (~60s accuracy) even if
  // the process restarts mid-visit and never sees this socket disconnect.
  const heartbeat = setInterval(() => {
    void deps.db
      .run('UPDATE visitors SET last_seen_at = ? WHERE id = ?', [nowIso(), data.visitorId])
      .catch(() => undefined);
  }, 60_000);
  heartbeat.unref?.();
  socket.on('disconnect', () => clearInterval(heartbeat));

  // Resume the open conversation, if any.
  const conv = await deps.db.get<ConversationRow>(
    "SELECT * FROM conversations WHERE visitor_id = ? AND status IN ('WAITING','OFFERED','ACTIVE') ORDER BY created_at DESC LIMIT 1",
    [data.visitorId],
  );

  let conversation = null;
  let messages: unknown[] = [];
  let agent: { name: string; avatarColor: string; avatarUrl?: string | null } | null = null;

  if (conv) {
    data.conversationId = conv.id;
    await socket.join(convRoom(conv.id));
    if (conv.status === 'OFFERED') cancelMissedTimer(conv.id);
    conversation = (await loadSummary(deps, conv.id)) ?? null;
    // Bounded: only the latest 150 messages ride the widget handshake.
    const rows = await deps.db.all<MessageRow>(
      'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 150) t ORDER BY created_at ASC, id ASC',
      [conv.id],
    );
    messages = await hydrateMessages(deps, rows);
    if (conv.assigned_user_id) {
      const assigned = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [
        conv.assigned_user_id,
      ]);
      if (assigned) {
        agent = {
          name: assigned.name,
          avatarColor: assigned.avatar_color,
          avatarUrl: assigned.avatar_url ?? null,
        };
      }
    }
  }

  const visitorRow = await deps.db.get<VisitorRow>('SELECT * FROM visitors WHERE id = ?', [
    data.visitorId,
  ]);

  socket.emit(EV.WidgetReady, {
    visitorToken: ctx.visitorToken,
    visitor: visitorRow ? toVisitor(visitorRow, true, ctx.page) : null,
    website: toBranding(ctx.websiteRow),
    conversation,
    messages,
    agent,
  });

  await broadcastVisitors(deps, data.websiteId);
}

// ═════════════════════════════ /agent ════════════════════════

function attachAgentNamespace(deps: AppDeps, ns: Namespace): void {
  ns.use((socket, next) => {
    void (async () => {
      const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
      const token = asString(auth.token);
      if (!token) return next(new Error('Missing token'));
      const payload = verifyToken<AgentTokenPayload>(deps.config, token);
      if (!payload || payload.typ !== 'agent') return next(new Error('Unauthorized'));
      const user = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [payload.sub]);
      if (!user) return next(new Error('Unauthorized'));
      // Per-user IP allow-list also gates the realtime socket.
      if (!ipAllowed(user.allowed_ips, clientIp(socket) ?? '')) {
        return next(new Error('Access is not allowed from your network.'));
      }

      const data = socket.data as AgentSocketData;
      data.userId = user.id;
      data.role = user.role;
      data.name = user.name;
      agentCtx.set(socket, { user });
      next();
    })().catch((err: unknown) => {
      next(err instanceof Error ? err : new Error('Agent handshake failed'));
    });
  });

  ns.on('connection', (socket) => {
    const data = socket.data as AgentSocketData;

    void onAgentConnected(deps, socket, data).catch((err: unknown) => {
      console.error('[realtime] agent connect', err);
      socket.emit(EV.AppError, { message: 'Failed to initialise session' });
    });

    // ── Open a conversation (ack: {conversation, messages, history}) ──
    socket.on(
      EV.AgentOpen,
      safe(socket, async (payload: unknown, ack?: unknown) => {
        const reply = typeof ack === 'function' ? (ack as (res: unknown) => void) : () => {};
        const p = (payload ?? {}) as Record<string, unknown>;
        const conv = await getConversation(deps, asString(p.conversationId));
        if (!conv) {
          reply({ error: 'Conversation not found' });
          return;
        }
        // MANAGER may open anything to watch; everyone else needs manage access.
        const allowed =
          data.role === 'MANAGER' ||
          (await canManageConversation(deps, conv, data.userId, data.role));
        if (!allowed) {
          reply({ error: 'Forbidden' });
          socket.emit(EV.AppError, { message: 'You do not have access to this conversation' });
          return;
        }
        await socket.join(convRoom(conv.id));
        const [conversation, rows, history] = await Promise.all([
          loadSummary(deps, conv.id),
          // Bounded: agents get the latest 300 messages on open.
          deps.db.all<MessageRow>(
            'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 300) t ORDER BY created_at ASC, id ASC',
            [conv.id],
          ),
          loadHistory(deps, conv.id),
        ]);
        const messages = await hydrateMessages(deps, rows);
        reply({ conversation, messages, history });
      }),
    );

    // ── Agent sends a message ──
    const allowAgentMsg = makeLimiter(MSG_RATE_MAX * 2, MSG_RATE_WINDOW_MS);
    socket.on(
      EV.AgentMessage,
      safe(socket, async (payload: unknown) => {
        if (!allowAgentMsg()) return;
        if (data.role === 'MANAGER') {
          socket.emit(EV.AppError, { message: 'Managers have view-only access' });
          return;
        }
        const p = (payload ?? {}) as Record<string, unknown>;
        const body = asString(p.body)?.trim().slice(0, MAX_MESSAGE_CHARS);
        const tempId = asString(p.tempId) ?? undefined;
        const conv = await getConversation(deps, asString(p.conversationId));
        if (!conv || !body) return;
        if (conv.status === 'CLOSED' || conv.status === 'MISSED') {
          socket.emit(EV.AppError, { message: 'Conversation is closed' });
          return;
        }
        if (conv.status === 'WAITING') {
          // Zendesk-style "start typing to join": messaging a queued chat claims it.
          const isMine = conv.assigned_user_id === data.userId;
          const isBoss = data.role === 'LEAD' || data.role === 'ADMIN';
          const allowed =
            isMine ||
            (isBoss
              ? await canManageConversation(deps, conv, data.userId, data.role)
              : !conv.assigned_user_id &&
                (await userCanAccessWebsite(deps, data.userId, data.role, conv.website_id)));
          if (!allowed) {
            socket.emit(EV.AppError, { message: 'This conversation is not assigned to you' });
            return;
          }
          if (!isMine) {
            await recordAssignment(
              deps,
              conv.id,
              conv.assigned_user_id,
              data.userId,
              conv.assigned_user_id ? 'TRANSFER' : 'AUTO',
            );
            await deps.db.run('UPDATE conversations SET assigned_user_id = ? WHERE id = ?', [
              data.userId,
              conv.id,
            ]);
          }
          await socket.join(convRoom(conv.id));
          await postMessage(deps, {
            conversationId: conv.id,
            senderType: 'SYSTEM',
            kind: 'SYSTEM',
            body: `${data.name} has joined the chat`,
          });
          await activateConversation(deps, conv.id);
        } else if (!(await canSendAsAgent(deps, conv, data.userId, data.role))) {
          socket.emit(EV.AppError, { message: 'Only the assigned agent can send messages here' });
          return;
        }
        await postMessage(deps, {
          conversationId: conv.id,
          senderType: 'AGENT',
          senderUserId: data.userId,
          body,
          tempId,
        });
      }),
    );

    // ── CSR-initiated chat → OFFERED ──
    socket.on(
      EV.AgentStartChat,
      safe(socket, async (payload: unknown, ack?: unknown) => {
        const reply =
          typeof ack === 'function' ? (ack as (r: { conversationId: string }) => void) : null;
        if (data.role === 'MANAGER') {
          socket.emit(EV.AppError, { message: 'Managers have view-only access' });
          return;
        }
        const p = (payload ?? {}) as Record<string, unknown>;
        const websiteId = asString(p.websiteId);
        const visitorId = asString(p.visitorId);
        const body = asString(p.body)?.trim();
        if (!websiteId || !visitorId || !body) return;

        if (!(await userCanAccessWebsite(deps, data.userId, data.role, websiteId))) {
          socket.emit(EV.AppError, { message: 'You do not have access to this website' });
          return;
        }
        const visitor = await deps.db.get<VisitorRow>(
          'SELECT * FROM visitors WHERE id = ? AND website_id = ?',
          [visitorId, websiteId],
        );
        if (!visitor) {
          socket.emit(EV.AppError, { message: 'Visitor not found' });
          return;
        }
        const open = await deps.db.get<ConversationRow>(
          "SELECT * FROM conversations WHERE visitor_id = ? AND status IN ('WAITING','OFFERED','ACTIVE') LIMIT 1",
          [visitorId],
        );
        if (open) {
          // Already an open conversation — post into it (when allowed) and
          // hand its id back so the client opens that chat instead of erroring.
          await socket.join(convRoom(open.id));
          if (await canSendAsAgent(deps, open, data.userId, data.role)) {
            await postMessage(deps, {
              conversationId: open.id,
              senderType: 'AGENT',
              senderUserId: data.userId,
              body,
            });
          }
          reply?.({ conversationId: open.id });
          return;
        }

        const conversationId = newId();
        await deps.db.run(
          "INSERT INTO conversations (id, website_id, visitor_id, status, assigned_user_id, created_at, activated_at, closed_at) VALUES (?, ?, ?, 'OFFERED', ?, ?, NULL, NULL)",
          [conversationId, websiteId, visitorId, data.userId, nowIso()],
        );
        await recordAssignment(deps, conversationId, null, data.userId, 'OFFER');
        await socket.join(convRoom(conversationId));

        // Pull the visitor's live widget sockets into the conversation room so
        // they receive the opening message + status immediately.
        for (const ws of deps.io.of(WIDGET_NAMESPACE).sockets.values()) {
          const wd = ws.data as Partial<WidgetSocketData>;
          if (wd.visitorId === visitorId) {
            await ws.join(convRoom(conversationId));
            wd.conversationId = conversationId;
          }
        }

        await postMessage(deps, {
          conversationId,
          senderType: 'AGENT',
          senderUserId: data.userId,
          body,
        });
        await emitConversationStatus(deps, conversationId);
        await emitConversationAgent(deps, conversationId);

        // Visitor not around? Start the 10-minute missed countdown right away.
        if (!deps.presence.isVisitorOnline(visitorId)) scheduleMissedTimer(deps, conversationId);
        reply?.({ conversationId });
      }),
    );

    // ── Accept (WAITING → ACTIVE) ──
    socket.on(
      EV.AgentAccept,
      safe(socket, async (payload: unknown) => {
        if (data.role === 'MANAGER') {
          socket.emit(EV.AppError, { message: 'Managers have view-only access' });
          return;
        }
        const p = (payload ?? {}) as Record<string, unknown>;
        const conv = await getConversation(deps, asString(p.conversationId));
        if (!conv) return;
        if (conv.status !== 'WAITING') {
          socket.emit(EV.AppError, { message: 'Conversation is not waiting to be accepted' });
          return;
        }
        if (conv.assigned_user_id !== data.userId) {
          // A LEAD/ADMIN may take the chat over — record the hand-off.
          if (data.role !== 'LEAD' && data.role !== 'ADMIN') {
            socket.emit(EV.AppError, { message: 'This conversation is not assigned to you' });
            return;
          }
          if (!(await canManageConversation(deps, conv, data.userId, data.role))) {
            socket.emit(EV.AppError, { message: 'You do not have access to this conversation' });
            return;
          }
          await recordAssignment(
            deps,
            conv.id,
            conv.assigned_user_id,
            data.userId,
            conv.assigned_user_id ? 'TRANSFER' : 'AUTO',
          );
          await deps.db.run('UPDATE conversations SET assigned_user_id = ? WHERE id = ?', [
            data.userId,
            conv.id,
          ]);
        }
        await socket.join(convRoom(conv.id));
        await postMessage(deps, {
          conversationId: conv.id,
          senderType: 'SYSTEM',
          kind: 'SYSTEM',
          body: `${data.name} has joined the chat`,
        });
        await activateConversation(deps, conv.id);
      }),
    );

    // ── Close ──
    socket.on(
      EV.AgentClose,
      safe(socket, async (payload: unknown) => {
        if (data.role === 'MANAGER') {
          socket.emit(EV.AppError, { message: 'Managers have view-only access' });
          return;
        }
        const p = (payload ?? {}) as Record<string, unknown>;
        const conv = await getConversation(deps, asString(p.conversationId));
        if (!conv) return;
        if (!(await canManageConversation(deps, conv, data.userId, data.role))) {
          socket.emit(EV.AppError, { message: 'You cannot close this conversation' });
          return;
        }
        cancelMissedTimer(conv.id);
        await closeConversation(deps, conv.id);
      }),
    );

    // ── Transfer ──
    socket.on(
      EV.AgentTransfer,
      safe(socket, async (payload: unknown) => {
        if (data.role === 'MANAGER') {
          socket.emit(EV.AppError, { message: 'Managers have view-only access' });
          return;
        }
        const p = (payload ?? {}) as Record<string, unknown>;
        const toUserId = asString(p.toUserId);
        const conv = await getConversation(deps, asString(p.conversationId));
        if (!conv || !toUserId) return;
        if (!(await canManageConversation(deps, conv, data.userId, data.role))) {
          socket.emit(EV.AppError, { message: 'You cannot transfer this conversation' });
          return;
        }
        if (toUserId === conv.assigned_user_id) {
          socket.emit(EV.AppError, { message: 'Conversation is already assigned to that agent' });
          return;
        }
        const target = await deps.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [toUserId]);
        if (!target) {
          socket.emit(EV.AppError, { message: 'Target agent not found' });
          return;
        }
        if (target.role === 'MANAGER') {
          socket.emit(EV.AppError, { message: 'Managers cannot take chats' });
          return;
        }
        const isMember = await userCanAccessWebsite(
          deps,
          target.id,
          target.role,
          conv.website_id,
        );
        if (!isMember || !(await hasCapacity(deps, target))) {
          socket.emit(EV.AppError, { message: `${target.name} is not available right now` });
          return;
        }
        await transferConversation(deps, conv.id, conv.assigned_user_id, toUserId);
      }),
    );

    // ── Typing indicator → widget side ──
    socket.on(
      EV.AgentTyping,
      safe(socket, (payload: unknown) => {
        if (data.role === 'MANAGER') return; // watchers never show as typing
        const p = (payload ?? {}) as Record<string, unknown>;
        const conversationId = asString(p.conversationId);
        if (!conversationId) return;
        deps.io
          .of(WIDGET_NAMESPACE)
          .to(convRoom(conversationId))
          .emit(EV.ChatTyping, {
            conversationId,
            from: 'AGENT',
            typing: p.typing === true,
          });
      }),
    );

    // ── Read receipts (agent read visitor messages) ──
    socket.on(
      EV.AgentRead,
      safe(socket, async (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const messageIds = asStringArray(p.messageIds);
        const conv = await getConversation(deps, asString(p.conversationId));
        if (!conv || messageIds.length === 0) return;
        if (!(await canSendAsAgent(deps, conv, data.userId, data.role))) return;
        const readAt = nowIso();
        await deps.db.run(
          `UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_type = 'VISITOR' AND read_at IS NULL AND id IN (${messageIds.map(() => '?').join(',')})`,
          [readAt, conv.id, ...messageIds],
        );
        const receipt = { conversationId: conv.id, messageIds, readAt };
        deps.io.of(WIDGET_NAMESPACE).to(convRoom(conv.id)).emit(EV.ChatReceipt, receipt);
        deps.io.of(AGENT_NAMESPACE).to(convRoom(conv.id)).emit(EV.ChatReceipt, receipt);
        await emitInboxUpdate(deps, conv.id);
      }),
    );

    // ── Request feedback: pops the rating stars on the visitor's widget ──
    socket.on(
      EV.AgentRequestFeedback,
      safe(socket, async (payload: unknown) => {
        if (data.role === 'MANAGER') {
          socket.emit(EV.AppError, { message: 'Managers have view-only access' });
          return;
        }
        const p = (payload ?? {}) as Record<string, unknown>;
        const conv = await getConversation(deps, asString(p.conversationId));
        if (!conv) return;
        if (conv.status !== 'ACTIVE') {
          socket.emit(EV.AppError, { message: 'Feedback can only be requested in an active chat' });
          return;
        }
        if (!(await canSendAsAgent(deps, conv, data.userId, data.role))) {
          socket.emit(EV.AppError, { message: 'Only the assigned agent can request feedback' });
          return;
        }
        if (conv.rating != null) {
          socket.emit(EV.AppError, { message: 'The customer already rated this chat' });
          return;
        }
        deps.io.of(WIDGET_NAMESPACE).to(convRoom(conv.id)).emit(EV.ChatFeedbackRequest, {
          conversationId: conv.id,
        });
        await postMessage(deps, {
          conversationId: conv.id,
          senderType: 'SYSTEM',
          kind: 'SYSTEM',
          body: `${data.name} requested feedback — the customer can now rate this chat ⭐`,
        });
      }),
    );

    // ── Watch a website (visitor list + inbox fan-out) ──
    socket.on(
      EV.AgentWatchWebsite,
      safe(socket, async (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const websiteId = asString(p.websiteId);
        if (!websiteId) return;
        if (!(await userCanAccessWebsite(deps, data.userId, data.role, websiteId))) {
          socket.emit(EV.AppError, { message: 'You do not have access to this website' });
          return;
        }
        await socket.join(websiteRoom(websiteId));
        socket.emit(EV.VisitorsUpdate, {
          websiteId,
          visitors: await buildVisitorList(deps, websiteId),
        });
      }),
    );

    // ── Manual availability (Online / Away) ──
    socket.on(
      EV.AgentSetAway,
      safe(socket, async (payload: unknown) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        const away = p.away === true;
        deps.presence.setAgentAway(data.userId, away);
        deps.io
          .of(AGENT_NAMESPACE)
          .emit(EV.PresenceUpdate, { userId: data.userId, online: true, away });
        // Coming back available may pick up queued chats.
        if (!away) {
          const sites = await deps.db.all<{ website_id: string }>(
            'SELECT DISTINCT website_id FROM conversations WHERE status = ?',
            ['WAITING'],
          );
          for (const s of sites) await drainQueue(deps, s.website_id);
        }
      }),
    );

    // ── Calls (contract implemented by the features agent) ──
    registerAgentCallHandlers(deps, socket);

    // ── Disconnect ──
    socket.on('disconnect', () => {
      const wentOffline = deps.presence.removeAgent(data.userId, socket.id);
      if (wentOffline) {
        deps.io.of(AGENT_NAMESPACE).emit(EV.PresenceUpdate, { userId: data.userId, online: false });
      }
    });
  });
}

async function onAgentConnected(
  deps: AppDeps,
  socket: Socket,
  data: AgentSocketData,
): Promise<void> {
  const ctx = agentCtx.get(socket);
  if (!ctx) {
    socket.disconnect(true);
    return;
  }

  const cameOnline = deps.presence.addAgent(data.userId, socket.id);
  await socket.join(userRoom(data.userId));
  if (cameOnline) {
    deps.io.of(AGENT_NAMESPACE).emit(EV.PresenceUpdate, { userId: data.userId, online: true });
  }

  // Scoped websites + teams (ADMIN/MANAGER = all; others via team membership).
  const isAdmin = data.role === 'ADMIN' || data.role === 'MANAGER';
  const websiteRows = isAdmin
    ? await deps.db.all<WebsiteRow>('SELECT * FROM websites ORDER BY name ASC')
    : await deps.db.all<WebsiteRow>(
        'SELECT w.* FROM websites w JOIN team_members tm ON tm.team_id = w.team_id WHERE tm.user_id = ? ORDER BY w.name ASC',
        [data.userId],
      );
  const websites: Website[] = websiteRows.map((w) => ({
    id: w.id,
    name: w.name,
    label: w.label ?? null,
    logoUrl: w.logo_url,
    primaryColor: w.primary_color,
    greeting: w.greeting,
    widgetKey: w.widget_key,
    domains: (w.domains ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),
    teamId: w.team_id,
  }));

  interface TeamRow {
    id: string;
    name: string;
  }
  const teamRows = isAdmin
    ? await deps.db.all<TeamRow>('SELECT * FROM teams ORDER BY name ASC')
    : await deps.db.all<TeamRow>(
        'SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.name ASC',
        [data.userId],
      );

  const teams: Team[] = [];
  for (const t of teamRows) {
    const memberRows = await deps.db.all<UserRow & { is_lead: number }>(
      'SELECT u.*, tm.is_lead FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ?',
      [t.id],
    );
    teams.push({
      id: t.id,
      name: t.name,
      members: memberRows.map((m) => ({
        ...toUserPublic(m),
        isLead: Number(m.is_lead) === 1,
        online: deps.presence.isAgentOnline(m.id),
        away: deps.presence.isAgentAway(m.id),
      })),
    });
  }

  // A Team Lead's CSR ids ride along so the dashboard can gate the composer.
  const csrIds =
    data.role === 'LEAD'
      ? (
          await deps.db.all<{ id: string }>('SELECT id FROM users WHERE team_lead_id = ?', [
            data.userId,
          ])
        ).map((r) => r.id)
      : [];

  // Include live online/away so the client's availability toggle is correct
  // right after a (re)connect, not reset to "Online".
  const me = {
    ...toUserPublic(ctx.user),
    online: deps.presence.isAgentOnline(ctx.user.id),
    away: deps.presence.isAgentAway(ctx.user.id),
  };
  socket.emit(EV.AgentReady, { me, websites, teams, csrIds });

  // A newly-online agent may free up the queue.
  await drainQueue(deps);
}
