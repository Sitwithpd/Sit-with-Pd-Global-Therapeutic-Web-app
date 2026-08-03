import { NextFunction, Response } from 'express';
import { BASE_CURRENCY } from '../lib/money';
import { AuthRequest } from '../types';
import { resolveRequestCurrency } from '../services/fx/currency.service';

export const CURRENCY_HEADER = 'x-req-currency';
export const PRICE_CONTEXT_HEADER = 'x-price-context';

/**
 * Admin screens manage the catalogue in the currency prices are entered in, so
 * they ask for the base currency explicitly rather than hardcoding "GBP"
 * client-side. Shared endpoints serve both audiences, so this is a request-level
 * opt-in rather than a per-route decision.
 */
function wantsBaseCurrency(req: AuthRequest): boolean {
  const header = req.headers[PRICE_CONTEXT_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim().toLowerCase() === 'base';
}

export async function resolveCurrency(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Prices differ per currency, so a shared cache must key on both headers.
  res.setHeader('Vary', `${CURRENCY_HEADER}, ${PRICE_CONTEXT_HEADER}`);

  if (wantsBaseCurrency(req)) {
    req.currency = BASE_CURRENCY;
    next();
    return;
  }

  try {
    req.currency = await resolveRequestCurrency(req.headers[CURRENCY_HEADER]);
  } catch {
    req.currency = BASE_CURRENCY;
  }
  next();
}

export function currencyOf(req: AuthRequest): string {
  return req.currency ?? BASE_CURRENCY;
}
