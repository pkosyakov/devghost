import { describe, it, expect } from 'vitest';
import {
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyRefreshTokenHash,
  getRefreshTokenExpiry,
} from '../mobile-auth';

describe('mobile-auth', () => {
  describe('access tokens', () => {
    it('generates and verifies a valid JWT', async () => {
      const payload = { userId: 'user_123', email: 'test@test.com', role: 'USER' as const };
      const token = await generateAccessToken(payload);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const verified = await verifyAccessToken(token);
      expect(verified.userId).toBe('user_123');
      expect(verified.email).toBe('test@test.com');
      expect(verified.role).toBe('USER');
    });

    it('rejects expired token', async () => {
      const payload = { userId: 'user_123', email: 'test@test.com', role: 'USER' as const };
      const token = await generateAccessToken(payload, -1);
      await expect(verifyAccessToken(token)).rejects.toThrow();
    });

    it('rejects tampered token', async () => {
      const payload = { userId: 'user_123', email: 'test@test.com', role: 'USER' as const };
      const token = await generateAccessToken(payload);
      const tampered = token.slice(0, -5) + 'xxxxx';
      await expect(verifyAccessToken(tampered)).rejects.toThrow();
    });
  });

  describe('refresh tokens', () => {
    it('generates a random opaque token', () => {
      const token = generateRefreshToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThanOrEqual(64);
    });

    it('generates unique tokens', () => {
      const t1 = generateRefreshToken();
      const t2 = generateRefreshToken();
      expect(t1).not.toBe(t2);
    });

    it('hashes and verifies refresh token', async () => {
      const token = generateRefreshToken();
      const hash = await hashRefreshToken(token);
      expect(hash).not.toBe(token);
      expect(await verifyRefreshTokenHash(token, hash)).toBe(true);
    });

    it('rejects wrong token against hash', async () => {
      const token = generateRefreshToken();
      const hash = await hashRefreshToken(token);
      expect(await verifyRefreshTokenHash('wrong_token', hash)).toBe(false);
    });
  });

  describe('getRefreshTokenExpiry', () => {
    it('returns a date 30 days from now', () => {
      const expiry = getRefreshTokenExpiry();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const diff = expiry.getTime() - Date.now();
      expect(diff).toBeGreaterThan(thirtyDaysMs - 1000);
      expect(diff).toBeLessThan(thirtyDaysMs + 1000);
    });
  });
});
