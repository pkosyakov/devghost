import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { apiResponse, apiError } from '@/lib/api-utils';
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyRefreshTokenHash,
  getRefreshTokenExpiry,
} from '@/lib/mobile-auth';
import { logger } from '@/lib/logger';

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = refreshSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { refreshToken, deviceId } = parsed.data;

    // Find all non-expired tokens for this device
    const candidates = await prisma.refreshToken.findMany({
      where: {
        deviceId,
        expiresAt: { gt: new Date() },
      },
      include: { user: { select: { id: true, email: true, role: true, isBlocked: true } } },
    });

    // Try to find a matching token
    let matchedToken = null;
    for (const candidate of candidates) {
      if (await verifyRefreshTokenHash(refreshToken, candidate.tokenHash)) {
        matchedToken = candidate;
        break;
      }
    }

    if (!matchedToken) {
      return apiError('Invalid refresh token', 401);
    }

    // REUSE DETECTION: if token was already rotated, someone is replaying it
    if (matchedToken.rotatedAt) {
      logger.warn(
        { userId: matchedToken.userId, deviceId, tokenId: matchedToken.id },
        'Refresh token reuse detected — revoking all tokens for user'
      );

      // Revoke ALL refresh tokens for this user (nuclear option)
      await prisma.refreshToken.updateMany({
        where: { userId: matchedToken.userId, rotatedAt: null },
        data: { rotatedAt: new Date() },
      });

      return apiError('Token reuse detected. All sessions revoked. Please login again.', 401);
    }

    const { user } = matchedToken;

    if (user.isBlocked) {
      return apiError('Account is blocked', 403);
    }

    // Rotate: mark old token as used
    await prisma.refreshToken.update({
      where: { id: matchedToken.id },
      data: { rotatedAt: new Date() },
    });

    // Issue new tokens
    const newRefreshToken = generateRefreshToken();
    const newTokenHash = await hashRefreshToken(newRefreshToken);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: newTokenHash,
        deviceId,
        expiresAt: getRefreshTokenExpiry(),
      },
    });

    const accessToken = await generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return apiResponse({
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    logger.error({ err }, 'Mobile token refresh error');
    return apiError('Internal server error', 500);
  }
}
