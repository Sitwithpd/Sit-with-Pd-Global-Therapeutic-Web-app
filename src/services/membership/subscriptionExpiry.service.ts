import { SubscriptionStatus } from '@prisma/client';
import prisma from '../../config/prisma';

/**
 * Retires subscriptions whose paid period has elapsed.
 *
 * Flutterwave owns the retry schedule, so a missing renewal here does not mean
 * the charge failed permanently — it means we have not seen a successful one
 * yet. An ACTIVE row therefore goes PAST_DUE first and keeps its benefits for a
 * grace window, while a row the member already cancelled expires immediately
 * because no further charge is coming.
 */
export const PAST_DUE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export async function processExpiredSubscriptions(now = new Date()): Promise<{
  pastDue: number;
  expired: number;
}> {
  const cancelled = await prisma.subscription.updateMany({
    where: {
      status: SubscriptionStatus.CANCELLED,
      currentPeriodEnd: { lt: now },
    },
    data: { status: SubscriptionStatus.EXPIRED },
  });

  const lapsed = await prisma.subscription.updateMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: { lt: now },
    },
    data: { status: SubscriptionStatus.PAST_DUE },
  });

  const graceElapsed = await prisma.subscription.updateMany({
    where: {
      status: SubscriptionStatus.PAST_DUE,
      currentPeriodEnd: { lt: new Date(now.getTime() - PAST_DUE_GRACE_MS) },
    },
    data: { status: SubscriptionStatus.EXPIRED },
  });

  // An abandoned checkout must not hold the member's single subscription slot.
  const staleCheckouts = await prisma.subscription.updateMany({
    where: {
      status: SubscriptionStatus.PENDING_PAYMENT,
      createdAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) },
    },
    data: { status: SubscriptionStatus.EXPIRED },
  });

  const expired = cancelled.count + graceElapsed.count + staleCheckouts.count;
  if (lapsed.count || expired) {
    console.log(`[subscription-expiry] ${lapsed.count} past due, ${expired} expired.`);
  }
  return { pastDue: lapsed.count, expired };
}
