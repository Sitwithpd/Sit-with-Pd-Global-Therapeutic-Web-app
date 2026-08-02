import { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { AppError } from '../middleware/error.middleware';
import { slugifyTag } from './tag.service';
import { ensurePlatformSettings } from './platformSettings.service';
import {
  sendCommunityJoinNotificationEmail,
  sendCommunityWelcomeEmail,
} from '../utils/email.service';

export const COMMUNITY_TITLE_MAX = 160;
export const COMMUNITY_SUBTITLE_MAX = 300;
export const COMMUNITY_DESCRIPTION_MAX = 4000;
export const COMMUNITY_ICON_KEY_MAX = 60;
export const COMMUNITY_LINK_MAX = 500;
export const COMMUNITY_MAX_GAINS = 20;
export const COMMUNITY_GAIN_MAX = 300;

export const JOIN_FULL_NAME_MAX = 120;
export const JOIN_PHONE_MAX = 30;
export const JOIN_REASON_MAX = 2000;
export const COMMUNITY_ADMIN_SEARCH_MAX_LEN = 100;

/** Relation shape returned by every community response. */
export const communityInclude = {
  tags: { include: { tag: true }, orderBy: { order: 'asc' as const } },
  _count: { select: { joinRequests: true } },
} as const;

// ── Validation helpers ────────────────────────────────────────────────────────

export function requireText(raw: unknown, field: string, max: number): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new AppError(`${field} is required.`, 400);
  if (s.length > max) throw new AppError(`${field} must be at most ${max} characters.`, 400);
  return s;
}

export function optionalText(raw: unknown, field: string, max: number): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (s.length > max) throw new AppError(`${field} must be at most ${max} characters.`, 400);
  return s;
}

/**
 * The group link is the entire value of a membership, so it is validated but
 * never echoed back on a public route. Any https URL is accepted — WhatsApp
 * uses chat.whatsapp.com, wa.me and whatsapp.com/channel interchangeably.
 */
export function parseWhatsappLink(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw new AppError('whatsappLink is required.', 400);
    return undefined;
  }
  const s = String(raw).trim();
  if (s.length > COMMUNITY_LINK_MAX) {
    throw new AppError(`whatsappLink must be at most ${COMMUNITY_LINK_MAX} characters.`, 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new AppError('whatsappLink must be a valid URL.', 400);
  }
  if (parsed.protocol !== 'https:') {
    throw new AppError('whatsappLink must start with https://.', 400);
  }
  return s;
}

export function parseGains(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Buffer.isBuffer(raw)) return parseGains(raw.toString('utf8'));
  let list: string[];
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'string' && raw[0].trim().startsWith('[')) {
      return parseGains(raw[0].trim());
    }
    list = raw.map((v) => String(v).trim()).filter(Boolean);
  } else {
    const str = String(raw).trim();
    if (!str) return [];
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        list = Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [];
      } catch {
        throw new AppError('gains must be a valid JSON array.', 400);
      }
    } else {
      list = str
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (list.length > COMMUNITY_MAX_GAINS) {
    throw new AppError(`At most ${COMMUNITY_MAX_GAINS} "what you'll gain" entries are allowed.`, 400);
  }
  for (const g of list) {
    if (g.length > COMMUNITY_GAIN_MAX) {
      throw new AppError(`Each gain must be at most ${COMMUNITY_GAIN_MAX} characters.`, 400);
    }
  }
  return list;
}

export function parseBooleanFlag(input: unknown, fallback: boolean): boolean {
  if (input === undefined || input === null || input === '') return fallback;
  if (typeof input === 'boolean') return input;
  return ['true', '1', 'yes', 'on'].includes(String(input).toLowerCase());
}

export function parseOrder(input: unknown): number {
  if (input === undefined || input === null || input === '') return 0;
  const n = typeof input === 'number' ? input : parseInt(String(input), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError('order must be a non-negative integer.', 400);
  }
  return n;
}

/**
 * Derives a URL-safe slug from the title (or an explicit override) and appends
 * a numeric suffix until it is free. `excludeId` lets an update keep its own slug.
 */
