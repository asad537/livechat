// ─────────────────────────────────────────────────────────────
// Auto-translate (cross-language chat) — reuses the same AI engine
// as the greeter bot, so it costs nothing extra beyond the key you
// already configured (Groq / Gemini free tiers, or Anthropic).
//
// Direction:
//   • VISITOR message → translated to English for the agent, and the
//     visitor's detected language is cached on the visitor row.
//   • AGENT  message → translated to the visitor's language.
//   • BOT / SYSTEM messages are skipped (the greeter already mirrors
//     the visitor's language; system notes are UI chrome).
//
// The translation is stored on the message row (`translated_body` +
// `orig_lang`) and carried on the ChatMessage, so each side renders
// the version in its own language with a "show original" toggle —
// no extra socket events, and it survives reloads.
// ─────────────────────────────────────────────────────────────
import { AGENT_NAMESPACE, WIDGET_NAMESPACE, EV, type ChatMessage } from '@livechat/shared';
import type { AppDeps } from '../../core/deps.js';

/** The agent/dashboard language. Everything visitors say is normalised to this. */
const AGENT_LANG = 'en';

interface ConvLite {
  website_id: string;
  visitor_id: string;
}

/** A few friendly names to steer the model; unknown codes fall back to the code. */
const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ur: 'Urdu',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  tr: 'Turkish',
  ru: 'Russian',
  hi: 'Hindi',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  fa: 'Persian',
  pl: 'Polish',
};

function langName(code: string): string {
  return LANG_NAMES[code.toLowerCase()] ?? code;
}

/** True when this deployment can translate at all. The primary engine is the
    free, keyless Google endpoint, so no AI key is required — only the toggle. */
export function translationEnabled(deps: AppDeps): boolean {
  return deps.config.autoTranslate;
}

// ─── One AI round-trip: detect source language + translate ───

interface TranslateResult {
  /** ISO 639-1 code of the source text. */
  lang: string;
  /** The text rendered in the target language (unchanged if already target). */
  text: string;
}

function buildPrompt(target: string): string {
  const targetName = langName(target);
  return (
    `You are a translation engine for a live customer-support chat. ` +
    `Detect the language the user's message is written in, then translate it into ${targetName} (${target}). ` +
    `Reply with ONLY a compact JSON object and nothing else: ` +
    `{"lang":"<ISO 639-1 code of the source language>","text":"<the message in ${targetName}>"}. ` +
    `If the message is already in ${targetName}, return it unchanged with its language code. ` +
    `Preserve URLs, emojis, product names, numbers and punctuation exactly. ` +
    `Never add commentary, explanations, or quotes around the JSON.`
  );
}

/** Pull the first {...} JSON object out of a model response (tolerates ``` fences). */
function parseResult(raw: string): TranslateResult | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { lang?: unknown; text?: unknown };
    const lang = typeof obj.lang === 'string' ? obj.lang.trim().slice(0, 8).toLowerCase() : '';
    const text = typeof obj.text === 'string' ? obj.text : '';
    if (!text) return null;
    return { lang: lang || 'und', text };
  } catch {
    return null;
  }
}

async function anthropicTranslate(
  deps: AppDeps,
  system: string,
  text: string,
): Promise<string | null> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: deps.config.anthropicApiKey! });
  const res = await client.messages.create({
    model: deps.config.aiModel,
    max_tokens: 1000,
    system,
    messages: [{ role: 'user', content: text }],
  });
  return res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

