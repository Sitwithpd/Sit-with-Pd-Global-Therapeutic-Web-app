import { Request, Response } from 'express';
import { BillingInterval, MembershipPlan, Prisma, SubscriptionStatus } from '@prisma/client';
import prisma from '../config/prisma';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import { currencyOf } from '../middleware/currency.middleware';
import { BASE_CURRENCY, parseToMinor } from '../lib/money';
import { serializePrice, serializePaymentAmount } from '../lib/priceSerialization';
import {
  ENTITLED_STATUSES,
  OCCUPYING_STATUSES,
  addInterval,
  getCurrentSubscription,
  isEntitled,
  parseInterval,
  priceMinorFor,
} from '../services/membership/membership.service';
import crypto from 'crypto';
import {
  cancelFlutterwaveSubscription,
  initializeFlutterwavePayment,
} from '../lib/flutterwaveIntegration';
import { quotePlan, resolveProviderPlan } from '../services/membership/membership.service';

export const PLAN_NAME_MAX = 120;
export const PLAN_TAGLINE_MAX = 200;
export const PLAN_BENEFIT_MAX = 300;
export const PLAN_BENEFITS_MAX_COUNT = 30;

// ─────────────────────────────────────────────
// PARSING
// ─────────────────────────────────────────────

function parseBoolean(input: unknown, fallback: boolean): boolean {
  if (input === undefined || input === null || input === '') return fallback;
  if (typeof input === 'boolean') return input;
  return ['true', '1', 'yes', 'on'].includes(String(input).toLowerCase());
}

function parseText(raw: unknown, field: string, max: number, required: boolean): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw new AppError(`${field} is required.`, 400);
    return undefined;
  }
  const s = String(raw).trim();
  if (s.length > max) throw new AppError(`${field} must be at most ${max} characters.`, 400);
  return s;
}

/** Accepts an array, a JSON string, or newline-separated text (multipart sends any). */
function parseBenefits(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Buffer.isBuffer(raw)) return parseBenefits(raw.toString('utf8'));

  let items: unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else {
    const str = String(raw).trim();
    if (!str) return [];
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        throw new AppError('benefits must be a valid JSON array.', 400);
      }
    } else {
      items = str.split(/\r?\n/);
    }
  }

  const cleaned = items.map((v) => String(v).trim()).filter(Boolean);
  if (cleaned.length > PLAN_BENEFITS_MAX_COUNT) {
    throw new AppError(`benefits must have at most ${PLAN_BENEFITS_MAX_COUNT} entries.`, 400);
  }
  for (const b of cleaned) {
    if (b.length > PLAN_BENEFIT_MAX) {
      throw new AppError(`each benefit must be at most ${PLAN_BENEFIT_MAX} characters.`, 400);
    }
  }
  return cleaned;
}

function parsePriceMinor(raw: unknown, field: string, required: boolean): bigint | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw new AppError(`${field} is required.`, 400);
    return undefined;
  }
  const minor = parseToMinor(String(raw), BASE_CURRENCY);
  if (minor < 0n) throw new AppError(`${field} cannot be negative.`, 400);
  return minor;
}

// ─────────────────────────────────────────────
// SERIALIZATION
// ─────────────────────────────────────────────

/**
 * Both cadences are localised, because the pricing card shows a monthly/annual
 * toggle and must not round-trip to the server to flip it.
 */
