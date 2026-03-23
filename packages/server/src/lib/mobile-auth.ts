import { SignJWT, jwtVerify } from 'jose';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET || 'fallback-dev-secret'
);
const ACCESS_TOKEN_TTL = 15 * 60; // 15 minutes in seconds

export interface MobileTokenPayload {
  userId: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

export async function generateAccessToken(
  payload: MobileTokenPayload,
  ttlSeconds: number = ACCESS_TOKEN_TTL
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .setIssuer('devghost-mobile')
    .sign(JWT_SECRET);
}

export async function verifyAccessToken(token: string): Promise<MobileTokenPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET, {
    issuer: 'devghost-mobile',
  });
  return {
    userId: payload.userId as string,
    email: payload.email as string,
    role: payload.role as 'USER' | 'ADMIN',
  };
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export async function hashRefreshToken(token: string): Promise<string> {
  return bcrypt.hash(token, 10);
}

export async function verifyRefreshTokenHash(
  token: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(token, hash);
}

export function getRefreshTokenExpiry(): Date {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}
