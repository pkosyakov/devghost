# Codebase Audit Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 43 issues identified in the codebase audit, prioritizing security, performance, and maintainability.

**Architecture:**
- Phase 1 focuses on critical security fixes that can be done without breaking changes
- Phase 2 creates shared utilities to reduce code duplication (DRY principle)
- Phase 3 removes unused code to reduce bundle size and maintenance burden
- Phase 4 optimizes performance-critical paths
- Phase 5 improves type safety and best practices

**Tech Stack:** Next.js 16, TypeScript, Prisma, Vitest

---

## Phase 1: Critical Security Fixes (Priority: IMMEDIATE)

### Task 1.1: Remove GitHub Token from Client Session

**Files:**
- Modify: `src/lib/auth.ts:44-54`
- Modify: `src/types/next-auth.d.ts` (if exists)

**Why:** GitHub access tokens are currently exposed to the browser via the session object. This violates OAuth security best practices and could allow token theft via XSS.

**Step 1: Review current session callback**

Read and understand the current implementation:
```typescript
// Current insecure code in auth.ts:44-54
async session({ session, token }) {
  if (token && session.user) {
    session.user.id = token.id as string;
    session.user.email = token.email as string;
  }
  // SECURITY ISSUE: Token exposed to client
  if (token.githubAccessToken) {
    (session as { githubAccessToken?: string }).githubAccessToken = token.githubAccessToken as string;
  }
  return session;
}
```

**Step 2: Modify session callback to remove token**

Replace the session callback in `src/lib/auth.ts`:

```typescript
async session({ session, token }) {
  if (token && session.user) {
    session.user.id = token.id as string;
    session.user.email = token.email as string;
  }
  // REMOVED: GitHub token no longer exposed to client
  // Access tokens are now fetched from DB in API routes only
  return session;
}
```

**Step 3: Verify API routes fetch token from DB**

Check that `src/app/api/github/repos/route.ts` already fetches token from database (it does):
```typescript
const user = await prisma.user.findUnique({
  where: { id: session.user.id },
  select: { githubAccessToken: true },
});
```

**Step 4: Remove sensitive console.log**

In `src/lib/auth.ts:35`, change:
```typescript
console.log('GitHub token saved for user:', email);
```
To:
```typescript
console.log('GitHub token saved for user:', email.substring(0, 3) + '***');
```

**Step 5: Run tests to verify no breakage**

Run: `cd prototype && pnpm test:run`
Expected: All tests pass

**Step 6: Manual verification**

1. Start dev server: `cd prototype && pnpm dev`
2. Login with GitHub
3. Open browser DevTools → Application → Session Storage
4. Verify `githubAccessToken` is NOT present in session

**Step 7: Commit**

```bash
cd prototype
git add src/lib/auth.ts
git commit -m "fix(security): remove GitHub token from client session

- Token is now only accessible server-side via database lookup
- Prevents potential XSS-based token theft
- Redacts email in logs"
```

---

### Task 1.2: Fix Silent Error Catching

**Files:**
- Modify: `src/app/api/system/browse-directory/route.ts:99-102`

**Why:** Empty catch blocks hide errors, making debugging impossible.

**Step 1: Locate the silent catch**

The silent catch is at lines 99-102:
```typescript
} catch {
  // Try next dialog
  continue;
}
```

**Step 2: Add logging to the catch block**

Replace lines 99-102:
```typescript
} catch (dialogError) {
  // Log the specific dialog failure for debugging
  console.debug(`[BrowseDirectory] ${cmd.split(' ')[0]} failed:`,
    dialogError instanceof Error ? dialogError.message : 'Unknown error');
  // Try next dialog
  continue;
}
```

**Step 3: Commit**

```bash
cd prototype
git add src/app/api/system/browse-directory/route.ts
git commit -m "fix(error-handling): add logging to folder dialog fallbacks

Previously silent catch made debugging impossible"
```

---

## Phase 2: Extract Shared Utilities (Reduce Duplication)

### Task 2.1: Create Order Authorization Helper

**Files:**
- Modify: `src/lib/api-utils.ts`
- Create: `src/lib/__tests__/api-utils.test.ts`

