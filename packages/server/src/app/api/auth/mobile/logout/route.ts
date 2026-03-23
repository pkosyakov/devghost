import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

export async function POST() {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;
    const { user } = result;

    const { count } = await prisma.refreshToken.updateMany({
      where: { userId: user.id, rotatedAt: null },
      data: { rotatedAt: new Date() },
    });

    logger.info({ userId: user.id, revokedCount: count }, 'Mobile logout — all tokens revoked');

    return apiResponse({ success: true });
  } catch (err) {
    logger.error({ err }, 'Mobile logout error');
    return apiError('Internal server error', 500);
  }
}
