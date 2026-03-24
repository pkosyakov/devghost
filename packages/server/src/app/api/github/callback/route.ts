import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/db';
import { getUserSession } from '@/lib/api-utils';
import { gitLogger } from '@/lib/logger';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:3000';

// GET /api/github/callback - Handle GitHub OAuth callback
export async function GET(request: NextRequest) {
  const settingsUrl = (params?: string) =>
    new URL(`/settings${params ? `?${params}` : ''}`, AUTH_URL);

  try {
    // Must be logged in
    const session = await getUserSession();
    if (!session) {
      return NextResponse.redirect(new URL('/login', AUTH_URL));
    }

    const { searchParams } = request.nextUrl;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // GitHub returned an error (user denied access, etc.)
    if (error) {
      gitLogger.warn({ error, userId: session.user.id }, 'GitHub OAuth denied');
      return NextResponse.redirect(settingsUrl('github=denied'));
    }

    if (!code || !state) {
      gitLogger.warn({ userId: session.user.id }, 'GitHub OAuth callback missing code or state');
      return NextResponse.redirect(settingsUrl('github=error'));
    }

    // Verify CSRF state
    const cookieStore = await cookies();
    const storedState = cookieStore.get('github_oauth_state')?.value;

    // Clear the state cookie regardless of outcome
    cookieStore.delete('github_oauth_state');

    if (!storedState || storedState !== state) {
      gitLogger.warn({ userId: session.user.id }, 'GitHub OAuth state mismatch');
      return NextResponse.redirect(settingsUrl('github=error&reason=state_mismatch'));
    }

    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      gitLogger.error('GitHub OAuth credentials not configured');
      return NextResponse.redirect(settingsUrl('github=error&reason=not_configured'));
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${AUTH_URL}/api/github/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      gitLogger.error(
        { status: tokenResponse.status, userId: session.user.id },
        'GitHub token exchange failed'
      );
      return NextResponse.redirect(settingsUrl('github=error&reason=token_exchange'));
    }

    const tokenData = await tokenResponse.json();

    if (tokenData.error || !tokenData.access_token) {
      gitLogger.error(
        { error: tokenData.error, userId: session.user.id },
        'GitHub token exchange returned error'
      );
      return NextResponse.redirect(settingsUrl('github=error&reason=token_exchange'));
    }

    const accessToken = tokenData.access_token;

    // Verify the token works by fetching GitHub user info
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'DevGhost',
      },
    });

    if (!userResponse.ok) {
      gitLogger.error(
        { status: userResponse.status, userId: session.user.id },
        'GitHub token validation failed'
      );
      return NextResponse.redirect(settingsUrl('github=error&reason=invalid_token'));
    }

    const githubUser = await userResponse.json();

    // Save token to the CURRENT user's DB record (by session user ID, not by email)
    await prisma.user.update({
      where: { id: session.user.id },
      data: { githubAccessToken: accessToken },
    });

    gitLogger.info(
      { userId: session.user.id, githubLogin: githubUser.login },
      'GitHub account linked successfully'
    );

    return NextResponse.redirect(settingsUrl('github=connected'));
  } catch (error) {
    gitLogger.error({ err: error }, 'GitHub OAuth callback error');
    return NextResponse.redirect(settingsUrl('github=error'));
  }
}
