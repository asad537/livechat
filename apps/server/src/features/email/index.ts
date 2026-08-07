// ─────────────────────────────────────────────────────────────
// Email transcript — when a conversation closes, the visitor gets
// a branded copy of the chat by email (if they shared an address
// and SMTP is configured; otherwise this is a silent no-op).
//
// Deliberately self-contained (raw SQL, no domain/* imports) so it
// can be called from domain/conversations without import cycles.
// ─────────────────────────────────────────────────────────────
import type { AppDeps } from '../../core/deps.js';

interface ConvRow {
  id: string;
  website_id: string;
  visitor_id: string;
  closed_at: string | null;
}

interface WebsiteRow {
  name: string;
  primary_color: string;
}

interface VisitorRow {
  name: string | null;
  email: string | null;
}

interface MsgRow {
  sender_type: string;
  body: string | null;
  kind: string;
  created_at: string;
  sender_name: string | null;
  file_name: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transporter: any | null = null;
let warnedOnce = false;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Fire-and-forget: email the transcript to the visitor after close. */
export async function sendTranscriptEmail(deps: AppDeps, conversationId: string): Promise<void> {
  const { config } = deps;
  if (!config.smtpHost) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.log('[email] SMTP not configured — transcript emails disabled (set SMTP_HOST to enable)');
    }
    return;
  }

  try {
    const conv = await deps.db.get<ConvRow>(
      'SELECT id, website_id, visitor_id, closed_at FROM conversations WHERE id = ?',
      [conversationId],
    );
    if (!conv) return;

    const [website, visitor, messages] = await Promise.all([
      deps.db.get<WebsiteRow>('SELECT name, primary_color FROM websites WHERE id = ?', [
        conv.website_id,
      ]),
      deps.db.get<VisitorRow>('SELECT name, email FROM visitors WHERE id = ?', [conv.visitor_id]),
      deps.db.all<MsgRow>(
        `SELECT m.sender_type, m.body, m.kind, m.created_at,
                u.name AS sender_name, f.original_name AS file_name
           FROM messages m
           LEFT JOIN users u ON u.id = m.sender_user_id
           LEFT JOIN files f ON f.id = m.file_id
          WHERE m.conversation_id = ?
          ORDER BY m.created_at ASC`,
        [conversationId],
      ),
    ]);
    if (!website || !visitor?.email) return;

    const rows = messages
      .filter((m) => m.kind !== 'SYSTEM')
      .map((m) => {
        const who =
          m.sender_type === 'VISITOR'
            ? visitor.name || 'You'
            : m.sender_type === 'BOT'
              ? 'AI Assistant'
              : m.sender_name || 'Agent';
        const body =
          m.kind === 'FILE'
            ? `📎 File: ${m.file_name ?? 'attachment'}`
            : m.kind === 'CALL'
              ? `📞 ${m.body ?? 'Call'}`
              : (m.body ?? '');
        const isVisitor = m.sender_type === 'VISITOR';
        return `
          <tr>
            <td style="padding:6px 12px;vertical-align:top;white-space:nowrap;color:#94a3b8;font-size:12px">${fmtTime(m.created_at)}</td>
            <td style="padding:6px 12px;vertical-align:top;font-weight:600;white-space:nowrap;color:${isVisitor ? website.primary_color : '#334155'}">${esc(who)}</td>
            <td style="padding:6px 12px;vertical-align:top;color:#0f172a">${esc(body)}</td>
          </tr>`;
      })
      .join('');

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">
        <div style="background:${website.primary_color};color:#ffffff;padding:22px 24px">
          <div style="font-size:18px;font-weight:800">${esc(website.name)}</div>
          <div style="font-size:13px;opacity:.9;margin-top:2px">Your chat transcript</div>
        </div>
        <div style="padding:18px 12px">
          <table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>
        </div>
        <div style="padding:14px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
          Thanks for chatting with ${esc(website.name)} — reply to this email if you need anything else.
        </div>
      </div>`;

    if (!transporter) {
      const { default: nodemailer } = await import('nodemailer');
      transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? '' } : undefined,
      });
    }

    await transporter.sendMail({
      from: config.smtpFrom || config.smtpUser || `no-reply@${config.smtpHost}`,
      to: visitor.email,
      subject: `Your chat transcript — ${website.name}`,
      html,
    });
    console.log(`[email] transcript sent to ${visitor.email} (conversation ${conversationId})`);
  } catch (err) {
    console.warn('[email] transcript failed:', (err as Error).message);
  }
}
