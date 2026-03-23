import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getOAuthState, updateOAuthState } from '@/lib/services/mobile-oauth-store';
import { gitLogger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code || !state) {
      return new NextResponse('Missing code or state', { status: 400 });
    }

    const entry = getOAuthState(state);
    if (!entry) {
      return new NextResponse('Invalid or expired state', { status: 400 });
    }

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return new NextResponse('GitHub OAuth not configured', { status: 500 });
    }

    // Exchange code for GitHub access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error || !tokenData.access_token) {
      gitLogger.error({ error: tokenData.error }, 'GitHub token exchange failed');
      return new NextResponse('GitHub token exchange failed', { status: 400 });
    }

    // Generate one-time auth code
    const authCode = crypto.randomBytes(32).toString('base64url');

    // Store GitHub token and auth code in state
    updateOAuthState(state, {
      githubToken: tokenData.access_token,
      authCode,
    });

    // Redirect to universal link (iOS catches this)
    // Fallback: if no universal link domain, redirect to a success page
    const appDomain = process.env.MOBILE_APP_DOMAIN || 'devghost.app';
    const redirectUrl = `https://${appDomain}/github-callback?auth_code=${authCode}&state=${state}`;

    gitLogger.info({ userId: entry.userId }, 'Mobile GitHub OAuth callback — redirecting to app');

    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    gitLogger.error({ err }, 'Mobile GitHub callback error');
    return new NextResponse('Internal server error', { status: 500 });
  }
}
