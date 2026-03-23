import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'admin/credits/adjust' });

const schema = z.object({
  userId: z.string().min(1),
  amount: z.number().int(), // positive or negative
  reason: z.string().min(1).max(200),
});

/**
 * POST /api/admin/credits/adjust
 *
 * Adjust a user's permanent credits (add or deduct).
 * Creates an ADMIN_ADJUSTMENT transaction and audit log entry.
 */
export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors.map((e) => e.message).join(', '), 400);
  }

  const { userId, amount, reason } = parsed.data;

  if (amount === 0) {
    return apiError('Amount must not be zero', 400);
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Check user exists
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      // Atomic conditional update — prevents TOCTOU race on concurrent deductions
      if (amount < 0) {
        const updated = await tx.$executeRaw`
          UPDATE "User" SET "permanentCredits" = "permanentCredits" + ${amount}
          WHERE id = ${userId} AND "permanentCredits" + ${amount} >= 0
        `;
        if (updated === 0) throw new Error('INSUFFICIENT_BALANCE');
      } else {
        await tx.user.update({
          where: { id: userId },
          data: { permanentCredits: { increment: amount } },
        });
      }

      // Read back the updated balance
      const updated = await tx.user.findUnique({
        where: { id: userId },
        select: {
          permanentCredits: true,
          subscriptionCredits: true,
          reservedCredits: true,
        },
      });

      // Record the transaction
      await tx.creditTransaction.create({
        data: {
          userId,
          type: 'ADMIN_ADJUSTMENT',
          amount,
          wallet: 'PERMANENT',
          balanceAfter: updated!.permanentCredits + updated!.subscriptionCredits - updated!.reservedCredits,
          description: reason,
        },
      });

      return {
        permanent: updated!.permanentCredits,
        subscription: updated!.subscriptionCredits,
        reserved: updated!.reservedCredits,
        available:
          updated!.permanentCredits +
          updated!.subscriptionCredits -
          updated!.reservedCredits,
      };
    });

    // Audit log (fire-and-forget)
    await auditLog({
      userId: session.user.id,
      action: 'admin.credits.adjust',
      targetType: 'User',
      targetId: userId,
      details: { amount, reason },
    });

    log.info(
      { adminId: session.user.id, targetUserId: userId, amount, reason },
      'Admin credit adjustment applied',
    );

    return apiResponse({ balance: result });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'USER_NOT_FOUND') {
        return apiError('User not found', 404);
      }
      if (err.message === 'INSUFFICIENT_BALANCE') {
        return apiError(
          'Adjustment would result in negative permanent credits balance',
          422,
        );
      }
    }
    log.error({ err, userId, amount }, 'Failed to adjust credits');
    return apiError('Failed to adjust credits', 500);
  }
}