**Why:** The pattern of checking session + fetching order + verifying ownership is duplicated 10+ times across API routes.

**Step 1: Write the failing test**

Create `src/lib/__tests__/api-utils.test.ts`:

```typescript
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
import { getOrderWithAuth, OrderWithAuth } from '@/lib/api-utils';

describe('getOrderWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when not authenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const result = await getOrderWithAuth('order-123');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unauthorized');
    expect(result.status).toBe(401);
  });

  it('returns error when order not found', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

    const result = await getOrderWithAuth('order-123');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Order not found');
    expect(result.status).toBe(404);
  });

  it('returns order and session when authorized', async () => {
    const mockOrder = { id: 'order-123', userId: 'user-123', name: 'Test Order' };
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any);

    const result = await getOrderWithAuth('order-123');

    expect(result.success).toBe(true);
    expect(result.order).toEqual(mockOrder);
    expect(result.session?.user.id).toBe('user-123');
  });

  it('supports custom include options', async () => {
    const mockOrder = {
      id: 'order-123',
      userId: 'user-123',
      metrics: [{ id: 'metric-1' }]
    };
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
    } as any);
    vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any);

    const result = await getOrderWithAuth('order-123', {
      include: { metrics: true },
    });

    expect(result.success).toBe(true);
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { id: 'order-123', userId: 'user-123' },
      include: { metrics: true },
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd prototype && pnpm test:run src/lib/__tests__/api-utils.test.ts`
Expected: FAIL with "getOrderWithAuth is not defined" or similar

**Step 3: Implement getOrderWithAuth**

Add to `src/lib/api-utils.ts`:

```typescript
import { Order } from '@prisma/client';

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
  // Get and validate session
  const session = await getUserSession();
  if (!session) {
    return { success: false, error: 'Unauthorized', status: 401 };
  }

  // Build query with optional includes
  const query: {
    where: { id: string; userId: string };
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
  } = {
    where: { id: orderId, userId: session.user.id },
  };

  if (options?.include) {
    query.include = options.include;
  }
  if (options?.select) {
    query.select = options.select;
  }

  // Fetch order with ownership check
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
```

**Step 4: Run test to verify it passes**

Run: `cd prototype && pnpm test:run src/lib/__tests__/api-utils.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd prototype
git add src/lib/api-utils.ts src/lib/__tests__/api-utils.test.ts
git commit -m "feat(api): add getOrderWithAuth helper

Centralizes session validation, user lookup, and order ownership check.
Reduces code duplication across 10+ API routes."
```

---

### Task 2.2: Refactor Order Routes to Use Helper

**Files:**
- Modify: `src/app/api/orders/[id]/route.ts`
- Modify: `src/app/api/orders/[id]/developers/route.ts`
- Modify: `src/app/api/orders/[id]/commits/route.ts`
- Modify: `src/app/api/orders/[id]/progress/route.ts`
- Modify: `src/app/api/orders/[id]/mapping/route.ts`
- Modify: `src/app/api/orders/[id]/effort-distribution/route.ts`
- Modify: `src/app/api/orders/[id]/performance/route.ts`
- Modify: `src/app/api/orders/[id]/cache/route.ts`

**Why:** Now that we have the helper, we can reduce each route by ~10 lines.

**Step 1: Refactor GET in orders/[id]/route.ts**

Replace lines 11-38 (the GET function):

```typescript
import {
  apiResponse,
  apiError,
  getOrderWithAuth,
  orderAuthError,
} from '@/lib/api-utils';

// GET /api/orders/[id] - Get single order
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Single call replaces 15 lines of boilerplate
    const result = await getOrderWithAuth(id, {
      include: {
        metrics: {
          orderBy: [
            { periodType: 'asc' },
            { year: 'desc' },
            { month: 'desc' },
          ],
        },
      },
    });

    if (!result.success) {
      return orderAuthError(result);
    }

    const { order } = result;

    // ... rest of the function unchanged
```

**Step 2: Repeat for PUT and DELETE in same file**

Apply same pattern to PUT (lines 78-93) and DELETE (lines 154-169).

**Step 3: Refactor other route files**

Apply the same refactoring to each of the other 7 route files listed above.

**Step 4: Run tests**

