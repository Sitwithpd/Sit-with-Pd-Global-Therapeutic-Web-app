import { Request, Response } from 'express';
import { ConsultationStatus, Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import { serializeFormatTag, tagJoinInclude, withSerializedTags } from '../lib/serializeTags';
import { withPrice, withPrices, serializePaymentAmount } from '../lib/priceSerialization';
import { currencyOf } from '../middleware/currency.middleware';
import { BASE_CURRENCY, parseToMinor } from '../lib/money';
import { resolveFormatTagId, syncConsultationServiceTags } from '../services/tag.service';
import {
  scheduleChatReindexConsultationService,
} from '../services/chat/chatReindexHook.service';

const ADMIN_CONSULTATION_SEARCH_MAX_LEN = 100;

/** Relation shape every service response returns. */
const serviceRelationInclude = {
  tags: tagJoinInclude,
  formatTag: true,
} as const;

type ServiceWithRelations = Prisma.ConsultationServiceGetPayload<{
  include: typeof serviceRelationInclude;
}>;

/**
 * Flattens topic tags and lifts the single FORMAT tag to `format`.
 * `formatTagId` is kept so admin edit forms can round-trip the value.
 */
function serializeService(service: ServiceWithRelations) {
  const { formatTag, ...rest } = withSerializedTags(service);
  return { ...rest, format: serializeFormatTag(formatTag) };
}

async function localizeService(service: ServiceWithRelations, currency: string) {
  return withPrice(serializeService(service), currency);
}

async function findServiceForResponse(id: string, currency: string) {
  const service = await prisma.consultationService.findUnique({
    where: { id },
    include: serviceRelationInclude,
  });
  if (!service) throw new AppError('Service not found.', 404);
  return localizeService(service, currency);
}

/**
 * Bullet-list fields ("Who's it for", "What's included"). Accepts an array, a
 * JSON string, or newline-separated text — multipart forms send any of these.
 */
function parseBulletList(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (Buffer.isBuffer(raw)) return parseBulletList(raw.toString('utf8'), field);
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === 'string' && raw[0].trim().startsWith('[')) {
      return parseBulletList(raw[0].trim(), field);
    }
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      throw new AppError(`${field} must be a valid JSON array.`, 400);
    }
  }
  return str
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Cover image may arrive as an upload (multipart) or as a plain URL string, so
 * existing JSON callers keep working after multer was added to these routes.
 */
function resolveCoverImageUrl(req: AuthRequest): string | null | undefined {
  const uploaded = (req.file as (Express.Multer.File & { path?: string }) | undefined)?.path;
  if (uploaded) return uploaded;
  const raw = req.body?.coverImageUrl;
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  return String(raw).trim();
}

const CAL_EVENT_TYPE_TAKEN =
  'A consultation service already uses this Cal.com event type. Use a different event type or update the existing service.';

function normalizeOptionalUrl(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError('calBookingUrl must be a string.', 400);
  const t = value.trim();
  return t === '' ? null : t;
}

async function assertCalEventTypeIdAvailable(
  calEventTypeId: number | null | undefined,
  excludeServiceId?: string
): Promise<void> {
  if (calEventTypeId == null) return;

  const existing = await prisma.consultationService.findFirst({
    where: {
      calEventTypeId,
      ...(excludeServiceId && { NOT: { id: excludeServiceId } }),
    },
    select: { id: true },
  });
  if (existing) throw new AppError(CAL_EVENT_TYPE_TAKEN, 409);
}

// ─────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────

// GET /api/consultations/services — List all active consultation services
export const getServices = catchAsync(async (req: AuthRequest, res: Response) => {
  const services = await prisma.consultationService.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    include: serviceRelationInclude,
  });

  res.json({
    success: true,
    message: 'Services fetched.',
    data: await withPrices(services.map(serializeService), currencyOf(req)),
  });
});

// GET /api/consultations/services/:id — Single service detail
export const getServiceById = catchAsync(async (req: AuthRequest, res: Response) => {
  const service = await findServiceForResponse(req.params.id, currencyOf(req));

  res.json({ success: true, message: 'Service fetched.', data: service });
});

