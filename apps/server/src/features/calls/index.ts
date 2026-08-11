/**
 * Audio/video calls.
 *
 * Providers:
 *  - BUILTIN (default): P2P WebRTC mesh; SDP/ICE signaling relayed over Socket.IO.
 *    Peers are tracked in a module-level Map<callId, Map<peerId, {socket,label}>>
 *    where peerId = socket.id — sockets are held directly, so relays work across
 *    the /widget and /agent namespaces.
 *  - DAILY (when config.dailyApiKey is set): private api.daily.co room + short-lived
 *    meeting tokens; POST /api/calls/daily-webhook records join/leave/end call_events.
 */
import { Router, type Request, type Response } from 'express';
import type { Socket } from 'socket.io';
import {
  AGENT_NAMESPACE,
  EV,
  WIDGET_NAMESPACE,
  type CallKind,
  type CallMeta,
  type CallProvider,
  type CallStatus,
  type Role,
} from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import type { Config } from '../../core/config.js';
import { newId, nowIso } from '../../core/db.js';
import { postMessage } from '../../domain/messages.js';
import { loadSummary, userCanAccessWebsite } from '../../domain/conversations.js';

// ─── Rows / socket data ──────────────────────────────────────

interface CallRow {
  id: string;
  conversation_id: string;
  kind: CallKind;
  provider: CallProvider;
  status: CallStatus;
  room_url: string | null;
  started_by: string;
  created_at: string;
  ended_at: string | null;
}

interface ConversationRow {
  id: string;
  website_id: string;
  visitor_id: string;
  status: string;
  assigned_user_id: string | null;
}

interface AgentSocketData {
  userId: string;
  role: Role;
  name: string;
}

interface WidgetSocketData {
  visitorId: string;
  websiteId: string;
  conversationId: string | null;
}

type Ack = (payload: unknown) => void;

// ─── BUILTIN signaling state (module-level, peerId = socket.id) ───

interface PeerEntry {
  socket: Socket;
  label: string;
}

const callRooms = new Map<string, Map<string, PeerEntry>>();

// ─── Helpers ─────────────────────────────────────────────────

