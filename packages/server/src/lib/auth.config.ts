import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/login',
    newUser: '/register',
  },
  callbacks: {
    jwt({ token, user }) {
      // On login, copy role from user (DB) into JWT token
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role as typeof token.role ?? 'USER';
      }
      return token;
    },
    session({ session, token }) {
      // Propagate id and role from JWT into session
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role;
      }
      return session;
    },
    authorized() {
      return true;
    },
  },
  providers: [], // Providers are added in auth.ts
} satisfies NextAuthConfig;
