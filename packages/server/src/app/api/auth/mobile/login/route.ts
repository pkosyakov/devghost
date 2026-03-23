import { NextRequest } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '@/lib/db';
import { apiResponse, apiError } from '@/lib/api-utils';
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiry,
} from '@/lib/mobile-auth';
import { logger } from '@/lib/logger';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { email, password, deviceId } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, passwordHash: true, role: true, isBlocked: true },
    });

    if (!user || !user.passwordHash) {
      return apiError('Invalid credentials', 401);
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      return apiError('Invalid credentials', 401);
    }

    if (user.isBlocked) {
      return apiError('Account is blocked', 403);
    }

    // Invalidate existing refresh tokens for this device
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, deviceId, rotatedAt: null },
      data: { rotatedAt: new Date() },
    });

    const accessToken = await generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = generateRefreshToken();
    const tokenHash = await hashRefreshToken(refreshToken);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        deviceId,
        expiresAt: getRefreshTokenExpiry(),
      },
    });

    // Update lastLoginAt (fire and forget)
    prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    }).catch(() => {});

    logger.info({ userId: user.id, deviceId }, 'Mobile login successful');

    return apiResponse({
      accessToken,
      refreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    logger.error({ err }, 'Mobile login error');
    return apiError('Internal server error', 500);
  }
}
