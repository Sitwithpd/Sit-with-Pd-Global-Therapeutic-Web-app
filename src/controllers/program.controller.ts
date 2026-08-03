import { Request, Response } from 'express';
import { ModuleType, ProgramCategory, Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { mapForeignKeyDeleteError } from '../lib/prismaDeleteErrors';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import { tagJoinInclude, withSerializedTags } from '../lib/serializeTags';
import { withPrice, withPrices } from '../lib/priceSerialization';
import { currencyOf } from '../middleware/currency.middleware';
import { BASE_CURRENCY, parseToMinor } from '../lib/money';
import { parseVideoLinks } from '../lib/youtubeLinks';
import { syncProgramTags } from '../services/tag.service';
import {
  scheduleChatDeleteProgram,
  scheduleChatReindexProgram,
} from '../services/chat/chatReindexHook.service';

// ─────────────────────────────────────────────────────────────────────────────
// Small parse helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseOptionalInt(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n)) throw new AppError(`${field} must be a whole number.`, 400);
  return n;
}

function parseOptionalFloat(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = parseFloat(String(value));
  if (Number.isNaN(n)) throw new AppError(`${field} must be a number.`, 400);
  return n;
}

function optionalString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v);
}

const PROGRAM_START_DATE_HINT =
  'Use ISO 8601 (e.g. 2026-05-01T00:00:00.000Z). Omit the field if there is no start date.';

/** Optional start date on create — skips undefined/null/''; rejects invalid values. */
function parseOptionalProgramStartDateForCreate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw new AppError(`startDate is invalid. ${PROGRAM_START_DATE_HINT}`, 400);
  }
  return d;
}

/**
 * PATCH startDate semantics:
 * - omitted (`undefined`) → do not change the stored value
 * - `null` → clear `startDate` in the database
 * - `''` → leave unchanged (same as omit; avoids accidental clears from empty form fields)
 * - otherwise → must be a valid date
 */
function resolveProgramStartDatePatch(raw: unknown): { apply: boolean; value?: Date | null } {
  if (raw === undefined) return { apply: false };
  if (raw === null) return { apply: true, value: null };
  if (raw === '') return { apply: false };
  const d = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(d.getTime())) {
    throw new AppError(
      `startDate is invalid. Omit it to keep the current value, send null to clear it, or ${PROGRAM_START_DATE_HINT}`,
      400
    );
  }
  return { apply: true, value: d };
}

/**
 * Accepts an array, a JSON string of an array, newline- or semicolon-separated
 * text, or a single string — and always returns a plain string[].
 */
function parseStringArray(raw: unknown, field = 'learningOutcomes / learningObjectives'): string[] {
  if (raw === undefined || raw === null) return [];
  if (Buffer.isBuffer(raw)) return parseStringArray(raw.toString('utf8'), field);
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'string' && raw[0].trim().startsWith('[')) {
      return parseStringArray(raw[0].trim(), field);
    }
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(
        str.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
      );
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      throw new AppError(`${field} must be a valid JSON array.`, 400);
    }
  }
  const lines = str.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const semi = str.split(';').map((l) => l.trim()).filter(Boolean);
  if (semi.length > 1) return semi;
  return [str];
}

/**
 * Validates the Program Type/Category value coming from the form dropdown.
 * The design shows: Leaders | Students | Professionals
 */
function parseCategory(raw: unknown, required = false): ProgramCategory | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new AppError('category (program type) is required.', 400);
    return undefined;
  }
  const s = String(raw).trim().toUpperCase();
  if (!Object.values(ProgramCategory).includes(s as ProgramCategory)) {
    throw new AppError('category must be LEADERS, STUDENTS, or PROFESSIONALS.', 400);
  }
  return s as ProgramCategory;
}

/**
 * Validates the Module Type coming from the Add Module modal.
 * Design example shows: Reading, Video, etc.
 */
function parseModuleType(raw: unknown, required = false): ModuleType | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new AppError('Module type is required.', 400);
    return undefined;
  }
  const s = String(raw).trim().toUpperCase();
  if (!Object.values(ModuleType).includes(s as ModuleType)) {
    throw new AppError('Module type must be VIDEO, READING, QUIZ, ASSIGNMENT, or OTHER.', 400);
  }
  return s as ModuleType;
}

const PROGRAM_SEARCH_MAX_LEN = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Public Endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/programs
 * Public: returns all published programs with week/module counts for the listing page.
 * Shows: Program Name, Type (category), Enrolled count, Price, Status (isPublished).
 * Optional query: search (substring on title/description), category (LEADERS|STUDENTS|PROFESSIONALS).
 */
