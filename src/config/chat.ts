/**
 * AI chat widget — feature flags, limits, frontend paths, and disclaimer placeholders.
 * Disclaimer copy is pending client/admin review before launch.
 */

const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

function parseOptionalFloat(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return undefined;
  return n;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** Placeholder frontend routes — confirm with FE engineer before launch. */
export const CHAT_FRONTEND_PATHS = {
  programs: '/programs',
  programDetail: (id: string) => `/programs/${id}`,
  camps: '/camps',
  campDetail: (id: string) => `/camps/${id}`,
  consultations: '/consultations',
  community: '/community',
  contact: '/contact',
  dashboard: '/dashboard',
  blogPost: (slug: string) => `/blog/${slug}`,
  login: '/login',
} as const;

/** Pending client/admin review. */
export const CHAT_DISCLAIMER_SHORT =
  'Automated help only — not therapy, medical advice, or crisis support.';

/** Pending client/admin review. */
export const CHAT_DISCLAIMER_FULL = `This assistant answers common questions about Sit With PD — our programs, camps, consultations, and how to use the platform. It is automated and provides general information only. It does not provide medical advice, diagnosis, or mental health treatment, and it is not a substitute for care from a qualified professional.

If you are in crisis or may harm yourself or others, contact your local emergency services or a trusted professional immediately. For platform or booking help, visit our Contact page or choose a topic below.`;

export const CHAT_INTRO = 'Hi — how can we help you today? Ask a question or choose a topic below.';

export const CHAT_SUGGESTED_PROMPTS = [
  'What programs do you offer?',
  'How do camp registrations work?',
  'How do I book a consultation?',
  'How do I access a program I purchased?',
  'How do payments work on this site?',
  'How can I contact support?',
] as const;

export function isChatEnabled(): boolean {
  return parseBool(process.env.CHAT_ENABLED, true);
}

export function isChatStreamingEnabled(): boolean {
  return parseBool(process.env.CHAT_STREAMING_ENABLED, true);
}

export function getChatMaxMessagesPerSession(): number {
  return parsePositiveInt(process.env.CHAT_MAX_MESSAGES_PER_SESSION, 50);
}

export function getChatMaxMessagesPerHourGuest(): number {
  return parsePositiveInt(process.env.CHAT_MAX_MESSAGES_PER_HOUR_GUEST, 20);
}

export function getChatSessionCookieName(): string {
  const name = process.env.CHAT_SESSION_COOKIE_NAME?.trim();
  return name && name.length > 0 ? name : 'chat_session';
}

export function getChatSessionMaxAgeMs(): number {
  return parsePositiveInt(process.env.CHAT_SESSION_MAX_AGE_MS, DEFAULT_SESSION_MAX_AGE_MS);
}

export function getChatRagTopK(): number {
  return parsePositiveInt(process.env.CHAT_RAG_TOP_K, 8);
}

/** Cosine distance threshold; lower = stricter. Undefined = no minimum score filter. */
export function getChatRagMinScore(): number | undefined {
  return parseOptionalFloat(process.env.CHAT_RAG_MIN_SCORE);
}

/** Monthly hard cap in USD. Undefined = no cap enforced. */
export function getChatMonthlyBudgetUsd(): number | undefined {
  return parseOptionalFloat(process.env.CHAT_MONTHLY_BUDGET_USD);
}

export function getOpenAiChatModel(): string {
  const model = process.env.OPENAI_CHAT_MODEL?.trim();
  return model && model.length > 0 ? model : 'gpt-4o-mini';
}

export function getOpenAiEmbeddingModel(): string {
  const model = process.env.OPENAI_EMBEDDING_MODEL?.trim();
  return model && model.length > 0 ? model : 'text-embedding-3-small';
}

/** OpenAI text-embedding-3-small output dimensions. */
export const CHAT_EMBEDDING_DIMENSIONS = 1536;