async function serializePlan(plan: MembershipPlan, currency: string, admin = false) {
  const [monthly, annual] = await Promise.all([
    serializePrice(plan.monthlyPriceMinor, currency),
    serializePrice(plan.annualPriceMinor, currency),
  ]);

  const annualAsMonthlyMinor =
    annual.priceMinor > 0 ? Math.round(annual.priceMinor / 12) : 0;
  const monthlyOverYearMinor = monthly.priceMinor * 12;

  return {
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    benefits: plan.benefits,
    isActive: plan.isActive,
    isFeatured: plan.isFeatured,
    order: plan.order,
    currency: monthly.currency,
    monthlyPrice: monthly.price,
    monthlyPriceMinor: monthly.priceMinor,
    annualPrice: annual.price,
    annualPriceMinor: annual.priceMinor,
    /// Lets the UI show "£x/mo billed annually" without doing money maths itself.
    annualPricePerMonth: annualAsMonthlyMinor / 100,
    annualSavingsMinor: Math.max(monthlyOverYearMinor - annual.priceMinor, 0),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(admin && {
      baseCurrency: BASE_CURRENCY,
      baseMonthlyPriceMinor: Number(plan.monthlyPriceMinor),
      baseAnnualPriceMinor: Number(plan.annualPriceMinor),
    }),
  };
}

type SubscriptionWithPlan = Prisma.SubscriptionGetPayload<{
  include: { plan: true; pendingPlan: true };
}>;

function serializeSubscription(sub: SubscriptionWithPlan) {
  return {
    id: sub.id,
    status: sub.status,
    interval: sub.interval,
    isEntitled: isEntitled(sub),
    plan: {
      id: sub.plan.id,
      name: sub.plan.name,
      tagline: sub.plan.tagline,
      benefits: sub.plan.benefits,
    },
    amount: Number(sub.presentmentAmountMinor) / 100,
    amountMinor: Number(sub.presentmentAmountMinor),
    currency: sub.presentmentCurrency,
    baseAmountMinor: Number(sub.baseAmountMinor),
    baseCurrency: sub.baseCurrency,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelledAt: sub.cancelledAt,
    /// A scheduled downgrade that lands when the current period ends.
    pendingChange: sub.pendingPlan
      ? {
          planId: sub.pendingPlan.id,
          planName: sub.pendingPlan.name,
          interval: sub.pendingInterval,
          effectiveAt: sub.currentPeriodEnd,
        }
      : null,
    createdAt: sub.createdAt,
  };
}

// ─────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────

// GET /api/memberships/plans
export const getPlans = catchAsync(async (req: AuthRequest, res: Response) => {
  const plans = await prisma.membershipPlan.findMany({
    where: { isActive: true },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });
  const currency = currencyOf(req);

  res.json({
    success: true,
    message: 'Membership plans fetched.',
    data: await Promise.all(plans.map((p) => serializePlan(p, currency))),
  });
});

// GET /api/memberships/plans/:id
export const getPlanById = catchAsync(async (req: AuthRequest, res: Response) => {
  const plan = await prisma.membershipPlan.findFirst({
    where: { id: req.params.id, isActive: true },
  });
  if (!plan) throw new AppError('Membership plan not found.', 404);

  res.json({
    success: true,
    message: 'Membership plan fetched.',
    data: await serializePlan(plan, currencyOf(req)),
  });
});

// ─────────────────────────────────────────────
// MEMBER
// ─────────────────────────────────────────────

// GET /api/memberships/me
export const getMySubscription = catchAsync(async (req: AuthRequest, res: Response) => {
  const sub = await getCurrentSubscription(req.user!.id);

  res.json({
    success: true,
    message: 'Subscription fetched.',
    data: sub ? serializeSubscription(sub) : null,
  });
});

