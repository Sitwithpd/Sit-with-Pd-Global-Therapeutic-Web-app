import { Request, Response } from 'express';
import { ConsultationStatus, Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { parsePlatformCurrency } from '../lib/parsePlatformCurrency';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import {
  scheduleChatReindexConsultationService,
} from '../services/chat/chatReindexHook.service';

const ADMIN_CONSULTATION_SEARCH_MAX_LEN = 100;

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
export const getServices = catchAsync(async (_req: Request, res: Response) => {
  const services = await prisma.consultationService.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  res.json({ success: true, message: 'Services fetched.', data: services });
});

// GET /api/consultations/services/:id — Single service detail
export const getServiceById = catchAsync(async (req: Request, res: Response) => {
  const service = await prisma.consultationService.findUnique({
    where: { id: req.params.id },
  });

  if (!service) throw new AppError('Service not found.', 404);

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
    message: 'Consultation created (manual). Complete payment via existing Paystack flow if needed.',
    data: consultation,
  });
});

// GET /api/consultations/my — User's own bookings
export const getMyConsultations = catchAsync(async (req: AuthRequest, res: Response) => {
  const consultations = await prisma.consultation.findMany({
    where: { userId: req.user!.id },
    include: {
      service: true,
      payment: { select: { status: true, amount: true } },
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
        payment: { select: { status: true, amount: true } },
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
export const createService = catchAsync(async (req: Request, res: Response) => {
  const { title, description, price, currency, duration, calEventTypeId } = req.body;

  let parsedCal: number | undefined;
  if (calEventTypeId != null && calEventTypeId !== '') {
    parsedCal = parseInt(String(calEventTypeId), 10);
    if (Number.isNaN(parsedCal)) throw new AppError('calEventTypeId must be a number.', 400);
  }

  await assertCalEventTypeIdAvailable(parsedCal);

  const parsedCurrency = parsePlatformCurrency(currency);

  const createData: {
    title: string;
    description: string;
    price: number;
    duration: number;
    calEventTypeId?: number;
    calBookingUrl?: string | null;
    currency?: ReturnType<typeof parsePlatformCurrency>;
  } = {
    title,
    description,
    price: parseFloat(price),
    duration: parseInt(duration, 10),
    ...(parsedCal !== undefined && { calEventTypeId: parsedCal }),
    ...(parsedCurrency !== undefined && { currency: parsedCurrency }),
  };

  if ('calBookingUrl' in req.body) {
    const u = normalizeOptionalUrl(req.body.calBookingUrl);
    if (u !== undefined) createData.calBookingUrl = u;
  }

  try {
    const service = await prisma.consultationService.create({
      data: createData,
    });

    scheduleChatReindexConsultationService(service.id);
    res.status(201).json({ success: true, message: 'Service created.', data: service });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(CAL_EVENT_TYPE_TAKEN, 409);
    }
    throw e;
  }
});

// PATCH /api/admin/consultations/services/:id — Edit a service
export const updateService = catchAsync(async (req: Request, res: Response) => {
  const { title, description, price, currency, duration, isActive, calEventTypeId } = req.body;

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

  try {
    const service = await prisma.consultationService.update({
      where: { id: req.params.id },
      data: {
        ...(title && { title }),
        ...(description && { description }),
        ...(price != null && { price: parseFloat(price) }),
        ...(currency !== undefined && currency !== '' && {
          currency: parsePlatformCurrency(currency, true),
        }),
        ...(duration != null && { duration: parseInt(duration, 10) }),
        ...(isActive !== undefined && { isActive }),
        ...(calEventTypeId !== undefined && { calEventTypeId: nextCal as number | null }),
        ...(nextCalBookingUrl !== undefined && { calBookingUrl: nextCalBookingUrl }),
      },
    });

    scheduleChatReindexConsultationService(service.id);
    res.json({ success: true, message: 'Service updated.', data: service });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(CAL_EVENT_TYPE_TAKEN, 409);
    }
    throw e;
  }
});
