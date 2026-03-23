import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'admin/promo-codes/[id]' });

const updateSchema = z.object({
  isActive: z.boolean().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().optional(),
  description: z.string().max(200).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors.map((e) => e.message).join(', '), 400);
  }

  try {
    const existing = await prisma.promoCode.findUnique({ where: { id } });
    if (!existing) {
      return apiError('Promo code not found', 404);
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
    if (parsed.data.maxRedemptions !== undefined) data.maxRedemptions = parsed.data.maxRedemptions;
    if (parsed.data.expiresAt !== undefined) data.expiresAt = new Date(parsed.data.expiresAt);
    if (parsed.data.description !== undefined) data.description = parsed.data.description;

    const updated = await prisma.promoCode.update({
      where: { id },
      data,
    });

    await auditLog({
      userId: session.user.id,
      action: 'admin.promoCode.update',
      targetType: 'PromoCode',
      targetId: id,
      details: { code: existing.code, changes: parsed.data },
    });

    log.info({ promoCodeId: id, code: existing.code }, 'Promo code updated');

    return apiResponse(updated);
  } catch (err) {
    log.error({ err, promoCodeId: id }, 'Failed to update promo code');
    return apiError('Failed to update promo code', 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  try {
    const existing = await prisma.promoCode.findUnique({
      where: { id },
      select: { id: true, code: true, redemptionCount: true },
    });
    if (!existing) {
      return apiError('Promo code not found', 404);
    }

    // Soft-delete: deactivate instead of hard delete if already redeemed
    if (existing.redemptionCount > 0) {
      await prisma.promoCode.update({
        where: { id },
        data: { isActive: false },
      });

      await auditLog({
        userId: session.user.id,
        action: 'admin.promoCode.deactivate',
        targetType: 'PromoCode',
        targetId: id,
        details: { code: existing.code, reason: 'Has redemptions, soft-deleted' },
      });

      log.info({ promoCodeId: id, code: existing.code }, 'Promo code deactivated (has redemptions)');

      return apiResponse({ deactivated: true });
    }

    // Hard delete if no redemptions
    await prisma.promoCode.delete({ where: { id } });

    await auditLog({
      userId: session.user.id,
      action: 'admin.promoCode.delete',
      targetType: 'PromoCode',
      targetId: id,
      details: { code: existing.code },
    });

    log.info({ promoCodeId: id, code: existing.code }, 'Promo code deleted');

    return apiResponse({ deleted: true });
  } catch (err) {
    log.error({ err, promoCodeId: id }, 'Failed to delete promo code');
    return apiError('Failed to delete promo code', 500);
  }
}
