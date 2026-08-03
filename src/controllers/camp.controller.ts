import { Request, Response } from 'express';
import { Prisma, CampStatus, CampRegistrationStatus } from '@prisma/client';
import prisma from '../config/prisma';
import { mapForeignKeyDeleteError } from '../lib/prismaDeleteErrors';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { withPrices } from '../lib/priceSerialization';
import { serializePaymentAmount } from '../lib/priceSerialization';
import { currencyOf } from '../middleware/currency.middleware';
import { BASE_CURRENCY, parseToMinor } from '../lib/money';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest, ApplicantDetails } from '../types';
import {
  BLOCKED_NEW_REGISTRATION_MESSAGE,
  blockedNewRegistrationReason,
  computePaymentExpiresAt,
  computeTierAvailability,
  getSeatsTaken,
  getSeatsTakenByCamp,
  getUnitsHeldByTier,
  isCampOpenForRegistration,
  isRegistrationActiveHold,
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

/**
 * Camp money lives entirely on its tiers, and so does availability: a camp can
 * report seats remaining while every tier is unbookable because none of them
 * fits in the space left.
 */
async function serializeCamps<
  T extends {
    id: string;
    status: string;
    capacity: number;
    tiers?: Array<{ id: string; priceMinor: bigint; seatsPerUnit: number; maxUnits: number | null }>;
  },
>(camps: T[], currency: string) {
  const ids = camps.map((c) => c.id);
  const [seatsByCamp, unitsByTier] = await Promise.all([
    getSeatsTakenByCamp(ids),
    getUnitsHeldByTier(ids),
  ]);

  return Promise.all(
    camps.map(async (camp) => {
      const seatsTaken = seatsByCamp.get(camp.id) ?? 0;
      const seatsRemaining = Math.max(camp.capacity - seatsTaken, 0);
      const campIsOpen = isCampOpenForRegistration(camp.status);

      const tiers = camp.tiers
        ? await withPrices(
            camp.tiers.map((tier) => ({
              ...tier,
              ...computeTierAvailability({
                campIsOpen,
                seatsRemaining,
                seatsPerUnit: tier.seatsPerUnit,
                maxUnits: tier.maxUnits,
                unitsSold: unitsByTier.get(tier.id) ?? 0,
              }),
            })),
            currency
          )
        : undefined;

      return {
        ...camp,
        ...(tiers ? { tiers } : {}),
        seatsTaken,
        seatsRemaining,
        isOpenForRegistration: campIsOpen,
        hasBookableTier: (tiers ?? []).some((t) => (t as { isAvailable?: boolean }).isAvailable),
      };
    })
  );
}

async function serializeCamp<
  T extends {
    id: string;
    status: string;
    capacity: number;
    tiers?: Array<{ id: string; priceMinor: bigint; seatsPerUnit: number; maxUnits: number | null }>;
  },
>(camp: T, currency: string) {
  const [serialized] = await serializeCamps([camp], currency);
  return serialized;
}

/** Payment rows carry a locked presentment quote; expose it as amount+currency. */
function withPaymentAmount<T extends { payment?: unknown | null }>(row: T): T {
  if (!row.payment) return row;
  return {
    ...row,
    payment: {
      ...(row.payment as object),
      ...serializePaymentAmount(row.payment as Parameters<typeof serializePaymentAmount>[0]),
    },
  };
}

export const PARTICIPANT_NAME_MAX = 160;
export const PARTICIPANT_TEXT_MAX = 500;

export interface ParticipantInput {
  fullName?: string;
  age?: number | string | null;
  relationship?: string | null;
  dietaryRequirements?: string | null;
  medicalConditions?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

function participantText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (value.length > max) throw new AppError(`${field} must be at most ${max} characters.`, 400);
  return value;
}

function participantAge(raw: unknown): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const age = Number(raw);
  if (!Number.isInteger(age) || age < 0 || age > 120) {
    throw new AppError('Each attendee age must be a whole number between 0 and 120.', 400);
  }
  return age;
}

/**
 * The manifest is the roster the organiser works from at the gate, so it must
 * name exactly as many people as the tier covers — a count alone is not enough
 * to run a camp. Falls back to the legacy applicantDetails shape so older
 * clients keep working while the frontend catches up.
 */
