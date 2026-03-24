import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth-middleware';
import { routing } from '@/i18n/routing';

const intlMiddleware = createMiddleware(routing);

/** Стриппит locale prefix для проверки protected paths */
function getPathnameWithoutLocale(pathname: string, locales: readonly string[]): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) {
    return '/' + segments.slice(1).join('/');
  }
  return pathname;
}

/** Извлекает текущий locale из pathname */
function getLocaleFromPath(pathname: string, locales: readonly string[]): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) {
    return segments[0];
  }
  return routing.defaultLocale;
}

/** Строит path с учётом localePrefix: as-needed (en без префикса, ru с /ru) */
function buildLocalizedPath(path: string, locale: string): string {
  if (locale === routing.defaultLocale) return path;
  return `/${locale}${path}`;
}

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/orders',
  '/demo',
  '/settings',
  '/admin',
  '/billing',
  '/publications',
  '/profile',
];

function redirectWithIntlHeaders(
  intlResponse: NextResponse,
  url: string
): NextResponse {
  const res = NextResponse.redirect(url);
  intlResponse.headers.forEach((value, key) => {
    if (
      key.toLowerCase() === 'set-cookie' ||
      key.toLowerCase().startsWith('x-next-intl')
    ) {
      res.headers.append(key, value);
    }
  });
  return res;
}

export default async function middleware(req: NextRequest) {
  const intlResponse = intlMiddleware(req);
  const pathnameWithoutLocale = getPathnameWithoutLocale(
    req.nextUrl.pathname,
    routing.locales
  );
  const isProtected = PROTECTED_PREFIXES.some((p) =>
    pathnameWithoutLocale.startsWith(p)
  );
  const isAuthPage =
    pathnameWithoutLocale === '/login' || pathnameWithoutLocale === '/register';

  if (isProtected || isAuthPage) {
    const session = await auth();
    const locale = getLocaleFromPath(req.nextUrl.pathname, routing.locales);

    if (isProtected && !session?.user) {
      const signInPath = buildLocalizedPath('/login', locale);
      const signInUrl = new URL(signInPath, req.url);
      signInUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
      return redirectWithIntlHeaders(intlResponse, signInUrl.toString());
    }

    if (session?.user && pathnameWithoutLocale.startsWith('/admin')) {
      if ((session.user as { role?: string }).role !== 'ADMIN') {
        const dashboardPath = buildLocalizedPath('/dashboard', locale);
        return redirectWithIntlHeaders(
          intlResponse,
          new URL(dashboardPath, req.url).toString()
        );
      }
    }

    if (session?.user && isAuthPage) {
      const dashboardPath = buildLocalizedPath('/dashboard', locale);
      return redirectWithIntlHeaders(
        intlResponse,
        new URL(dashboardPath, req.url).toString()
      );
    }
  }

  return intlResponse;
}

export const config = {
  matcher: [
    '/((?!api|_next|_vercel|monitoring|.*\\..*).*)',
    // Email in path can contain dots. Keep middleware active for this route,
    // otherwise default-locale URLs may bypass intl rewrite and return 404.
    '/orders/:id/developers/:email*',
    '/(ru|en)/orders/:id/developers/:email*',
  ],
};
