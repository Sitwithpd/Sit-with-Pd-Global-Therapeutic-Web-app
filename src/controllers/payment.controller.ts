import { Request, Response } from 'express';
import crypto from 'crypto';
import { CampRegistrationStatus, PaymentProvider } from '@prisma/client';
import prisma from '../config/prisma';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest, FlutterwaveWebhookEvent, PaystackEvent } from '../types';
import {
  sendProgramPurchaseEmail,
  sendCampRegistrationEmail,
  sendConsultationBookingEmail,
} from '../utils/email.service';
import { isRegistrationPayable } from '../services/campInventory.service';
import {
  initializeFlutterwavePayment,
  isValidFlutterwaveWebhookSignature,
} from '../lib/flutterwaveIntegration';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE = 'https://api.paystack.co';

const DEFAULT_CURRENCY = (process.env.PAYMENT_DEFAULT_CURRENCY?.trim() || 'NGN').toUpperCase();

function parseProvider(raw: unknown): PaymentProvider {
  if (raw === undefined || raw === null || raw === '') return PaymentProvider.PAYSTACK;
  const s = String(raw).trim().toUpperCase();
  if (s === 'PAYSTACK') return PaymentProvider.PAYSTACK;
  if (s === 'FLUTTERWAVE' || s === 'FLW') return PaymentProvider.FLUTTERWAVE;
  throw new AppError('provider must be PAYSTACK or FLUTTERWAVE.', 400);
}

function parseCurrency(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CURRENCY;
  if (typeof raw !== 'string') throw new AppError('currency must be a 3-letter ISO code string.', 400);
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) {
    throw new AppError('currency must be a 3-letter ISO code (e.g. NGN, USD, GBP).', 400);
  }
  return s;
}

