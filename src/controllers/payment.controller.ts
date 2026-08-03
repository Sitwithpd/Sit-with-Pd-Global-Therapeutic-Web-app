import { Request, Response } from 'express';
import { CampRegistrationStatus, PaymentProvider, Prisma } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../config/prisma';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { currencyOf } from '../middleware/currency.middleware';
import { BASE_CURRENCY, minorToDecimalString } from '../lib/money';
import { serializePaymentAmount } from '../lib/priceSerialization';
import { localizePrice } from '../services/pricing/price.service';
import { AuthRequest, FlutterwaveWebhookEvent } from '../types';
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

/** tx_ref Flutterwave returns on webhook. Prefixed for traceability. */
function generateTxRef(userId: string): string {
  return `flw_${userId.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

interface ChargeSubject {
  basePriceMinor: bigint;
  description: string;
  /** Bounds the provider session so it cannot outlive a held seat. */
  sessionTimeoutSeconds?: number;
}

async function resolveProgramCharge(userId: string, itemId: string): Promise<ChargeSubject> {
  const program = await prisma.program.findUnique({ where: { id: itemId } });
  if (!program) throw new AppError('Program not found.', 404);

  const existing = await prisma.purchase.findUnique({
    where: { userId_programId: { userId, programId: itemId } },
  });
  if (existing) throw new AppError('You already own this program.', 400);

  return {
    basePriceMinor: program.priceMinor ?? 0n,
    description: `Purchase: ${program.title}`,
  };
}

async function resolveCampCharge(userId: string, itemId: string): Promise<ChargeSubject> {
  const registration = await prisma.campRegistration.findUnique({
    where: { id: itemId },
    include: { camp: true, tier: true, payment: true },
  });
  if (!registration) throw new AppError('Camp registration not found.', 404);
  if (registration.userId !== userId) throw new AppError('Unauthorized.', 403);
  if (!registration.tier) {
    throw new AppError('Camp registration is missing tier pricing. Please contact support.', 400);
  }
  if (registration.status === CampRegistrationStatus.CONFIRMED) {
    throw new AppError('You have already paid for this application.', 400);
  }
  if (!isRegistrationPayable(registration)) {
    throw new AppError(
      'This application has expired. Please re-apply to obtain a new payment window.',
      400
    );
  }

  // Frees the Payment.campRegistrationId unique slot so a retry can attach.
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

  const remainingMs = registration.paymentExpiresAt
    ? registration.paymentExpiresAt.getTime() - Date.now()
    : 0;

  return {
    basePriceMinor: registration.tier.priceMinor ?? 0n,
    description: `Camp Application: ${registration.camp.title} — ${registration.tier.label}`,
    sessionTimeoutSeconds: remainingMs > 0 ? Math.floor(remainingMs / 1000) : undefined,
  };
}

async function resolveConsultationCharge(userId: string, itemId: string): Promise<ChargeSubject> {
  const consultation = await prisma.consultation.findUnique({
    where: { id: itemId },
    include: { service: true },
  });
  if (!consultation) throw new AppError('Consultation not found.', 404);
  if (consultation.userId !== userId) throw new AppError('Unauthorized.', 403);

  const remainingMs = consultation.paymentExpiresAt
    ? consultation.paymentExpiresAt.getTime() - Date.now()
    : 0;

  return {
    basePriceMinor: consultation.service.priceMinor ?? 0n,
    description: `Consultation: ${consultation.service.title}`,
    sessionTimeoutSeconds: remainingMs > 0 ? Math.floor(remainingMs / 1000) : undefined,
  };
}

// POST /api/payments/initialize
// Body: { type: 'PROGRAM' | 'CAMP' | 'CONSULTATION', itemId }
// Currency comes from the X-Req-Currency header, never the body.
export const initializePayment = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { type, itemId } = req.body;
  const currency = currencyOf(req);

  if (!['PROGRAM', 'CAMP', 'CONSULTATION'].includes(type)) {
    throw new AppError('type must be PROGRAM, CAMP or CONSULTATION.', 400);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found.', 404);

  const subject =
    type === 'PROGRAM'
      ? await resolveProgramCharge(userId, itemId)
      : type === 'CAMP'
        ? await resolveCampCharge(userId, itemId)
        : await resolveConsultationCharge(userId, itemId);

  if (subject.basePriceMinor <= 0n) {
    throw new AppError('This item has no price set. Please contact support.', 400);
  }

  // Throws 503 when the rate is stale — GBP needs no rate and always proceeds.
  const quote = await localizePrice(subject.basePriceMinor, currency);

  const txRef = generateTxRef(userId);
  const fullName = `${user.firstName} ${user.lastName}`.trim() || undefined;

  const flwResponse = await initializeFlutterwavePayment({
    txRef,
    amount: Number(minorToDecimalString(quote.amountMinor, quote.currency)),
    currency: quote.currency,
    email: user.email,
    fullName,
    redirectUrl: `${process.env.CLIENT_URL}/payment/verify`,
    meta: { userId, type, itemId },
    paymentSessionTimeoutSeconds: subject.sessionTimeoutSeconds,
  });

  if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
    throw new AppError(
      flwResponse.message || 'Could not initialize payment. Please try again.',
      502
    );
  }

  await prisma.payment.create({
    data: {
      userId,
      type,
      status: 'PENDING',
      provider: PaymentProvider.FLUTTERWAVE,
      providerRef: txRef,
      providerResponse: { _initMeta: { userId, type, itemId } } as object,
      presentmentCurrency: quote.currency,
      presentmentAmountMinor: quote.amountMinor,
      baseCurrency: quote.baseCurrency,
      baseAmountMinor: quote.baseAmountMinor,
      fxRateId: quote.fxRateId,
      fxRate: quote.fxRate,
      marginBps: quote.marginBps,
      quotedAt: new Date(),
      ...(type === 'CAMP' && { campRegistrationId: itemId }),
      ...(type === 'CONSULTATION' && { consultationId: itemId }),
    },
  });

  res.json({
    success: true,
    message: 'Payment initialized.',
    data: {
      provider: PaymentProvider.FLUTTERWAVE,
      currency: quote.currency,
      amount: quote.amount,
      amountMinor: Number(quote.amountMinor),
      authorizationUrl: flwResponse.data.link,
      reference: txRef,
      description: subject.description,
    },
  });
});

interface FulfilmentInput {
  reference: string;
  userId: string;
  type: 'PROGRAM' | 'CAMP' | 'CONSULTATION';
  itemId: string;
  rawProviderResponse: object;
  paidAt: Date;
  settlementCurrency?: string | null;
}

async function fulfilSuccessfulPayment(input: FulfilmentInput): Promise<void> {
  const { reference, userId, type, itemId, rawProviderResponse, paidAt } = input;

  const payment = await prisma.payment.update({
    where: { providerRef: reference },
    data: {
      status: 'SUCCESS',
      providerResponse: rawProviderResponse,
      ...(input.settlementCurrency ? { settlementCurrency: input.settlementCurrency } : {}),
    },
  });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  if (type === 'PROGRAM') {
    await prisma.purchase.create({
      data: { userId, programId: itemId, payment: { connect: { id: payment.id } } },
    });
    const program = await prisma.program.findUnique({ where: { id: itemId } });
    if (program) await sendProgramPurchaseEmail(user.email, user.firstName, program.title);
    return;
  }

  if (type === 'CAMP') {
    const registration = await prisma.campRegistration.findUnique({
      where: { id: itemId },
      include: { camp: true },
    });

    if (!registration) {
      console.warn(`[flutterwave-webhook] CAMP success: registration ${itemId} not found.`);
      return;
    }
    if (registration.userId !== userId) {
      console.warn(
        `[flutterwave-webhook] CAMP success: registration ${itemId} userId mismatch ` +
          `(reg=${registration.userId}, meta=${userId}).`
      );
      return;
    }
    if (registration.status === CampRegistrationStatus.CONFIRMED) return;

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
      // Charged after the hold lapsed: flag for refund, do not confirm the seat.
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerResponse: {
            ...rawProviderResponse,
            _refundRequired: true,
            _refundReason: 'Registration expired before the charge succeeded.',
          } as object,
        },
      });
      console.error(
        '[flutterwave-webhook] CAMP refund-required: charge succeeded for a non-payable registration.',
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

// POST /api/payments/flutterwave-webhook
// Verified by the static `verif-hash` header set in the Flutterwave dashboard.
//
// Flutterwave v3 strips `meta` before delivering the webhook, so userId/type/
// itemId are recovered from our own Payment row rather than the event.
export const flutterwaveWebhook = async (req: Request, res: Response) => {
  if (!isValidFlutterwaveWebhookSignature(req.headers['verif-hash'])) {
    return res.status(400).json({ message: 'Invalid signature.' });
  }

  let event: FlutterwaveWebhookEvent;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body), 'utf8');
    event = JSON.parse(raw.toString('utf8')) as FlutterwaveWebhookEvent;
  } catch {
    return res.status(400).json({ message: 'Invalid JSON.' });
  }

  if (event.event !== 'charge.completed' || event.data?.status !== 'successful') {
    return res.sendStatus(200);
  }

  const reference = event.data?.tx_ref;
  if (!reference) {
    console.warn('[flutterwave-webhook] missing tx_ref on completed event.');
    return res.sendStatus(200);
  }

  const payment = await prisma.payment.findUnique({ where: { providerRef: reference } });
  if (!payment) {
    console.warn(`[flutterwave-webhook] no Payment row for tx_ref=${reference}.`);
    return res.sendStatus(200);
  }
  if (payment.status === 'SUCCESS') return res.sendStatus(200);

  // Guards against forged events even if verif-hash leaks. Compared against the
  // locked presentment quote, not a recomputed price.
  const expectedMinor = payment.presentmentAmountMinor ?? 0n;
  const expectedCurrency = payment.presentmentCurrency ?? BASE_CURRENCY;

  if (typeof event.data.currency === 'string') {
    if (event.data.currency.toUpperCase() !== expectedCurrency.toUpperCase()) {
      console.error(
        `[flutterwave-webhook] currency mismatch: event=${event.data.currency} expected=${expectedCurrency} tx_ref=${reference}.`
      );
      return res.sendStatus(200);
    }
  }

  if (typeof event.data.amount === 'number') {
    const expected = Number(minorToDecimalString(expectedMinor, expectedCurrency));
    if (Number(event.data.amount) !== expected) {
      console.error(
        `[flutterwave-webhook] amount mismatch: event=${event.data.amount} expected=${expected} tx_ref=${reference}.`
      );
      return res.sendStatus(200);
    }
  }

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
      (payment.providerResponse as { _initMeta?: { itemId?: string } } | null)?._initMeta;
    itemId = initMeta?.itemId ?? null;
  }

  if (!itemId) {
    console.warn(
      `[flutterwave-webhook] could not resolve itemId for tx_ref=${reference} type=${payment.type}.`
    );
    return res.sendStatus(200);
  }

  const createdAtRaw =
    (event.data as Record<string, unknown>).created_at ??
    (event.data as Record<string, unknown>).processor_response_at;
  const paidAt = typeof createdAtRaw === 'string' ? new Date(createdAtRaw) : new Date();

  const settlementCurrency =
    typeof (event.data as Record<string, unknown>).settled_currency === 'string'
      ? ((event.data as Record<string, unknown>).settled_currency as string)
      : null;

  try {
    await fulfilSuccessfulPayment({
      reference,
      userId,
      type,
      itemId,
      rawProviderResponse: event.data as object,
      paidAt,
      settlementCurrency,
    });
  } catch (err) {
    console.error('Flutterwave webhook processing error:', err);
  }

  res.sendStatus(200);
};

// GET /api/payments/verify/:reference
export const verifyPayment = catchAsync(async (req: Request, res: Response) => {
  const payment = await prisma.payment.findUnique({
    where: { providerRef: req.params.reference },
  });
  if (!payment) throw new AppError('Payment record not found.', 404);

  const { amount, currency } = serializePaymentAmount(payment);

  res.json({
    success: true,
    message: 'Payment status fetched.',
    data: { status: payment.status, type: payment.type, amount, currency },
  });
});

// GET /api/admin/payments
export const getAllPayments = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count(),
  ]);

  res.json({
    success: true,
    message: 'Payments fetched.',
    data: payments.map((payment) => ({ ...payment, ...serializePaymentAmount(payment) })),
    meta: buildMeta(total, page, limit),
  });
});
