import { SupportedCurrency } from '@prisma/client';
import prisma from '../../config/prisma';
import { BASE_CURRENCY, normalizeCurrencyCode } from '../../lib/money';

const CACHE_TTL_MS = 60_000;

let cache: { rows: SupportedCurrency[]; expiresAt: number } | null = null;

export function invalidateCurrencyCache(): void {
  cache = null;
}

export async function listSupportedCurrencies(): Promise<SupportedCurrency[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.rows;
  const rows = await prisma.supportedCurrency.findMany({ orderBy: { code: 'asc' } });
  cache = { rows, expiresAt: Date.now() + CACHE_TTL_MS };
  return rows;
}

export async function listEnabledCurrencyCodes(): Promise<string[]> {
  const rows = await listSupportedCurrencies();
  return rows.filter((r) => r.isEnabled).map((r) => r.code);
}

export async function findEnabledCurrency(
  code: unknown
): Promise<SupportedCurrency | null> {
  let normalized: string;
  try {
    normalized = normalizeCurrencyCode(code);
  } catch {
    return null;
  }
  const rows = await listSupportedCurrencies();
  return rows.find((r) => r.code === normalized && r.isEnabled) ?? null;
}

/**
 * Falls back to GBP rather than erroring: an unrecognised header is a client
 * problem, not a reason to fail a page load.
 */
export async function resolveRequestCurrency(code: unknown): Promise<string> {
  const match = await findEnabledCurrency(code);
  return match?.code ?? BASE_CURRENCY;
}

export async function getMarginBps(code: string): Promise<number> {
  const rows = await listSupportedCurrencies();
  return rows.find((r) => r.code === normalizeCurrencyCode(code))?.marginBps ?? 0;
}