Run: `cd prototype && pnpm test:run`
Expected: All tests pass

**Step 5: Commit**

```bash
cd prototype
git add src/app/api/orders/
git commit -m "refactor(api): use getOrderWithAuth in all order routes

Reduces boilerplate by ~10 lines per route handler.
Total reduction: ~100 lines across 10 files."
```

---

### Task 2.3: Create Decimal Normalization Utility

**Files:**
- Modify: `src/lib/utils.ts`
- Create: `src/lib/__tests__/utils.test.ts`

**Why:** Converting Prisma Decimal types to JavaScript numbers is done 15+ times with repeated code.

**Step 1: Write the failing test**

Create `src/lib/__tests__/utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeDecimals, normalizeMetrics } from '@/lib/utils';

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

describe('normalizeMetrics', () => {
  it('normalizes all standard metric fields', () => {
    const metric = {
      id: '1',
      dailyRate: { toString: () => '500' },
      effRate: { toString: () => '450' },
      deviation: { toString: () => '-10' },
      totalCost: { toString: () => '10000' },
      avgProductivity: { toString: () => '0.9' },
      workDays: 20,
    };

    const result = normalizeMetrics(metric);

    expect(result.dailyRate).toBe(500);
    expect(result.effRate).toBe(450);
    expect(result.deviation).toBe(-10);
    expect(result.totalCost).toBe(10000);
    expect(result.avgProductivity).toBe(0.9);
    expect(result.workDays).toBe(20);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd prototype && pnpm test:run src/lib/__tests__/utils.test.ts`
Expected: FAIL

**Step 3: Implement utility functions**

Add to `src/lib/utils.ts`:

```typescript
/**
 * Convert Prisma Decimal fields to JavaScript numbers
 * @param obj - Object containing potential Decimal fields
 * @param fields - Array of field names to convert
 * @returns New object with Decimals converted to numbers
 */
export function normalizeDecimals<T extends Record<string, unknown>>(
  obj: T,
  fields: (keyof T)[]
): T {
  const result = { ...obj };

  for (const field of fields) {
    const value = result[field];
    if (value === null || value === undefined) {
      continue;
    }
    // Handle Prisma Decimal objects
    if (typeof value === 'object' && value !== null) {
      if ('toNumber' in value && typeof value.toNumber === 'function') {
        (result as Record<string, unknown>)[field as string] = value.toNumber();
      } else {
        (result as Record<string, unknown>)[field as string] = Number(value);
      }
    }
  }

  return result;
}

/**
 * Standard metric fields that need Decimal → Number conversion
 */
const METRIC_DECIMAL_FIELDS = [
  'dailyRate',
  'effRate',
  'deviation',
  'totalCost',
  'avgProductivity',
] as const;

/**
 * Normalize all Decimal fields in an OrderMetric object
 */
export function normalizeMetrics<T extends Record<string, unknown>>(metric: T): T {
  return normalizeDecimals(metric, METRIC_DECIMAL_FIELDS as unknown as (keyof T)[]);
}
```

**Step 4: Run test to verify it passes**

Run: `cd prototype && pnpm test:run src/lib/__tests__/utils.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd prototype
git add src/lib/utils.ts src/lib/__tests__/utils.test.ts
git commit -m "feat(utils): add Decimal normalization utilities

- normalizeDecimals: converts specified fields
- normalizeMetrics: handles standard metric fields
Reduces repetitive Number() conversions across codebase."
```

---

### Task 2.4: Create Date Range Validation Utility

**Files:**
- Modify: `src/lib/api-utils.ts`

**Why:** Date range validation is duplicated 3 times with identical logic.

**Step 1: Add to existing api-utils.test.ts**

Add new tests to `src/lib/__tests__/api-utils.test.ts`:

```typescript
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
```

**Step 2: Implement the utility**

Add to `src/lib/api-utils.ts`:

```typescript
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
```

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run src/lib/__tests__/api-utils.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/lib/api-utils.ts src/lib/__tests__/api-utils.test.ts
git commit -m "feat(api): add validateDateRange utility

