import { BASE_CURRENCY, minorToNumber } from './money';
import { localizePrice } from '../services/pricing/price.service';

export interface SerializedPrice {
  price: number;
  priceMinor: number;
  currency: string;
}

export interface AdminSerializedPrice extends SerializedPrice {
  basePriceMinor: number;
  baseCurrency: string;
  fxRateId: string | null;
}

/**
 * Listings must not fail because a rate lapsed — only checkout is gated on
 * freshness, so display falls back to the base currency instead of erroring.
 */
async function safeLocalize(baseMinor: bigint, currency: string) {
  try {
    return await localizePrice(baseMinor, currency, { allowStale: true });
  } catch {
    return await localizePrice(baseMinor, BASE_CURRENCY);
  }
}

export async function serializePrice(
  baseMinor: bigint | null | undefined,
  currency: string
): Promise<SerializedPrice> {
  const minor = baseMinor ?? 0n;
  const localized = await safeLocalize(minor, currency);
  return {
    price: localized.amount,
    priceMinor: Number(localized.amountMinor),
    currency: localized.currency,
  };
}

export async function serializeAdminPrice(
  baseMinor: bigint | null | undefined,
  currency: string
): Promise<AdminSerializedPrice> {
  const minor = baseMinor ?? 0n;
  const localized = await safeLocalize(minor, currency);
  return {
    price: localized.amount,
    priceMinor: Number(localized.amountMinor),
    currency: localized.currency,
    basePriceMinor: Number(localized.baseAmountMinor),
    baseCurrency: localized.baseCurrency,
    fxRateId: localized.fxRateId,
  };
}

/** Replaces `priceMinor` on an entity with the localized `price` + `currency`. */
export async function withPrice<T extends { priceMinor?: bigint | null }>(
  entity: T,
  currency: string,
  { admin = false }: { admin?: boolean } = {}
): Promise<Omit<T, 'priceMinor'> & SerializedPrice> {
  const { priceMinor, ...rest } = entity;
  const serialized = admin
    ? await serializeAdminPrice(priceMinor, currency)
    : await serializePrice(priceMinor, currency);
  return { ...rest, ...serialized };
}

export async function withPrices<T extends { priceMinor?: bigint | null }>(
  entities: T[],
  currency: string,
  options: { admin?: boolean } = {}
): Promise<Array<Omit<T, 'priceMinor'> & SerializedPrice>> {
  return Promise.all(entities.map((entity) => withPrice(entity, currency, options)));
}

/** Payment rows carry their own locked presentment amount — never re-converted. */
export function serializePaymentAmount(payment: {
  presentmentAmountMinor?: bigint | null;
  presentmentCurrency?: string | null;
  baseAmountMinor?: bigint | null;
  baseCurrency?: string | null;
}): {
  amount: number;
  amountMinor: number;
  currency: string;
  baseAmount: number;
  baseAmountMinor: number;
  baseCurrency: string;
} {
  const currency = payment.presentmentCurrency ?? BASE_CURRENCY;
  const minor = payment.presentmentAmountMinor ?? 0n;
  const baseCurrency = payment.baseCurrency ?? BASE_CURRENCY;
  const baseMinor = payment.baseAmountMinor ?? 0n;
  return {
    amount: minorToNumber(minor, currency),
    amountMinor: Number(minor),
    currency,
    // The GBP equivalent locked at checkout, so admin rows reconcile against
    // the base-currency revenue total.
    baseAmount: minorToNumber(baseMinor, baseCurrency),
    baseAmountMinor: Number(baseMinor),
    baseCurrency,
  };
}
