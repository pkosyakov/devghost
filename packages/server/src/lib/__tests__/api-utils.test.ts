import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
vi.mock('@/lib/db', () => ({
  default: {
    order: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

import prisma from '@/lib/db';
import { auth } from '@/lib/auth';
import { getOrderWithAuth, validateDateRange } from '@/lib/api-utils';

describe('getOrderWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when not authenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as any);

    const result = await getOrderWithAuth('order-123');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Unauthorized');
      expect(result.status).toBe(401);
    }
  });

  it('returns error when user is blocked', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'blocked@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-123',
      email: 'blocked@example.com',
      role: 'USER',
      isBlocked: true,
    } as any);

    const result = await getOrderWithAuth('order-123');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Unauthorized');
      expect(result.status).toBe(401);
    }
  });

  it('returns error when order not found', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      role: 'USER',
      isBlocked: false,
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

    const result = await getOrderWithAuth('order-123');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Order not found');
      expect(result.status).toBe(404);
    }
  });

  it('returns order and session when authorized', async () => {
    const mockOrder = { id: 'order-123', userId: 'user-123', name: 'Test Order' };
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      role: 'USER',
      isBlocked: false,
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any);

    const result = await getOrderWithAuth('order-123');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.order).toEqual(mockOrder);
      expect(result.session?.user.id).toBe('user-123');
      expect(result.session?.user.role).toBe('USER');
    }
  });

  it('includes userId in where clause for regular users', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      role: 'USER',
      isBlocked: false,
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-123',
      userId: 'user-123',
      metrics: [{ id: 'metric-1' }]
    } as any);

    await getOrderWithAuth('order-123', {
      include: { metrics: true },
    });

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { id: 'order-123', userId: 'user-123' },
      include: { metrics: true },
    });
  });

  it('skips userId in where clause for ADMIN users', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'admin@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      isBlocked: false,
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-456',
      userId: 'other-user',
    } as any);

    const result = await getOrderWithAuth('order-456');

    expect(result.success).toBe(true);
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { id: 'order-456' },
    });
  });

  it('admin can access orders owned by other users', async () => {
    const otherUsersOrder = { id: 'order-789', userId: 'other-user-id', name: 'Other Order' };
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'admin@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      isBlocked: false,
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue(otherUsersOrder as any);

    const result = await getOrderWithAuth('order-789');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.order).toEqual(otherUsersOrder);
      expect(result.session?.user.role).toBe('ADMIN');
    }
  });
});

describe('validateDateRange', () => {
  it('returns valid dates for correct input', () => {
    const result = validateDateRange('2024-01-01', '2024-12-31');

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.start.toISOString()).toContain('2024-01-01');
      expect(result.end.toISOString()).toContain('2024-12-31');
    }
  });

  it('returns error for invalid date format', () => {
    const result = validateDateRange('not-a-date', '2024-12-31');

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Invalid date format');
    }
  });

  it('returns error when start is after end', () => {
    const result = validateDateRange('2024-12-31', '2024-01-01');

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('Start date must be before end date');
    }
  });

  it('allows same start and end date', () => {
    const result = validateDateRange('2024-06-15', '2024-06-15');

    expect(result.valid).toBe(true);
  });
});