export const getAllPrograms = catchAsync(async (req: AuthRequest, res: Response) => {
  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string' ? rawSearch.trim().slice(0, PROGRAM_SEARCH_MAX_LEN) : '';

  const category = parseCategory(req.query.category, false);

  const where: Prisma.ProgramWhereInput = {
    isPublished: true,
    ...(category ? { category } : {}),
    ...(search.length > 0
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const programs = await prisma.program.findMany({
    where,
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      priceMinor: true,
      thumbnail: true,
      durationWeeks: true,
      hoursPerWeek: true,
      certificateLabel: true,
      learningOutcomes: true,
      audience: true,
      videoLinks: true,
      isPublished: true,
      startDate: true,
      facilitatorName: true,
      createdAt: true,
      tags: tagJoinInclude,
      _count: {
        select: {
          purchases: true, // "Enrolled" count shown in the table
          weeks: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    success: true,
    message: 'Programs retrieved.',
    data: await withPrices(programs.map(withSerializedTags), currencyOf(req)),
  });
});

/**
 * GET /api/programs/:id
 * Public: returns a single published program with its full week → module tree.
 * This is what a user sees on the program detail / content page.
 */
export const getProgramById = catchAsync(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  const program = await prisma.program.findUnique({
    where: { id, isPublished: true },
    include: {
      tags: tagJoinInclude,
      weeks: {
        orderBy: { order: 'asc' },
        include: {
          modules: {
            orderBy: { order: 'asc' },
            // Public view: omit embedCode for security; only expose contentUrl
            select: {
              id: true,
              title: true,
              description: true,
              type: true,
              duration: true,
              contentUrl: true,
              order: true,
            },
          },
        },
      },
    },
  });

  if (!program) throw new AppError('Program not found.', 404);

  res.json({
    success: true,
    message: 'Program retrieved.',
    data: await withPrice(withSerializedTags(program), currencyOf(req)),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Program CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/programs/admin/all
 * Admin: returns all programs (published and unpublished) for the Programs table.
 * The table columns are: Program Name, Type, Enrolled, Price, Status, Actions.
 * Optional query: search (title/description), category (program type enum), plus page/limit.
 */
export const adminGetAllPrograms = catchAsync(async (req: AuthRequest, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string' ? rawSearch.trim().slice(0, PROGRAM_SEARCH_MAX_LEN) : '';

  const category = parseCategory(req.query.category, false);

  const where: Prisma.ProgramWhereInput = {
    ...(category ? { category } : {}),
    ...(search.length > 0
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [programs, total] = await Promise.all([
    prisma.program.findMany({
      where,
      include: {
        tags: tagJoinInclude,
        _count: {
          select: {
            purchases: true, // "Enrolled" column
            weeks: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.program.count({ where }),
  ]);

  res.json({
    success: true,
    message: 'All programs retrieved.',
    data: await withPrices(programs.map(withSerializedTags), currencyOf(req), { admin: true }),
    meta: buildMeta(total, page, limit),
  });
});

/**
 * POST /api/programs
 * Admin: creates a program (Basic Information + Learning Objectives + Facilitator Information).
 * Program Weeks and Modules are added separately after creation via their own endpoints,
 * but this endpoint also accepts an optional `weeks` array for single-shot creation
 * so the frontend can POST everything at once when the admin clicks "Create Program".
 *
 * Body (multipart/form-data):
 *   title, category, durationWeeks, hoursPerWeek, price, startDate,
 *   description, learningOutcomes (JSON array or newline-separated),
 *   facilitatorName, facilitatorEmail, thumbnail (file),
 *   weeks (optional JSON string) — see WeekInput type below
 */
export const createProgram = catchAsync(async (req: AuthRequest, res: Response) => {
  const {
    title,
    description,
    price,
    currency,
    category,
    durationWeeks,
    hoursPerWeek,
    certificateLabel,
    startDate,
    facilitatorName,
    facilitatorEmail,
    weeks: weeksRaw,
  } = req.body;

  const thumbnail = (req.file as Express.Multer.File & { path: string })?.path ?? null;

  if (!title) throw new AppError('Program name is required.', 400);
  if (!description) throw new AppError('Description is required.', 400);
  if (price === undefined || price === null || price === '') {
    throw new AppError('Price is required.', 400);
  }

  const learningOutcomes = parseStringArray(
    req.body.learningOutcomes ?? req.body.learning_outcomes
  );
  // "Who's this for" — full-sentence bullets, same input handling as outcomes.
  const audience = parseStringArray(req.body.audience, 'audience');
  // YouTube media embeds; array order is the display order.
  const videoLinks = parseVideoLinks(req.body.videoLinks);
  const parsedCategory = parseCategory(category) ?? ProgramCategory.LEADERS;

  // Parse optional nested weeks payload for single-shot creation
  type ModuleInput = {
    title: string;
    description?: string;
    type?: string;
    duration?: string;
    contentUrl?: string;
    embedCode?: string;
  };
  type WeekInput = {
    title: string;
    description?: string;
    learningObjectives?: string[];
    modules?: ModuleInput[];
  };

  let weeks: WeekInput[] = [];
  if (weeksRaw) {
    try {
      weeks = typeof weeksRaw === 'string' ? JSON.parse(weeksRaw) : weeksRaw;
    } catch {
      throw new AppError('weeks must be a valid JSON array.', 400);
    }
  }

  const optionalStartDate = parseOptionalProgramStartDateForCreate(startDate);

  const program = await prisma.program.create({
    data: {
      title,
      description,
      priceMinor: parseToMinor(String(price), BASE_CURRENCY),
      category: parsedCategory,
      thumbnail,
      learningOutcomes,
      audience,
      videoLinks,
      ...(optionalString(certificateLabel) !== undefined && {
        certificateLabel: optionalString(certificateLabel),
      }),
      ...(optionalString(facilitatorName) !== undefined && {
        facilitatorName: optionalString(facilitatorName),
      }),
      ...(optionalString(facilitatorEmail) !== undefined && {
        facilitatorEmail: optionalString(facilitatorEmail),
      }),
      ...(parseOptionalInt(durationWeeks, 'durationWeeks') !== undefined && {
        durationWeeks: parseOptionalInt(durationWeeks, 'durationWeeks'),
      }),
      ...(parseOptionalFloat(hoursPerWeek, 'hoursPerWeek') !== undefined && {
        hoursPerWeek: parseOptionalFloat(hoursPerWeek, 'hoursPerWeek'),
      }),
      ...(optionalStartDate !== undefined && {
        startDate: optionalStartDate,
      }),

      // Nested create for weeks + modules if provided in the same request
      weeks: weeks.length
        ? {
            create: weeks.map((w, wi) => ({
              title: w.title,
              description: w.description ?? null,
              learningObjectives: parseStringArray(w.learningObjectives),
              order: wi + 1,
              modules: w.modules?.length
                ? {
                    create: w.modules.map((m, mi) => ({
                      title: m.title,
                      description: m.description ?? null,
                      type: (parseModuleType(m.type) ?? ModuleType.OTHER),
                      duration: m.duration ?? null,
                      contentUrl: m.contentUrl ?? null,
                      embedCode: m.embedCode ?? null,
                      order: mi + 1,
                    })),
                  }
                : undefined,
            })),
          }
        : undefined,
    },
    include: {
      weeks: {
        orderBy: { order: 'asc' },
        include: { modules: { orderBy: { order: 'asc' } } },
      },
    },
  });

  // Tags live in a join table, so they are attached after the row exists.
  // Only touched when the caller actually sent the field.
  if (req.body.tags !== undefined) {
    await syncProgramTags(program.id, req.body.tags);
  }
  const created = await findProgramWithRelations(program.id, currencyOf(req));

  scheduleChatReindexProgram(program.id);
  res.status(201).json({ success: true, message: 'Program created.', data: created });
});

/** Re-reads a program with the relation shape every mutation response returns. */
async function findProgramWithRelations(id: string, currency: string) {
  const program = await prisma.program.findUnique({
    where: { id },
    include: {
      tags: tagJoinInclude,
      weeks: {
        orderBy: { order: 'asc' },
        include: { modules: { orderBy: { order: 'asc' } } },
      },
    },
  });
  if (!program) throw new AppError('Program not found.', 404);
  return withPrice(withSerializedTags(program), currency, { admin: true });
}

/**
 * PATCH /api/programs/:id
 * Admin: updates program-level fields (Basic Info, Learning Objectives, Facilitator).
 * Weeks and Modules have their own dedicated endpoints.
 */
export const updateProgram = catchAsync(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const {
    title,
    description,
    price,
    currency,
    isPublished,
    category,
    durationWeeks,
    hoursPerWeek,
    certificateLabel,
    startDate,
    facilitatorName,
    facilitatorEmail,
  } = req.body;
  const thumbnail = (req.file as Express.Multer.File & { path: string })?.path;

  const loRaw = req.body.learningOutcomes ?? req.body.learning_outcomes;

  const startDatePatch = resolveProgramStartDatePatch(startDate);

  const data: Prisma.ProgramUpdateInput = {
    ...(title && { title }),
    ...(description && { description }),
    ...(price !== undefined && price !== '' && {
      priceMinor: parseToMinor(String(price), BASE_CURRENCY),
    }),
    ...(isPublished !== undefined && {
      isPublished: isPublished === true || isPublished === 'true',
    }),
    ...(thumbnail && { thumbnail }),
    ...(category !== undefined && category !== '' && {
      category: parseCategory(category, true),
    }),
    ...(durationWeeks !== undefined && {
      durationWeeks: parseOptionalInt(durationWeeks, 'durationWeeks'),
    }),
    ...(hoursPerWeek !== undefined && {
      hoursPerWeek: parseOptionalFloat(hoursPerWeek, 'hoursPerWeek'),
    }),
    ...(certificateLabel !== undefined && {
      certificateLabel: optionalString(certificateLabel),
    }),
    ...(facilitatorName !== undefined && {
      facilitatorName: optionalString(facilitatorName),
    }),
    ...(facilitatorEmail !== undefined && {
      facilitatorEmail: optionalString(facilitatorEmail),
    }),
    ...(startDatePatch.apply && { startDate: startDatePatch.value }),
    ...(loRaw !== undefined && {
      learningOutcomes: { set: parseStringArray(loRaw) },
    }),
    // Omit to keep; send [] (or '') to clear.
    ...(req.body.audience !== undefined && {
      audience: { set: parseStringArray(req.body.audience, 'audience') },
    }),
    // Replacing the whole list is also how the admin reorders the embeds.
    ...(req.body.videoLinks !== undefined && {
      videoLinks: { set: parseVideoLinks(req.body.videoLinks) },
    }),
  };

  try {
    await prisma.program.update({ where: { id }, data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Program not found.', 404);
    }
    throw e;
  }

  if (req.body.tags !== undefined) {
    await syncProgramTags(id, req.body.tags);
  }
  const program = await findProgramWithRelations(id, currencyOf(req));

  scheduleChatReindexProgram(id);
  res.json({ success: true, message: 'Program updated.', data: program });
});

/**
 * DELETE /api/programs/:id
 * Admin: deletes a program and all its weeks + modules (via cascade).
 */
export const deleteProgram = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.program.delete({ where: { id } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Program not found.', 404);
    }
    throw e;
  }
  scheduleChatDeleteProgram(id);
  res.json({ success: true, message: 'Program deleted.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Week CRUD
// These map to the "Program Weeks" section and the "Add New Week" modal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/programs/:id/weeks
 * Admin: adds a new week to a program ("Add Week" modal).
 * Body: { title, description?, learningObjectives? }
 */
export const addWeek = catchAsync(async (req: Request, res: Response) => {
  const { id: programId } = req.params;
  const { title, description, learningObjectives, learning_objectives } = req.body;

  if (!title) throw new AppError('Week title is required.', 400);

  // Auto-assign order as next available
  const lastWeek = await prisma.programWeek.findFirst({
    where: { programId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  const order = (lastWeek?.order ?? 0) + 1;

  const week = await prisma.programWeek.create({
    data: {
      programId,
      title,
      description: description ?? null,
      learningObjectives: parseStringArray(learningObjectives ?? learning_objectives),
      order,
    },
    include: { modules: { orderBy: { order: 'asc' } } },
  });

  scheduleChatReindexProgram(programId);
  res.status(201).json({ success: true, message: 'Week added.', data: week });
});

/**
 * PATCH /api/programs/:id/weeks/:weekId
 * Admin: updates a week's title, description, or learning objectives.
 */
export const updateWeek = catchAsync(async (req: Request, res: Response) => {
  const { id: programId, weekId } = req.params;
  const { title, description, learningObjectives, learning_objectives, order } = req.body;

  const loRaw = learningObjectives ?? learning_objectives;

  const week = await prisma.programWeek.update({
    where: { id: weekId },
    data: {
      ...(title && { title }),
      ...(description !== undefined && { description: optionalString(description) }),
      ...(loRaw !== undefined && {
        learningObjectives: { set: parseStringArray(loRaw) },
      }),
      ...(order !== undefined && { order: parseInt(String(order), 10) }),
    },
    include: { modules: { orderBy: { order: 'asc' } } },
  });

  scheduleChatReindexProgram(programId);
  res.json({ success: true, message: 'Week updated.', data: week });
});

/**
 * DELETE /api/programs/:id/weeks/:weekId
 * Admin: deletes a week and all its modules (cascade).
 * Matches the trash icon on the week card.
 */
export const deleteWeek = catchAsync(async (req: Request, res: Response) => {
  const { id: programId, weekId } = req.params;
  try {
    await prisma.programWeek.delete({ where: { id: weekId } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Week not found.', 404);
    }
    throw e;
  }
  scheduleChatReindexProgram(programId);
  res.json({ success: true, message: 'Week deleted.' });
});

/**
 * GET /api/programs/:id/weeks
 * Admin: returns all weeks for a program with their modules.
 * Used when the admin clicks "Manage Modules" to load the Modules for Week N panel.
 */
export const getWeeks = catchAsync(async (req: Request, res: Response) => {
  const { id: programId } = req.params;

  const weeks = await prisma.programWeek.findMany({
    where: { programId },
    orderBy: { order: 'asc' },
    include: {
      modules: { orderBy: { order: 'asc' } },
      _count: { select: { modules: true } },
    },
  });

  res.json({ success: true, message: 'Weeks retrieved.', data: weeks });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Module CRUD
// These map to the "Add Module to Week N" modal and the Modules list within a week.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/programs/:id/weeks/:weekId/modules
 * Admin: adds a module to a specific week ("Add Module" modal).
 *
 * Body: {
 *   title,          — Module Title *
 *   description?,   — "What will participants learn?"
 *   type,           — Type * (VIDEO | READING | QUIZ | ASSIGNMENT | OTHER)
 *   duration?,      — Duration * free text e.g. "45 min"
 *   contentUrl?,    — Content URL (YouTube, Vimeo, Google Docs, etc.)
 *   embedCode?,     — Embed Code (iframe or HTML embed)
 * }
 * At least one of contentUrl or embedCode must be provided (Content Link is required).
 */
export const addModule = catchAsync(async (req: Request, res: Response) => {
  const { id: programId, weekId } = req.params;
  const { title, description, type, duration, contentUrl, embedCode } = req.body;

  if (!title) throw new AppError('Module title is required.', 400);
  if (!type) throw new AppError('Module type is required.', 400);
  if (!contentUrl && !embedCode) {
    throw new AppError('A content URL or embed code is required (Content Link).', 400);
  }

  const parsedType = parseModuleType(type, true)!;

  // Auto-assign order within week
  const lastModule = await prisma.programModule.findFirst({
    where: { weekId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  const order = (lastModule?.order ?? 0) + 1;

  const module = await prisma.programModule.create({
    data: {
      weekId,
      title,
      description: description ?? null,
      type: parsedType,
      duration: duration ?? null,
      contentUrl: contentUrl ?? null,
      embedCode: embedCode ?? null,
      order,
    },
  });

  scheduleChatReindexProgram(programId);
  res.status(201).json({ success: true, message: 'Module added.', data: module });
});

/**
 * PATCH /api/programs/:id/weeks/:weekId/modules/:moduleId
 * Admin: updates a module's content.
 */
export const updateModule = catchAsync(async (req: Request, res: Response) => {
  const { id: programId, moduleId } = req.params;
  const { title, description, type, duration, contentUrl, embedCode, order } = req.body;

  const module = await prisma.programModule.update({
    where: { id: moduleId },
    data: {
      ...(title && { title }),
      ...(description !== undefined && { description: optionalString(description) }),
      ...(type !== undefined && type !== '' && { type: parseModuleType(type, true) }),
      ...(duration !== undefined && { duration: optionalString(duration) }),
      ...(contentUrl !== undefined && { contentUrl: optionalString(contentUrl) }),
      ...(embedCode !== undefined && { embedCode: optionalString(embedCode) }),
      ...(order !== undefined && { order: parseInt(String(order), 10) }),
    },
  });

  scheduleChatReindexProgram(programId);
  res.json({ success: true, message: 'Module updated.', data: module });
});

/**
 * DELETE /api/programs/:id/weeks/:weekId/modules/:moduleId
 * Admin: removes a module from a week (the X icon on a module card).
 */
export const deleteModule = catchAsync(async (req: Request, res: Response) => {
  const { id: programId, moduleId } = req.params;
  try {
    await prisma.programModule.delete({ where: { id: moduleId } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Module not found.', 404);
    }
    throw e;
  }
  scheduleChatReindexProgram(programId);
  res.json({ success: true, message: 'Module deleted.' });
});