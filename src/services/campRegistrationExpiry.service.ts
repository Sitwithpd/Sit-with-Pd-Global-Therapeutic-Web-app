import { CampRegistrationStatus } from '@prisma/client';
import prisma from '../config/prisma';
import { whereExpiredHoldCandidates } from './campInventory.service';

/**
 * Releases camp seats whose 60-minute payment hold has elapsed.
 *
 * Mirrors `processExpiredConsultationPayments` in shape and intent.
 *
 * For each PENDING_PAYMENT registration past its `paymentExpiresAt`:
 *   - Atomically flips status → EXPIRED via `updateMany` guarded on
 *     `status === PENDING_PAYMENT`. If a concurrent provider webhook has
 *     already promoted the row to CONFIRMED, our update returns count=0 and
 *     we skip the rest — the webhook owns that row's payment reconciliation.
 *   - Reconciles the linked Payment so a future retry can attach a fresh
 *     Payment without hitting `Payment.campRegistrationId @unique`:
 *       PENDING → status FAILED + null campRegistrationId
 *       FAILED  → null campRegistrationId
 *       SUCCESS → leave SUCCESS but tag `providerResponse._refundRequired=true`
 *                 and emit a structured log. This handles the rare race where
 *                 charge.success commits in the same window we expire the
 *                 seat (the webhook would have skipped its refund-flag path
 *                 because its own updateMany returns count=0 once we've
 *                 already flipped to EXPIRED).
 *
 * Returns the number of registrations actually released this run.
 */
export async function processExpiredCampRegistrations(): Promise<number> {
  const now = new Date();

  const candidates = await prisma.campRegistration.findMany({
    where: whereExpiredHoldCandidates(now),
    include: { payment: true },
  });

  let released = 0;

  for (const reg of candidates) {
    const won = await prisma.$transaction(async (tx) => {
      // 1. Race-safe expiry flip. Only the call that finds the row still in
      //    PENDING_PAYMENT will succeed; concurrent webhook promotion to
      //    CONFIRMED returns count=0 and we leave the row alone.
      const result = await tx.campRegistration.updateMany({
        where: { id: reg.id, status: CampRegistrationStatus.PENDING_PAYMENT },
        data: {
          status: CampRegistrationStatus.EXPIRED,
          paymentExpiresAt: null,
        },
      });
      if (result.count !== 1) return false;

      if (!reg.payment) return true;

      // 2. Re-read the live Payment row inside the transaction in case its
      //    status changed since the scan (e.g. webhook just landed SUCCESS).
      const live = await tx.payment.findUnique({
        where: { id: reg.payment.id },
        select: { id: true, status: true, providerResponse: true },
      });
      if (!live) return true;

      if (live.status === 'SUCCESS') {
        // Edge race: the provider confirmed the charge while we were expiring the
        // seat. Webhook will have skipped its refund-flag branch (its own
        // updateMany now returns 0 against an EXPIRED row), so the worker
        // takes responsibility for marking this payment for manual refund.
        const existing = (live.providerResponse as object | null) ?? {};
        await tx.payment.update({
          where: { id: live.id },
          data: {
            providerResponse: {
              ...existing,
              _refundRequired: true,
              _refundReason:
                'Race: registration expired during charge.success handling.',
            } as object,
          },
        });
        console.error(
          '[camp-registration-expiry] Race: refund-required for SUCCESS payment on expired registration.',
          JSON.stringify({
            paymentId: live.id,
            registrationId: reg.id,
            userId: reg.userId,
            paymentExpiresAt: reg.paymentExpiresAt,
          })
        );
        return true;
      }

      // 3. PENDING / FAILED: detach so a retry can attach a fresh Payment;
      //    promote PENDING → FAILED on the way out so it doesn't sit forever.
      await tx.payment.update({
        where: { id: live.id },
        data: {
          campRegistrationId: null,
          ...(live.status === 'PENDING' ? { status: 'FAILED' as const } : {}),
        },
      });
      return true;
    });

    if (won) released += 1;
  }

  if (released > 0) {
    console.log(
      `[camp-registration-expiry] Released ${released} expired PENDING_PAYMENT registration(s).`
    );
  }
  return released;
}
