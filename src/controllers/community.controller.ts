import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { mapForeignKeyDeleteError } from '../lib/prismaDeleteErrors';
import { toPublicCommunityWithTags } from '../lib/communitySerialization';
import { withSerializedTags } from '../lib/serializeTags';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import { syncCommunityTags } from '../services/tag.service';
import {
  scheduleChatDeleteCommunity,
  scheduleChatReindexCommunity,
} from '../services/chat/chatReindexHook.service';
import {
  COMMUNITY_ADMIN_SEARCH_MAX_LEN,
  COMMUNITY_DESCRIPTION_MAX,
  COMMUNITY_ICON_KEY_MAX,
  COMMUNITY_SUBTITLE_MAX,
  COMMUNITY_TITLE_MAX,
  JOIN_FULL_NAME_MAX,
  JOIN_PHONE_MAX,
  JOIN_REASON_MAX,
  buildUniqueSlug,
  communityInclude,
  findPublishedCommunity,
  listCommunitiesAdmin,
  listJoinRequestsAdmin,
  listPublishedCommunities,
  optionalText,
  parseBooleanFlag,
  parseGains,
  parseOrder,
  parseWhatsappLink,
  requireText,
  resendJoinInvite,
  submitJoinRequest,
} from '../services/community.service';

// ─────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────

/** GET /api/communities — published communities; group link stripped. */
export const getCommunities = catchAsync(async (_req: Request, res: Response) => {
  const communities = await listPublishedCommunities();

  res.json({
    success: true,
    message: 'Communities fetched.',
    data: communities.map(toPublicCommunityWithTags),
  });
});

/** GET /api/communities/:idOrSlug — published detail; group link stripped. */
export const getCommunityByIdOrSlug = catchAsync(async (req: Request, res: Response) => {
  const community = await findPublishedCommunity(req.params.idOrSlug);
  if (!community) throw new AppError('Community not found.', 404);

  res.json({
    success: true,
    message: 'Community fetched.',
    data: toPublicCommunityWithTags(community),
  });
});

/**
 * POST /api/communities/:idOrSlug/join — anonymous application.
 * Saves the request and emails the WhatsApp invite immediately.
 *
 * This is an unauthenticated endpoint that causes mail to be sent to a
 * caller-supplied address, so it is rate limited in app.ts and carries the same
 * honeypot as the contact form. Repeat submits from one address update the
 * existing row rather than sending again.
 */
export const joinCommunity = catchAsync(async (req: Request, res: Response) => {
  // Bots fill hidden fields; pretend success without saving or emailing.
  const honeypot = req.body?.website ?? req.body?.company;
  if (typeof honeypot === 'string' && honeypot.trim().length > 0) {
    return res.status(201).json({
      success: true,
      message: 'Application received. Check your inbox for the group invite.',
    });
  }

  const fullName = requireText(req.body?.fullName, 'Full name', JOIN_FULL_NAME_MAX);
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!email) throw new AppError('Email is required.', 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('A valid email address is required.', 400);
  }

  const phone = optionalText(req.body?.phone, 'Phone', JOIN_PHONE_MAX) ?? null;
  const reason = optionalText(req.body?.reason, 'Reason', JOIN_REASON_MAX) ?? null;

  const agreedToPolicy = parseBooleanFlag(req.body?.agreedToPolicy, false);
  if (!agreedToPolicy) {
    throw new AppError('You must agree to the privacy policy to join.', 400);
  }

  const source =
    typeof req.body?.source === 'string' && req.body.source.trim()
      ? req.body.source.trim().slice(0, 120)
      : undefined;

  const { request, emailed } = await submitJoinRequest(req.params.idOrSlug, {
    fullName,
    email,
    phone,
    reason,
    agreedToPolicy,
    source,
  });

  // Always 201: the application is saved either way. `emailed` tells the client
  // whether to say "check your inbox" or "we'll be in touch shortly".
  res.status(201).json({
    success: true,
    message: emailed
      ? 'Application received. Check your inbox for the group invite.'
      : "Application received. We'll send your invite shortly.",
    data: { id: request.id, emailed },
  });
});

// ─────────────────────────────────────────────
// ADMIN — Communities
// ─────────────────────────────────────────────

/** GET /api/communities/admin/all — includes the group link. */
export const getCommunitiesAdmin = catchAsync(async (req: AuthRequest, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);
  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, COMMUNITY_ADMIN_SEARCH_MAX_LEN)
      : '';

  const { rows, total } = await listCommunitiesAdmin({ skip, take: limit, search });

  res.json({
    success: true,
    message: 'Communities fetched.',
    data: rows.map(withSerializedTags),
    meta: buildMeta(total, page, limit),
  });
});

/** GET /api/communities/admin/:id — includes the group link. */
export const getCommunityAdminById = catchAsync(async (req: AuthRequest, res: Response) => {
  const community = await prisma.community.findUnique({
    where: { id: req.params.id },
    include: communityInclude,
  });
  if (!community) throw new AppError('Community not found.', 404);

  res.json({
    success: true,
    message: 'Community fetched.',
    data: withSerializedTags(community),
  });
});

