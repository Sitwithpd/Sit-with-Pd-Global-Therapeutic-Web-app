import { Request, Response } from 'express';
import { Prisma, CampStatus, CampRegistrationStatus } from '@prisma/client';
import prisma from '../config/prisma';
import { stripLegacyCampPrice } from '../lib/campSerialization';
import { mapForeignKeyDeleteError } from '../lib/prismaDeleteErrors';
import { parsePlatformCurrency } from '../lib/parsePlatformCurrency';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest, ApplicantDetails } from '../types';
import {
  computePaymentExpiresAt,
  getSeatsTaken,
  isRegistrationActiveHold,
  canReuseRegistrationRow,
  whereCountsTowardCampInventory,
  whereCountsTowardTierInventory,
} from '../services/campInventory.service';
import {
  scheduleChatDeleteCamp,
  scheduleChatReindexCamp,
} from '../services/chat/chatReindexHook.service';

// ─────────────────────────────────────────────
// SHARED INCLUDES
// ─────────────────────────────────────────────

// Public-facing camp shape: everything the marketing page needs in one payload.
const publicCampInclude = {
  tiers: { orderBy: { order: 'asc' as const } },
  images: { orderBy: { order: 'asc' as const } },
  testimonials: {
    where: { isPublished: true },
    orderBy: { order: 'asc' as const },
  },
  _count: { select: { registrations: true } },
};

const ADMIN_CAMP_SEARCH_MAX_LEN = 100;

// ─────────────────────────────────────────────
// ADMIN — list all camps (pagination, search, status)
// ─────────────────────────────────────────────

// GET /api/camps/admin/all — optional ?search= & ?status=UPCOMING|ONGOING|COMPLETED|CANCELLED
export const getAllCampsAdmin = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string' ? rawSearch.trim().slice(0, ADMIN_CAMP_SEARCH_MAX_LEN) : '';

  const rawStatus = req.query.status;
  let status: CampStatus | undefined;
  if (rawStatus !== undefined && String(rawStatus).trim() !== '') {
    const s = String(rawStatus).trim().toUpperCase();
    if (!Object.values(CampStatus).includes(s as CampStatus)) {
      throw new AppError(`Invalid status. Use one of: ${Object.values(CampStatus).join(', ')}.`, 400);
    }
    status = s as CampStatus;
  }

  const where: Prisma.CampWhereInput = {
    ...(status ? { status } : {}),
    ...(search.length > 0
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { location: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [camps, total] = await Promise.all([
    prisma.camp.findMany({
      where,
      select: {
        id: true,
        title: true,
        description: true,
        location: true,
        currency: true,
        capacity: true,
        startDate: true,
        endDate: true,
        thumbnail: true,
        status: true,
        benefits: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            registrations: true,
            tiers: true,
            images: true,
          },
        },
      },
      orderBy: { startDate: 'desc' },
      skip,
      take: limit,
    }),
    prisma.camp.count({ where }),
  ]);

  res.json({
    success: true,
    message: 'Camps fetched.',
    data: camps,
    meta: buildMeta(total, page, limit),
  });
});

// ─────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────

// GET /api/camps — List all upcoming/ongoing camps
export const getAllCamps = catchAsync(async (_req: Request, res: Response) => {
  const camps = await prisma.camp.findMany({
    where: { status: { in: ['UPCOMING', 'ONGOING'] } },
    orderBy: { startDate: 'asc' },
    include: publicCampInclude,
  });

  const withSeats = await Promise.all(
    camps.map(async (camp) => {
      const seatsTaken = await getSeatsTaken(camp.id);
      return {
        ...stripLegacyCampPrice(camp),
        seatsTaken,
        seatsRemaining: Math.max(camp.capacity - seatsTaken, 0),
      };
    })
  );

  res.json({ success: true, message: 'Camps fetched.', data: withSeats });
});

