import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { BASE_CURRENCY, minorToNumber } from '../lib/money';
import { serializePaymentAmount } from '../lib/priceSerialization';
import { fetchCalEventTypesList } from '../lib/cal';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { Prisma } from '@prisma/client';

const USER_SEARCH_MAX_LEN = 100;

// ── Dashboard Stats ───────────────────────────────────────────────────────────
// GET /api/admin/stats
export const getDashboardStats = catchAsync(async (_req: Request, res: Response) => {
  const [
    totalUsers,
    totalPrograms,
    totalCamps,
    totalConsultations,
    totalRevenue,
    revenueByCurrency,
    recentPayments,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'USER' } }),
    prisma.program.count(),
    prisma.camp.count(),
    prisma.consultation.count(),
    prisma.payment.aggregate({
      where: { status: 'SUCCESS' },
      _sum: { baseAmountMinor: true },
    }),
    prisma.payment.groupBy({
      by: ['presentmentCurrency'],
      where: { status: 'SUCCESS' },
      _sum: { presentmentAmountMinor: true },
      _count: true,
    }),
    prisma.payment.findMany({
      where: { status: 'SUCCESS' },
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    }),
  ]);

  res.json({
    success: true,
    message: 'Dashboard stats fetched.',
    data: {
      totalUsers,
      totalPrograms,
      totalCamps,
      totalConsultations,
      totalRevenue: minorToNumber(totalRevenue._sum.baseAmountMinor ?? 0n, BASE_CURRENCY),
      totalRevenueMinor: Number(totalRevenue._sum.baseAmountMinor ?? 0n),
      currency: BASE_CURRENCY,
      revenueByCurrency: revenueByCurrency.map((row) => ({
        currency: row.presentmentCurrency,
        amount: minorToNumber(row._sum.presentmentAmountMinor ?? 0n, row.presentmentCurrency),
        amountMinor: Number(row._sum.presentmentAmountMinor ?? 0n),
        payments: row._count,
      })),
      recentPayments: recentPayments.map((p) => ({ ...p, ...serializePaymentAmount(p) })),
    },
  });
});

// ── All Users ─────────────────────────────────────────────────────────────────
// GET /api/admin/users — optional query: search (firstName, lastName, email substring, case-insensitive)
export const getAllUsers = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);
  const raw = req.query.search;
  const search =
    typeof raw === 'string'
      ? raw.trim().slice(0, USER_SEARCH_MAX_LEN)
      : '';

  const where: Prisma.UserWhereInput = {
    role: 'USER',
    ...(search.length > 0
      ? {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        isEmailVerified: true,
        createdAt: true,
        _count: {
          select: { purchases: true, campRegistrations: true, consultations: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  res.json({
    success: true,
    message: 'Users fetched.',
    data: users,
    meta: buildMeta(total, page, limit),
  });
});

// ── Single User Detail ────────────────────────────────────────────────────────
// GET /api/admin/users/:id
export const getUserById = catchAsync(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      isEmailVerified: true,
      createdAt: true,
      purchases: { include: { program: { select: { title: true, priceMinor: true } } } },
      campRegistrations: {
        include: {
          camp: { select: { title: true, startDate: true, thumbnail: true } },
          tier: { select: { id: true, label: true, priceMinor: true, seatsPerUnit: true } },
          payment: {
            select: {
              status: true,
              presentmentAmountMinor: true,
              presentmentCurrency: true,
              baseAmountMinor: true,
              baseCurrency: true,
              createdAt: true,
              providerRef: true,
            },
          },
        },
      },
      consultations: { include: { service: { select: { title: true } } } },
      payments: { orderBy: { createdAt: 'desc' } },
    },
  });

  const data = user
    ? {
        ...user,
        campRegistrations: user.campRegistrations.map((r) => ({
          ...r,
          camp: r.camp,
        })),
      }
    : user;

  res.json({ success: true, message: 'User detail fetched.', data });
});

// ── Cal.com event types (admin picker) ────────────────────────────────────────
// GET /api/admin/cal/event-types?username=optional-cal-username
export const getCalEventTypes = catchAsync(async (req: Request, res: Response) => {
  if (!process.env.CAL_API_KEY?.trim()) {
    throw new AppError('Cal.com API is not configured (CAL_API_KEY).', 503);
  }

  const username =
    typeof req.query.username === 'string' && req.query.username.trim() !== ''
      ? req.query.username.trim()
      : undefined;

  try {
    const all = await fetchCalEventTypesList({ username });
    const { skip, page, limit } = parseAdminPagination(req);
    const total = all.length;
    const data = all.slice(skip, skip + limit);
    res.json({
      success: true,
      message: 'Cal.com event types fetched.',
      data,
      meta: buildMeta(total, page, limit),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Cal.com request failed';
    throw new AppError(msg, 502);
  }
});