/** POST /api/communities — admin create. */
export const createCommunity = catchAsync(async (req: AuthRequest, res: Response) => {
  const title = requireText(req.body?.title, 'Title', COMMUNITY_TITLE_MAX);
  const subtitle = requireText(req.body?.subtitle, 'Subtitle', COMMUNITY_SUBTITLE_MAX);
  const description = requireText(req.body?.description, 'Description', COMMUNITY_DESCRIPTION_MAX);
  const whatsappLink = parseWhatsappLink(req.body?.whatsappLink, true)!;
  const iconKey = optionalText(req.body?.iconKey, 'iconKey', COMMUNITY_ICON_KEY_MAX) ?? null;
  const gains = parseGains(req.body?.gains);
  const slug = await buildUniqueSlug(
    typeof req.body?.slug === 'string' && req.body.slug.trim() ? req.body.slug : title
  );

  const community = await prisma.community.create({
    data: {
      title,
      slug,
      subtitle,
      description,
      gains,
      iconKey,
      whatsappLink,
      isPublished: parseBooleanFlag(req.body?.isPublished, true),
      order: parseOrder(req.body?.order),
    },
  });

  if (req.body?.tags !== undefined) {
    await syncCommunityTags(community.id, req.body.tags);
  }

  const created = await prisma.community.findUnique({
    where: { id: community.id },
    include: communityInclude,
  });

  scheduleChatReindexCommunity(community.id);
  res.status(201).json({
    success: true,
    message: 'Community created.',
    data: withSerializedTags(created!),
  });
});

/** PATCH /api/communities/:id — admin update. */
export const updateCommunity = catchAsync(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.community.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new AppError('Community not found.', 404);

  const data: Prisma.CommunityUpdateInput = {};

  if (req.body?.title !== undefined) {
    data.title = requireText(req.body.title, 'Title', COMMUNITY_TITLE_MAX);
  }
  if (req.body?.subtitle !== undefined) {
    data.subtitle = requireText(req.body.subtitle, 'Subtitle', COMMUNITY_SUBTITLE_MAX);
  }
  if (req.body?.description !== undefined) {
    data.description = requireText(req.body.description, 'Description', COMMUNITY_DESCRIPTION_MAX);
  }
  if (req.body?.whatsappLink !== undefined) {
    // Required-if-present: there is no way to clear the link, since a community
    // without one cannot fulfil a join request.
    data.whatsappLink = parseWhatsappLink(req.body.whatsappLink, true)!;
  }
  if (req.body?.iconKey !== undefined) {
    data.iconKey = optionalText(req.body.iconKey, 'iconKey', COMMUNITY_ICON_KEY_MAX) ?? null;
  }
  if (req.body?.gains !== undefined) {
    data.gains = { set: parseGains(req.body.gains) };
  }
  if (req.body?.isPublished !== undefined) {
    data.isPublished = parseBooleanFlag(req.body.isPublished, true);
  }
  if (req.body?.order !== undefined) {
    data.order = parseOrder(req.body.order);
  }
  // Only re-slug on an explicit request — public URLs would otherwise break
  // whenever an admin tweaks the title.
  if (typeof req.body?.slug === 'string' && req.body.slug.trim()) {
    data.slug = await buildUniqueSlug(req.body.slug, id);
  }

  await prisma.community.update({ where: { id }, data });

  if (req.body?.tags !== undefined) {
    await syncCommunityTags(id, req.body.tags);
  }

  const community = await prisma.community.findUnique({ where: { id }, include: communityInclude });

  scheduleChatReindexCommunity(id);
  res.json({
    success: true,
    message: 'Community updated.',
    data: withSerializedTags(community!),
  });
});

/** DELETE /api/communities/:id — cascades tags and join requests. */
export const deleteCommunity = catchAsync(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.community.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new AppError('Community not found.', 404);

  try {
    await prisma.community.delete({ where: { id } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Community not found.', 404);
    }
    throw e;
  }

  scheduleChatDeleteCommunity(id);
  res.json({ success: true, message: 'Community deleted.' });
});

// ─────────────────────────────────────────────
// ADMIN — Join requests
// ─────────────────────────────────────────────

/** GET /api/communities/admin/join-requests?communityId=&search= */
export const getJoinRequestsAdmin = catchAsync(async (req: AuthRequest, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);
  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, COMMUNITY_ADMIN_SEARCH_MAX_LEN)
      : '';
  const communityId =
    typeof req.query.communityId === 'string' && req.query.communityId.trim()
      ? req.query.communityId.trim()
      : undefined;

  const { rows, total } = await listJoinRequestsAdmin({
    skip,
    take: limit,
    search,
    communityId,
  });

  res.json({
    success: true,
    message: 'Join requests fetched.',
    data: rows,
    meta: buildMeta(total, page, limit),
  });
});

/** POST /api/communities/admin/join-requests/:id/resend — retry a failed invite. */
export const resendJoinRequestInvite = catchAsync(async (req: AuthRequest, res: Response) => {
  const request = await resendJoinInvite(req.params.id);

  res.json({ success: true, message: 'Invite resent.', data: request });
});