// GET /api/camps/current — Next upcoming camp (the "Annual Camping Programme" featured event)
export const getCurrentCamp = catchAsync(async (_req: Request, res: Response) => {
  const camp = await prisma.camp.findFirst({
    where: { status: 'UPCOMING' },
    orderBy: { startDate: 'asc' },
    include: publicCampInclude,
  });

  if (!camp) {
    res.json({ success: true, message: 'No upcoming camp scheduled.', data: null });
    return;
  }

  const seatsTaken = await getSeatsTaken(camp.id);

  res.json({
    success: true,
    message: 'Current camp fetched.',
    data: {
      ...stripLegacyCampPrice(camp),
      seatsTaken,
      seatsRemaining: Math.max(camp.capacity - seatsTaken, 0),
    },
  });
});

// GET /api/camps/:id — Single camp detail
export const getCampById = catchAsync(async (req: Request, res: Response) => {
  const camp = await prisma.camp.findUnique({
    where: { id: req.params.id },
    include: publicCampInclude,
  });

  if (!camp) throw new AppError('Camp not found.', 404);

  const seatsTaken = await getSeatsTaken(camp.id);

  res.json({
    success: true,
    message: 'Camp fetched.',
    data: {
      ...stripLegacyCampPrice(camp),
      seatsTaken,
      seatsRemaining: Math.max(camp.capacity - seatsTaken, 0),
    },
  });
});

// ─────────────────────────────────────────────
// USER ROUTES
// ─────────────────────────────────────────────

