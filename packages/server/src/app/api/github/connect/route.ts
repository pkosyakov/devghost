import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
import { z } from 'zod';
import { gitLogger } from '@/lib/logger';

const saveTokenSchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
});

// GET /api/github/connect - Check GitHub connection status
export async function GET() {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;

    const user = await prisma.user.findUnique({
      where: { id: result.user.id },
      select: { id: true, githubAccessToken: true },
    });
    if (!user) return apiError('User not found', 404);

    const isConnected = !!user.githubAccessToken;

    // If connected, verify token is still valid
    if (isConnected && user.githubAccessToken) {
      try {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `token ${user.githubAccessToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'DevGhost',
          },
        });

        if (!response.ok) {
          // Token invalid, clear it
          await prisma.user.update({
            where: { id: user.id },
            data: { githubAccessToken: null },
          });
          return apiResponse({ isConnected: false, username: null });
        }

        const githubUser = await response.json();
        return apiResponse({
          isConnected: true,
          username: githubUser.login,
          avatarUrl: githubUser.avatar_url,
        });
      } catch {
        return apiResponse({ isConnected: true, username: null });
      }
    }

    return apiResponse({ isConnected: false, username: null });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error checking GitHub connection');
    return apiError('Failed to check GitHub connection', 500);
  }
}

// POST /api/github/connect - Save GitHub access token
export async function POST(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;

    const user = await prisma.user.findUnique({
      where: { id: result.user.id },
      select: { id: true, githubAccessToken: true },
    });
    if (!user) return apiError('User not found', 404);

    const body = await request.json();
    const parsed = saveTokenSchema.safeParse(body);

    if (!parsed.success) {
      return apiError(parsed.error.errors[0].message, 400);
    }

    const { accessToken } = parsed.data;

    // Verify token is valid
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'DevGhost',
      },
    });

    if (!response.ok) {
      return apiError('Invalid GitHub access token', 400);
    }

    const githubUser = await response.json();

    // Save token to database
    await prisma.user.update({
      where: { id: user.id },
      data: { githubAccessToken: accessToken },
    });

    return apiResponse({
      success: true,
      username: githubUser.login,
      avatarUrl: githubUser.avatar_url,
    });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error saving GitHub token');
    return apiError('Failed to save GitHub token', 500);
  }
}

// DELETE /api/github/connect - Disconnect GitHub account
export async function DELETE() {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;

    await prisma.user.update({
      where: { id: result.user.id },
      data: { githubAccessToken: null },
    });

    return apiResponse({ success: true });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error disconnecting GitHub');
    return apiError('Failed to disconnect GitHub', 500);
  }
}