async function openAiCompatTranslate(
  deps: AppDeps,
  system: string,
  text: string,
): Promise<string | null> {
  const endpoint =
    deps.config.aiProvider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.config.aiApiKey}`,
    },
    body: JSON.stringify({
      model: deps.config.aiModel,
      max_tokens: 1000,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${deps.config.aiProvider} translate ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

/** Free, keyless translation via Google's public endpoint — auto-detects the
    source language and has no per-day token limit (unlike the LLM providers). */
async function googleTranslate(text: string, target: string): Promise<TranslateResult | null> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(target) +
    '&dt=t&q=' +
    encodeURIComponent(text);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    // Shape: [ [ ["translated","original",…], … ], null, "<detected src lang>", … ]
    const data = (await res.json()) as [Array<[string]>, unknown, string];
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const translated = segments.map((s) => (Array.isArray(s) ? s[0] : '')).join('');
    const lang = typeof data?.[2] === 'string' ? data[2].toLowerCase().slice(0, 8) : 'und';
    if (!translated) return null;
    return { lang: lang || 'und', text: translated };
  } catch {
    return null;
  }
}

/** Detect + translate `text` into `target`. Returns null on any failure.
    Free Google endpoint first (no token limits); the configured LLM is only a
    fallback for when that endpoint is unreachable. */
async function translate(
  deps: AppDeps,
  text: string,
  target: string,
): Promise<TranslateResult | null> {
  const free = await googleTranslate(text, target);
  if (free) return free;

  // Fallback: the LLM provider (if any). Skipped when none is configured.
  if (deps.config.aiProvider === 'builtin') return null;
  const system = buildPrompt(target);
  try {
    const raw =
      deps.config.aiProvider === 'anthropic'
        ? await anthropicTranslate(deps, system, text)
        : await openAiCompatTranslate(deps, system, text);
    if (!raw) return null;
    return parseResult(raw);
  } catch (err) {
    console.warn('[translate] fallback failed:', (err as Error).message);
    return null;
  }
}

// ─── Orchestration: enrich a freshly-posted message in place ─

/**
 * Fill `message.translatedBody` / `message.origLang` for cross-language chat and
 * persist them on the row. Mutates `message` so the caller can broadcast the
 * enriched copy. A no-op (leaves the message untouched) when translation is
 * disabled, unnecessary, or the source already matches the reader's language.
 */
export async function applyTranslation(
  deps: AppDeps,
  message: ChatMessage,
  conv: ConvLite,
): Promise<void> {
  if (!translationEnabled(deps)) return;
  if (message.kind !== 'TEXT') return;
  const body = message.body?.trim();
  if (!body) return;

  if (message.senderType === 'VISITOR') {
    // Visitor → English (for the agent). Also cache the visitor's language so
    // the agent's replies can be translated back the other way.
    const result = await translate(deps, body, AGENT_LANG);
    if (!result) return;
    if (result.lang && result.lang !== 'und') {
      await deps.db
        .run('UPDATE visitors SET lang = ? WHERE id = ?', [result.lang, conv.visitor_id])
        .catch(() => {});
    }
    // Already English → nothing for the agent to translate.
    if (result.lang === AGENT_LANG || result.text.trim() === body) return;
    // The English version is for the agent → patch the /agent side only.
    await persist(deps, message, result.text, result.lang, AGENT_NAMESPACE);
    return;
  }

  if (message.senderType === 'AGENT') {
    // Agent → the visitor's language (only when we know it and it isn't English).
    const row = await deps.db.get<{ lang: string | null }>(
      'SELECT lang FROM visitors WHERE id = ?',
      [conv.visitor_id],
    );
    const target = row?.lang?.toLowerCase();
    if (!target || target === AGENT_LANG || target === 'und') return;
    const result = await translate(deps, body, target);
    if (!result || result.text.trim() === body) return;
    // The visitor-language version is for the visitor → patch the /widget side.
    await persist(deps, message, result.text, AGENT_LANG, WIDGET_NAMESPACE);
  }
  // BOT / SYSTEM: intentionally skipped.
}

async function persist(
  deps: AppDeps,
  message: ChatMessage,
  translated: string,
  origLang: string,
  namespace: string,
): Promise<void> {
  await deps.db
    .run('UPDATE messages SET translated_body = ?, orig_lang = ? WHERE id = ?', [
      translated,
      origLang,
      message.id,
    ])
    .catch((err: unknown) => console.warn('[translate] persist failed:', (err as Error).message));
  message.translatedBody = translated;
  message.origLang = origLang;
  // Live patch so the already-rendered bubble fills in with the translation.
  deps.io.of(namespace).to(`conv:${message.conversationId}`).emit(EV.ChatTranslation, {
    conversationId: message.conversationId,
    messageId: message.id,
    translatedBody: translated,
    origLang,
  });
}
