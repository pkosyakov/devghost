import { NextRequest, NextResponse } from 'next/server';
import { requireUserSession, isErrorResponse, apiError } from '@/lib/api-utils';
import { createOAuthState } from '@/lib/services/mobile-oauth-store';
import { gitLogger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;

    const { searchParams } = new URL(request.url);
    const codeChallenge = searchParams.get('code_challenge');

    if (!codeChallenge) {
      return apiError('code_challenge is required', 400);
    }

    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return apiError('GitHub OAuth not configured', 500);
    }

    const state = createOAuthState(result.user.id, codeChallenge);

    const callbackUrl = `${process.env.AUTH_URL || 'http://localhost:3000'}/api/github/mobile/callback`;

    const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
    githubAuthUrl.searchParams.set('client_id', clientId);
    githubAuthUrl.searchParams.set('redirect_uri', callbackUrl);
    githubAuthUrl.searchParams.set('scope', 'read:user user:email repo');
    githubAuthUrl.searchParams.set('state', state);

    gitLogger.info({ userId: result.user.id }, 'Mobile GitHub OAuth initiated');

    return NextResponse.redirect(githubAuthUrl.toString());
  } catch (err) {
    gitLogger.error({ err }, 'Mobile GitHub authorize error');
    return apiError('Internal server error', 500);
  }
}
