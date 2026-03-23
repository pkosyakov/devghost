import { describe, it, expect } from 'vitest';
import { normalizeDecimals } from '@/lib/utils';

describe('normalizeDecimals', () => {
  it('converts Decimal-like objects to numbers', () => {
    const input = {
      name: 'test',
      dailyRate: { toNumber: () => 500 },
      effRate: { toNumber: () => 450.5 },
      count: 10,
    };

    const result = normalizeDecimals(input, ['dailyRate', 'effRate']);

    expect(result.name).toBe('test');
    expect(result.dailyRate).toBe(500);
    expect(result.effRate).toBe(450.5);
    expect(result.count).toBe(10);
  });

  it('handles Number() conversion for Prisma Decimals', () => {
    const input = {
      value: { toString: () => '123.45' },
    };

    const result = normalizeDecimals(input, ['value']);

    expect(result.value).toBe(123.45);
  });

  it('preserves null values', () => {
    const input = { value: null };
    const result = normalizeDecimals(input, ['value']);
    expect(result.value).toBeNull();
  });
});
