import { Response } from 'express';
import prisma from '../config/prisma';
import { serializePaymentAmount } from '../lib/priceSerialization';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import {
  buildProgramDashboardPayload,
  completeProgramModule as completeProgramModuleSvc,
  getProgressOverviewsForPrograms,
  programDashboardInclude,
} from '../services/programProgress.service';

// GET /api/dashboard — User's full dashboard data
/** Payment rows carry a locked presentment quote; expose it as amount+currency. */
function withPaymentAmount<T extends { payment?: unknown | null }>(row: T): T {
  if (!row.payment) return row;
  return {
    ...row,
    payment: {
      ...(row.payment as object),
      ...serializePaymentAmount(row.payment as Parameters<typeof serializePaymentAmount>[0]),
    },
  };
}

export const getDashboard = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const [purchases, campRegistrations, consultations] = await Promise.all([
    prisma.purchase.findMany({
      where: { userId },
      include: {
        program: {
          include: { _count: { select: { weeks: true } } },
        },
        payment: { select: { status: true, presentmentAmountMinor: true, presentmentCurrency: true, baseAmountMinor: true, baseCurrency: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),

    // Explicit select so `status` and `paymentExpiresAt` are part of the
    // documented dashboard contract (frontend renders "Complete Payment" CTA
    // with a countdown when status === PENDING_PAYMENT and paymentExpiresAt
    // is in the future).
    prisma.campRegistration.findMany({
      where: { userId },
      select: {
        id: true,
        userId: true,
        campId: true,
        tierId: true,
        participantCount: true,
        applicantDetails: true,
        status: true,
        paymentExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        camp: true,
        payment: { select: { status: true, presentmentAmountMinor: true, presentmentCurrency: true, baseAmountMinor: true, baseCurrency: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),

    prisma.consultation.findMany({
      where: { userId },
      include: {
        service: true,
        payment: { select: { status: true, presentmentAmountMinor: true, presentmentCurrency: true, baseAmountMinor: true, baseCurrency: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const successProgramIds = purchases
    .filter((p) => p.payment?.status === 'SUCCESS')
    .map((p) => p.programId);

  const progressByProgram = await getProgressOverviewsForPrograms(userId, successProgramIds);

  const purchasesWithProgress = purchases.map((p) => ({
    ...p,
    progress:
      p.payment?.status === 'SUCCESS'
        ? progressByProgram.get(p.programId) ?? null
        : null,
  }));

  const campRegistrationsSanitized = campRegistrations.map((r) => ({
    ...r,
    camp: r.camp,
  }));

  res.json({
    success: true,
    message: 'Dashboard data fetched.',
    data: {
      purchases: purchasesWithProgress.map(withPaymentAmount),
      campRegistrations: campRegistrationsSanitized.map(withPaymentAmount),
      consultations: consultations.map(withPaymentAmount),
    },
  });
});

// GET /api/dashboard/programs/:programId — Purchased program tree + module completion + progress rollup
export const getProgramContent = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { programId } = req.params;

  const purchase = await prisma.purchase.findUnique({
    where: { userId_programId: { userId, programId } },
    include: { payment: true },
  });

  if (!purchase || purchase.payment?.status !== 'SUCCESS') {
    return res.status(403).json({
      success: false,
      message: 'You have not purchased this program.',
    });
  }

  const program = await prisma.program.findUnique({
    where: { id: programId },
    include: programDashboardInclude,
  });

  if (!program) {
    throw new AppError('Program not found.', 404);
  }

  const data = await buildProgramDashboardPayload(userId, programId, program);

  res.json({ success: true, message: 'Program content fetched.', data });
});

/**
 * POST /api/dashboard/programs/:programId/modules/:moduleId/complete
 * Frontend calls when the learner finishes a module (e.g. video ended, quiz submitted). Idempotent.
 */
export const completeProgramModule = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { programId, moduleId } = req.params;

  const result = await completeProgramModuleSvc({ userId, programId, moduleId });

  if (!result.ok) {
    return res.status(result.status).json({
      success: false,
      message: result.message,
    });
  }

  res.json({
    success: true,
    message: result.progress.isProgramCompleted
      ? 'Module completed. You have finished this programme!'
      : 'Module progress saved.',
    data: result.progress,
  });
});