// GET /api/memberships/me/payments
export const getMySubscriptionPayments = catchAsync(async (req: AuthRequest, res: Response) => {
  const payments = await prisma.payment.findMany({
    where: { userId: req.user!.id, type: 'MEMBERSHIP' },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  res.json({
    success: true,
    message: 'Billing history fetched.',
    data: payments.map((p) => ({
      id: p.id,
      status: p.status,
      providerRef: p.providerRef,
      createdAt: p.createdAt,
      ...serializePaymentAmount(p),
    })),
  });
});

/**
 * POST /api/memberships/me/cancel
 *
 * Switches off auto-renew. The row keeps its period, so the member keeps the
 * access they paid for and there is nothing to refund.
 */
export const cancelMySubscription = catchAsync(async (req: AuthRequest, res: Response) => {
  const sub = await getCurrentSubscription(req.user!.id);
  if (!sub) throw new AppError('You do not have an active membership.', 404);
  if (sub.cancelAtPeriodEnd) throw new AppError('This membership is already set to cancel.', 400);
  if (sub.status === SubscriptionStatus.PENDING_PAYMENT) {
    throw new AppError('This membership has not been paid for yet.', 400);
  }

  // Best effort: if Flutterwave has already forgotten the subscription we still
  // want our own auto-renew flag off, so a failure here must not block.
  if (sub.providerSubscriptionId) {
    try {
      await cancelFlutterwaveSubscription(sub.providerSubscriptionId);
    } catch (err) {
      console.error('[membership] provider cancel failed:', err);
    }
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      cancelAtPeriodEnd: true,
      cancelledAt: new Date(),
      status: SubscriptionStatus.CANCELLED,
      // A scheduled downgrade is meaningless once they are leaving.
      pendingPlanId: null,
      pendingInterval: null,
    },
    include: { plan: true, pendingPlan: true },
  });

  res.json({
    success: true,
    message: 'Membership cancelled. You keep access until the end of your current period.',
    data: serializeSubscription(updated),
  });
});

/**
 * POST /api/memberships/me/resume — undo a cancellation before it lands.
 * Only possible while the paid period is still running.
 */
export const resumeMySubscription = catchAsync(async (req: AuthRequest, res: Response) => {
  const sub = await getCurrentSubscription(req.user!.id);
  if (!sub || !sub.cancelAtPeriodEnd) {
    throw new AppError('You do not have a cancelled membership to resume.', 404);
  }
  if (!isEntitled(sub)) {
    throw new AppError('This membership has already ended. Please subscribe again.', 400);
  }

  // The provider subscription was cancelled, so billing has to be re-established
  // by checking out again rather than silently reviving a dead mandate.
  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: false, cancelledAt: null, status: SubscriptionStatus.ACTIVE },
    include: { plan: true, pendingPlan: true },
  });

  res.json({
    success: true,
    message:
      'Membership resumed for the current period. Renew from your dashboard before it expires to restore automatic billing.',
    data: serializeSubscription(updated),
  });
});

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────

// GET /api/memberships/admin/plans
export const getPlansAdmin = catchAsync(async (req: AuthRequest, res: Response) => {
  const plans = await prisma.membershipPlan.findMany({
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { subscriptions: true } } },
  });

  const withCounts = await Promise.all(
    plans.map(async (plan) => ({
      ...(await serializePlan(plan, BASE_CURRENCY, true)),
      totalSubscriptions: plan._count.subscriptions,
      activeSubscribers: await prisma.subscription.count({
        where: { planId: plan.id, status: { in: ENTITLED_STATUSES } },
      }),
    }))
  );

  res.json({ success: true, message: 'Membership plans fetched.', data: withCounts });
});

// POST /api/memberships/admin/plans
export const createPlan = catchAsync(async (req: AuthRequest, res: Response) => {
  const plan = await prisma.membershipPlan.create({
    data: {
      name: parseText(req.body.name, 'name', PLAN_NAME_MAX, true)!,
      tagline: parseText(req.body.tagline, 'tagline', PLAN_TAGLINE_MAX, false) ?? null,
      monthlyPriceMinor: parsePriceMinor(req.body.monthlyPrice, 'monthlyPrice', true)!,
      annualPriceMinor: parsePriceMinor(req.body.annualPrice, 'annualPrice', true)!,
      benefits: parseBenefits(req.body.benefits),
      isActive: parseBoolean(req.body.isActive, true),
      isFeatured: parseBoolean(req.body.isFeatured, false),
      order: Number.isFinite(Number(req.body.order)) ? Number(req.body.order) : 0,
    },
  });

  res.status(201).json({
    success: true,
    message: 'Membership plan created.',
    data: await serializePlan(plan, BASE_CURRENCY, true),
  });
});

