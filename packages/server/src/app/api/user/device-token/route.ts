import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

const registerSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

const deleteSchema = z.object({
  token: z.string().min(1),
});

// POST /api/user/device-token — register device for push notifications
export async function POST(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;
    const { user } = result;

    const body = await request.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { token, platform } = parsed.data;

    // Upsert: if token exists for different user, reassign
    await prisma.deviceToken.upsert({
      where: { token },
      create: {
        userId: user.id,
        token,
        platform,
      },
      update: {
        userId: user.id,
        platform,
      },
    });

    logger.info({ userId: user.id, platform }, 'Device token registered');

    return apiResponse({ success: true });
  } catch (err) {
    logger.error({ err }, 'Device token registration error');
    return apiError('Internal server error', 500);
  }
}

// DELETE /api/user/device-token — unregister device
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;
    const { user } = result;

    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { token } = parsed.data;

    await prisma.deviceToken.deleteMany({
      where: { token, userId: user.id },
    });

    logger.info({ userId: user.id }, 'Device token unregistered');

    return apiResponse({ success: true });
  } catch (err) {
    logger.error({ err }, 'Device token deletion error');
    return apiError('Internal server error', 500);
  }
}
