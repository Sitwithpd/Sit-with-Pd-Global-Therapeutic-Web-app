import { PlatformCurrency } from '@prisma/client';
import { AppError } from '../middleware/error.middleware';

/** Validates NGN | USD | EUR | GBP for program, camp, and consultation pricing. */
export function parsePlatformCurrency(
  raw: unknown,
  required = false
): PlatformCurrency | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new AppError('currency is required.', 400);
    return undefined;
  }
  const s = String(raw).trim().toUpperCase();
  if (!Object.values(PlatformCurrency).includes(s as PlatformCurrency)) {
    throw new AppError('currency must be one of: NGN, USD, EUR, GBP.', 400);
  }
  return s as PlatformCurrency;
}