/** tx_ref Flutterwave will return on webhook. Prefixed for traceability. */
function generateFlutterwaveTxRef(userId: string): string {
  return `flw_${userId.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// ── Helper: Call Paystack API ─────────────────────────────────────────────────
const paystackRequest = async (endpoint: string, method = 'GET', body?: object) => {
  const res = await fetch(`${PAYSTACK_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return res.json();
};

// ── Initialize Payment ────────────────────────────────────────────────────────
// POST /api/payments/initialize
// Body: {
//   type: 'PROGRAM' | 'CAMP' | 'CONSULTATION',
//   itemId: string,
//   provider?: 'PAYSTACK' | 'FLUTTERWAVE',  // default PAYSTACK
//   currency?: 'NGN' | 'USD' | ...           // ISO code; default PAYMENT_DEFAULT_CURRENCY or NGN
// }
// CAMP: amount comes from the registration's CampTier only.
export const initializePayment = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { type, itemId } = req.body;
  const provider = parseProvider(req.body?.provider);
  let currency = parseCurrency(req.body?.currency);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found.', 404);

  let amount = 0;
  let description = '';

  // Determine amount based on payment type
  if (type === 'PROGRAM') {
    const program = await prisma.program.findUnique({ where: { id: itemId } });
    if (!program) throw new AppError('Program not found.', 404);

    // Check not already purchased
    const existing = await prisma.purchase.findUnique({
      where: { userId_programId: { userId, programId: itemId } },
    });
    if (existing) throw new AppError('You already own this program.', 400);

    amount = program.price;
    // The program's stored currency is authoritative for its price. Ignore any
    // currency on the request so a Naira-priced program can never be charged as
    // USD (which previously produced amounts far above provider limits).
    currency = program.currency;
    description = `Purchase: ${program.title}`;

  } else if (type === 'CAMP') {
    const registration = await prisma.campRegistration.findUnique({
      where: { id: itemId },
      include: { camp: true, tier: true, payment: true },
    });
    if (!registration) throw new AppError('Camp registration not found.', 404);
    if (registration.userId !== userId) throw new AppError('Unauthorized.', 403);

    if (!registration.tier) {
      throw new AppError(
        'Camp registration is missing tier pricing. Please contact support.',
        400
      );
    }

    // Lifecycle gate (Phase 5): refuse to start a Paystack session for any
    // registration that is not currently payable. This catches CONFIRMED,
    // EXPIRED, CANCELLED, and PENDING_PAYMENT past the 60-minute deadline.
    if (registration.status === CampRegistrationStatus.CONFIRMED) {
      throw new AppError('You have already paid for this application.', 400);
    }
    if (!isRegistrationPayable(registration)) {
      throw new AppError(
        'This application has expired. Please re-apply to obtain a new payment window.',
        400
      );
    }

    // Stale-payment cleanup: free the Payment.campRegistrationId @unique slot so
    // the new Payment row created below can attach. Mirrors the cleanup performed
    // by camp.controller.ts on the reset path; this branch additionally handles
    // the double-click case where a user clicks "Pay" twice on the same active
    // registration before the first session is finalised.
    if (registration.payment) {
      if (registration.payment.status === 'SUCCESS') {
        throw new AppError('You have already paid for this application.', 400);
      }
      await prisma.payment.update({
        where: { id: registration.payment.id },
        data: {
          campRegistrationId: null,
          ...(registration.payment.status === 'PENDING' ? { status: 'FAILED' as const } : {}),
        },
      });
    }

    amount = registration.tier.price;
    // Camp tier prices are denominated in the camp's stored currency.
    currency = registration.camp.currency;
    description = `Camp Application: ${registration.camp.title} — ${registration.tier.label}`;

  } else if (type === 'CONSULTATION') {
    const consultation = await prisma.consultation.findUnique({
      where: { id: itemId },
      include: { service: true },
    });
    if (!consultation) throw new AppError('Consultation not found.', 404);
    if (consultation.userId !== userId) throw new AppError('Unauthorized.', 403);

    amount = consultation.service.price;
    // Service price is denominated in the consultation service's stored currency.
    currency = consultation.service.currency;
    description = `Consultation: ${consultation.service.title}`;
  }

  let authorizationUrl: string;
  let reference: string;

  if (provider === PaymentProvider.PAYSTACK) {
    // Paystack expects amount in kobo (multiply by 100)
    const paystackResponse = (await paystackRequest('/transaction/initialize', 'POST', {
      email: user.email,
      amount: amount * 100,
      currency,
      metadata: { userId, type, itemId },
      callback_url: `${process.env.CLIENT_URL}/payment/verify`,
    })) as { status: boolean; data: { reference: string; authorization_url: string } };

    if (!paystackResponse.status) {
      throw new AppError('Could not initialize payment. Please try again.', 500);
    }

    authorizationUrl = paystackResponse.data.authorization_url;
    reference = paystackResponse.data.reference;
  } else {
    // Flutterwave — full units (no kobo conversion). We generate tx_ref and store
    // it on the Payment row; the webhook echoes it back under data.tx_ref.
    const txRef = generateFlutterwaveTxRef(userId);
    const fullName = `${user.firstName} ${user.lastName}`.trim() || undefined;

    const flwResponse = await initializeFlutterwavePayment({
      txRef,
      amount,
      currency,
      email: user.email,
      fullName,
      redirectUrl: `${process.env.CLIENT_URL}/payment/verify`,
      meta: { userId, type, itemId },
    });

    if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
      throw new AppError(
        flwResponse.message || 'Could not initialize payment. Please try again.',
        500
      );
    }

    authorizationUrl = flwResponse.data.link;
    reference = txRef;
  }

  // Create a PENDING payment record (unique on `paystackRef` regardless of provider).
  // `paystackResponse._initMeta` lets the webhook recover userId/type/itemId
  // without depending on the gateway echoing `meta` back — Flutterwave v3 strips
  // `meta` from webhook deliveries even when we send it at init time.
  await prisma.payment.create({
    data: {
      userId,
      type,
      amount,
      currency,
      provider,
      status: 'PENDING',
      paystackRef: reference,
      paystackResponse: { _initMeta: { userId, type, itemId } } as object,
      ...(type === 'CAMP' && { campRegistrationId: itemId }),
      ...(type === 'CONSULTATION' && { consultationId: itemId }),
    },
  });

  res.json({
    success: true,
    message: 'Payment initialized.',
    data: {
      provider,
      currency,
      authorizationUrl,
      reference,
      description,
    },
  });
});

// ── Shared fulfilment (Paystack + Flutterwave) ───────────────────────────────
// Both webhooks share the same downstream logic: mark the Payment row SUCCESS,
// then fulfil based on type (program purchase, camp registration confirm, or
// consultation confirm). Differences live above in signature verification and
// in how each provider names the reference / event time.
interface FulfilmentInput {
  reference: string;
  userId: string;
  type: 'PROGRAM' | 'CAMP' | 'CONSULTATION';
  itemId: string;
  provider: PaymentProvider;
  rawProviderResponse: object;
  // When the gateway recorded the successful charge (used by camp lifecycle).
  paidAt: Date;
  logTag: '[paystack-webhook]' | '[flutterwave-webhook]';
}