// POST /api/camps/:id/register — Submit a camp application.
// Body: { tierId: string, applicantDetails?: ApplicantDetails }
//
// Lifecycle (Phase 4):
//   - The whole flow runs in a single $transaction with a row-level lock on the
//     camp ("SELECT … FOR UPDATE") so concurrent registrations on the same camp
//     are serialized and capacity / tier-cap math sees a consistent snapshot.
//   - A new row is created with status=PENDING_PAYMENT and a 60-minute hold
//     (paymentExpiresAt). After expiry the row is reusable: a retry resets the
//     same row instead of inserting a new one (keeps @@unique([userId, campId])).
//   - Existing-row dispatch covers: already CONFIRMED, post-expiry SUCCESS
//     payment (refund pending → admin), still-active hold (resume payment), and
//     reusable rows (EXPIRED / CANCELLED / PENDING_PAYMENT past deadline).
export const registerForCamp = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const campId = req.params.id;
  const { tierId, applicantDetails } = req.body as {
    tierId?: string;
    applicantDetails?: ApplicantDetails;
  };

  const registration = await prisma.$transaction(async (tx) => {
    // 1. Lock the camp row to serialize concurrent registrations on this camp.
    //    Held until the transaction commits / rolls back. Other camps are unaffected.
    await tx.$queryRaw`SELECT id FROM "camps" WHERE id = ${campId} FOR UPDATE`;

    // 2. Re-load camp + tiers from the locked snapshot.
    const camp = await tx.camp.findUnique({
      where: { id: campId },
      include: { tiers: true },
    });
    if (!camp) throw new AppError('Camp not found.', 404);
    if (camp.status !== 'UPCOMING') {
      throw new AppError('This camp is no longer accepting applications.', 400);
    }
    if (camp.tiers.length === 0) {
      throw new AppError(
        'This camp has no participation tiers configured. Add tiers before opening registration.',
        400
      );
    }

    // 3. Validate tier selection.
    if (!tierId) throw new AppError('Please select a participation tier.', 400);
    const tier = camp.tiers.find((t) => t.id === tierId) ?? null;
    if (!tier) throw new AppError('Invalid tier selected.', 400);

    const participantCount = tier.seatsPerUnit;

    // 4. Validate party size for multi-seat tiers (e.g. Couple needs 1 party member).
    if (participantCount > 1) {
      const partySize = applicantDetails?.partyMembers?.length ?? 0;
      if (partySize < participantCount - 1) {
        throw new AppError(
          `The "${tier.label}" package covers ${participantCount} people. Please list ${
            participantCount - 1
          } additional party member(s).`,
          400
        );
      }
    }

    const now = new Date();
    const paymentExpiresAt = computePaymentExpiresAt(now);

    // 5. Tier cap (only applies when maxUnits is configured on the tier).
    if (tier.maxUnits != null) {
      const heldUnits = await tx.campRegistration.count({
        where: whereCountsTowardTierInventory(tier.id, now),
      });
      if (heldUnits >= tier.maxUnits) {
        throw new AppError(`The "${tier.label}" package is sold out.`, 400);
      }
    }

    // 6. Camp seat capacity (sums participantCount across CONFIRMED + active holds).
    const seatsAgg = await tx.campRegistration.aggregate({
      where: whereCountsTowardCampInventory(campId, now),
      _sum: { participantCount: true },
    });
    const seatsTaken = seatsAgg._sum.participantCount ?? 0;
    if (seatsTaken + participantCount > camp.capacity) {
      throw new AppError('Not enough spots remaining for this selection.', 400);
    }

    // 7. Existing-row dispatch (at most one row per (userId, campId) due to @@unique).
    const existing = await tx.campRegistration.findUnique({
      where: { userId_campId: { userId, campId } },
      include: { payment: true },
    });

    if (existing) {
      // (a) Already paid — block silently.
      if (existing.status === CampRegistrationStatus.CONFIRMED) {
        throw new AppError('You have already applied for this camp.', 400);
      }

      // (b) Defensive: a SUCCESS payment exists but the registration is not
      //     CONFIRMED. This is the post-expiry-payment / pending-refund state
      //     and needs admin review before the user re-applies.
      if (existing.payment?.status === 'SUCCESS') {
        throw new AppError(
          'A previous payment is pending review. Please contact support before re-applying.',
          400
        );
      }

      // (c) Still-active hold — guide user to complete the existing checkout.
      if (isRegistrationActiveHold(existing, now)) {
        throw new AppError(
          'You have a pending application for this camp. Complete payment for it or wait for it to expire before re-applying.',
          400
        );
      }

      // (d) Reusable row: EXPIRED, CANCELLED, or PENDING_PAYMENT past deadline.
      if (canReuseRegistrationRow(existing, now)) {
        // Detach any prior payment so Phase 5 can attach a fresh one to this
        // registration (Payment.campRegistrationId is @unique). PENDING is also
        // promoted to FAILED so it doesn't sit pending forever.
        if (existing.payment) {
          await tx.payment.update({
            where: { id: existing.payment.id },
            data: {
              campRegistrationId: null,
              ...(existing.payment.status === 'PENDING' ? { status: 'FAILED' as const } : {}),
            },
          });
        }

        const reset = await tx.campRegistration.update({
          where: { id: existing.id },
          data: {
            tierId: tier.id,
            participantCount,
            applicantDetails: (applicantDetails ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            status: CampRegistrationStatus.PENDING_PAYMENT,
            paymentExpiresAt,
          },
          include: { camp: true, tier: true },
        });

        return reset;
      }

      // Defensive: should be unreachable — every enum value is handled above.
      throw new AppError(
        'Registration is in an unexpected state. Please contact support.',
        500
      );
    }

    // 8. No existing row — create a fresh PENDING_PAYMENT hold.
    const created = await tx.campRegistration.create({
      data: {
        userId,
        campId,
        tierId: tier.id,
        participantCount,
        applicantDetails: (applicantDetails ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        status: CampRegistrationStatus.PENDING_PAYMENT,
        paymentExpiresAt,
      },
      include: { camp: true, tier: true },
    });

    return created;
  });

  res.status(201).json({
    success: true,
    message: 'Application submitted. Please complete payment within 60 minutes.',
    data: {
      ...registration,
      camp: stripLegacyCampPrice(registration.camp),
    },
  });
});

