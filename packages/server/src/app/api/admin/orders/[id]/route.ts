import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, name: true, user: { select: { email: true } } },
  });
  if (!order) return apiError('Order not found', 404);

  const { name: orderName, user: { email: ownerEmail } } = order;

  await prisma.order.delete({ where: { id } });

  await auditLog({
    userId: session.user.id,
    action: 'admin.order.delete',
    targetType: 'Order',
    targetId: id,
    details: { orderName, ownerEmail },
  });

  return apiResponse({ deleted: true });
}
