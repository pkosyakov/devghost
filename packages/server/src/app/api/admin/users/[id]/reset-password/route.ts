import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { hashPassword } from '@/lib/auth';
import { auditLog } from '@/lib/audit';
import crypto from 'crypto';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true },
  });
  if (!target) return apiError('User not found', 404);

  // Generate random 12-char password
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const passwordHash = await hashPassword(tempPassword);

  await prisma.user.update({
    where: { id },
    data: { passwordHash },
  });

  await auditLog({
    userId: session.user.id,
    action: 'admin.user.reset_password',
    targetType: 'User',
    targetId: id,
    details: { email: target.email },
  });

  // NOTE: tempPassword returned to admin UI for manual delivery.
  // TODO: Replace with email delivery when SMTP is configured.
  return apiResponse({ tempPassword });
}
