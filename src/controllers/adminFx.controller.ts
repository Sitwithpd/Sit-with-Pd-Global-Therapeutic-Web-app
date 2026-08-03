import { Response } from 'express';
import prisma from '../config/prisma';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import { BASE_CURRENCY, normalizeCurrencyCode } from '../lib/money';
import { listCurrentRates, writeRate } from '../services/fx/fxRate.service';
import {
  invalidateCurrencyCache,
  listSupportedCurrencies,
} from '../services/fx/currency.service';
import { runFxSync, getConsecutiveFxFailures } from '../services/fx/fxSync.job';
import { FX_STALE_THRESHOLD_MS, FX_DRIFT_THRESHOLD_BPS } from '../config/money.config';

// GET /api/admin/fx/rates
export const getFxRates = catchAsync(async (_req: AuthRequest, res: Response) => {
  const rates = await listCurrentRates();
  res.json({
    success: true,
    message: 'FX rates fetched.',
    data: {
      baseCurrency: BASE_CURRENCY,
      staleThresholdHours: FX_STALE_THRESHOLD_MS / 3_600_000,
      driftThresholdBps: FX_DRIFT_THRESHOLD_BPS,
      consecutiveSyncFailures: getConsecutiveFxFailures(),
      rates,
    },
  });
});

// POST /api/admin/fx/sync
export const triggerFxSync = catchAsync(async (_req: AuthRequest, res: Response) => {
  const outcomes = await runFxSync();
  res.json({ success: true, message: 'FX sync run.', data: outcomes });
});

// POST /api/admin/fx/rates — manual override when the feed is wrong
export const overrideFxRate = catchAsync(async (req: AuthRequest, res: Response) => {
  const quoteCurrency = normalizeCurrencyCode(req.body?.quoteCurrency);
  if (quoteCurrency === BASE_CURRENCY) {
    throw new AppError(`${BASE_CURRENCY} is the base currency and has no rate.`, 400);
  }

  const rate = Number(req.body?.rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AppError('rate must be a positive number.', 400);
  }

  const supported = await prisma.supportedCurrency.findUnique({ where: { code: quoteCurrency } });
  if (!supported) throw new AppError(`${quoteCurrency} is not a supported currency.`, 404);

  const written = await writeRate({ quoteCurrency, rate, source: 'manual' });

  res.status(201).json({
    success: true,
    message: 'Rate override recorded.',
    data: { id: written.id, quoteCurrency, rate: written.rate.toString(), source: written.source },
  });
});

// GET /api/admin/currencies
export const getSupportedCurrencies = catchAsync(async (_req: AuthRequest, res: Response) => {
  const currencies = await listSupportedCurrencies();
  res.json({ success: true, message: 'Currencies fetched.', data: currencies });
});

// PATCH /api/admin/currencies/:code
export const updateSupportedCurrency = catchAsync(async (req: AuthRequest, res: Response) => {
  const code = normalizeCurrencyCode(req.params.code);
  const existing = await prisma.supportedCurrency.findUnique({ where: { code } });
  if (!existing) throw new AppError(`${code} is not a supported currency.`, 404);

  const data: { isEnabled?: boolean; marginBps?: number } = {};

  if (req.body?.isEnabled !== undefined) {
    if (typeof req.body.isEnabled !== 'boolean') {
      throw new AppError('isEnabled must be a boolean.', 400);
    }
    if (existing.isBase && req.body.isEnabled === false) {
      throw new AppError('The base currency cannot be disabled.', 400);
    }
    data.isEnabled = req.body.isEnabled;
  }

  if (req.body?.marginBps !== undefined) {
    const marginBps = Number(req.body.marginBps);
    if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 10_000) {
      throw new AppError('marginBps must be an integer between 0 and 10000.', 400);
    }
    data.marginBps = marginBps;
  }

  if (Object.keys(data).length === 0) {
    throw new AppError('Provide at least one field: isEnabled, marginBps.', 400);
  }

  const updated = await prisma.supportedCurrency.update({ where: { code }, data });
  invalidateCurrencyCache();

  res.json({ success: true, message: 'Currency updated.', data: updated });
});