// GET /api/camps/:id/my-registration — Caller's own registration state for this camp.
//
// Pure read; never mutates. Used by the frontend to decide what to show on the
// camp page (apply button vs. "Complete Payment" countdown vs. "Confirmed" vs.
// "Expired — re-apply"). Returns `data: null` with 200 if the user has no row
// for this camp, so the client has a single response shape to handle.
export const getMyCampRegistration = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { id: campId } = req.params;

  const registration = await prisma.campRegistration.findUnique({
    where: { userId_campId: { userId, campId } },
    select: {
      id: true,
      campId: true,
      tierId: true,
      participantCount: true,
      applicantDetails: true,
      status: true,
      paymentExpiresAt: true,
      createdAt: true,
      updatedAt: true,
      camp: true,
      tier: { select: { id: true, label: true, price: true, seatsPerUnit: true } },
      payment: { select: { status: true, amount: true, createdAt: true } },
    },
  });

  if (!registration) {
    res.json({ success: true, message: 'No registration found.', data: null });
    return;
  }

  res.json({
    success: true,
    message: 'Registration fetched.',
    data: { ...registration, camp: stripLegacyCampPrice(registration.camp) },
  });
});

// ─────────────────────────────────────────────
// ADMIN ROUTES — CAMPS
// ─────────────────────────────────────────────

// POST /api/camps — Create a camp (set prices on tiers after creation)
export const createCamp = catchAsync(async (req: AuthRequest, res: Response) => {
  const { title, description, location, capacity, startDate, endDate, currency, benefits } = req.body;
  const thumbnail = (req.file as Express.Multer.File & { path: string })?.path;

  const parsedBenefits = parseStringArray(benefits);
  const parsedCurrency = parsePlatformCurrency(currency);

  const camp = await prisma.camp.create({
    data: {
      title,
      description,
      location,
      capacity: parseInt(capacity),
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      ...(parsedCurrency !== undefined && { currency: parsedCurrency }),
      benefits: parsedBenefits,
      thumbnail,
    },
  });

  scheduleChatReindexCamp(camp.id);
  res.status(201).json({
    success: true,
    message: 'Camp created.',
    data: stripLegacyCampPrice(camp),
  });
});

// PATCH /api/camps/:id — Update a camp (pricing is only via tier endpoints; camp-level `price` is not accepted)
export const updateCamp = catchAsync(async (req: AuthRequest, res: Response) => {
  const {
    title,
    description,
    location,
    capacity,
    startDate,
    endDate,
    status,
    currency,
    benefits,
  } = req.body;
  const thumbnail = (req.file as Express.Multer.File & { path: string })?.path;

  const camp = await prisma.camp.update({
    where: { id: req.params.id },
    data: {
      ...(title && { title }),
      ...(description && { description }),
      ...(location && { location }),
      ...(capacity && { capacity: parseInt(capacity) }),
      ...(startDate && { startDate: new Date(startDate) }),
      ...(endDate && { endDate: new Date(endDate) }),
      ...(status && { status }),
      ...(currency !== undefined && currency !== '' && {
        currency: parsePlatformCurrency(currency, true),
      }),
      ...(benefits !== undefined && { benefits: parseStringArray(benefits) }),
      ...(thumbnail && { thumbnail }),
    },
  });

  scheduleChatReindexCamp(camp.id);
  res.json({ success: true, message: 'Camp updated.', data: stripLegacyCampPrice(camp) });
});

// DELETE /api/camps/:id — Deletes camp; cascades tiers, images, registrations.
// Blocked when CONFIRMED or PENDING_PAYMENT registrations exist (EXPIRED/CANCELLED do not block).
// Payments on deleted camp registrations retain rows with campRegistrationId nulled (FK SET NULL).
// Testimonials tied to this camp: campId → null (already onDelete SetNull).
export const deleteCamp = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;

  const blockingRegistrations = await prisma.campRegistration.count({
    where: {
      campId: id,
      status: {
        in: [CampRegistrationStatus.CONFIRMED, CampRegistrationStatus.PENDING_PAYMENT],
      },
    },
  });
  if (blockingRegistrations > 0) {
    throw new AppError(
      'This camp cannot be deleted because it has confirmed registrations or registrations awaiting payment.',
      409
    );
  }

  try {
    await prisma.camp.delete({ where: { id } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Camp not found.', 404);
    }
    throw e;
  }
  scheduleChatDeleteCamp(id);
  res.json({ success: true, message: 'Camp deleted.' });
});

