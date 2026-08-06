import crypto from 'crypto';

const FLUTTERWAVE_BASE = process.env.FLUTTERWAVE_API_BASE_URL?.trim() || 'https://api.flutterwave.com/v3';

function getSecretKey(): string {
  const key = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error(
      'Flutterwave is not configured: set FLUTTERWAVE_SECRET_KEY (and optionally FLUTTERWAVE_WEBHOOK_HASH).'
    );
  }
  return key;
}

/** Generic Flutterwave API call wrapper. */
export async function flutterwaveRequest<T = unknown>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: object
): Promise<T> {
  const res = await fetch(`${FLUTTERWAVE_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await res.json()) as T;
}

export interface FlutterwaveInitInput {
  txRef: string;
  amount: number;
  currency: string;
  email: string;
  fullName?: string;
  redirectUrl: string;
  meta: { userId: string; type: 'PROGRAM' | 'CAMP' | 'CONSULTATION' | 'MEMBERSHIP'; itemId: string };
  paymentSessionTimeoutSeconds?: number;
  /**
   * Flutterwave payment-plan id. When present the charge enrols the customer on
   * that plan and Flutterwave owns every subsequent debit, retry and dunning
   * attempt — we only observe the resulting charge.completed events.
   */
  paymentPlanId?: string;
}

export interface FlutterwaveInitResponse {
  status: 'success' | 'error';
  message?: string;
  data?: { link: string };
}

/**
 * Initialize a hosted Flutterwave checkout. Returns the redirect URL the
 * client should send the user to. `tx_ref` (we generate it) is stored as the
 * Payment row's unique reference and echoed back to us on webhook.
 */
export async function initializeFlutterwavePayment(
  input: FlutterwaveInitInput
): Promise<FlutterwaveInitResponse> {
  const payload: Record<string, unknown> = {
    tx_ref: input.txRef,
    amount: input.amount,
    currency: input.currency,
    redirect_url: input.redirectUrl,
    customer: {
      email: input.email,
      ...(input.fullName ? { name: input.fullName } : {}),
    },
    meta: input.meta,
  };

  if (input.paymentPlanId) payload.payment_plan = input.paymentPlanId;

  if (input.paymentSessionTimeoutSeconds && input.paymentSessionTimeoutSeconds > 0) {
    payload.payment_options = 'card,banktransfer,ussd,account';
    payload.session_duration = Math.round(input.paymentSessionTimeoutSeconds / 60); // minutes
  }

  return flutterwaveRequest<FlutterwaveInitResponse>('/payments', 'POST', payload);
}

export interface FlutterwaveVerifyTransactionResponse {
  status: 'success' | 'error';
  message?: string;
  data?: {
    id: number;
    tx_ref: string;
    flw_ref: string;
    amount: number;
    currency: string;
    status: 'successful' | 'failed' | 'pending';
    customer: { email: string };
    meta?: { userId?: string; type?: string; itemId?: string };
  };
}

/** Server-side verification by Flutterwave's numeric transaction id. */
export async function verifyFlutterwaveTransactionById(
  transactionId: number | string
): Promise<FlutterwaveVerifyTransactionResponse> {
  return flutterwaveRequest<FlutterwaveVerifyTransactionResponse>(
    `/transactions/${encodeURIComponent(String(transactionId))}/verify`
  );
}

/**
 * Validate the `verif-hash` header Flutterwave sends with every webhook.
 * Flutterwave's webhook is **not** an HMAC of the body — it's a static
 * pre-shared secret you set in the dashboard and we mirror in env. Compare
 * with a constant-time check to avoid timing leaks.
 */
export function isValidFlutterwaveWebhookSignature(
  receivedHeader: string | string[] | undefined
): boolean {
  const expected = process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
  if (!expected) return false;
  if (!receivedHeader) return false;
  const received = Array.isArray(receivedHeader) ? receivedHeader[0] : receivedHeader;
  if (typeof received !== 'string' || received.length === 0) return false;
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Payment plans (recurring) ────────────────────────────────────────────────

export interface FlutterwavePaymentPlanResponse {
  status: 'success' | 'error';
  message?: string;
  data?: { id: number; name: string; amount: number; interval: string; status: string };
}

/**
 * Creates a recurring payment plan. Flutterwave fixes the amount and currency
 * on the plan itself, which is why one membership plan needs one of these per
 * (interval x currency x price) — see MembershipProviderPlan.
 *
 * `duration` is omitted deliberately: absent means bill indefinitely until the
 * subscription is cancelled, which is what a membership is.
 */
export async function createFlutterwavePaymentPlan(input: {
  name: string;
  amount: number;
  currency: string;
  interval: 'monthly' | 'yearly';
}): Promise<FlutterwavePaymentPlanResponse> {
  return flutterwaveRequest<FlutterwavePaymentPlanResponse>('/payment-plans', 'POST', {
    name: input.name,
    amount: input.amount,
    currency: input.currency,
    interval: input.interval,
  });
}

/** Stops future debits. Flutterwave keeps the plan row; it just goes inactive. */
export async function cancelFlutterwaveSubscription(
  subscriptionId: string
): Promise<{ status: 'success' | 'error'; message?: string }> {
  return flutterwaveRequest(`/subscriptions/${subscriptionId}/cancel`, 'PUT');
}
