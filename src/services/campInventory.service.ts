import { Prisma, CampRegistrationStatus } from '@prisma/client';
import prisma from '../config/prisma';

/**
 * Single source of truth for camp registration inventory + lifecycle rules.
 *
 * Consumed by:
 *   - camp.controller     (registerForCamp + public seat counts)
 *   - payment.controller  (initialize + provider webhook for type=CAMP)
 *   - campRegistrationExpiry.service (Phase 6)
 *   - dashboard / admin   (read endpoints)
 *
 * This file imports only @prisma/client and the prisma singleton; nothing else
 * imports back into it, so the dependency graph stays one-directional.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a freshly-created PENDING_PAYMENT registration holds its seat
 * before the expiry worker releases it. Aligns with the user-facing
 * "complete payment within 60 minutes" copy and matches the consultation flow.
 */
export const CAMP_PAYMENT_HOLD_MS = 60 * 60 * 1000;

export function computePaymentExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + CAMP_PAYMENT_HOLD_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Where-clause builders (use inside controllers / transactions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows that currently consume camp / tier inventory:
 *   - CONFIRMED                                          → fully paid
 *   - PENDING_PAYMENT with paymentExpiresAt in the future → active hold
 *
 * A null paymentExpiresAt on a PENDING_PAYMENT row is defensively treated as
 * still holding (shouldn't occur because /register always sets it; the expiry
 * worker also normalizes). EXPIRED and CANCELLED never consume inventory.
 */
function holdingInventoryFilter(now: Date): Prisma.CampRegistrationWhereInput {
  return {
    OR: [
      { status: CampRegistrationStatus.CONFIRMED },
      {
        status: CampRegistrationStatus.PENDING_PAYMENT,
        OR: [
          { paymentExpiresAt: null },
          { paymentExpiresAt: { gt: now } },
        ],
      },
    ],
  };
}

export function whereCountsTowardCampInventory(
  campId: string,
  now: Date = new Date()
): Prisma.CampRegistrationWhereInput {
  return { campId, ...holdingInventoryFilter(now) };
}

export function whereCountsTowardTierInventory(
  tierId: string,
  now: Date = new Date()
): Prisma.CampRegistrationWhereInput {
  return { tierId, ...holdingInventoryFilter(now) };
}

/**
 * Used by the expiry worker (Phase 6): PENDING_PAYMENT rows whose deadline
 * has elapsed. Rows with a null deadline are not auto-expired here; they
 * indicate a data anomaly and should be inspected manually.
 */
export function whereExpiredHoldCandidates(
  now: Date = new Date()
): Prisma.CampRegistrationWhereInput {
  return {
    status: CampRegistrationStatus.PENDING_PAYMENT,
    paymentExpiresAt: { lt: now },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience aggregations (read endpoints; not for use inside transactions —
// pass the where-clause builders into the transaction client directly there)
// ─────────────────────────────────────────────────────────────────────────────

/** Total seats currently held for a camp (sum of participantCount on holding rows). */
export async function getSeatsTaken(
  campId: string,
  now: Date = new Date()
): Promise<number> {
  const agg = await prisma.campRegistration.aggregate({
    where: whereCountsTowardCampInventory(campId, now),
    _sum: { participantCount: true },
  });
  return agg._sum.participantCount ?? 0;
}

/** How many units of a specific tier are currently held (one row = one unit). */
export async function getTierUnitsHeld(
  tierId: string,
  now: Date = new Date()
): Promise<number> {
  return prisma.campRegistration.count({
    where: whereCountsTowardTierInventory(tierId, now),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure predicates (no DB) — work on any object that has the lifecycle fields
// ─────────────────────────────────────────────────────────────────────────────

type RegistrationLifecycleFields = {
  status: CampRegistrationStatus;
  paymentExpiresAt: Date | null;
};

/**
 * True when the registration can still complete checkout. Used by:
 *   - POST /api/payments/initialize (CAMP) before talking to the provider.
 *   - The provider webhook before promoting status to CONFIRMED.
 *
 * Strict by design: requires PENDING_PAYMENT with a deadline in the future.
 * A null deadline is treated as not payable so the webhook can route those
 * to the manual refund queue rather than silently confirming.
 */
export function isRegistrationPayable(
  reg: RegistrationLifecycleFields,
  at: Date = new Date()
): boolean {
  if (reg.status !== CampRegistrationStatus.PENDING_PAYMENT) return false;
  if (reg.paymentExpiresAt == null) return false;
  return reg.paymentExpiresAt.getTime() > at.getTime();
}

/**
 * True when the row currently consumes a seat (CONFIRMED, or PENDING_PAYMENT
 * within its hold window). Mirrors `holdingInventoryFilter` for in-memory checks.
 */
export function isRegistrationActiveHold(
  reg: RegistrationLifecycleFields,
  at: Date = new Date()
): boolean {
  if (reg.status === CampRegistrationStatus.CONFIRMED) return true;
  if (reg.status !== CampRegistrationStatus.PENDING_PAYMENT) return false;
  if (reg.paymentExpiresAt == null) return true;
  return reg.paymentExpiresAt.getTime() > at.getTime();
}

/**
 * True when /api/camps/:id/register is allowed to reuse this row (reset back
 * to PENDING_PAYMENT). False for active holds and for CONFIRMED rows
 * (which should respond with "already applied").
 */
export function canReuseRegistrationRow(
  reg: RegistrationLifecycleFields,
  at: Date = new Date()
): boolean {
  if (reg.status === CampRegistrationStatus.EXPIRED) return true;
  if (reg.status === CampRegistrationStatus.CANCELLED) return true;
  if (reg.status === CampRegistrationStatus.PENDING_PAYMENT) {
    if (reg.paymentExpiresAt == null) return false;
    return reg.paymentExpiresAt.getTime() <= at.getTime();
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batched aggregates (list endpoints) — one query per camp set, not per tier
// ─────────────────────────────────────────────────────────────────────────────

/** Seats held per camp, keyed by campId. */
export async function getSeatsTakenByCamp(
  campIds: string[],
  now: Date = new Date()
): Promise<Map<string, number>> {
  if (campIds.length === 0) return new Map();
  const rows = await prisma.campRegistration.groupBy({
    by: ['campId'],
    where: { campId: { in: campIds }, ...holdingInventoryFilter(now) },
    _sum: { participantCount: true },
  });
  return new Map(rows.map((r) => [r.campId, r._sum.participantCount ?? 0]));
}

/** Units held per tier, keyed by tierId. One holding row = one unit. */
export async function getUnitsHeldByTier(
  campIds: string[],
  now: Date = new Date()
): Promise<Map<string, number>> {
  if (campIds.length === 0) return new Map();
  const rows = await prisma.campRegistration.groupBy({
    by: ['tierId'],
    where: { campId: { in: campIds }, tierId: { not: null }, ...holdingInventoryFilter(now) },
    _count: { _all: true },
  });
  return new Map(rows.filter((r) => r.tierId).map((r) => [r.tierId as string, r._count._all]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier availability
// ─────────────────────────────────────────────────────────────────────────────

export type TierUnavailableReason =
  | 'CAMP_CLOSED'
  | 'TIER_SOLD_OUT'
  | 'INSUFFICIENT_SEATS'
  | null;

export interface TierAvailability {
  unitsSold: number;
  unitsRemaining: number | null;
  isAvailable: boolean;
  unavailableReason: TierUnavailableReason;
}

/**
 * A tier is bookable only when the camp is open, the tier has units left, and
 * the camp has room for a whole unit. The last condition is why a camp can show
 * seats remaining while every tier is unavailable.
 */
export function computeTierAvailability(input: {
  campIsOpen: boolean;
  seatsRemaining: number;
  seatsPerUnit: number;
  maxUnits: number | null;
  unitsSold: number;
}): TierAvailability {
  const unitsRemaining =
    input.maxUnits == null ? null : Math.max(input.maxUnits - input.unitsSold, 0);

  let unavailableReason: TierUnavailableReason = null;
  if (!input.campIsOpen) unavailableReason = 'CAMP_CLOSED';
  else if (unitsRemaining !== null && unitsRemaining <= 0) unavailableReason = 'TIER_SOLD_OUT';
  else if (input.seatsRemaining < input.seatsPerUnit) unavailableReason = 'INSUFFICIENT_SEATS';

  return {
    unitsSold: input.unitsSold,
    unitsRemaining,
    isAvailable: unavailableReason === null,
    unavailableReason,
  };
}

export const CAMP_OPEN_STATUSES = ['UPCOMING'] as const;

export function isCampOpenForRegistration(status: string): boolean {
  return (CAMP_OPEN_STATUSES as readonly string[]).includes(status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multiple units per user
// ─────────────────────────────────────────────────────────────────────────────

export type BlockedNewRegistrationReason =
  | 'ACTIVE_HOLD'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_UNDER_REVIEW'
  | null;

/**
 * A user may hold several registrations for one camp, but only one checkout at
 * a time — otherwise a single person could hold arbitrary inventory by opening
 * repeated unpaid holds.
 */
export function blockedNewRegistrationReason(
  registrations: Array<
    RegistrationLifecycleFields & { payment?: { status: string } | null }
  >,
  at: Date = new Date()
): BlockedNewRegistrationReason {
  for (const reg of registrations) {
    // A SUCCESS payment on a non-CONFIRMED row is the pending-refund state.
    if (reg.status !== CampRegistrationStatus.CONFIRMED && reg.payment?.status === 'SUCCESS') {
      return 'PAYMENT_UNDER_REVIEW';
    }
    if (isRegistrationActiveHold(reg, at) && reg.status !== CampRegistrationStatus.CONFIRMED) {
      return 'ACTIVE_HOLD';
    }
    if (reg.payment?.status === 'PENDING' && reg.status !== CampRegistrationStatus.CONFIRMED) {
      return 'PAYMENT_PENDING';
    }
  }
  return null;
}

export const BLOCKED_NEW_REGISTRATION_MESSAGE: Record<
  Exclude<BlockedNewRegistrationReason, null>,
  string
> = {
  ACTIVE_HOLD:
    'You have a pending application for this camp. Complete payment for it or wait for it to expire before booking another.',
  PAYMENT_PENDING:
    'A payment for this camp is still processing. Wait for it to complete before booking another.',
  PAYMENT_UNDER_REVIEW:
    'A previous payment is pending review. Please contact support before booking again.',
};