Centralizes date range validation logic used in 3+ routes."
```

---

### Task 2.5: Create GitHub API Client

**Files:**
- Create: `src/lib/github-client.ts`
- Create: `src/lib/__tests__/github-client.test.ts`

**Why:** GitHub API fetch patterns (headers, auth, error handling) are duplicated 4+ times.

**Step 1: Write the failing test**

Create `src/lib/__tests__/github-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient, GitHubApiError } from '@/lib/github-client';

describe('GitHubClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes correct headers in requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });
    global.fetch = mockFetch;

    const client = new GitHubClient('test-token');
    await client.get('/user');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token test-token',
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'AI-Code-Audit',
        }),
      })
    );
  });

  it('throws GitHubApiError on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const client = new GitHubClient('invalid-token');

    await expect(client.get('/user')).rejects.toThrow(GitHubApiError);
    await expect(client.get('/user')).rejects.toMatchObject({
      status: 401,
      code: 'TOKEN_EXPIRED',
    });
  });

  it('throws GitHubApiError on 403 rate limit', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers({ 'X-RateLimit-Remaining': '0' }),
    });

    const client = new GitHubClient('test-token');

    await expect(client.get('/user')).rejects.toMatchObject({
      status: 403,
      code: 'RATE_LIMITED',
    });
  });
});
```

**Step 2: Implement GitHubClient**

Create `src/lib/github-client.ts`:

```typescript
/**
 * GitHub API Client
 * Centralizes authentication, headers, and error handling for GitHub API calls
 */

export type GitHubErrorCode =
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNKNOWN';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: GitHubErrorCode
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export class GitHubClient {
  private baseUrl = 'https://api.github.com';

  constructor(private token: string) {}

  private getHeaders(): HeadersInit {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'AI-Code-Audit',
    };
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      return response.json();
    }

    let code: GitHubErrorCode = 'UNKNOWN';
    let message = response.statusText;

    switch (response.status) {
      case 401:
        code = 'TOKEN_EXPIRED';
        message = 'GitHub token is invalid or expired';
        break;
      case 403:
        const remaining = response.headers.get('X-RateLimit-Remaining');
        if (remaining === '0') {
          code = 'RATE_LIMITED';
          message = 'GitHub API rate limit exceeded';
        } else {
          code = 'FORBIDDEN';
          message = 'Access forbidden';
        }
        break;
      case 404:
        code = 'NOT_FOUND';
        message = 'Resource not found';
        break;
    }

    throw new GitHubApiError(message, response.status, code);
  }

  async get<T>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<T>(response);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * Fetch all pages of a paginated GitHub API endpoint
   */
  async paginate<T>(path: string, options?: { maxPages?: number }): Promise<T[]> {
    const maxPages = options?.maxPages ?? 10;
    const results: T[] = [];
    let url: string | null = path.startsWith('http')
      ? path
      : `${this.baseUrl}${path}`;
    let page = 0;

    while (url && page < maxPages) {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        await this.handleResponse(response);
      }

      const data = await response.json();
      results.push(...(Array.isArray(data) ? data : [data]));

      // Check for next page in Link header
      const linkHeader = response.headers.get('Link');
      url = this.parseNextLink(linkHeader);
      page++;
    }

    return results;
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;

    const links = linkHeader.split(',');
    for (const link of links) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        return match[1];
      }
    }
    return null;
  }
}

/**
 * Factory function to create a GitHubClient from a user's stored token
 */
export async function createGitHubClient(
  userId: string,
  prisma: { user: { findUnique: Function } }
): Promise<GitHubClient | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { githubAccessToken: true },
  });

  if (!user?.githubAccessToken) {
    return null;
  }

  return new GitHubClient(user.githubAccessToken);
}
```

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run src/lib/__tests__/github-client.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/lib/github-client.ts src/lib/__tests__/github-client.test.ts
git commit -m "feat(github): add centralized GitHub API client

- Consistent headers and authentication
- Standardized error handling with typed errors
- Pagination support
- Factory function for creating from stored token"
```

---

## Phase 3: Remove Unused Code

### Task 3.1: Delete Unused Hook File

**Files:**
- Delete: `src/hooks/use-api.ts`

**Why:** All 13 hooks in this file reference non-existent API endpoints from an old data model.

