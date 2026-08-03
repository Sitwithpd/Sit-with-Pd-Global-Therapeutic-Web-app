import { FX_PROBE_AMOUNT } from '../../config/money.config';

const FLUTTERWAVE_BASE =
  process.env.FLUTTERWAVE_API_BASE_URL?.trim() || 'https://api.flutterwave.com/v3';

interface TransferRatesResponse {
  status?: string;
  message?: string;
  data?: {
    rate?: number;
    source?: { currency?: string; amount?: number };
    destination?: { currency?: string; amount?: number };
  };
}

export interface FetchedRate {
  quoteCurrency: string;
  /** Quote units per 1 base unit. */
  rate: number;
  probeAmount: number;
  source: 'flutterwave';
}

/**
 * Queries in the sweep direction (quote -> GBP) because that is the rate we
 * actually convert back at; pricing off it is self-hedging, whereas mid-market
 * would leave us short by Flutterwave's spread on every withdrawal.
 *
 * The endpoint answers "how much source buys this destination amount", so the
 * returned rate is inverted before storage.
 */
export async function fetchRate(
  baseCurrency: string,
  quoteCurrency: string
): Promise<FetchedRate> {
  const key = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!key) throw new Error('FLUTTERWAVE_SECRET_KEY is not configured.');

  const params = new URLSearchParams({
    amount: String(FX_PROBE_AMOUNT),
    source_currency: quoteCurrency,
    destination_currency: baseCurrency,
  });

  const res = await fetch(`${FLUTTERWAVE_BASE}/transfers/rates?${params.toString()}`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  const body = (await res.json()) as TransferRatesResponse;
  if (!res.ok || body.status !== 'success' || typeof body.data?.rate !== 'number') {
    throw new Error(
      `Flutterwave rate lookup failed for ${quoteCurrency}->${baseCurrency}: ${
        body.message ?? res.status
      }`
    );
  }

  const sweepRate = body.data.rate;
  if (!(sweepRate > 0)) {
    throw new Error(`Flutterwave returned a non-positive rate for ${quoteCurrency}.`);
  }

  return {
    quoteCurrency,
    rate: 1 / sweepRate,
    probeAmount: FX_PROBE_AMOUNT,
    source: 'flutterwave',
  };
}