export async function buildUniqueSlug(
  source: string,
  excludeId?: string
): Promise<string> {
  const base = slugifyTag(source) || 'community';
  let candidate = base;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const clash = await prisma.community.findFirst({
      where: { slug: candidate, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: { id: true },
    });
    if (!clash) return candidate;
    candidate = `${base}-${attempt}`;
  }
  throw new AppError('Could not generate a unique slug for this community.', 409);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listPublishedCommunities() {
  return prisma.community.findMany({
    where: { isPublished: true },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: communityInclude,
  });
}

/** Accepts either a cuid or a slug so public URLs can use the readable form. */
export async function findPublishedCommunity(idOrSlug: string) {
  return prisma.community.findFirst({
    where: { isPublished: true, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: communityInclude,
  });
}

export async function listCommunitiesAdmin(opts: {
  skip: number;
  take: number;
  search: string;
}) {
  const { skip, take, search } = opts;
  const where: Prisma.CommunityWhereInput =
    search.length > 0
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { subtitle: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

  const [rows, total] = await Promise.all([
    prisma.community.findMany({
      where,
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      skip,
      take,
      include: communityInclude,
    }),
    prisma.community.count({ where }),
  ]);

  return { rows, total };
}

// ── Join requests ─────────────────────────────────────────────────────────────

export interface JoinRequestInput {
  fullName: string;
  email: string;
  phone: string | null;
  reason: string | null;
  agreedToPolicy: boolean;
  source?: string;
}

/**
 * Attempts delivery and records the outcome on the row. Never throws — a dead
 * SMTP box must not lose the application or 500 the visitor; `linkEmailedAt`
 * stays null and the admin "resend" action picks it up.
 */
async function deliverInvite(requestId: string, params: {
  to: string;
  fullName: string;
  communityTitle: string;
  whatsappLink: string;
}): Promise<boolean> {
  try {
    await sendCommunityWelcomeEmail(params);
    await prisma.communityJoinRequest.update({
      where: { id: requestId },
      data: { linkEmailedAt: new Date(), emailError: null },
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[community-join] invite delivery failed', {
      requestId,
      error: message,
    });
    await prisma.communityJoinRequest.update({
      where: { id: requestId },
      data: { linkEmailedAt: null, emailError: message.slice(0, 500) },
    });
    return false;
  }
}

/** Best-effort admin notification; failure never affects the visitor's result. */
async function notifyAdminOfJoin(params: {
  requestId: string;
  communityTitle: string;
  input: JoinRequestInput;
}): Promise<void> {
  try {
    const settings = await ensurePlatformSettings();
    const to = settings.supportEmail?.trim();
    if (!to) return;
    await sendCommunityJoinNotificationEmail({
      to,
      fullName: params.input.fullName,
      email: params.input.email,
      phone: params.input.phone,
      reason: params.input.reason,
      communityTitle: params.communityTitle,
      requestId: params.requestId,
    });
  } catch (err) {
    console.error('[community-join] admin notification failed', err);
  }
}

export async function submitJoinRequest(idOrSlug: string, input: JoinRequestInput) {
  const community = await findPublishedCommunity(idOrSlug);
  if (!community) throw new AppError('Community not found.', 404);

  // Re-applying with the same address refreshes the row rather than creating a
  // second one — this is what stops repeat submits from re-blasting the link.
  const request = await prisma.communityJoinRequest.upsert({
    where: { communityId_email: { communityId: community.id, email: input.email } },
    create: {
      communityId: community.id,
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      reason: input.reason,
      agreedToPolicy: input.agreedToPolicy,
      ...(input.source ? { source: input.source } : {}),
    },
    update: {
      fullName: input.fullName,
      phone: input.phone,
      reason: input.reason,
      agreedToPolicy: input.agreedToPolicy,
    },
  });

  const emailed = await deliverInvite(request.id, {
    to: input.email,
    fullName: input.fullName,
    communityTitle: community.title,
    whatsappLink: community.whatsappLink,
  });

  await notifyAdminOfJoin({
    requestId: request.id,
    communityTitle: community.title,
    input,
  });

  return { request, community, emailed };
}

export async function listJoinRequestsAdmin(opts: {
  skip: number;
  take: number;
  search: string;
  communityId?: string;
}) {
  const { skip, take, search, communityId } = opts;
  const where: Prisma.CommunityJoinRequestWhereInput = {
    ...(communityId ? { communityId } : {}),
    ...(search.length > 0
      ? {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.communityJoinRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { community: { select: { id: true, title: true, slug: true } } },
    }),
    prisma.communityJoinRequest.count({ where }),
  ]);

  return { rows, total };
}

/** Admin retry for a request whose invite never went out. */
export async function resendJoinInvite(requestId: string) {
  const request = await prisma.communityJoinRequest.findUnique({
    where: { id: requestId },
    include: { community: true },
  });
  if (!request) throw new AppError('Join request not found.', 404);

  const emailed = await deliverInvite(request.id, {
    to: request.email,
    fullName: request.fullName,
    communityTitle: request.community.title,
    whatsappLink: request.community.whatsappLink,
  });

  if (!emailed) {
    throw new AppError(
      'Could not send the invite email. Check the mail configuration and try again.',
      502
    );
  }

  return prisma.communityJoinRequest.findUnique({
    where: { id: requestId },
    include: { community: { select: { id: true, title: true, slug: true } } },
  });
}
