// ─────────────────────────────────────────────────────────────
// AI greeter — keeps the customer company while they wait in the
// queue (conversation WAITING and unassigned). Replies come from
// the Claude API when ANTHROPIC_API_KEY is set; otherwise a
// built-in rule-based assistant answers. The bot goes quiet the
// moment a human agent is assigned/accepts.
//
// Messages are stored with sender_type 'BOT' and hydrate with the
// BOT_SENDER identity, so both the widget and the dashboard render
// them as "AI Assistant" bubbles — including after reloads.
// ─────────────────────────────────────────────────────────────
import { EV, WIDGET_NAMESPACE, type ChatMessage } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';
import { postMessage, type MessageRow } from '../../domain/messages.js';

interface ConvRow {
  id: string;
  website_id: string;
  visitor_id: string;
  status: string;
  assigned_user_id: string | null;
}

interface WebsiteRow {
  id: string;
  name: string;
  greeting: string;
  primary_color: string;
}

interface VisitorRow {
  id: string;
  name: string | null;
  email: string | null;
}

/** Per-conversation lock so overlapping visitor messages produce one reply. */
const inFlight = new Set<string>();
/** Conversations where the built-in bot already introduced itself. */
const greeted = new Set<string>();

const HISTORY_LIMIT = 14;
const DEBOUNCE_MS = 900;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fire-and-forget entry point — call after a VISITOR message is posted.
 * Replies only while the conversation is queued (WAITING + unassigned).
 */
export function maybeBotReply(deps: AppDeps, conversationId: string): void {
  if (!deps.config.aiGreeter) return;
  if (inFlight.has(conversationId)) return;
  inFlight.add(conversationId);

  void (async () => {
    try {
      // Small debounce so rapid-fire visitor messages get one combined answer.
      await sleep(DEBOUNCE_MS);

      const conv = await deps.db.get<ConvRow>(
        'SELECT id, website_id, visitor_id, status, assigned_user_id FROM conversations WHERE id = ?',
        [conversationId],
      );
      // Bot only speaks while the visitor is genuinely waiting in the queue.
      if (!conv || conv.status !== 'WAITING' || conv.assigned_user_id !== null) return;

      const [website, visitor, history] = await Promise.all([
        deps.db.get<WebsiteRow>(
          'SELECT id, name, greeting, primary_color FROM websites WHERE id = ?',
          [conv.website_id],
        ),
        deps.db.get<VisitorRow>('SELECT id, name, email FROM visitors WHERE id = ?', [
          conv.visitor_id,
        ]),
        deps.db.all<MessageRow>(
          `SELECT * FROM messages WHERE conversation_id = ? AND kind = 'TEXT' ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}`,
          [conversationId],
        ),
      ]);
      if (!website) return;
      history.reverse();

      // "AI is typing…" on the customer side while we generate.
      const room = `conv:${conversationId}`;
      deps.io.of(WIDGET_NAMESPACE).to(room).emit(EV.ChatTyping, {
        conversationId,
        from: 'AGENT',
        typing: true,
      });

      let reply: string | null = null;
      try {
        reply = deps.config.anthropicApiKey
          ? await claudeReply(deps, website, visitor ?? null, history)
          : builtinReply(conversationId, website, history);
      } finally {
        deps.io.of(WIDGET_NAMESPACE).to(room).emit(EV.ChatTyping, {
          conversationId,
          from: 'AGENT',
          typing: false,
        });
      }
      if (!reply) return;

      // Re-check: a human may have been assigned while we were generating.
      const fresh = await deps.db.get<ConvRow>(
        'SELECT id, website_id, visitor_id, status, assigned_user_id FROM conversations WHERE id = ?',
        [conversationId],
      );
      if (!fresh || fresh.status !== 'WAITING' || fresh.assigned_user_id !== null) return;

      await postMessage(deps, {
        conversationId,
        senderType: 'BOT',
        body: reply,
      });
    } catch (err) {
      console.warn('[aibot] reply failed:', (err as Error).message);
    } finally {
      inFlight.delete(conversationId);
    }
  })();
}

// ─── Claude-powered reply ────────────────────────────────────

function toClaudeMessages(
  history: MessageRow[],
): { role: 'user' | 'assistant'; content: string }[] {
  const msgs = history
    .filter((m) => (m.sender_type === 'VISITOR' || m.sender_type === 'BOT') && m.body)
    .map((m) => ({
      role: m.sender_type === 'VISITOR' ? ('user' as const) : ('assistant' as const),
      content: m.body as string,
    }));
  // The API requires the first message to be a user turn.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

async function claudeReply(
  deps: AppDeps,
  website: WebsiteRow,
  visitor: VisitorRow | null,
  history: MessageRow[],
): Promise<string | null> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: deps.config.anthropicApiKey! });

  const messages = toClaudeMessages(history);
  if (messages.length === 0) return null;

  const response = await client.messages.create({
    model: deps.config.aiModel,
    max_tokens: 400,
    system:
      `You are the AI assistant on the live-chat widget of "${website.name}". ` +
      `All human support agents are currently busy; you are keeping the customer company until one joins. ` +
      `Website greeting (tone reference): "${website.greeting}". ` +
      (visitor?.name ? `The customer's name is ${visitor.name}. ` : '') +
      `Reply in the same language the customer writes in. Keep replies short (1-3 sentences), warm and helpful. ` +
      `Answer general questions where you safely can, and collect useful details (order number, issue summary, contact info) so the human agent can start faster. ` +
      `Never invent order status, prices, refunds, or policies specific to ${website.name} — for those, say a human agent will confirm shortly. ` +
      `Do not promise exact wait times.`,
    messages,
  });

  if (response.stop_reason === 'refusal') return null;
  const text = response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  return text || null;
}

// ─── Built-in rule-based fallback (no API key needed) ────────

function builtinReply(
  conversationId: string,
  website: WebsiteRow,
  history: MessageRow[],
): string | null {
  const lastVisitor = [...history].reverse().find((m) => m.sender_type === 'VISITOR');
  const text = (lastVisitor?.body ?? '').toLowerCase();

  if (!greeted.has(conversationId)) {
    greeted.add(conversationId);
    return (
      `Hi! I'm the ${website.name} AI assistant 🤖 All of our agents are helping other customers right now, ` +
      `but I've saved your spot in the queue. While we wait — could you share a few details about what you need help with? ` +
      `That way the agent can jump straight in.`
    );
  }

  if (/(price|cost|rate|charge|kitna|qeemat)/.test(text)) {
    return `Good question! I don't want to quote you a wrong price — an agent will confirm the exact pricing as soon as they join. Anything else I can note down for them?`;
  }
  if (/(order|delivery|track|parcel|shipment)/.test(text)) {
    return `Got it — I've noted this is about an order/delivery. If you have an order number, drop it here and the agent will have it ready when they join.`;
  }
  if (/(refund|return|cancel)/.test(text)) {
    return `Understood — I've flagged this as a refund/return request. An agent will confirm the policy details with you shortly.`;
  }
  if (/(thank|thanks|shukriya|ok|okay)/.test(text)) {
    return `You're welcome! You're still in the queue — an agent will be with you shortly. 😊`;
  }
  return `Thanks — I've added that to your conversation notes so the agent has full context when they join. Is there anything else you'd like me to pass along?`;
}