function buildManifest(
  participants: ParticipantInput[] | undefined,
  applicantDetails: ApplicantDetails | undefined,
  seats: number,
  tierLabel: string
): Prisma.CampParticipantCreateWithoutRegistrationInput[] {
  let source: ParticipantInput[] = Array.isArray(participants) ? participants : [];

  if (source.length === 0 && applicantDetails) {
    source = [
      {
        fullName: applicantDetails.fullName,
        dietaryRequirements: applicantDetails.dietaryRestrictions,
        medicalConditions: applicantDetails.medicalConditions,
        emergencyContactName: applicantDetails.emergencyContact?.name,
        emergencyContactPhone: applicantDetails.emergencyContact?.phone,
      },
      ...(applicantDetails.partyMembers ?? []).map((m) => ({
        fullName: m.fullName,
        age: m.age,
        relationship: m.relationship,
      })),
    ];
  }

  const named = source.filter((p) => String(p?.fullName ?? '').trim() !== '');
  if (named.length !== seats) {
    throw new AppError(
      `The "${tierLabel}" package covers ${seats} ${seats === 1 ? 'person' : 'people'}. ` +
        `Please provide ${seats} named attendee(s); received ${named.length}.`,
      400
    );
  }

  const seen = new Set<string>();
  return named.map((p, index) => {
    const fullName = participantText(p.fullName, 'Attendee name', PARTICIPANT_NAME_MAX)!;
    const key = fullName.toLowerCase();
    if (seen.has(key)) {
      throw new AppError(`Attendee "${fullName}" is listed more than once.`, 400);
    }
    seen.add(key);

    return {
      fullName,
      isLead: index === 0,
      order: index,
      age: participantAge(p.age),
      relationship: participantText(p.relationship, 'Relationship', PARTICIPANT_NAME_MAX),
      dietaryRequirements: participantText(p.dietaryRequirements, 'Dietary requirements', PARTICIPANT_TEXT_MAX),
      medicalConditions: participantText(p.medicalConditions, 'Medical conditions', PARTICIPANT_TEXT_MAX),
      emergencyContactName: participantText(p.emergencyContactName, 'Emergency contact name', PARTICIPANT_NAME_MAX),
      emergencyContactPhone: participantText(p.emergencyContactPhone, 'Emergency contact phone', PARTICIPANT_NAME_MAX),
    };
  });
}

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
        category: true,
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

  const seatsByCamp = await getSeatsTakenByCamp(camps.map((c) => c.id));

  res.json({
    success: true,
    message: 'Camps fetched.',
    // _count.registrations counts rows; seats is what capacity is measured in.
    data: camps.map((camp) => {
      const seatsTaken = seatsByCamp.get(camp.id) ?? 0;
      return {
        ...camp,
        seatsTaken,
        seatsRemaining: Math.max(camp.capacity - seatsTaken, 0),
      };
    }),
    meta: buildMeta(total, page, limit),
  });
});

// ─────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────

// GET /api/camps — List all upcoming/ongoing camps
export const getAllCamps = catchAsync(async (req: AuthRequest, res: Response) => {
  const camps = await prisma.camp.findMany({
    where: { status: { in: ['UPCOMING', 'ONGOING'] } },
    orderBy: { startDate: 'asc' },
    include: publicCampInclude,
  });

  res.json({
    success: true,
    message: 'Camps fetched.',
    data: await serializeCamps(camps, currencyOf(req)),
  });
});

// GET /api/camps/current — Next upcoming camp (the "Annual Camping Programme" featured event)
export const getCurrentCamp = catchAsync(async (req: AuthRequest, res: Response) => {
  const camp = await prisma.camp.findFirst({
    where: { status: 'UPCOMING' },
    orderBy: { startDate: 'asc' },
    include: publicCampInclude,
  });

  if (!camp) {
    res.json({ success: true, message: 'No upcoming camp scheduled.', data: null });
    return;
  }

  res.json({
    success: true,
    message: 'Current camp fetched.',
    data: await serializeCamp(camp, currencyOf(req)),
  });
});