async function fulfilSuccessfulPayment(input: FulfilmentInput): Promise<void> {
  const { reference, userId, type, itemId, provider, rawProviderResponse, paidAt, logTag } = input;

  // 1. Mark payment row SUCCESS — idempotent: matching paystackRef is unique.
  const payment = await prisma.payment.update({
    where: { paystackRef: reference },
    data: { status: 'SUCCESS', paystackResponse: rawProviderResponse, provider },
  });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  if (type === 'PROGRAM') {
    await prisma.purchase.create({
      data: { userId, programId: itemId, payment: { connect: { id: payment.id } } },
    });

    const program = await prisma.program.findUnique({ where: { id: itemId } });
    if (program) {
      await sendProgramPurchaseEmail(user.email, user.firstName, program.title);
    }
    return;
  }

  if (type === 'CAMP') {
    const registration = await prisma.campRegistration.findUnique({
      where: { id: itemId },
      include: { camp: true },
    });

    if (!registration) {
      console.warn(`${logTag} CAMP charge.success: registration ${itemId} not found.`);
      return;
    }
    if (registration.userId !== userId) {
      console.warn(
        `${logTag} CAMP charge.success: registration ${itemId} userId mismatch ` +
          `(reg=${registration.userId}, metadata=${userId}).`
      );
      return;
    }
    if (registration.status === CampRegistrationStatus.CONFIRMED) {
      // Idempotent: already promoted, almost certainly a webhook retry.
      return;
    }

    if (isRegistrationPayable(registration, paidAt)) {
      const promoted = await prisma.campRegistration.updateMany({
        where: { id: registration.id, status: CampRegistrationStatus.PENDING_PAYMENT },
        data: { status: CampRegistrationStatus.CONFIRMED, paymentExpiresAt: null },
      });
      if (promoted.count === 1) {
        await sendCampRegistrationEmail(
          user.email,
          user.firstName,
          registration.camp.title,
          registration.camp.startDate
        );
      }
    } else {
      // Money was taken after the hold elapsed — flag for manual refund and
      // DO NOT confirm the seat.
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          paystackResponse: {
            ...rawProviderResponse,
            _refundRequired: true,
            _refundReason: 'Registration expired before charge.success arrived.',
          } as object,
        },
      });
      console.error(
        `${logTag} CAMP refund-required: charge.success arrived for non-payable registration.`,
        JSON.stringify({
          paymentId: payment.id,
          reference,
          registrationId: registration.id,
          userId,
          registrationStatus: registration.status,
          registrationExpiresAt: registration.paymentExpiresAt,
          paidAt: paidAt.toISOString(),
        })
      );
    }
    return;
  }

  if (type === 'CONSULTATION') {
    const consultation = await prisma.consultation.findUnique({
      where: { id: itemId },
      include: { service: true },
    });
    if (
      consultation &&
      (consultation.status === 'PENDING_PAYMENT' || consultation.status === 'PENDING')
    ) {
      await prisma.consultation.update({
        where: { id: consultation.id },
        data: { status: 'CONFIRMED' },
      });
      await sendConsultationBookingEmail(
        user.email,
        user.firstName,
        consultation.service.title,
        consultation.confirmedDate ?? consultation.preferredDate ?? undefined
      );
    }
  }
}

// ── Paystack Webhook ──────────────────────────────────────────────────────────
// POST /api/payments/webhook
// Called by Paystack when payment status changes
export const paystackWebhook = async (req: Request, res: Response) => {
  // Raw body required — mounted with express.raw in app.ts (Paystack signs exact bytes)
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body), 'utf8');
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).json({ message: 'Invalid signature.' });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(raw.toString('utf8')) as PaystackEvent;
  } catch {
    return res.status(400).json({ message: 'Invalid JSON.' });
  }

  // 2. Only handle successful charges
  if (event.event !== 'charge.success') {
    return res.sendStatus(200);
  }

  const { reference, metadata } = event.data;
  const { userId, type, itemId } = metadata;

  // Time-of-truth for camp payability is when Paystack actually charged the
  // card, not when the webhook reached us. Falls back to receipt time.
  const paidAtRaw = (event.data as Record<string, unknown>).paid_at;
  const paidAt = typeof paidAtRaw === 'string' ? new Date(paidAtRaw) : new Date();

  try {
    await fulfilSuccessfulPayment({
      reference,
      userId,
      type,
      itemId,
      provider: PaymentProvider.PAYSTACK,
      rawProviderResponse: event.data as object,
      paidAt,
      logTag: '[paystack-webhook]',
    });
  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  res.sendStatus(200);
};

