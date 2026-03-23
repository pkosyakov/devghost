import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
import { getOAuthState, deleteOAuthState, verifyPKCE } from '@/lib/services/mobile-oauth-store';
import { gitLogger } from '@/lib/logger';

const exchangeSchema = z.object({
  authCode: z.string().min(1),
  codeVerifier: z.string().min(43).max(128),
  state: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;

    const body = await request.json();
    const parsed = exchangeSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { authCode, codeVerifier, state } = parsed.data;

    const entry = getOAuthState(state);
    if (!entry) {
      return apiError('Invalid or expired state', 400);
    }

    // Verify the request is from the same user who initiated
    if (entry.userId !== result.user.id) {
      gitLogger.warn(
        { expectedUserId: entry.userId, actualUserId: result.user.id },
        'Mobile GitHub OAuth user mismatch'
      );
      deleteOAuthState(state);
      return apiError('User mismatch', 403);
    }

    // Verify auth code matches
    if (entry.authCode !== authCode) {
      return apiError('Invalid auth code', 400);
    }

    // Verify PKCE
    if (!verifyPKCE(codeVerifier, entry.codeChallenge)) {
      gitLogger.warn({ userId: result.user.id }, 'Mobile GitHub OAuth PKCE verification failed');
      deleteOAuthState(state);
      return apiError('PKCE verification failed', 400);
    }

    if (!entry.githubToken) {
      deleteOAuthState(state);
      return apiError('GitHub token not available', 400);
    }

    // Verify GitHub token is valid and get user info
    const ghResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${entry.githubToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'DevGhost',
      },
    });

    if (!ghResponse.ok) {
      deleteOAuthState(state);
      return apiError('GitHub token validation failed', 400);
    }

    const githubUser = await ghResponse.json();

    // Save GitHub token to user
    await prisma.user.update({
      where: { id: result.user.id },
      data: {
        githubAccessToken: entry.githubToken,
        githubUsername: githubUser.login,
      },
    });

    // Clean up state
    deleteOAuthState(state);

    gitLogger.info(
      { userId: result.user.id, githubUsername: githubUser.login },
      'Mobile GitHub OAuth completed'
    );

    return apiResponse({
      success: true,
      username: githubUser.login,
      avatarUrl: githubUser.avatar_url,
    });
  } catch (err) {
    gitLogger.error({ err }, 'Mobile GitHub exchange error');
    return apiError('Internal server error', 500);
  }
}