**Step 1: Verify no imports exist**

Run: `cd prototype && grep -r "from.*use-api" src/ --include="*.ts" --include="*.tsx"`
Expected: No output (no files import from use-api)

**Step 2: Delete the file**

```bash
cd prototype
rm src/hooks/use-api.ts
```

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove unused use-api.ts hooks file

All 13 hooks referenced non-existent API endpoints from old data model.
Reduces bundle size and maintenance burden."
```

---

### Task 3.2: Delete Unused Component

**Files:**
- Delete: `src/components/ai-metrics-dashboard.tsx`

**Why:** This component is never imported anywhere.

**Step 1: Verify no imports exist**

Run: `cd prototype && grep -r "ai-metrics-dashboard\|AIMetricsDashboard" src/ --include="*.ts" --include="*.tsx"`
Expected: Only the file itself appears in results

**Step 2: Delete the file**

```bash
cd prototype
rm src/components/ai-metrics-dashboard.tsx
```

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove unused AIMetricsDashboard component

Component was never imported or used. Reduces bundle size."
```

---

### Task 3.3: Remove Unused Utility Functions

**Files:**
- Modify: `src/lib/utils.ts`
- Modify: `src/core/metrics/dateUtils.ts`

**Why:** `formatDateTime`, `formatCurrency`, and `getWorkDaysBetween` are exported but never used.

**Step 1: Remove from utils.ts**

Remove `formatDateTime` and `formatCurrency` functions from `src/lib/utils.ts`.

**Step 2: Remove from dateUtils.ts**

Remove `getWorkDaysBetween` function from `src/core/metrics/dateUtils.ts`.
Also update `src/core/metrics/index.ts` to not export it.

**Step 3: Run tests to ensure no breakage**

Run: `cd prototype && pnpm test:run`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/lib/utils.ts src/core/metrics/dateUtils.ts src/core/metrics/index.ts
git commit -m "chore: remove unused utility functions

- formatDateTime (utils.ts)
- formatCurrency (utils.ts)
- getWorkDaysBetween (dateUtils.ts)"
```

---

### Task 3.4: Remove Unused Constants

**Files:**
- Modify: `src/lib/constants.ts`

**Why:** 5 constants are defined but never imported.

**Step 1: Remove unused constants**

Remove from `src/lib/constants.ts`:
- `PERIOD_TYPES`
- `MONTHS`
- `CURRENCIES`
- `REPO_STATUSES`
- `DEFAULT_RATES`

**Step 2: Verify build succeeds**

Run: `cd prototype && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
cd prototype
git add src/lib/constants.ts
git commit -m "chore: remove unused constants

Removed PERIOD_TYPES, MONTHS, CURRENCIES, REPO_STATUSES, DEFAULT_RATES"
```

---

### Task 3.5: Remove Dead Code in Analyze Route

**Files:**
- Modify: `src/app/api/orders/[id]/analyze/route.ts`

**Why:** The `calculateMetrics` function (95 lines) is defined but never called.

**Step 1: Identify the dead code**

The function is at approximately lines 40-140 in the file.

**Step 2: Remove the function**

Delete the entire `calculateMetrics` function and the unused constants:
- `DEFAULT_DAILY_RATE`
- `DEV_HOURS_PER_DAY`

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/app/api/orders/[id]/analyze/route.ts
git commit -m "chore: remove dead calculateMetrics function

95 lines of unused code removed. Metrics are now calculated by EffortDistributionService."
```

---

## Phase 4: Performance Optimizations

### Task 4.1: Fix N+1 Query in Developer Metrics

**Files:**
- Modify: `src/core/orchestration/AnalysisOrchestrator.ts`

**Why:** Current code executes N queries for N developers instead of 1 batched query.

**Step 1: Locate the problem**

In `recalculateOrderMetrics` method (around line 784):
```typescript
for (const [email, stats] of developerEfforts) {
  const commitCount = await prisma.commitAnalysis.count({
    where: { orderId: this.config.orderId, authorEmail: email },
  });
  // N queries!
}
```

**Step 2: Batch the query**

