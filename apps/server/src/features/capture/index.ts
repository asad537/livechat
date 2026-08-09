// ─── Auto-capture visitor contact details from chat messages ──
// Zendesk-style: when a visitor types their email, phone number or name
// in the conversation, save it to the visitor profile automatically.
// Conservative by design — only fills fields that are still empty, never
// overwrites anything an agent or the visitor already set.
import type { AppDeps } from '../../core/deps.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Phone-looking run with separators; validated by digit count below.
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{7,16}\d/;

// Name introductions (English + Roman Urdu). Deliberately narrow.
const NAME_PATTERNS = [
  /\bmy name is\s+([A-Za-z][A-Za-z .'-]{1,40})/i,
  /\bmera naam\s+([A-Za-z][A-Za-z .'-]{1,40})/i,
  /\bname\s*[:=-]\s*([A-Za-z][A-Za-z .'-]{1,40})/i,
  // "this is Hafiz Muhammad" — requires 2+ capitalised words to avoid "this is urgent"
  /\bthis is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/,
];

// Words that mean the "name" match was actually a sentence, not a name.
const NOT_A_NAME =
  /\b(looking|interested|trying|unable|having|asking|waiting|calling|going|sorry|sure|okay|ok|not|very|really|urgent|important)\b/i;

function cleanName(raw: string): string | null {
  let s = raw.trim().replace(/\s+/g, ' ');
  s = s.replace(/[.,!?;:].*$/, ''); // cut at first punctuation
  const words = s
    .split(' ')
    .filter((w) => !/^(ha|hai|hy|h|hain|hun|hoon|and|or|is|se)$/i.test(w))
    .slice(0, 4);
  s = words.join(' ');
  if (s.length < 2 || s.length > 40 || NOT_A_NAME.test(s)) return null;
  return words.map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1)).join(' ');
}

/** Scan a visitor message and fill empty profile fields. Returns true if anything changed. */
export async function captureVisitorInfo(
  deps: AppDeps,
  visitorId: string,
  body: string,
): Promise<boolean> {
  try {
    const row = await deps.db.get<{
      name: string | null;
      email: string | null;
      phone: string | null;
    }>('SELECT name, email, phone FROM visitors WHERE id = ?', [visitorId]);
    if (!row) return false;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (!row.email) {
      const m = body.match(EMAIL_RE);
      if (m) {
        sets.push('email = ?');
        params.push(m[0].slice(0, 255));
      }
    }
    if (!row.phone) {
      const m = body.match(PHONE_RE);
      const digits = m ? m[0].replace(/\D/g, '') : '';
      if (m && digits.length >= 10 && digits.length <= 15) {
        sets.push('phone = ?');
        params.push(m[0].trim().slice(0, 64));
      }
    }
    if (!row.name) {
      for (const re of NAME_PATTERNS) {
        const m = body.match(re);
        const name = m?.[1] ? cleanName(m[1]) : null;
        if (name) {
          sets.push('name = ?');
          params.push(name);
          break;
        }
      }
    }

    if (sets.length === 0) return false;
    params.push(visitorId);
    await deps.db.run(`UPDATE visitors SET ${sets.join(', ')} WHERE id = ?`, params);
    return true;
  } catch {
    return false; // capture is best-effort
  }
}