export function toCallMeta(row: CallRow): CallMeta {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    provider: row.provider,
    status: row.status,
    roomUrl: row.room_url,
    startedBy: row.started_by,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

async function getCall(deps: AppDeps, callId: string): Promise<CallRow | undefined> {
  return deps.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', [callId]);
}

async function getConversation(
  deps: AppDeps,
  conversationId: string,
): Promise<ConversationRow | undefined> {
  return deps.db.get<ConversationRow>(
    'SELECT id, website_id, visitor_id, status, assigned_user_id FROM conversations WHERE id = ?',
    [conversationId],
  );
}

async function recordCallEvent(
  deps: AppDeps,
  callId: string,
  participant: string,
  event: 'INVITED' | 'JOIN' | 'LEAVE' | 'DECLINE' | 'END',
): Promise<void> {
  await deps.db.run(
    'INSERT INTO call_events (id, call_id, participant, event, created_at) VALUES (?, ?, ?, ?, ?)',
    [newId(), callId, participant.slice(0, 64), event, nowIso()],
  );
}

function emitCallStatus(deps: AppDeps, row: CallRow): void {
  const payload = { call: toCallMeta(row) };
  const room = `conv:${row.conversation_id}`;
  deps.io.of(WIDGET_NAMESPACE).to(room).emit(EV.CallStatus, payload);
  deps.io.of(AGENT_NAMESPACE).to(room).emit(EV.CallStatus, payload);
}

function sendError(socket: Socket, message: string): void {
  socket.emit(EV.AppError, { message });
}

// ─── Daily provider (used only when config.dailyApiKey is set) ───

interface DailyRoom {
  name: string;
  url: string;
}

async function dailyPost<T>(config: Config, apiPath: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.daily.co/v1${apiPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.dailyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Daily API ${apiPath} failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

async function createDailyRoom(config: Config, kind: CallKind): Promise<DailyRoom> {
  const room = await dailyPost<DailyRoom>(config, '/rooms', {
    privacy: 'private',
    properties: {
      exp: Math.floor(Date.now() / 1000) + 2 * 60 * 60, // room valid for 2h
      start_video_off: kind === 'AUDIO',
      enable_screenshare: kind === 'VIDEO',
    },
  });
  return room;
}

async function createDailyToken(
  config: Config,
  roomName: string,
  userName: string,
  isOwner: boolean,
): Promise<string> {
  const res = await dailyPost<{ token: string }>(config, '/meeting-tokens', {
    properties: {
      room_name: roomName,
      user_name: userName,
      is_owner: isOwner,
      exp: Math.floor(Date.now() / 1000) + 2 * 60 * 60,
    },
  });
  return res.token;
}

function withDailyToken(meta: CallMeta, token: string | null): CallMeta {
  if (meta.provider !== 'DAILY' || !meta.roomUrl || !token) return meta;
  return { ...meta, roomUrl: `${meta.roomUrl}?t=${token}` };
}

// ─── Shared BUILTIN mesh handlers ────────────────────────────

async function handleJoin(
  deps: AppDeps,
  socket: Socket,
  callId: string,
  label: string,
  participant: string,
): Promise<void> {
  const call = await getCall(deps, callId);
  if (!call || call.status === 'ENDED' || call.status === 'DECLINED') {
    sendError(socket, 'Call is no longer active');
    return;
  }

  let peers = callRooms.get(callId);
  if (!peers) {
    peers = new Map<string, PeerEntry>();
    callRooms.set(callId, peers);
  }
  if (peers.has(socket.id)) return; // already joined

  const existing = [...peers.entries()].map(([peerId, entry]) => ({
    peerId,
    label: entry.label,
  }));
  peers.set(socket.id, { socket, label });
  await recordCallEvent(deps, callId, participant, 'JOIN');

  // Reply with the peers already in the call, then announce the newcomer.
  socket.emit(EV.CallPeers, { callId, peers: existing });
  for (const [peerId, entry] of peers) {
    if (peerId === socket.id) continue;
    entry.socket.emit(EV.CallJoin, { callId, peerId: socket.id, label });
  }
}

function handleSignal(
  socket: Socket,
  payload: { callId?: string; to?: string; data?: unknown },
): void {
  const { callId, to, data } = payload ?? {};
  if (!callId || !to) return;
  const peers = callRooms.get(callId);
  if (!peers || !peers.has(socket.id)) return;
  const target = peers.get(to);
  if (!target) return;
  target.socket.emit(EV.CallSignal, { callId, from: socket.id, data });
}

async function handleLeave(
  deps: AppDeps,
  socket: Socket,
  callId: string,
  participant: string,
): Promise<void> {
  const peers = callRooms.get(callId);
  if (!peers || !peers.has(socket.id)) return;
  peers.delete(socket.id);
  await recordCallEvent(deps, callId, participant, 'LEAVE');

  for (const [, entry] of peers) {
    entry.socket.emit(EV.CallLeave, { callId, peerId: socket.id });
  }

  // A call needs at least two participants — when someone hangs up and
  // one (or zero) remain, end the call for EVERYONE. The remaining
  // participant's UI closes via the ENDED CallStatus broadcast.
  if (peers.size <= 1) {
    callRooms.delete(callId);
    const call = await getCall(deps, callId);
    if (call && call.status !== 'ENDED' && call.status !== 'DECLINED') {
      const endedAt = nowIso();
      await deps.db.run("UPDATE calls SET status = 'ENDED', ended_at = ? WHERE id = ?", [
        endedAt,
        callId,
      ]);
      await recordCallEvent(deps, callId, participant, 'END');
      const updated = await getCall(deps, callId);
      if (updated) emitCallStatus(deps, updated);
    }
  }
}

async function handleDisconnect(
  deps: AppDeps,
  socket: Socket,
  participant: string,
): Promise<void> {
  const memberOf: string[] = [];
  for (const [callId, peers] of callRooms) {
    if (peers.has(socket.id)) memberOf.push(callId);
  }
  for (const callId of memberOf) {
    await handleLeave(deps, socket, callId, participant);
  }
}

// ─── Widget handlers ─────────────────────────────────────────

export function registerWidgetCallHandlers(deps: AppDeps, socket: Socket): void {
  const data = (): WidgetSocketData => socket.data as WidgetSocketData;
  const participant = (): string => `VISITOR:${data().visitorId}`;

  /** Load the call and verify it belongs to this visitor's conversation. */
  const ownCall = async (callId: string): Promise<CallRow | null> => {
    if (!callId) return null;
    const call = await getCall(deps, callId);
    if (!call) return null;
    const conversation = await getConversation(deps, call.conversation_id);
    if (!conversation || conversation.visitor_id !== data().visitorId) return null;
    return call;
  };

  socket.on(EV.WidgetCallAccept, async (payload: { callId?: string }) => {
    try {
      const call = await ownCall(payload?.callId ?? '');
      if (!call) {
        sendError(socket, 'Call not found');
        return;
      }
      if (call.status !== 'INVITED') return;
      await deps.db.run("UPDATE calls SET status = 'ACTIVE' WHERE id = ?", [call.id]);
      const updated = await getCall(deps, call.id);
      if (updated) emitCallStatus(deps, updated);
    } catch (err) {
      console.error('[calls] widget accept failed:', err);
      sendError(socket, 'Could not accept the call');
    }
  });

  socket.on(EV.WidgetCallDecline, async (payload: { callId?: string }) => {
    try {
      const call = await ownCall(payload?.callId ?? '');
      if (!call) {
        sendError(socket, 'Call not found');
        return;
      }
      if (call.status === 'ENDED' || call.status === 'DECLINED') return;
      await deps.db.run("UPDATE calls SET status = 'DECLINED', ended_at = ? WHERE id = ?", [
        nowIso(),
        call.id,
      ]);
      await recordCallEvent(deps, call.id, participant(), 'DECLINE');
      const updated = await getCall(deps, call.id);
      if (updated) emitCallStatus(deps, updated);
    } catch (err) {
      console.error('[calls] widget decline failed:', err);
      sendError(socket, 'Could not decline the call');
    }
  });

  socket.on(EV.CallJoin, async (payload: { callId?: string }) => {
    try {
      const call = await ownCall(payload?.callId ?? '');
      if (!call) {
        sendError(socket, 'Call not found');
        return;
      }
      const visitor = await deps.db.get<{ name: string | null }>(
        'SELECT name FROM visitors WHERE id = ?',
        [data().visitorId],
      );
      await handleJoin(deps, socket, call.id, visitor?.name || 'Visitor', participant());
    } catch (err) {
      console.error('[calls] widget join failed:', err);
      sendError(socket, 'Could not join the call');
    }
  });

  socket.on(EV.CallSignal, (payload: { callId?: string; to?: string; data?: unknown }) => {
    handleSignal(socket, payload);
  });

  socket.on(EV.CallLeave, async (payload: { callId?: string }) => {
    try {
      if (payload?.callId) await handleLeave(deps, socket, payload.callId, participant());
    } catch (err) {
      console.error('[calls] widget leave failed:', err);
    }
  });

  socket.on('disconnect', () => {
    void handleDisconnect(deps, socket, participant()).catch((err) =>
      console.error('[calls] widget disconnect cleanup failed:', err),
    );
  });
}

// ─── Agent handlers ──────────────────────────────────────────

export function registerAgentCallHandlers(deps: AppDeps, socket: Socket): void {
  const data = (): AgentSocketData => socket.data as AgentSocketData;
  const participant = (): string => `AGENT:${data().userId}`;

  /** Assignee, ADMIN, or the assignee's Team Lead may act on a conversation's calls. */
  const canActOnConversation = async (conversation: {
    websiteId: string;
    assignedUserId: string | null;
  }): Promise<boolean> => {
    const { userId, role } = data();
    if (role === 'ADMIN') return true;
    if (role === 'MANAGER') return false; // view-only
    if (conversation.assignedUserId === userId) return true;
    if (role === 'LEAD') {
      if (conversation.assignedUserId) {
        const csr = await deps.db.get<{ id: string }>(
          'SELECT id FROM users WHERE id = ? AND team_lead_id = ?',
          [conversation.assignedUserId, userId],
        );
        return !!csr;
      }
      return userCanAccessWebsite(deps, userId, role, conversation.websiteId);
    }
    return false;
  };

  socket.on(
    EV.AgentCallStart,
    async (payload: { conversationId?: string; kind?: CallKind }, ack?: Ack) => {
      try {
        const conversationId = payload?.conversationId ?? '';
        const kind: CallKind = payload?.kind === 'VIDEO' ? 'VIDEO' : 'AUDIO';
        const summary = await loadSummary(deps, conversationId);
        if (!summary) {
          sendError(socket, 'Conversation not found');
          return;
        }
        if (!(await canActOnConversation(summary))) {
          sendError(socket, 'Not allowed to start a call in this conversation');
          return;
        }

        // Provider selection: DAILY when an API key is configured, else BUILTIN.
        let provider: CallProvider = 'BUILTIN';
        let roomUrl: string | null = null;
        let visitorToken: string | null = null;
        let agentToken: string | null = null;
        if (deps.config.dailyApiKey) {
          try {
            const room = await createDailyRoom(deps.config, kind);
            const visitorName = summary.visitor?.name || 'Visitor';
            [agentToken, visitorToken] = await Promise.all([
              createDailyToken(deps.config, room.name, data().name, true),
              createDailyToken(deps.config, room.name, visitorName, false),
            ]);
            provider = 'DAILY';
            roomUrl = room.url;
          } catch (err) {
            console.warn('[calls] Daily room creation failed — falling back to BUILTIN:', err);
          }
        }

        const callId = newId();
        const startedBy = participant();
        await deps.db.run(
          `INSERT INTO calls (id, conversation_id, kind, provider, status, room_url, started_by, created_at, ended_at)
           VALUES (?, ?, ?, ?, 'INVITED', ?, ?, ?, NULL)`,
          [callId, conversationId, kind, provider, roomUrl, startedBy, nowIso()],
        );
        await recordCallEvent(deps, callId, startedBy, 'INVITED');

        await postMessage(deps, {
          conversationId,
          senderType: 'AGENT',
          senderUserId: data().userId,
          body: kind === 'VIDEO' ? 'Video call' : 'Audio call',
          kind: 'CALL',
          callId,
        });

        const row = await getCall(deps, callId);
        if (!row) return;
        const meta = toCallMeta(row);
        const from = { name: data().name };

        deps.io
          .of(WIDGET_NAMESPACE)
          .to(`conv:${conversationId}`)
          .emit(EV.CallInvite, { call: withDailyToken(meta, visitorToken), from });
        deps.io
          .of(AGENT_NAMESPACE)
          .to(`conv:${conversationId}`)
          .emit(EV.CallStatus, { call: withDailyToken(meta, agentToken) });
        ack?.({ call: withDailyToken(meta, agentToken) });
      } catch (err) {
        console.error('[calls] start failed:', err);
        sendError(socket, 'Could not start the call');
      }
    },
  );

  socket.on(EV.AgentCallInvite, async (payload: { callId?: string; userId?: string }) => {
    try {
      const { callId = '', userId = '' } = payload ?? {};
      const call = await getCall(deps, callId);
      if (!call || call.status === 'ENDED' || call.status === 'DECLINED') {
        sendError(socket, 'Call is no longer active');
        return;
      }
      const conversation = await getConversation(deps, call.conversation_id);
      if (!conversation) {
        sendError(socket, 'Conversation not found');
        return;
      }

      // Requester must be part of the call (or assignee/admin of the conversation).
      const requesterInCall = callRooms.get(callId)?.has(socket.id) ?? false;
      const requesterAllowed =
        requesterInCall ||
        data().role === 'ADMIN' ||
        conversation.assigned_user_id === data().userId;
      if (!requesterAllowed) {
        sendError(socket, 'Not allowed to invite participants to this call');
        return;
      }

      // Invitee must be an ADMIN or a member of the website's team.
      const invitee = await deps.db.get<{ id: string; role: Role; name: string }>(
        'SELECT id, role, name FROM users WHERE id = ?',
        [userId],
      );
      if (!invitee) {
        sendError(socket, 'User not found');
        return;
      }
      if (invitee.role === 'MANAGER') {
        sendError(socket, 'Managers cannot join calls');
        return;
      }
      if (invitee.role !== 'ADMIN') {
        const member = await deps.db.get(
          `SELECT tm.id FROM team_members tm
             JOIN websites w ON w.team_id = tm.team_id
            WHERE w.id = ? AND tm.user_id = ?`,
          [conversation.website_id, userId],
        );
        if (!member) {
          sendError(socket, 'User is not on this website’s team');
          return;
        }
      }

      let meta = toCallMeta(call);
      if (meta.provider === 'DAILY' && deps.config.dailyApiKey && call.room_url) {
        try {
          const roomName = call.room_url.split('/').pop() as string;
          const token = await createDailyToken(deps.config, roomName, invitee.name, false);
          meta = withDailyToken(meta, token);
        } catch (err) {
          console.warn('[calls] Daily token for invitee failed:', err);
        }
      }

      deps.io
        .of(AGENT_NAMESPACE)
        .to(`user:${userId}`)
        .emit(EV.CallInvite, { call: meta, from: { name: data().name } });
    } catch (err) {
      console.error('[calls] invite participant failed:', err);
      sendError(socket, 'Could not invite the participant');
    }
  });

  socket.on(EV.CallJoin, async (payload: { callId?: string }) => {
    try {
      const callId = payload?.callId ?? '';
      const call = await getCall(deps, callId);
      if (!call || call.status === 'ENDED' || call.status === 'DECLINED') {
        sendError(socket, 'Call is no longer active');
        return;
      }
      const conversation = await getConversation(deps, call.conversation_id);
      if (!conversation) {
        sendError(socket, 'Conversation not found');
        return;
      }
      const { userId, role } = data();
      const allowed =
        role === 'ADMIN' ||
        conversation.assigned_user_id === userId ||
        (await userCanAccessWebsite(deps, userId, role, conversation.website_id));
      if (!allowed) {
        sendError(socket, 'Not allowed to join this call');
        return;
      }
      await handleJoin(deps, socket, callId, data().name, participant());
    } catch (err) {
      console.error('[calls] agent join failed:', err);
      sendError(socket, 'Could not join the call');
    }
  });

  socket.on(EV.CallSignal, (payload: { callId?: string; to?: string; data?: unknown }) => {
    handleSignal(socket, payload);
  });

  socket.on(EV.CallLeave, async (payload: { callId?: string }) => {
    try {
      if (payload?.callId) await handleLeave(deps, socket, payload.callId, participant());
    } catch (err) {
      console.error('[calls] agent leave failed:', err);
    }
  });

  socket.on('disconnect', () => {
    void handleDisconnect(deps, socket, participant()).catch((err) =>
      console.error('[calls] agent disconnect cleanup failed:', err),
    );
  });
}

// ─── REST: Daily webhook ─────────────────────────────────────

export function buildCallsRouter(deps: AppDeps): Router {
  const router = Router();

  /**
   * Daily.co webhook — records participant join/leave and meeting end into
   * call_events, and finalizes the call row when the meeting ends.
   */
  router.post('/api/calls/daily-webhook', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const type = String(body.type ?? '');
      const payload = (body.payload ?? {}) as Record<string, unknown>;
      const roomName = String(payload.room ?? payload.room_name ?? body.room ?? '');

      const eventMap: Record<string, 'JOIN' | 'LEAVE' | 'END'> = {
        'participant.joined': 'JOIN',
        'participant.left': 'LEAVE',
        'meeting.ended': 'END',
      };
      const event = eventMap[type];
      if (!event || !roomName) {
        res.json({ ok: true, ignored: true });
        return;
      }

      const call = await deps.db.get<CallRow>(
        "SELECT * FROM calls WHERE provider = 'DAILY' AND room_url LIKE ? ORDER BY created_at DESC LIMIT 1",
        [`%/${roomName}`],
      );
      if (!call) {
        res.json({ ok: true, ignored: true });
        return;
      }

      const who = String(payload.user_name ?? payload.user_id ?? 'daily-participant');
      await recordCallEvent(deps, call.id, who, event);

      if (event === 'JOIN' && call.status === 'INVITED') {
        await deps.db.run("UPDATE calls SET status = 'ACTIVE' WHERE id = ?", [call.id]);
        const updated = await getCall(deps, call.id);
        if (updated) emitCallStatus(deps, updated);
      }

      if (event === 'END' && call.status !== 'ENDED' && call.status !== 'DECLINED') {
        await deps.db.run("UPDATE calls SET status = 'ENDED', ended_at = ? WHERE id = ?", [
          nowIso(),
          call.id,
        ]);
        const updated = await getCall(deps, call.id);
        if (updated) emitCallStatus(deps, updated);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[calls] daily webhook failed:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}
