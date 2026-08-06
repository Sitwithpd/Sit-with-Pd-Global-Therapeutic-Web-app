import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { mapForeignKeyDeleteError } from '../lib/prismaDeleteErrors';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';

export const TEAM_NAME_MAX = 200;
export const TEAM_ROLE_MAX = 120;
export const TEAM_BIO_MAX = 5000;

function parseBoolean(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') return ['true', '1', 'yes', 'on'].includes(input.toLowerCase());
  return false;
}

function parseOrder(input: unknown): number {
  if (input === undefined || input === null || input === '') return 0;
  const n = typeof input === 'number' ? input : parseInt(String(input), 10);
  if (!Number.isFinite(n) || n < 0) throw new AppError('order must be a non-negative integer.', 400);
  return n;
}

function trimName(name: unknown): string {
  const s = String(name ?? '').trim();
  if (!s) throw new AppError('name is required.', 400);
  if (s.length > TEAM_NAME_MAX) {
    throw new AppError(`name must be at most ${TEAM_NAME_MAX} characters.`, 400);
  }
  return s;
}

function trimRole(role: unknown, required: boolean): string | null {
  if (role === undefined || role === null) {
    if (required) throw new AppError('role is required.', 400);
    return null;
  }
  const s = String(role).trim();
  if (!s) {
    if (required) throw new AppError('role is required.', 400);
    return null;
  }
  if (s.length > TEAM_ROLE_MAX) {
    throw new AppError(`role must be at most ${TEAM_ROLE_MAX} characters.`, 400);
  }
  return s;
}


/**
 * Long-form profile copy, so line structure is content rather than noise.
 *
 * Blank lines separate paragraphs and must survive, which rules out a plain
 * `.trim()` on the whole string being enough. What is normalised:
 *  - CRLF/CR to LF, so a paste from Word does not store \r\n that then throws
 *    the length check and any downstream rendering out
 *  - trailing spaces per line, which paste leaves behind invisibly
 *  - runs of 3+ newlines down to 2 (one blank line), so an accidental lean on
 *    Enter cannot open a chasm in the layout
 *  - leading/trailing whitespace of the whole field
 *
 * Returns null for an absent or emptied value: bio is optional, and sending ""
 * is how the admin form clears one.
 */
function normalizeBio(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (Buffer.isBuffer(raw)) return normalizeBio(raw.toString('utf8'));

  const normalized = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return null;
  if (normalized.length > TEAM_BIO_MAX) {
    throw new AppError(`bio must be at most ${TEAM_BIO_MAX} characters.`, 400);
  }
  return normalized;
}

function uploadedPhotoUrl(req: AuthRequest): string | undefined {
  return (req.file as Express.Multer.File & { path?: string } | undefined)?.path;
}

// GET /api/team — public listing (published only)
export const getTeamMembers = catchAsync(async (_req: Request, res: Response) => {
  const members = await prisma.teamMember.findMany({
    where: { isPublished: true },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });

  res.json({ success: true, message: 'Team members fetched.', data: members });
});

// GET /api/team/admin/all — admin listing (all, including unpublished)
export const getTeamMembersAdmin = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const [members, total] = await Promise.all([
    prisma.teamMember.findMany({
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.teamMember.count(),
  ]);

  res.json({
    success: true,
    message: 'Team members fetched.',
    data: members,
    meta: buildMeta(total, page, limit),
  });
});

// GET /api/team/:id — public (published only)
export const getTeamMemberById = catchAsync(async (req: Request, res: Response) => {
  const member = await prisma.teamMember.findFirst({
    where: { id: req.params.id, isPublished: true },
  });
  if (!member) throw new AppError('Team member not found.', 404);
  res.json({ success: true, message: 'Team member fetched.', data: member });
});

// POST /api/team — admin
export const createTeamMember = catchAsync(async (req: AuthRequest, res: Response) => {
  const { name, role, bio, photoUrl, isPublished, order } = req.body;
  const safeName = trimName(name);
  const safeRole = trimRole(role, true);
  const uploaded = uploadedPhotoUrl(req);

  const member = await prisma.teamMember.create({
    data: {
      name: safeName,
      role: safeRole!,
      bio: normalizeBio(bio),
      photoUrl: uploaded || (typeof photoUrl === 'string' && photoUrl.trim() ? photoUrl.trim() : null),
      isPublished: isPublished === undefined ? true : parseBoolean(isPublished),
      order: parseOrder(order),
    },
  });

  res.status(201).json({ success: true, message: 'Team member created.', data: member });
});

// PATCH /api/team/:id — admin
export const updateTeamMember = catchAsync(async (req: AuthRequest, res: Response) => {
  const { name, role, bio, photoUrl, isPublished, order } = req.body;

  const existing = await prisma.teamMember.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError('Team member not found.', 404);

  const uploaded = uploadedPhotoUrl(req);
  const data: Prisma.TeamMemberUpdateInput = {};

  if (name !== undefined) data.name = trimName(name);
  if (role !== undefined) {
    const safeRole = trimRole(role, true);
    if (safeRole) data.role = safeRole;
  }
  // Omit to keep the current bio; send "" to clear it.
  if (bio !== undefined) data.bio = normalizeBio(bio);
  if (uploaded) {
    data.photoUrl = uploaded;
  } else if (photoUrl !== undefined) {
    data.photoUrl = typeof photoUrl === 'string' && photoUrl.trim() ? photoUrl.trim() : null;
  }
  if (isPublished !== undefined) data.isPublished = parseBoolean(isPublished);
  if (order !== undefined) data.order = parseOrder(order);

  const member = await prisma.teamMember.update({
    where: { id: req.params.id },
    data,
  });

  res.json({ success: true, message: 'Team member updated.', data: member });
});

// DELETE /api/team/:id — admin
export const deleteTeamMember = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.teamMember.findUnique({ where: { id } });
  if (!existing) throw new AppError('Team member not found.', 404);
  try {
    await prisma.teamMember.delete({ where: { id } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Team member not found.', 404);
    }
    throw e;
  }
  res.json({ success: true, message: 'Team member deleted.' });
});
