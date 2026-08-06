import { Payment, SubscriptionStatus, User } from '@prisma/client';
import prisma from '../../config/prisma';
import { addInterval } from './membership.service';

/**
 * Applies a successful membership charge.
 *
 * The same code path serves the first charge and every Flutterwave-driven
 * renewal: both arrive as `charge.completed` against a Payment row we created,
 * and both mean "the member has paid for one more interval". Renewals extend
 * from the existing period end rather than from the payment date, so a webhook
 * that lands a few hours late does not shorten the period the member bought.
 */
export async function fulfilMembershipPayment(input: {
  payment: Payment;
  userId: string;
  subscriptionId: string;
  paidAt: Date;
  user: User;
}): Promise<void> {
  const { payment, userId, subscriptionId, paidAt } = input;

  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: true },
  });
  if (!sub || sub.userId !== userId) {
    console.warn(`[membership] payment ${payment.providerRef} has no matching subscription.`);
    return;
  }

  const isRenewal = sub.status !== SubscriptionStatus.PENDING_PAYMENT && !!sub.currentPeriodEnd;
  const anchor =
    isRenewal && sub.currentPeriodEnd && sub.currentPeriodEnd > paidAt
      ? sub.currentPeriodEnd
      : paidAt;

  // A downgrade scheduled during the last period takes effect now, at the
  // renewal boundary — that is the whole point of deferring it.
  const applyPending = isRenewal && sub.pendingPlanId;
  const nextPlanId = applyPending ? sub.pendingPlanId! : sub.planId;
  const nextInterval = applyPending && sub.pendingInterval ? sub.pendingInterval : sub.interval;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: SubscriptionStatus.ACTIVE,
      planId: nextPlanId,
      interval: nextInterval,
      currentPeriodStart: isRenewal ? sub.currentPeriodEnd ?? paidAt : paidAt,
      currentPeriodEnd: addInterval(anchor, nextInterval),
      pendingPlanId: null,
      pendingInterval: null,
      ...(payment.providerResponse &&
      typeof payment.providerResponse === 'object' &&
      'data' in (payment.providerResponse as Record<string, unknown>)
        ? {}
        : {}),
    },
  });

  // Supersede any other subscription this member was holding — an upgrade
  // creates a new row and the old one must stop occupying the single slot.
  await prisma.subscription.updateMany({
    where: {
      userId,
      id: { not: sub.id },
      status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING_PAYMENT, SubscriptionStatus.PAST_DUE, SubscriptionStatus.CANCELLED] },
    },
    data: { status: SubscriptionStatus.EXPIRED, cancelAtPeriodEnd: true },
  });
}