// GET /api/camps/:id/participants — View who applied (admin)
//
// Returns every registration row (PENDING_PAYMENT, CONFIRMED, EXPIRED,
// CANCELLED) so the admin UI can render status badges. Pass an optional
// `?status=` query param to scope the list to a single lifecycle state.
export const getCampParticipants = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);
  const { id: campId } = req.params;

  const rawStatus = req.query.status;
  let statusFilter: CampRegistrationStatus | undefined;
  if (rawStatus !== undefined && String(rawStatus).trim() !== '') {
    const s = String(rawStatus).trim().toUpperCase();
    if (!Object.values(CampRegistrationStatus).includes(s as CampRegistrationStatus)) {
      throw new AppError(
        `Invalid status. Use one of: ${Object.values(CampRegistrationStatus).join(', ')}.`,
        400
      );
    }
    statusFilter = s as CampRegistrationStatus;
  }

  const where: Prisma.CampRegistrationWhereInput = {
    campId,
    ...(statusFilter ? { status: statusFilter } : {}),
  };

  const [registrations, total] = await Promise.all([
    prisma.campRegistration.findMany({
      where,
      select: {
        id: true,
        userId: true,
        campId: true,
        tierId: true,
        participantCount: true,
        applicantDetails: true,
        status: true,
        paymentExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        tier: { select: { id: true, label: true, price: true, seatsPerUnit: true } },
        payment: { select: { status: true, amount: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.campRegistration.count({ where }),
  ]);

  res.json({
    success: true,
    message: 'Participants fetched.',
    data: registrations,
    meta: buildMeta(total, page, limit),
  });
});

// ─────────────────────────────────────────────
// ADMIN ROUTES — TIERS
// ─────────────────────────────────────────────

// POST /api/camps/:campId/tiers — Create a participation tier
export const createCampTier = catchAsync(async (req: AuthRequest, res: Response) => {
  const { campId } = req.params;
  const { label, description, price, inclusions, seatsPerUnit, maxUnits, order, isFeatured } =
    req.body;

  const labelNorm = typeof label === 'string' ? label.trim() : '';
  if (!labelNorm || price === undefined) {
    throw new AppError('label and price are required.', 400);
  }

  const camp = await prisma.camp.findUnique({ where: { id: campId } });
  if (!camp) throw new AppError('Camp not found.', 404);

  try {
    const tier = await prisma.campTier.create({
      data: {
        campId,
        label: labelNorm,
        description,
        price: parseFloat(price),
        inclusions: parseStringArray(inclusions),
        seatsPerUnit: seatsPerUnit ? parseInt(seatsPerUnit) : 1,
        maxUnits: maxUnits ? parseInt(maxUnits) : null,
        order: order ? parseInt(order) : 0,
        isFeatured: parseBoolean(isFeatured),
      },
    });
    scheduleChatReindexCamp(campId);
    res.status(201).json({ success: true, message: 'Tier created.', data: tier });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError('A tier with this label already exists for this camp.', 409);
    }
    throw e;
  }
});

// PATCH /api/camps/:campId/tiers/:tierId — Update a tier
export const updateCampTier = catchAsync(async (req: AuthRequest, res: Response) => {
  const { campId, tierId } = req.params;
  const { label, description, price, inclusions, seatsPerUnit, maxUnits, order, isFeatured } =
    req.body;

  const existing = await prisma.campTier.findUnique({ where: { id: tierId } });
  if (!existing || existing.campId !== campId) throw new AppError('Tier not found.', 404);

  const labelNorm =
    label !== undefined && typeof label === 'string' ? label.trim() : undefined;
  if (labelNorm !== undefined && !labelNorm) {
    throw new AppError('label cannot be empty.', 400);
  }

  try {
    const tier = await prisma.campTier.update({
      where: { id: tierId },
      data: {
        ...(labelNorm !== undefined && { label: labelNorm }),
        ...(description !== undefined && { description }),
        ...(price !== undefined && price !== '' && { price: parseFloat(price) }),
        ...(inclusions !== undefined && { inclusions: parseStringArray(inclusions) }),
        ...(seatsPerUnit !== undefined && { seatsPerUnit: parseInt(seatsPerUnit) }),
        ...(maxUnits !== undefined && { maxUnits: maxUnits === null || maxUnits === '' ? null : parseInt(maxUnits) }),
        ...(order !== undefined && { order: parseInt(order) }),
        ...(isFeatured !== undefined && { isFeatured: parseBoolean(isFeatured) }),
      },
    });
    scheduleChatReindexCamp(campId);
    res.json({ success: true, message: 'Tier updated.', data: tier });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError('A tier with this label already exists for this camp.', 409);
    }
    throw e;
  }
});

// DELETE /api/camps/:campId/tiers/:tierId — Remove a tier
export const deleteCampTier = catchAsync(async (req: Request, res: Response) => {
  const { campId, tierId } = req.params;
  const existing = await prisma.campTier.findUnique({ where: { id: tierId } });
  if (!existing || existing.campId !== campId) throw new AppError('Tier not found.', 404);

  try {
    await prisma.campTier.delete({ where: { id: tierId } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    throw e;
  }
  scheduleChatReindexCamp(campId);
  res.json({ success: true, message: 'Tier deleted.' });
});

// ─────────────────────────────────────────────
// ADMIN ROUTES — GALLERY IMAGES
// ─────────────────────────────────────────────

// POST /api/camps/:campId/images — Upload one or more gallery images (field: "images")
export const uploadCampImages = catchAsync(async (req: AuthRequest, res: Response) => {
  const { campId } = req.params;
  const files = req.files as (Express.Multer.File & { path: string })[] | undefined;
  const captions = parseStringArray(req.body?.captions);

  if (!files || files.length === 0) {
    throw new AppError('No images uploaded. Use field name "images".', 400);
  }

  const camp = await prisma.camp.findUnique({ where: { id: campId } });
  if (!camp) throw new AppError('Camp not found.', 404);

  const existingCount = await prisma.campImage.count({ where: { campId } });

  const created = await prisma.$transaction(
    files.map((file, i) =>
      prisma.campImage.create({
        data: {
          campId,
          url: file.path,
          caption: captions[i] || null,
          order: existingCount + i,
        },
      })
    )
  );

  res.status(201).json({ success: true, message: 'Images uploaded.', data: created });
});

// PATCH /api/camps/:campId/images/:imageId — Update caption/order of a gallery image
export const updateCampImage = catchAsync(async (req: AuthRequest, res: Response) => {
  const { campId, imageId } = req.params;
  const { caption, order } = req.body;

  const existing = await prisma.campImage.findUnique({ where: { id: imageId } });
  if (!existing || existing.campId !== campId) throw new AppError('Image not found.', 404);

  const image = await prisma.campImage.update({
    where: { id: imageId },
    data: {
      ...(caption !== undefined && { caption }),
      ...(order !== undefined && { order: parseInt(order) }),
    },
  });

  res.json({ success: true, message: 'Image updated.', data: image });
});

// DELETE /api/camps/:campId/images/:imageId — Remove a gallery image
export const deleteCampImage = catchAsync(async (req: Request, res: Response) => {
  const { campId, imageId } = req.params;
  const existing = await prisma.campImage.findUnique({ where: { id: imageId } });
  if (!existing || existing.campId !== campId) throw new AppError('Image not found.', 404);

  try {
    await prisma.campImage.delete({ where: { id: imageId } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    throw e;
  }
  res.json({ success: true, message: 'Image deleted.' });
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

// Accepts an array, JSON string, or comma-separated string and normalises to string[].
// Useful when the same endpoint accepts both `application/json` and `multipart/form-data`.
function parseStringArray(input: unknown): string[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input.map((v) => String(v).trim()).filter(Boolean);
  if (typeof input !== 'string') return [];
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      // fall through to CSV
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBoolean(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') return ['true', '1', 'yes', 'on'].includes(input.toLowerCase());
  return false;
}
