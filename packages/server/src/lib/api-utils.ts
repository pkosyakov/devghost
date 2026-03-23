import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import prisma from '@/lib/db';
import { verifyAccessToken } from './mobile-auth';
import { Order } from '@prisma/client';
import { ZodSchema, ZodError } from 'zod';

/**
 * Response helper for API routes
 */
export function apiResponse<T>(data: T, status: number = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

export function apiError(error: string, status: number = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/**
 * User session interface
 */
export interface UserSession {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

/**
 * Get authenticated session from Bearer JWT token (mobile clients)
 * Returns null if no valid Bearer token present
 */
export async function getUserSessionFromBearer(): Promise<UserSession | null> {
  try {
    const headersList = await headers();
    const authHeader = headersList.get('authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.slice(7);
    const payload = await verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, role: true, isBlocked: true },
    });

    if (!user || user.isBlocked) {
      return null;
    }

    return {
      user: { id: user.id, email: user.email, role: user.role },
    };
  } catch {
    return null;
  }
}

/**
 * Get authenticated session
 * Checks Bearer JWT first (mobile), then NextAuth cookie (web)
 * Returns null if not authenticated
 */
export async function getUserSession(): Promise<UserSession | null> {
  // Try Bearer token first (mobile clients)
  const bearerSession = await getUserSessionFromBearer();
  if (bearerSession) {
    return bearerSession;
  }

  const session = await auth();

  if (!session?.user?.email) {
    return null;
  }

  // Look up user by email to get ID, role, and blocked status
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, email: true, role: true, isBlocked: true },
  });

  if (!user || user.isBlocked) {
    return null;
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  };
}

/**
 * Require authenticated user session
 * Returns session or NextResponse error
 */
export async function requireUserSession(): Promise<UserSession | NextResponse> {
  const session = await getUserSession();

  if (!session) {
    return apiError('Unauthorized', 401);
  }

  return session;
}

/**
 * Require admin user session
 * Returns session or NextResponse error (401/403)
 */
export async function requireAdmin(): Promise<UserSession | NextResponse> {
  const session = await getUserSession();
  if (!session) {
    return apiError('Unauthorized', 401);
  }

  if (session.user.role !== 'ADMIN') {
    return apiError('Forbidden', 403);
  }

  return session;
}

/**
 * Check if response is an error response
 */
export function isErrorResponse(
  result: UserSession | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * Result type for order authorization check
 */
export type OrderWithAuth<T = Order> =
  | { success: true; order: T; session: UserSession }
  | { success: false; error: string; status: number };

/**
 * Options for fetching order with relations
 */
export interface GetOrderOptions {
  include?: Record<string, unknown>;
  select?: Record<string, unknown>;
}

/**
 * Get order with authentication and authorization check
 * Combines session validation, user lookup, and order ownership verification
 *
 * @param orderId - The order ID to fetch
 * @param options - Optional Prisma include/select options
 * @returns OrderWithAuth result with order and session, or error details
 */
export async function getOrderWithAuth<T = Order>(
  orderId: string,
  options?: GetOrderOptions
): Promise<OrderWithAuth<T>> {
  const session = await getUserSession();
  if (!session) {
    return { success: false, error: 'Unauthorized', status: 401 };
  }

  // Admin sees all orders, regular user only their own
  const where: { id: string; userId?: string } = { id: orderId };
  if (session.user.role !== 'ADMIN') {
    where.userId = session.user.id;
  }

  const query: {
    where: typeof where;
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
  } = { where };

  if (options?.include) query.include = options.include;
  if (options?.select) query.select = options.select;

  const order = await prisma.order.findFirst(query);
  if (!order) {
    return { success: false, error: 'Order not found', status: 404 };
  }

  return { success: true, order: order as T, session };
}

/**
 * Helper to convert OrderWithAuth error to NextResponse
 */
export function orderAuthError(result: { error: string; status: number }) {
  return apiError(result.error, result.status);
}

/**
 * Parse and validate request body with Zod schema.
 * Returns parsed data or a 400 error response.
 */
export async function parseBody<T>(
  request: NextRequest,
  schema: ZodSchema<T>,
): Promise<{ success: true; data: T } | { success: false; error: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { success: false, error: apiError('Invalid JSON body', 400) };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    const message = (result.error as ZodError).errors.map((e) => e.message).join(', ');
    return { success: false, error: apiError(message, 400) };
  }

  return { success: true, data: result.data };
}

/**
 * Result type for date range validation
 */
export type DateRangeResult =
  | { valid: true; start: Date; end: Date }
  | { valid: false; error: string };

/**
 * Validate a date range
 * @param startDate - Start date as ISO string
 * @param endDate - End date as ISO string
 * @returns Validation result with parsed dates or error
 */
export function validateDateRange(
  startDate: string,
  endDate: string
): DateRangeResult {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { valid: false, error: 'Invalid date format' };
  }

  if (start > end) {
    return { valid: false, error: 'Start date must be before end date' };
  }

  return { valid: true, start, end };
}
