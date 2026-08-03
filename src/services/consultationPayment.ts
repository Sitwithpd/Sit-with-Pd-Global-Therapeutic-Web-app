import crypto from 'crypto';
import { PaymentProvider } from '@prisma/client';
import prisma from '../config/prisma';
import { sendConsultationPaymentLinkEmail } from '../utils/email.service';
import { initializeFlutterwavePayment } from '../lib/flutterwaveIntegration';
import { BASE_CURRENCY, minorToDecimalString } from '../lib/money';
import { localizePrice } from './pricing/price.service';

const PAYMENT_WINDOW_SECONDS = 60 * 60; // matches paymentExpiresAt

/**
 * Triggered by the Cal.com BOOKING_CREATED webhook, which carries no request
 * context — there is no presentment currency to honour, so the quote is taken
 * in the base currency unless a caller overrides it.
 */
export async function createConsultationPaymentAndEmail(
  consultationId: string,
  options: { currency?: string } = {}
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
  const quote = await localizePrice(
    consultation.service.priceMinor,
    options.currency ?? BASE_CURRENCY
  );

  const txRef = `flw_${user.id.slice(0, 8)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const flwResponse = await initializeFlutterwavePayment({
    txRef,
    amount: Number(minorToDecimalString(quote.amountMinor, quote.currency)),
    currency: quote.currency,
    email: user.email,
    fullName: `${user.firstName} ${user.lastName}`.trim() || undefined,
    redirectUrl: `${process.env.CLIENT_URL}/payment/verify`,
    meta: { userId: user.id, type: 'CONSULTATION', itemId: consultationId },
    paymentSessionTimeoutSeconds: PAYMENT_WINDOW_SECONDS,
  });

  if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
    throw new Error(flwResponse.message || 'Flutterwave initialize failed');
  }

  await prisma.payment.create({
    data: {
      userId: user.id,
      type: 'CONSULTATION',
      provider: PaymentProvider.FLUTTERWAVE,
      status: 'PENDING',
      providerRef: txRef,
      consultationId,
      presentmentCurrency: quote.currency,
      presentmentAmountMinor: quote.amountMinor,
      baseCurrency: quote.baseCurrency,
      baseAmountMinor: quote.baseAmountMinor,
      fxRateId: quote.fxRateId,
      fxRate: quote.fxRate,
      marginBps: quote.marginBps,
      quotedAt: new Date(),
      // Flutterwave v3 strips `meta` from webhook deliveries.
      providerResponse: {
        _initMeta: { userId: user.id, type: 'CONSULTATION', itemId: consultationId },
      } as object,
    },
  });

  await sendConsultationPaymentLinkEmail(
    user.email,
    user.firstName,
    consultation.service.title,
    flwResponse.data.link,
    PAYMENT_WINDOW_SECONDS
  );
}
