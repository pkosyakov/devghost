import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';
import { getUserSession } from '@/lib/api-utils';
import { gitLogger } from '@/lib/logger';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID?.trim();
const AUTH_URL = (process.env.AUTH_URL || 'http://localhost:3000').trim();

function normalizeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/settings';
  }

  try {
    const authBase = new URL(AUTH_URL);
    const resolved = new URL(raw, AUTH_URL);
    if (resolved.origin !== authBase.origin) {
      return '/settings';
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/settings';
  }
}

// GET /api/github/oauth - Initiate GitHub OAuth flow for linking account
export async function GET(request: NextRequest) {
  try {
    const returnTo = normalizeReturnTo(request.nextUrl.searchParams.get('returnTo'));

    // Must be logged in to link GitHub
    const session = await getUserSession();
    if (!session) {
      return NextResponse.redirect(new URL('/login', AUTH_URL));
    }

    if (!GITHUB_CLIENT_ID) {
      gitLogger.error('GITHUB_CLIENT_ID not configured');
      return NextResponse.redirect(
        new URL('/settings?github=error&reason=not_configured', AUTH_URL)
      );
    }

    // Generate CSRF state token
    const state = randomBytes(32).toString('hex');

    // Store state in httpOnly cookie for verification in callback
    const cookieStore = await cookies();
    cookieStore.set('github_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    });
    cookieStore.set('github_oauth_return_to', returnTo, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/',
    });

    // Build GitHub authorization URL
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: `${AUTH_URL}/api/github/callback`,
      scope: 'read:user user:email repo',
      state,
    });

    return NextResponse.redirect(
      `https://github.com/login/oauth/authorize?${params.toString()}`
    );
  } catch (error) {
    gitLogger.error({ err: error }, 'Failed to initiate GitHub OAuth');
    return NextResponse.redirect(
      new URL('/settings?github=error', AUTH_URL)
    );
  }
}