Before the loop, add:
```typescript
// Batch query for all commit counts
const commitCounts = await prisma.commitAnalysis.groupBy({
  by: ['authorEmail'],
  where: { orderId: this.config.orderId },
  _count: { commitHash: true },
});
const countByEmail = new Map(
  commitCounts.map(c => [c.authorEmail, c._count.commitHash])
);
```

Inside the loop, replace:
```typescript
const commitCount = countByEmail.get(email) || 0;
```

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/core/orchestration/AnalysisOrchestrator.ts
git commit -m "perf: fix N+1 query in developer metrics calculation

Uses groupBy to fetch all commit counts in single query instead of N queries."
```

---

### Task 4.2: Batch Repository Stats Upserts

**Files:**
- Modify: `src/core/orchestration/AnalysisOrchestrator.ts`

**Why:** Sequential upserts in a loop are slow for many repositories.

**Step 1: Locate the problem**

In `saveRepositoryStats` method (around line 1162):
```typescript
for (const metrics of this.repositoryMetrics) {
  await prisma.repositoryProcessingStats.upsert({...}); // Sequential!
}
```

**Step 2: Parallelize with Promise.all**

Replace with:
```typescript
await Promise.all(
  this.repositoryMetrics.map(metrics =>
    prisma.repositoryProcessingStats.upsert({
      where: {
        orderId_repositoryFullName: {
          orderId: this.config.orderId,
          repositoryFullName: metrics.repositoryFullName,
        },
      },
      create: { /* ... */ },
      update: { /* ... */ },
    })
  )
);
```

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/core/orchestration/AnalysisOrchestrator.ts
git commit -m "perf: parallelize repository stats upserts

Uses Promise.all instead of sequential awaits for better performance."
```

---

### Task 4.3: Add Prisma Transaction for Metrics Recalculation

**Files:**
- Modify: `src/core/orchestration/AnalysisOrchestrator.ts`

**Why:** Multi-step database operations can leave data inconsistent if any step fails.

**Step 1: Locate the problem**

In `recalculateOrderMetrics` (around lines 764-803):
```typescript
await prisma.orderMetric.deleteMany({...});
// If next operation fails, metrics are deleted but not recreated!
for (...) {
  await prisma.orderMetric.create({...});
}
await prisma.order.update({...});
```

**Step 2: Wrap in transaction**

```typescript
await prisma.$transaction(async (tx) => {
  // Delete old metrics
  await tx.orderMetric.deleteMany({
    where: { orderId: this.config.orderId },
  });

  // Create new metrics
  for (const [email, stats] of developerEfforts) {
    await tx.orderMetric.create({...});
  }

  // Update order totals
  await tx.order.update({
    where: { id: this.config.orderId },
    data: { totalCost },
  });
});
```

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/core/orchestration/AnalysisOrchestrator.ts
git commit -m "fix(db): wrap metrics recalculation in transaction

Ensures data consistency if any step fails during metrics update."
```

---

## Phase 5: Type Safety Improvements

### Task 5.1: Fix 'any' Types in Components

**Files:**
- Modify: `src/components/commit-analysis-table.tsx`
- Modify: `src/components/effort-calendar.tsx`
- Modify: `src/app/(dashboard)/demo/page.tsx`

**Why:** Using `any` defeats TypeScript's type safety.

**Step 1: Define proper types for commit-analysis-table.tsx**

At line 184, replace:
```typescript
distribution.map((d: any) => [d.commitHash, d])
```

First, ensure proper interface exists:
```typescript
interface EffortDistribution {
  commitHash: string;
  date: string;
  effortHours: number;
  // ... other fields
}
```

Then update:
```typescript
distribution.map((d: EffortDistribution) => [d.commitHash, d])
```

**Step 2: Fix effort-calendar.tsx**

Replace lines 32, 132, 147 with proper types:
```typescript
interface DayData {
  date: string;
  effortHours: number;
  commits: number;
}

// Line 32
.sort((a: DayData, b: DayData) => new Date(a.date).getTime() - new Date(b.date).getTime())
```

**Step 3: Fix demo/page.tsx**

Replace lines 321-322:
```typescript
// Instead of:
let aValue: any;
let bValue: any;