// PATCH /api/memberships/admin/plans/:id
export const updatePlan = catchAsync(async (req: AuthRequest, res: Response) => {
  const existing = await prisma.membershipPlan.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError('Membership plan not found.', 404);

  const data: Prisma.MembershipPlanUpdateInput = {};
  if (req.body.name !== undefined) data.name = parseText(req.body.name, 'name', PLAN_NAME_MAX, true);
  if (req.body.tagline !== undefined) {
    data.tagline = parseText(req.body.tagline, 'tagline', PLAN_TAGLINE_MAX, false) ?? null;
  }
  if (req.body.monthlyPrice !== undefined) {
    data.monthlyPriceMinor = parsePriceMinor(req.body.monthlyPrice, 'monthlyPrice', true);
  }
  if (req.body.annualPrice !== undefined) {
    data.annualPriceMinor = parsePriceMinor(req.body.annualPrice, 'annualPrice', true);
  }
  if (req.body.benefits !== undefined) data.benefits = { set: parseBenefits(req.body.benefits) };
  if (req.body.isActive !== undefined) data.isActive = parseBoolean(req.body.isActive, true);
  if (req.body.isFeatured !== undefined) data.isFeatured = parseBoolean(req.body.isFeatured, false);
  if (req.body.order !== undefined && Number.isFinite(Number(req.body.order))) {
    data.order = Number(req.body.order);
  }

  const plan = await prisma.membershipPlan.update({ where: { id: req.params.id }, data });

  res.json({
    success: true,
    message:
      'Membership plan updated. Existing subscribers keep the price they signed up at until they change plan.',
    data: await serializePlan(plan, BASE_CURRENCY, true),
  });
});

/**
 * DELETE /api/memberships/admin/plans/:id
 *
 * Refused while anyone has ever subscribed: subscription rows reference the
 * plan and are the billing record. Deactivating hides it from the public page
 * without destroying that history.
 */
export const deletePlan = catchAsync(async (req: AuthRequest, res: Response) => {
  const plan = await prisma.membershipPlan.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { subscriptions: true } } },
  });
  if (!plan) throw new AppError('Membership plan not found.', 404);

  if (plan._count.subscriptions > 0) {
    const active = await prisma.subscription.count({
      where: { planId: plan.id, status: { in: ENTITLED_STATUSES } },
    });
    throw new AppError(
      active > 0
        ? `This plan has ${active} active subscriber(s) and cannot be deleted. Deactivate it instead — it will disappear from the pricing page while existing members keep their billing.`
        : `This plan has ${plan._count.subscriptions} past subscription(s) on record and cannot be deleted without destroying billing history. Deactivate it instead.`,
      409
    );
  }

  await prisma.membershipPlan.delete({ where: { id: plan.id } });
  res.json({ success: true, message: 'Membership plan deleted.' });
});

// GET /api/memberships/admin/subscribers — optional ?status= & ?planId=
export const getSubscribersAdmin = catchAsync(async (req: AuthRequest, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const rawStatus = req.query.status;
  let status: SubscriptionStatus | undefined;
  if (rawStatus !== undefined && String(rawStatus).trim() !== '') {
    const s = String(rawStatus).trim().toUpperCase();
    if (!Object.values(SubscriptionStatus).includes(s as SubscriptionStatus)) {
      throw new AppError(
        `Invalid status. Use one of: ${Object.values(SubscriptionStatus).join(', ')}.`,
        400
      );
    }
    status = s as SubscriptionStatus;
  }

  const planId = typeof req.query.planId === 'string' && req.query.planId.trim()
    ? req.query.planId.trim()
    : undefined;

  const where: Prisma.SubscriptionWhereInput = {
    ...(status ? { status } : {}),
    ...(planId ? { planId } : {}),
  };

  const [subs, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      include: {
        plan: true,
        pendingPlan: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.subscription.count({ where }),
  ]);

  res.json({
    success: true,
    message: 'Subscribers fetched.',
    data: subs.map((s) => ({ ...serializeSubscription(s), user: s.user })),
    meta: buildMeta(total, page, limit),
  });
});

