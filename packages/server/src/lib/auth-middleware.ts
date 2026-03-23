/**
 * Minimal auth for Edge middleware. Uses only authConfig to avoid pulling in
 * logger, prisma, etc. which are Node.js-only.
 */
import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

export const { auth } = NextAuth(authConfig);
