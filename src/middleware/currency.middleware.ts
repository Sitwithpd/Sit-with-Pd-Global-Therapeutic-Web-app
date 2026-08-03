import { NextFunction, Response } from 'express';
import { BASE_CURRENCY } from '../lib/money';
import { AuthRequest } from '../types';
import { resolveRequestCurrency } from '../services/fx/currency.service';

export const CURRENCY_HEADER = 'x-req-currency';

export async function resolveCurrency(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Prices differ per currency, so a shared cache must key on the header.
  res.setHeader('Vary', CURRENCY_HEADER);
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