// GET /api/memberships/admin/stats
export const getMembershipStats = catchAsync(async (_req: AuthRequest, res: Response) => {
  const [active, cancelling, pastDue, byPlan, mrr] = await Promise.all([
    prisma.subscription.count({ where: { status: SubscriptionStatus.ACTIVE } }),
    prisma.subscription.count({ where: { cancelAtPeriodEnd: true, status: SubscriptionStatus.CANCELLED } }),
    prisma.subscription.count({ where: { status: SubscriptionStatus.PAST_DUE } }),
    prisma.subscription.groupBy({
      by: ['planId'],
      where: { status: { in: ENTITLED_STATUSES } },
      _count: true,
    }),
    prisma.subscription.findMany({
      where: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] } },
      select: { interval: true, baseAmountMinor: true },
    }),
  ]);

  // Annual plans contribute a twelfth of their charge to monthly recurring
  // revenue; mixing the two raw would overstate it twelvefold.
  const mrrMinor = mrr.reduce((sum, s) => {
    const minor = Number(s.baseAmountMinor);
    return sum + (s.interval === BillingInterval.ANNUAL ? Math.round(minor / 12) : minor);
  }, 0);

  res.json({
    success: true,
    message: 'Membership stats fetched.',
    data: {
      activeSubscribers: active,
      cancelling,
      pastDue,
      mrr: mrrMinor / 100,
      mrrMinor,
      currency: BASE_CURRENCY,
      byPlan: byPlan.map((r) => ({ planId: r.planId, subscribers: r._count })),
    },
  });
});

// ─────────────────────────────────────────────
// CHECKOUT
// ─────────────────────────────────────────────

