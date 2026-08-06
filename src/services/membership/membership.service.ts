import { BillingInterval, MembershipPlan, Subscription, SubscriptionStatus } from '@prisma/client';
import prisma from '../../config/prisma';
import { AppError } from '../../middleware/error.middleware';
import { BASE_CURRENCY, minorToDecimalString } from '../../lib/money';
import { localizePrice } from '../pricing/price.service';
import { createFlutterwavePaymentPlan } from '../../lib/flutterwaveIntegration';

/** Statuses that still entitle the member to their benefits. */
export const ENTITLED_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.CANCELLED,
];

/** Statuses that occupy the member's single subscription slot. */
export const OCCUPYING_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.PENDING_PAYMENT,
  ...ENTITLED_STATUSES,
];

export function priceMinorFor(plan: MembershipPlan, interval: BillingInterval): bigint {
  return interval === BillingInterval.ANNUAL ? plan.annualPriceMinor : plan.monthlyPriceMinor;
}

export function parseInterval(raw: unknown): BillingInterval {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'MONTHLY' || s === 'ANNUAL') return s as BillingInterval;
  throw new AppError('interval must be MONTHLY or ANNUAL.', 400);
}

export function addInterval(from: Date, interval: BillingInterval): Date {
  const d = new Date(from);
  if (interval === BillingInterval.ANNUAL) d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/**
 * A subscription is "entitled" while the paid period has not elapsed, even
 * after cancelling — cancelling switches off auto-renew, it does not revoke
 * time already paid for.
 */
export function isEntitled(sub: Pick<Subscription, 'status' | 'currentPeriodEnd'>, now = new Date()): boolean {
  if (!ENTITLED_STATUSES.includes(sub.status)) return false;
  if (!sub.currentPeriodEnd) return sub.status === SubscriptionStatus.ACTIVE;
  return sub.currentPeriodEnd.getTime() > now.getTime();
}

/** The member's single live subscription, or null. */
export async function getCurrentSubscription(userId: string) {
  return prisma.subscription.findFirst({
    where: { userId, status: { in: OCCUPYING_STATUSES } },
    include: { plan: true, pendingPlan: true },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Resolves the Flutterwave payment plan for a (plan, interval, currency) at the
 * plan's *current* price, creating it on first use.
 *
 * Keyed on amount as well, so repricing mints a new provider plan rather than
 * changing what existing subscribers are billed — they stay on the plan they
 * agreed to until they change tier.
 */
export async function resolveProviderPlan(
  plan: MembershipPlan,
  interval: BillingInterval,
  currency: string,
  amountMinor: bigint
) {
  const existing = await prisma.membershipProviderPlan.findUnique({
    where: {
      planId_interval_currency_amountMinor: {
        planId: plan.id,
        interval,
        currency,
        amountMinor,
      },
    },
  });
  if (existing) return existing;

  const amount = Number(minorToDecimalString(amountMinor, currency));
  const created = await createFlutterwavePaymentPlan({
    name: `${plan.name} — ${interval === BillingInterval.ANNUAL ? 'Annual' : 'Monthly'} (${currency})`,
    amount,
    currency,
    interval: interval === BillingInterval.ANNUAL ? 'yearly' : 'monthly',
  });

  if (created.status !== 'success' || !created.data?.id) {
    throw new AppError(
      created.message || 'Could not set up recurring billing for this plan. Please try again.',
      502
    );
  }

  // Two concurrent first-subscribers can both miss the cache and create a plan
  // at Flutterwave. Losing that race is harmless — keep the row that landed.
  return prisma.membershipProviderPlan.upsert({
    where: {
      planId_interval_currency_amountMinor: {
        planId: plan.id,
        interval,
        currency,
        amountMinor,
      },
    },
    update: {},
    create: {
      planId: plan.id,
      interval,
      currency,
      amountMinor,
      providerPlanId: String(created.data.id),
    },
  });
}

export interface MembershipQuote {
  amount: number;
  amountMinor: bigint;
  currency: string;
  baseAmountMinor: bigint;
  baseCurrency: string;
}

/** Localises a plan price for checkout. Throws StaleRateError like every other quote. */
export async function quotePlan(
  plan: MembershipPlan,
  interval: BillingInterval,
  currency: string
): Promise<MembershipQuote> {
  const baseMinor = priceMinorFor(plan, interval);
  if (baseMinor <= 0n) throw new AppError('This plan has no price set. Please contact support.', 400);

  const localized = await localizePrice(baseMinor, currency);
  return {
    amount: localized.amount,
    amountMinor: localized.amountMinor,
    currency: localized.currency,
    baseAmountMinor: localized.baseAmountMinor,
    baseCurrency: localized.baseCurrency ?? BASE_CURRENCY,
  };
}
