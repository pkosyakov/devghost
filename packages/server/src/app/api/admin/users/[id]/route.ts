import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';

const updateSchema = z.object({
  role: z.enum(['USER', 'ADMIN']).optional(),
  isBlocked: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, isBlocked: true },
  });
  if (!target) return apiError('User not found', 404);

  // Prevent self-modification
  if (target.id === session.user.id) {
    return apiError('Cannot modify your own account', 400);
  }

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return apiError(parsed.error.errors[0].message, 400);

  const data: Record<string, unknown> = {};

  if (parsed.data.role !== undefined) {
    // Last-admin protection: prevent demoting when only one admin remains
    if (target.role === 'ADMIN' && parsed.data.role !== 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return apiError('Cannot demote the last admin', 400);
      }
    }
    data.role = parsed.data.role;
    await auditLog({
      userId: session.user.id,
      action: 'admin.user.role_change',
      targetType: 'User',
      targetId: id,
      details: { oldRole: target.role, newRole: parsed.data.role },
    });
  }

  if (parsed.data.isBlocked !== undefined) {
    data.isBlocked = parsed.data.isBlocked;
    if (parsed.data.isBlocked) {
      data.blockedAt = new Date();
      await auditLog({
        userId: session.user.id,
        action: 'admin.user.block',
        targetType: 'User',
        targetId: id,
        details: { email: target.email },
      });
    } else {
      data.blockedAt = null;
      await auditLog({
        userId: session.user.id,
        action: 'admin.user.unblock',
        targetType: 'User',
        targetId: id,
        details: { email: target.email },
      });
    }
  }

  if (Object.keys(data).length === 0) {
    return apiError('No fields to update', 400);
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true, isBlocked: true, blockedAt: true },
  });

  return apiResponse(updated);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true },
  });
  if (!target) return apiError('User not found', 404);

  if (target.id === session.user.id) {
    return apiError('Cannot delete your own account', 400);
  }

  // Last-admin protection
  if (target.role === 'ADMIN') {
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (adminCount <= 1) {
      return apiError('Cannot delete the last admin', 400);
    }
  }

  await prisma.user.delete({ where: { id } });

  await auditLog({
    userId: session.user.id,
    action: 'admin.user.delete',
    targetType: 'User',
    targetId: id,
    details: { email: target.email },
  });

  return apiResponse({ deleted: true });
}