function generateTxRef(userId: string): string {
  return `flw_${userId.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * POST /api/memberships/subscribe  { planId, interval }
 *
 * Also the upgrade path: an upgrade is a fresh charge that starts a new period
 * immediately, and the previous subscription is superseded once this one is
 * paid for (see membershipFulfilment). Downgrades never come through here —
 * they are scheduled by /change and cost nothing today.
 */
export const subscribe = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const interval = parseInterval(req.body.interval);
  const planId = String(req.body.planId ?? '').trim();
  if (!planId) throw new AppError('planId is required.', 400);

  const plan = await prisma.membershipPlan.findFirst({ where: { id: planId, isActive: true } });
  if (!plan) throw new AppError('Membership plan not found.', 404);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found.', 404);

  const current = await getCurrentSubscription(userId);
  if (current && current.planId === plan.id && current.interval === interval && isEntitled(current)) {
    throw new AppError('You are already on this plan.', 400);
  }
  if (current && current.status === SubscriptionStatus.PENDING_PAYMENT) {
    throw new AppError(
      'You already have a membership checkout in progress. Complete or abandon it before starting another.',
      409
    );
  }

  // Throws 503 when the FX rate is stale, exactly like every other checkout.
  const quote = await quotePlan(plan, interval, currencyOf(req));
  const providerPlan = await resolveProviderPlan(plan, interval, quote.currency, quote.amountMinor);

  const subscription = await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      interval,
      status: SubscriptionStatus.PENDING_PAYMENT,
      presentmentCurrency: quote.currency,
      presentmentAmountMinor: quote.amountMinor,
      baseCurrency: quote.baseCurrency,
      baseAmountMinor: quote.baseAmountMinor,
      providerPlanRowId: providerPlan.id,
    },
  });

  const txRef = generateTxRef(userId);
  const flwResponse = await initializeFlutterwavePayment({
    txRef,
    amount: quote.amount,
    currency: quote.currency,
    email: user.email,
    fullName: `${user.firstName} ${user.lastName}`.trim() || undefined,
    redirectUrl: `${process.env.CLIENT_URL}/payment/verify`,
    meta: { userId, type: 'MEMBERSHIP', itemId: subscription.id },
    paymentPlanId: providerPlan.providerPlanId,
  });

  if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
    // Nothing was charged, so the placeholder row must not linger and block
    // the member's next attempt.
    await prisma.subscription.delete({ where: { id: subscription.id } });
    throw new AppError(
      flwResponse.message || 'Could not start your membership. Please try again.',
      502
    );
  }

  await prisma.payment.create({
    data: {
      userId,
      type: 'MEMBERSHIP',
      status: 'PENDING',
      provider: 'FLUTTERWAVE',
      providerRef: txRef,
      providerResponse: { _initMeta: { userId, type: 'MEMBERSHIP', itemId: subscription.id } },
      presentmentCurrency: quote.currency,
      presentmentAmountMinor: quote.amountMinor,
      baseCurrency: quote.baseCurrency,
      baseAmountMinor: quote.baseAmountMinor,
      quotedAt: new Date(),
      subscriptionId: subscription.id,
    },
  });

  res.status(201).json({
    success: true,
    message: 'Membership checkout started.',
    data: {
      subscriptionId: subscription.id,
      authorizationUrl: flwResponse.data.link,
      reference: txRef,
      amount: quote.amount,
      currency: quote.currency,
      interval,
      planName: plan.name,
    },
  });
});

/**
 * POST /api/memberships/me/change  { planId, interval }
 *
 * Decides upgrade vs downgrade by comparing the GBP price of the two options,
 * never the presentment price — otherwise an FX move could turn an upgrade
 * into a downgrade. An upgrade is refused here and sent to /subscribe so the
 * member sees and approves the charge; a downgrade is scheduled for the period
 * boundary so no paid time is lost.
 */
export const changeMyPlan = catchAsync(async (req: AuthRequest, res: Response) => {
  const interval = parseInterval(req.body.interval);
  const planId = String(req.body.planId ?? '').trim();
  if (!planId) throw new AppError('planId is required.', 400);

  const sub = await getCurrentSubscription(req.user!.id);
  if (!sub || !isEntitled(sub)) throw new AppError('You do not have an active membership.', 404);
  if (sub.cancelAtPeriodEnd) {
    throw new AppError('This membership is cancelling. Resume it before changing plan.', 400);
  }

  const target = await prisma.membershipPlan.findFirst({ where: { id: planId, isActive: true } });
  if (!target) throw new AppError('Membership plan not found.', 404);

  if (target.id === sub.planId && interval === sub.interval) {
    throw new AppError('You are already on this plan.', 400);
  }

  const currentBase = priceMinorFor(sub.plan, sub.interval);
  const targetBase = priceMinorFor(target, interval);
  // Normalise to a monthly figure so MONTHLY and ANNUAL are comparable.
  const perMonth = (minor: bigint, i: BillingInterval) =>
    i === BillingInterval.ANNUAL ? minor / 12n : minor;

  if (perMonth(targetBase, interval) > perMonth(currentBase, sub.interval)) {
    throw new AppError(
      'This is an upgrade and takes effect immediately. Start it from checkout so you can review the charge.',
      409
    );
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: { pendingPlanId: target.id, pendingInterval: interval },
    include: { plan: true, pendingPlan: true },
  });

  res.json({
    success: true,
    message: `You will move to ${target.name} when your current period ends. Nothing is charged today.`,
    data: serializeSubscription(updated),
  });
});

/** DELETE /api/memberships/me/change — drop a scheduled downgrade. */
export const cancelScheduledChange = catchAsync(async (req: AuthRequest, res: Response) => {
  const sub = await getCurrentSubscription(req.user!.id);
  if (!sub || !sub.pendingPlanId) {
    throw new AppError('You have no scheduled plan change.', 404);
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: { pendingPlanId: null, pendingInterval: null },
    include: { plan: true, pendingPlan: true },
  });

  res.json({
    success: true,
    message: 'Scheduled plan change removed.',
    data: serializeSubscription(updated),
  });
});