// ── Flutterwave Webhook ───────────────────────────────────────────────────────
// POST /api/payments/flutterwave-webhook
// Verified by static `verif-hash` header (set in Flutterwave dashboard).
//
// Flutterwave v3 strips the `meta` you pass at init time before delivering the
// webhook, so we cannot rely on `data.meta`. We look up the local Payment row
// by `tx_ref` (which we generated and stored at init) and derive userId/type/
// itemId from our own database. `_initMeta` in Payment.paystackResponse holds
// the itemId for PROGRAM purchases (CAMP/CONSULTATION already have FK columns).
export const flutterwaveWebhook = async (req: Request, res: Response) => {
  if (!isValidFlutterwaveWebhookSignature(req.headers['verif-hash'])) {
    return res.status(400).json({ message: 'Invalid signature.' });
  }

  // Mounted with express.raw — body is a Buffer; parse JSON ourselves.
  let event: FlutterwaveWebhookEvent;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body), 'utf8');
    event = JSON.parse(raw.toString('utf8')) as FlutterwaveWebhookEvent;
  } catch {
    return res.status(400).json({ message: 'Invalid JSON.' });
  }

  // Only act on completed successful charges.
  if (event.event !== 'charge.completed' || event.data?.status !== 'successful') {
    return res.sendStatus(200);
  }

  const reference = event.data?.tx_ref;
  if (!reference) {
    console.warn('[flutterwave-webhook] missing tx_ref on completed event.');
    return res.sendStatus(200);
  }

  // Look up the Payment row we created at init time. Source of truth for
  // userId/type/itemId regardless of whether Flutterwave echoes `meta`.
  const payment = await prisma.payment.findUnique({ where: { paystackRef: reference } });
  if (!payment) {
    console.warn(`[flutterwave-webhook] no Payment row found for tx_ref=${reference}.`);
    return res.sendStatus(200);
  }

  // Idempotent: a retried webhook delivery is a no-op.
  if (payment.status === 'SUCCESS') {
    return res.sendStatus(200);
  }

  // Defence-in-depth: amount + currency on the event must match what we
  // initialised with. Guards against forged events even if verif-hash leaks.
  if (
    typeof event.data.amount === 'number' &&
    Number(event.data.amount) !== Number(payment.amount)
  ) {
    console.error(
      `[flutterwave-webhook] amount mismatch: event=${event.data.amount} payment=${payment.amount} tx_ref=${reference}.`
    );
    return res.sendStatus(200);
  }
  if (
    typeof event.data.currency === 'string' &&
    event.data.currency.toUpperCase() !== payment.currency.toUpperCase()
  ) {
    console.error(
      `[flutterwave-webhook] currency mismatch: event=${event.data.currency} payment=${payment.currency} tx_ref=${reference}.`
    );
    return res.sendStatus(200);
  }

  // Resolve itemId from the Payment row. CAMP/CONSULTATION already have it on
  // dedicated FK columns; PROGRAM falls back to the _initMeta blob stashed at
  // init time. We also honour `data.meta` when present so the local simulator
  // continues to work (it sends `meta` explicitly).
  const eventMeta = event.data.meta;
  let userId = payment.userId;
  let type = payment.type as 'PROGRAM' | 'CAMP' | 'CONSULTATION';
  let itemId: string | null = null;

  if (eventMeta?.userId && eventMeta?.type && eventMeta?.itemId) {
    userId = eventMeta.userId;
    type = eventMeta.type;
    itemId = eventMeta.itemId;
  } else if (payment.type === 'CAMP') {
    itemId = payment.campRegistrationId;
  } else if (payment.type === 'CONSULTATION') {
    itemId = payment.consultationId;
  } else if (payment.type === 'PROGRAM') {
    const initMeta =
      (payment.paystackResponse as { _initMeta?: { itemId?: string } } | null)?._initMeta;
    itemId = initMeta?.itemId ?? null;
  }

  if (!itemId) {
    console.warn(
      `[flutterwave-webhook] could not resolve itemId for tx_ref=${reference} type=${payment.type}.`
    );
    return res.sendStatus(200);
  }

  // Use Flutterwave's reported transaction time when present.
  const createdAtRaw =
    (event.data as Record<string, unknown>).created_at ??
    (event.data as Record<string, unknown>).processor_response_at;
  const paidAt = typeof createdAtRaw === 'string' ? new Date(createdAtRaw) : new Date();

  try {
    await fulfilSuccessfulPayment({
      reference,
      userId,
      type,
      itemId,
      provider: PaymentProvider.FLUTTERWAVE,
      rawProviderResponse: event.data as object,
      paidAt,
      logTag: '[flutterwave-webhook]',
    });
  } catch (err) {
    console.error('Flutterwave webhook processing error:', err);
  }

  res.sendStatus(200);
};

// ── Verify Payment (frontend callback) ───────────────────────────────────────
// GET /api/payments/verify/:reference
export const verifyPayment = catchAsync(async (req: Request, res: Response) => {
  const { reference } = req.params;

  const payment = await prisma.payment.findUnique({
    where: { paystackRef: reference },
  });

  if (!payment) throw new AppError('Payment record not found.', 404);

  res.json({
    success: true,
    message: 'Payment status fetched.',
    data: { status: payment.status, type: payment.type, amount: payment.amount },
  });
});

// ── Admin: All Payments ───────────────────────────────────────────────────────
// GET /api/admin/payments
export const getAllPayments = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count(),
  ]);

  res.json({
    success: true,
    message: 'Payments fetched.',
    data: payments,
    meta: buildMeta(total, page, limit),
  });
});
