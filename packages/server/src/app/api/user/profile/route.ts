import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { z } from 'zod';
import {
  apiResponse,
  apiError,
  requireUserSession,
  isErrorResponse,
} from '@/lib/api-utils';
import { logger } from '@/lib/logger';

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export async function GET() {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        githubUsername: true,
      },
    });

    if (!user) {
      return apiError('User not found', 404);
    }

    return apiResponse({
      id: user.id,
      email: user.email,
      name: user.name || user.githubUsername || '',
    });
  } catch (error) {
    logger.error({ err: error }, 'Get profile error');
    return apiError('Failed to get profile', 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const body = await request.json();
    const result = updateProfileSchema.safeParse(body);

    if (!result.success) {
      return apiError(result.error.errors[0].message, 400);
    }

    const { name } = result.data;

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        githubUsername: true,
      },
    });

    return apiResponse({
      id: user.id,
      email: user.email,
      name: user.name || user.githubUsername || '',
    });
  } catch (error) {
    logger.error({ err: error }, 'Update profile error');
    return apiError('Failed to update profile', 500);
  }
}
