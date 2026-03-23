import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import { compare, hash } from 'bcryptjs';
import prisma from './db';
import { authConfig } from './auth.config';
import { auditLog } from './audit';
import { logger } from './logger';
import type { JWT } from 'next-auth/jwt';

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user }) {
      if (!user?.email) return true;
      const dbUser = await prisma.user.findUnique({
        where: { email: user.email },
        select: { isBlocked: true },
      });
      if (dbUser?.isBlocked) {
        auditLog({ action: 'auth.blocked_attempt', details: { email: user.email } });
        return false;
      }
      return true;
    },
    async jwt({ token, user, account }): Promise<JWT> {
      if (user) {
        token.id = user.id as string;
        token.email = user.email as string;
        token.role = (user as { role?: string }).role as JWT['role'] ?? 'USER';

        // Audit: successful login (fire-and-forget)
        auditLog({ userId: user.id as string, action: 'auth.login' });

        // Update lastLoginAt (fire-and-forget)
        prisma.user.update({
          where: { id: user.id as string },
          data: { lastLoginAt: new Date() },
        }).catch(() => {});
      }

      // Refresh role from DB with 5-minute TTL to catch role changes without querying on every request
      if (token.email) {
        const ROLE_REFRESH_INTERVAL = 5 * 60; // 5 minutes
        const now = Math.floor(Date.now() / 1000);
        const lastRefresh = (token.roleRefreshedAt as number) || 0;

        if (now - lastRefresh > ROLE_REFRESH_INTERVAL) {
          const dbUser = await prisma.user.findUnique({
            where: { email: token.email as string },
            select: { role: true },
          });
          if (dbUser) {
            token.role = dbUser.role;
            token.roleRefreshedAt = now;
          }
        }
      }

      // Handle GitHub OAuth - save token to DB
      if (account?.provider === 'github' && account.access_token) {
        token.githubAccessToken = account.access_token;

        // Save GitHub token to database
        const email = token.email || (user?.email as string);
        if (email) {
          try {
            await prisma.user.update({
              where: { email },
              data: { githubAccessToken: account.access_token },
            });
            logger.info({ email: email.substring(0, 3) + '***' }, 'GitHub token saved');
          } catch (error) {
            logger.error({ err: error }, 'Failed to save GitHub token');
          }
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.email = token.email as string;
        session.user.role = token.role;
      }
      // SECURITY: GitHub token is NOT exposed to client session
      // Access tokens are fetched from DB in API routes only
      return session;
    },
  },
  events: {
    async signOut(message) {
      const token = 'token' in message ? message.token : null;
      if (token?.id) {
        auditLog({ userId: token.id as string, action: 'auth.logout' });
      }
    },
  },
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
          select: { id: true, email: true, passwordHash: true, role: true, isBlocked: true },
        });

        if (!user) {
          auditLog({ action: 'auth.login_failed', details: { email: credentials.email as string, reason: 'user_not_found' } });
          return null;
        }

        const isPasswordValid = await compare(
          credentials.password as string,
          user.passwordHash
        );

        if (!isPasswordValid) {
          auditLog({ action: 'auth.login_failed', details: { email: user.email, reason: 'invalid_password' } });
          return null;
        }

        if (user.isBlocked) {
          auditLog({
            userId: user.id,
            action: 'auth.blocked_attempt',
            details: { email: user.email },
          });
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          role: user.role,
        };
      },
    }),
    // GitHub OAuth provider for connecting GitHub account (not for login)
    ...(githubClientId && githubClientSecret
      ? [
          GitHub({
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            authorization: {
              params: {
                scope: 'read:user user:email repo',
              },
            },
          }),
        ]
      : []),
  ],
});

export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hashedPassword: string
): Promise<boolean> {
  return compare(password, hashedPassword);
}
