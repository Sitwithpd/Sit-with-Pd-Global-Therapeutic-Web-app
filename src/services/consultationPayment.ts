import crypto from 'crypto';
import { PaymentProvider } from '@prisma/client';
import prisma from '../config/prisma';
import { sendConsultationPaymentLinkEmail } from '../utils/email.service';
import { initializeFlutterwavePayment } from '../lib/flutterwaveIntegration';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE = 'https://api.paystack.co';

const PAYMENT_WINDOW_SECONDS = 60 * 60; // 1 hour — matches paymentExpiresAt

async function paystackRequest(endpoint: string, method = 'GET', body?: object) {
  const res = await fetch(`${PAYSTACK_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return res.json();
}

function resolveProvider(provider?: PaymentProvider): PaymentProvider {
  if (provider) return provider;
  const fromEnv = process.env.CONSULTATION_PAYMENT_PROVIDER?.trim().toUpperCase();
  if (fromEnv === 'FLUTTERWAVE') return PaymentProvider.FLUTTERWAVE;
  return PaymentProvider.PAYSTACK;
}

/**
 * Creates a pending payment row (Paystack or Flutterwave) and emails the
 * authorization URL. Used after Cal.com BOOKING_CREATED webhook.
 *
 * Provider precedence: explicit arg → CONSULTATION_PAYMENT_PROVIDER env → PAYSTACK.
 */
export async function createConsultationPaymentAndEmail(
  consultationId: string,
  options: { provider?: PaymentProvider; currency?: string } = {}
): Promise<void> {
  const consultation = await prisma.consultation.findUnique({
    where: { id: consultationId },
    include: { service: true, user: true },
  });

  if (!consultation) throw new Error('Consultation not found');
  if (consultation.status !== 'PENDING_PAYMENT') {
    throw new Error('Consultation is not awaiting payment');
  }

  const existingPayment = await prisma.payment.findFirst({
    where: { consultationId, status: 'PENDING' },
  });
  if (existingPayment) {
    console.warn(`Payment already exists for consultation ${consultationId}`);
    return;
  }

  const user = consultation.user;
  const amount = consultation.service.price;
  const provider = resolveProvider(options.provider);
  const currency = consultation.service.currency;

  let authorizationUrl: string;
  let reference: string;

  if (provider === PaymentProvider.PAYSTACK) {
    const paystackResponse = (await paystackRequest('/transaction/initialize', 'POST', {
      email: user.email,
      amount: amount * 100,
      currency,
      metadata: { userId: user.id, type: 'CONSULTATION', itemId: consultationId },
      callback_url: `${process.env.CLIENT_URL}/payment/verify`,
    })) as { status: boolean; data: { reference: string; authorization_url: string } };

    if (!paystackResponse.status) throw new Error('Paystack initialize failed');
    authorizationUrl = paystackResponse.data.authorization_url;
    reference = paystackResponse.data.reference;
  } else {
    const txRef = `flw_${user.id.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const flwResponse = await initializeFlutterwavePayment({
      txRef,
      amount,
      currency,
      email: user.email,
      fullName: `${user.firstName} ${user.lastName}`.trim() || undefined,
      redirectUrl: `${process.env.CLIENT_URL}/payment/verify`,
      meta: { userId: user.id, type: 'CONSULTATION', itemId: consultationId },
      paymentSessionTimeoutSeconds: PAYMENT_WINDOW_SECONDS,
    });
    if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
      throw new Error(flwResponse.message || 'Flutterwave initialize failed');
    }
    authorizationUrl = flwResponse.data.link;
    reference = txRef;
  }

  await prisma.payment.create({
    data: {
      userId: user.id,
      type: 'CONSULTATION',
      amount,
      currency,
      provider,
      status: 'PENDING',
      paystackRef: reference,
      consultationId,
      // Stash init-time identifiers so the Flutterwave webhook can recover them
      // — Flutterwave v3 webhooks strip `meta` from the payload they send.
      paystackResponse: {
        _initMeta: { userId: user.id, type: 'CONSULTATION', itemId: consultationId },
      } as object,
    },
  });

  await sendConsultationPaymentLinkEmail(
    user.email,
    user.firstName,
    consultation.service.title,
    authorizationUrl,
    PAYMENT_WINDOW_SECONDS
  );
}