// ─────────────────────────────────────────────
// USER ROUTES
// ─────────────────────────────────────────────

// POST /api/consultations/book — Admin-only manual booking (no Cal.com); edge cases / support
export const adminManualBookConsultation = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, serviceId, preferredDate, notes } = req.body;

  if (!userId || !serviceId) {
    throw new AppError('userId and serviceId are required.', 400);
  }

  const service = await prisma.consultationService.findUnique({ where: { id: serviceId } });
  if (!service || !service.isActive) throw new AppError('This consultation service is not available.', 400);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found.', 404);

  const consultation = await prisma.consultation.create({
    data: {
      userId,
      serviceId,
      notes,
      preferredDate: preferredDate ? new Date(preferredDate) : undefined,
      status: 'PENDING',
    },
    include: { service: true, user: { select: { id: true, email: true, firstName: true, lastName: true } } },
  });

  res.status(201).json({
    success: true,
    message: 'Consultation created (manual). Complete payment via the existing checkout flow if needed.',
    data: consultation,
  });
});

// GET /api/consultations/my — User's own bookings
export const getMyConsultations = catchAsync(async (req: AuthRequest, res: Response) => {
  const consultations = await prisma.consultation.findMany({
    where: { userId: req.user!.id },
    include: {
      service: true,
      payment: { select: { status: true, presentmentAmountMinor: true, presentmentCurrency: true, baseAmountMinor: true, baseCurrency: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ success: true, message: 'Consultations fetched.', data: consultations });
});

// ─────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────

// GET /api/admin/consultations — optional ?search= & ?status=PENDING|…
export const getAllConsultations = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, ADMIN_CONSULTATION_SEARCH_MAX_LEN)
      : '';

  const rawStatus = req.query.status;
  let status: ConsultationStatus | undefined;
  if (rawStatus !== undefined && String(rawStatus).trim() !== '') {
    const s = String(rawStatus).trim().toUpperCase();
    if (!Object.values(ConsultationStatus).includes(s as ConsultationStatus)) {
      throw new AppError(`Invalid status. Use one of: ${Object.values(ConsultationStatus).join(', ')}.`, 400);
    }
    status = s as ConsultationStatus;
  }

  const where: Prisma.ConsultationWhereInput = {
    ...(status ? { status } : {}),
    ...(search.length > 0
      ? {
          OR: [
            { user: { firstName: { contains: search, mode: 'insensitive' } } },
            { user: { lastName: { contains: search, mode: 'insensitive' } } },
            { user: { email: { contains: search, mode: 'insensitive' } } },
            { service: { title: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [consultations, total] = await Promise.all([
    prisma.consultation.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        service: true,
        payment: { select: { status: true, presentmentAmountMinor: true, presentmentCurrency: true, baseAmountMinor: true, baseCurrency: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.consultation.count({ where }),
  ]);

  res.json({
    success: true,
    message: 'All consultations fetched.',
    data: consultations,
    meta: buildMeta(total, page, limit),
  });
});

// PATCH /api/admin/consultations/:id — Update status / confirm date
export const updateConsultation = catchAsync(async (req: Request, res: Response) => {
  const { status, confirmedDate } = req.body;

  const consultation = await prisma.consultation.update({
    where: { id: req.params.id },
    data: {
      ...(status && { status }),
      ...(confirmedDate && { confirmedDate: new Date(confirmedDate) }),
    },
    include: { user: true, service: true },
  });

  res.json({ success: true, message: 'Consultation updated.', data: consultation });
});

// POST /api/admin/consultations/services — Create a new service
export const createService = catchAsync(async (req: AuthRequest, res: Response) => {
  const { title, description, price, duration, calEventTypeId } = req.body;

  let parsedCal: number | undefined;
  if (calEventTypeId != null && calEventTypeId !== '') {
    parsedCal = parseInt(String(calEventTypeId), 10);
    if (Number.isNaN(parsedCal)) throw new AppError('calEventTypeId must be a number.', 400);
  }

  await assertCalEventTypeIdAvailable(parsedCal);

  const coverImageUrl = resolveCoverImageUrl(req);
  const formatTagId = await resolveFormatTagId(req.body.format);

  const createData: Prisma.ConsultationServiceUncheckedCreateInput = {
    title,
    description,
    priceMinor: parseToMinor(String(price), BASE_CURRENCY),
    duration: parseInt(duration, 10),
    audience: parseBulletList(req.body.audience, 'audience'),
    whatsIncluded: parseBulletList(req.body.whatsIncluded, 'whatsIncluded'),
    ...(parsedCal !== undefined && { calEventTypeId: parsedCal }),
    ...(coverImageUrl !== undefined && { coverImageUrl }),
    ...(formatTagId !== undefined && { formatTagId }),
  };

  if ('calBookingUrl' in req.body) {
    const u = normalizeOptionalUrl(req.body.calBookingUrl);
    if (u !== undefined) createData.calBookingUrl = u;
  }

  let serviceId: string;
  try {
    const service = await prisma.consultationService.create({ data: createData });
    serviceId = service.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(CAL_EVENT_TYPE_TAKEN, 409);
    }
    throw e;
  }

  if (req.body.tags !== undefined) {
    await syncConsultationServiceTags(serviceId, req.body.tags);
  }
  const created = await findServiceForResponse(serviceId, currencyOf(req));

  scheduleChatReindexConsultationService(serviceId);
  res.status(201).json({ success: true, message: 'Service created.', data: created });
});

// PATCH /api/admin/consultations/services/:id — Edit a service
export const updateService = catchAsync(async (req: AuthRequest, res: Response) => {
  const { title, description, price, duration, isActive, calEventTypeId } = req.body;

  let nextCal: number | null | undefined;
  if (calEventTypeId !== undefined) {
    nextCal =
      calEventTypeId === null || calEventTypeId === ''
        ? null
        : parseInt(String(calEventTypeId), 10);
    if (calEventTypeId !== null && calEventTypeId !== '' && Number.isNaN(nextCal as number)) {
      throw new AppError('calEventTypeId must be a number.', 400);
    }
  }

  if (nextCal !== undefined && nextCal !== null) {
    await assertCalEventTypeIdAvailable(nextCal, req.params.id);
  }

  let nextCalBookingUrl: string | null | undefined;
  if ('calBookingUrl' in req.body) {
    const u = normalizeOptionalUrl(req.body.calBookingUrl);
    if (u !== undefined) nextCalBookingUrl = u;
  }

  const coverImageUrl = resolveCoverImageUrl(req);
  const formatTagId = await resolveFormatTagId(req.body.format);

  try {
    await prisma.consultationService.update({
      where: { id: req.params.id },
      data: {
        ...(title && { title }),
        ...(description && { description }),
        ...(price != null && price !== '' && {
          priceMinor: parseToMinor(String(price), BASE_CURRENCY),
        }),
        ...(duration != null && { duration: parseInt(duration, 10) }),
        ...(isActive !== undefined && { isActive }),
        ...(calEventTypeId !== undefined && { calEventTypeId: nextCal as number | null }),
        ...(nextCalBookingUrl !== undefined && { calBookingUrl: nextCalBookingUrl }),
        ...(coverImageUrl !== undefined && { coverImageUrl }),
        ...(formatTagId !== undefined && { formatTagId }),
        // Omit to keep; send [] (or '') to clear.
        ...(req.body.audience !== undefined && {
          audience: { set: parseBulletList(req.body.audience, 'audience') },
        }),
        ...(req.body.whatsIncluded !== undefined && {
          whatsIncluded: { set: parseBulletList(req.body.whatsIncluded, 'whatsIncluded') },
        }),
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(CAL_EVENT_TYPE_TAKEN, 409);
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Service not found.', 404);
    }
    throw e;
  }

  if (req.body.tags !== undefined) {
    await syncConsultationServiceTags(req.params.id, req.body.tags);
  }
  const service = await findServiceForResponse(req.params.id, currencyOf(req));

  scheduleChatReindexConsultationService(req.params.id);
  res.json({ success: true, message: 'Service updated.', data: service });
});