// GET /api/camps/:id — Single camp detail
export const getCampById = catchAsync(async (req: AuthRequest, res: Response) => {
  const camp = await prisma.camp.findUnique({
    where: { id: req.params.id },
    include: publicCampInclude,
  });

  if (!camp) throw new AppError('Camp not found.', 404);

  res.json({
    success: true,
    message: 'Camp fetched.',
    data: await serializeCamp(camp, currencyOf(req)),
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
  const { tierId, applicantDetails, participants: participantsInput } = req.body as {
    tierId?: string;
    applicantDetails?: ApplicantDetails;
    participants?: ParticipantInput[];
  };

  const registration = await prisma.$transaction(async (tx) => {
    // Lock the camp row so concurrent registrations on this camp serialize.
    await tx.$queryRaw`SELECT id FROM "camps" WHERE id = ${campId} FOR UPDATE`;

    const camp = await tx.camp.findUnique({
      where: { id: campId },
      include: { tiers: true },
    });
    if (!camp) throw new AppError('Camp not found.', 404);
    if (!isCampOpenForRegistration(camp.status)) {
      throw new AppError('This camp is no longer accepting applications.', 400);
    }
    if (camp.tiers.length === 0) {
      throw new AppError(
        'This camp has no participation tiers configured. Add tiers before opening registration.',
        400
      );
    }

    if (!tierId) throw new AppError('Please select a participation tier.', 400);
    const tier = camp.tiers.find((t) => t.id === tierId) ?? null;
    if (!tier) throw new AppError('Invalid tier selected.', 400);

    const participantCount = tier.seatsPerUnit;
    const now = new Date();

    // One checkout at a time per user per camp — otherwise a single account
    // could hold unlimited inventory through repeated unpaid holds.
    const existingForUser = await tx.campRegistration.findMany({
      where: { userId, campId },
      include: { payment: { select: { status: true } } },
    });
    const blocked = blockedNewRegistrationReason(existingForUser, now);
    if (blocked) throw new AppError(BLOCKED_NEW_REGISTRATION_MESSAGE[blocked], 400);

    // Tier cap counts purchases, not seats.
    if (tier.maxUnits != null) {
      const heldUnits = await tx.campRegistration.count({
        where: whereCountsTowardTierInventory(tier.id, now),
      });
      if (heldUnits >= tier.maxUnits) {
        throw new AppError(`The "${tier.label}" package is sold out.`, 400);
      }
    }

    // Camp capacity counts seats: SUM(participantCount) over holding rows.
    const seatsAgg = await tx.campRegistration.aggregate({
      where: whereCountsTowardCampInventory(campId, now),
      _sum: { participantCount: true },
    });
    const seatsTaken = seatsAgg._sum.participantCount ?? 0;
    const seatsRemaining = Math.max(camp.capacity - seatsTaken, 0);
    if (participantCount > seatsRemaining) {
      throw new AppError(
        seatsRemaining === 0
          ? 'This camp is fully booked.'
          : `Only ${seatsRemaining} seat(s) remain, and the "${tier.label}" package needs ${participantCount}.`,
        400
      );
    }

    const manifest = buildManifest(participantsInput, applicantDetails, participantCount, tier.label);

    const created = await tx.campRegistration.create({
      data: {
        userId,
        campId,
        tierId: tier.id,
        participantCount,
        applicantDetails: (applicantDetails ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        status: CampRegistrationStatus.PENDING_PAYMENT,
        paymentExpiresAt: computePaymentExpiresAt(now),
        participants: { create: manifest },
      },
      include: {
        camp: true,
        tier: true,
        participants: { orderBy: { order: 'asc' } },
      },
    });

    return created;
  });

  res.status(201).json({
    success: true,
    message: 'Application submitted. Please complete payment within 60 minutes.',
    data: registration,
  });
});

// GET /api/camps/:id/my-registration — Caller's own registration state for this camp.
//
// Pure read; never mutates. Used by the frontend to decide what to show on the
// camp page (apply button vs. "Complete Payment" countdown vs. "Confirmed" vs.
// "Expired — re-apply"). Returns `data: null` with 200 if the user has no row
// for this camp, so the client has a single response shape to handle.
export const getMyCampRegistrations = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { id: campId } = req.params;

  const registrations = await prisma.campRegistration.findMany({
    where: { userId, campId },
    orderBy: { createdAt: 'desc' },
    include: {
      camp: true,
      tier: { select: { id: true, label: true, priceMinor: true, seatsPerUnit: true } },
      participants: { orderBy: { order: 'asc' } },
      payment: {
        select: {
          status: true,
          presentmentAmountMinor: true,
          presentmentCurrency: true,
          baseAmountMinor: true,
          baseCurrency: true,
          createdAt: true,
        },
      },
    },
  });

  const now = new Date();
  const blockedReason = blockedNewRegistrationReason(registrations, now);
  const confirmed = registrations.filter((r) => r.status === 'CONFIRMED');

  res.json({
    success: true,
    message: 'Registrations fetched.',
    data: {
      registrations: registrations.map(withPaymentAmount),
      // The row the user still has to act on, if any.
      actionable: [registrations.find((r) => isRegistrationActiveHold(r, now) && r.status !== 'CONFIRMED')]
        .filter(Boolean)
        .map((r) => withPaymentAmount(r!))[0] ?? null,
      confirmedUnits: confirmed.length,
      confirmedSeats: confirmed.reduce((sum, r) => sum + r.participantCount, 0),
      canBookAnother: blockedReason === null,
      blockedReason,
      blockedMessage: blockedReason ? BLOCKED_NEW_REGISTRATION_MESSAGE[blockedReason] : null,
    },
  });
});


// ─────────────────────────────────────────────
// ADMIN ROUTES — CAMPS
// ─────────────────────────────────────────────

// POST /api/camps — Create a camp (set prices on tiers after creation)
export const createCamp = catchAsync(async (req: AuthRequest, res: Response) => {
  const { title, description, location, capacity, startDate, endDate, category, benefits } =
    req.body;
  const thumbnail = (req.file as Express.Multer.File & { path: string })?.path;

  const parsedBenefits = parseStringArray(benefits);
  const parsedCategory = parseCampCategory(category, true)!;

  const camp = await prisma.camp.create({
    data: {
      title,
      description,
      location,
      category: parsedCategory,
      capacity: parseInt(capacity),
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      benefits: parsedBenefits,
      thumbnail,
    },
  });

  scheduleChatReindexCamp(camp.id);
  res.status(201).json({
    success: true,
    message: 'Camp created.',
    data: camp,
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
    category,
    benefits,
  } = req.body;
  const thumbnail = (req.file as Express.Multer.File & { path: string })?.path;

  // Omit to keep the current value; when present it must be a non-empty phrase
  // (there is no way to clear it back to null via the API).
  const parsedCategory = category !== undefined ? parseCampCategory(category, true) : undefined;

  const camp = await prisma.camp.update({
    where: { id: req.params.id },
    data: {
      ...(title && { title }),
      ...(description && { description }),
      ...(location && { location }),
      ...(parsedCategory !== undefined && { category: parsedCategory }),
      ...(capacity && { capacity: parseInt(capacity) }),
      ...(startDate && { startDate: new Date(startDate) }),
      ...(endDate && { endDate: new Date(endDate) }),
      ...(status && { status }),
      ...(benefits !== undefined && { benefits: parseStringArray(benefits) }),
      ...(thumbnail && { thumbnail }),
    },
  });

  scheduleChatReindexCamp(camp.id);
  res.json({ success: true, message: 'Camp updated.', data: camp });
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
        tier: { select: { id: true, label: true, priceMinor: true, seatsPerUnit: true } },
        participants: { orderBy: { order: 'asc' } },
        payment: { select: { status: true, presentmentAmountMinor: true, presentmentCurrency: true, baseAmountMinor: true, baseCurrency: true, createdAt: true } },
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
    data: registrations.map(withPaymentAmount),
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
        priceMinor: parseToMinor(String(price), BASE_CURRENCY),
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

  // participantCount is copied onto each registration at booking time, so
  // changing seatsPerUnit later would leave capacity maths using stale values.
  if (seatsPerUnit !== undefined && parseInt(seatsPerUnit) !== existing.seatsPerUnit) {
    const holding = await prisma.campRegistration.count({
      where: whereCountsTowardTierInventory(tierId),
    });
    if (holding > 0) {
      throw new AppError(
        `Cannot change seats per unit while ${holding} registration(s) hold this tier. ` +
          'Create a new tier instead so existing bookings keep their seat count.',
        400
      );
    }
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

export const CAMP_CATEGORY_MAX = 80;

/**
 * Single free-text phrase, e.g. "Wellness Retreat".
 * Required by the API on create even though the column is nullable — existing
 * camps predate the field and are left untouched until an admin edits them.
 */
function parseCampCategory(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw new AppError('category is required.', 400);
    return undefined;
  }
  const s = String(raw).trim();
  if (s.length > CAMP_CATEGORY_MAX) {
    throw new AppError(`category must be at most ${CAMP_CATEGORY_MAX} characters.`, 400);
  }
  return s;
}