// Use proper types:
let aValue: string | number | Date;
let bValue: string | number | Date;
```

**Step 4: Run TypeScript check**

Run: `cd prototype && pnpm tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
cd prototype
git add src/components/commit-analysis-table.tsx src/components/effort-calendar.tsx src/app/(dashboard)/demo/page.tsx
git commit -m "fix(types): replace 'any' types with proper interfaces

Improves type safety in commit-analysis-table, effort-calendar, and demo page."
```

---

### Task 5.2: Fix Type Assertions in AI Engine

**Files:**
- Modify: `src/core/ai/AIAnalysisEngine.ts`

**Why:** `as any` type assertions bypass type checking.

**Step 1: Locate the assertions**

At lines 427 and 432:
```typescript
analysis: response as any,
```

**Step 2: Use Prisma JsonValue type**

```typescript
import { Prisma } from '@prisma/client';

// Replace:
analysis: response as any,
// With:
analysis: response as unknown as Prisma.JsonValue,
```

**Step 3: Run TypeScript check**

Run: `cd prototype && pnpm tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
cd prototype
git add src/core/ai/AIAnalysisEngine.ts
git commit -m "fix(types): replace 'as any' with Prisma.JsonValue

Proper typing for JSON storage in Prisma."
```

---

## Phase 6: Code Architecture Improvements (Optional)

### Task 6.1: Extract Progress Reporter from Orchestrator

**Files:**
- Create: `src/core/orchestration/ProgressReporter.ts`
- Modify: `src/core/orchestration/AnalysisOrchestrator.ts`

**Why:** AnalysisOrchestrator is 1222 lines (God Object). Extracting progress reporting reduces complexity.

**Step 1: Create ProgressReporter class**

Create `src/core/orchestration/ProgressReporter.ts`:

```typescript
import prisma from '@/lib/db';
import type { AnalysisProgress } from './types';

export class ProgressReporter {
  private currentProgress: AnalysisProgress;

  constructor(
    private orderId: string,
    private totalRepositories: number
  ) {
    this.currentProgress = {
      orderId,
      totalRepositories,
      processedRepositories: 0,
      currentRepository: '',
      totalCommits: 0,
      analyzedCommits: 0,
      failedCommits: 0,
      currentPhase: 'INITIALIZING',
      phaseProgress: 0,
      estimatedTimeRemaining: null,
      errors: [],
    };
  }

  async update(updates: Partial<AnalysisProgress>): Promise<void> {
    this.currentProgress = { ...this.currentProgress, ...updates };
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await prisma.analysisProgress.upsert({
        where: { orderId: this.orderId },
        create: this.currentProgress,
        update: this.currentProgress,
      });
    } catch (error) {
      console.error('[ProgressReporter] Failed to persist:', error);
    }
  }

  get current(): AnalysisProgress {
    return { ...this.currentProgress };
  }
}
```

**Step 2: Use in Orchestrator**

Replace direct `reportProgress` calls with:
```typescript
private progressReporter: ProgressReporter;

constructor(config: OrchestratorConfig) {
  this.progressReporter = new ProgressReporter(
    config.orderId,
    config.repositories.length
  );
}

// Replace: await this.reportProgress({...})
// With: await this.progressReporter.update({...})
```

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/core/orchestration/
git commit -m "refactor: extract ProgressReporter from AnalysisOrchestrator

First step in reducing 1222-line God Object.
Improves separation of concerns and testability."
```

---

## Summary

### Total Changes by Phase:

| Phase | Tasks | Lines Changed | Lines Removed |
|-------|-------|---------------|---------------|
| 1. Security | 2 | ~20 | ~5 |
| 2. Utilities | 5 | ~350 | ~150 |
| 3. Dead Code | 5 | 0 | ~500 |
| 4. Performance | 3 | ~50 | ~30 |
| 5. Type Safety | 2 | ~40 | ~10 |
| 6. Architecture | 1 | ~100 | ~80 |
| **Total** | **18** | **~560** | **~775** |

### Net Result:
- **~215 lines reduced** overall
- **13 unused exports removed**
- **2 security vulnerabilities fixed**
- **1 N+1 query eliminated**
- **All code duplication patterns addressed**

---

Plan complete and saved to `docs/plans/2025-12-23-codebase-audit-fixes.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
