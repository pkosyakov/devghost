# DevGhost iOS App — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a native iOS app (SwiftUI, iOS 17+) with full feature parity to the DevGhost web app, plus server-side changes for mobile auth, StoreKit billing, and push notifications.

**Architecture:** Modular MVVM via Swift Packages (Core / Features / SharedUI). Server extended with dual-auth (Bearer JWT + NextAuth cookie), App Store billing integration, and APNs push. See `docs/plans/2026-03-05-ios-app-design.md` for full design.

**Tech Stack:** Swift 5.9+, SwiftUI, iOS 17+, Swift Charts, StoreKit 2, APNs, URLSession async/await. Server: Next.js, Prisma, NextAuth v5-beta.25.

---

## Phase 1: Foundation + Auth

Server-side dual-auth and iOS project scaffolding. This phase is the critical path — everything else depends on it.

---

### Task 1.1: Add RefreshToken model to Prisma schema

**Files:**
- Modify: `packages/server/prisma/schema.prisma`

**Step 1: Add the RefreshToken model and extend CreditTransactionType**

Add after the `User` model relations block (around line 62):

```prisma
model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  tokenHash String
  deviceId  String
  expiresAt DateTime
  rotatedAt DateTime?
  createdAt DateTime  @default(now())
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([tokenHash])
}
```

Add `refreshTokens RefreshToken[]` to the `User` model relations.

Extend `CreditTransactionType` enum — add after `ADMIN_ADJUSTMENT`:
```prisma
  IAP_PURCHASE
  IAP_SUBSCRIPTION_RENEWAL
  IAP_REFUND
```

Add `AppStoreEvent` model:
```prisma
model AppStoreEvent {
  id                    String   @id @default(cuid())
  originalTransactionId String   @unique
  type                  String
  productId             String
  processedAt           DateTime @default(now())
}
```

Add optional fields to `CreditPack`:
```prisma
  appStoreProductId String? @unique
```

Add optional fields to `Subscription`:
```prisma
  appStoreProductId String? @unique
```

Add optional field to `UserSubscription`:
```prisma
  appStoreOriginalTransactionId String? @unique
```

**Step 2: Add DeviceToken model**

```prisma
model DeviceToken {
  id        String   @id @default(cuid())
  userId    String
  token     String   @unique
  platform  String
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

Add `deviceTokens DeviceToken[]` to the `User` model relations.

**Step 3: Push schema to database**

Run: `cd packages/server && pnpm db:push`
Expected: Schema changes applied successfully.

**Step 4: Generate Prisma client**

Run: `cd packages/server && pnpm db:generate`
Expected: Prisma client generated.

**Step 5: Commit**

```bash
git add packages/server/prisma/schema.prisma
git commit -m "feat(db): add RefreshToken, DeviceToken, AppStoreEvent models and iOS billing fields"
```

---

### Task 1.2: Create mobile JWT utilities

**Files:**
- Create: `packages/server/src/lib/mobile-auth.ts`
- Create: `packages/server/src/lib/__tests__/mobile-auth.test.ts`

**Step 1: Write tests for JWT and refresh token utilities**

```typescript
// packages/server/src/lib/__tests__/mobile-auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyRefreshTokenHash,
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
      const token = await generateAccessToken(payload, -1); // already expired
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
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/lib/__tests__/mobile-auth.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement mobile-auth utilities**

```typescript
// packages/server/src/lib/mobile-auth.ts
import { SignJWT, jwtVerify } from 'jose';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET || 'fallback-dev-secret'
);
const ACCESS_TOKEN_TTL = 15 * 60; // 15 minutes in seconds
const REFRESH_TOKEN_TTL_DAYS = 30;

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
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/server && pnpm test -- src/lib/__tests__/mobile-auth.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/server/src/lib/mobile-auth.ts packages/server/src/lib/__tests__/mobile-auth.test.ts
git commit -m "feat(auth): add mobile JWT and refresh token utilities with tests"
```

---

### Task 1.3: Implement dual-auth in requireUserSession

**Files:**
- Modify: `packages/server/src/lib/api-utils.ts`
- Create: `packages/server/src/lib/__tests__/api-utils-mobile.test.ts`

**Step 1: Write test for Bearer token auth path**

```typescript
// packages/server/src/lib/__tests__/api-utils-mobile.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { headers } from 'next/headers';
import { generateAccessToken } from '../mobile-auth';
import { getUserSessionFromBearer } from '../api-utils';

// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

// Mock db
vi.mock('../db', () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import { db } from '../db';

describe('getUserSessionFromBearer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no Authorization header', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers());
    const result = await getUserSessionFromBearer();
    expect(result).toBeNull();
  });

  it('returns null for non-Bearer auth', async () => {
    const h = new Headers();
    h.set('Authorization', 'Basic abc123');
    vi.mocked(headers).mockResolvedValue(h);
    const result = await getUserSessionFromBearer();
    expect(result).toBeNull();
  });

  it('returns user session for valid Bearer token', async () => {
    const token = await generateAccessToken({
      userId: 'user_123',
      email: 'test@test.com',
      role: 'USER',
    });
    const h = new Headers();
    h.set('Authorization', `Bearer ${token}`);
    vi.mocked(headers).mockResolvedValue(h);

    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: 'user_123',
      email: 'test@test.com',
      role: 'USER',
      isBlocked: false,
    } as any);

    const result = await getUserSessionFromBearer();
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe('user_123');
  });

  it('returns null for blocked user', async () => {
    const token = await generateAccessToken({
      userId: 'user_123',
      email: 'test@test.com',
      role: 'USER',
    });
    const h = new Headers();
    h.set('Authorization', `Bearer ${token}`);
    vi.mocked(headers).mockResolvedValue(h);

    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: 'user_123',
      email: 'test@test.com',
      role: 'USER',
      isBlocked: true,
    } as any);

    const result = await getUserSessionFromBearer();
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/lib/__tests__/api-utils-mobile.test.ts`
Expected: FAIL — `getUserSessionFromBearer` not exported.

**Step 3: Add Bearer auth to api-utils.ts**

Add import at top of `packages/server/src/lib/api-utils.ts`:

```typescript
import { verifyAccessToken } from './mobile-auth';
```

Add new function after the existing `getUserSession()`:

```typescript
export async function getUserSessionFromBearer(): Promise<UserSession | null> {
  try {
    const headersList = await headers();
    const authHeader = headersList.get('authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.slice(7);
    const payload = await verifyAccessToken(token);

    const user = await db.user.findUnique({
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
```

Modify existing `getUserSession()` to check Bearer first:

```typescript
export async function getUserSession(): Promise<UserSession | null> {
  // Try Bearer token first (mobile clients)
  const bearerSession = await getUserSessionFromBearer();
  if (bearerSession) {
    return bearerSession;
  }

  // Fallback to NextAuth cookie session (web clients)
  const session = await auth();
  // ...rest of existing implementation unchanged
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/server && pnpm test -- src/lib/__tests__/api-utils-mobile.test.ts`
Expected: All 4 tests PASS.

**Step 5: Run existing tests to verify no regression**

Run: `cd packages/server && pnpm test`
Expected: All existing tests still pass.

**Step 6: Commit**

```bash
git add packages/server/src/lib/api-utils.ts packages/server/src/lib/__tests__/api-utils-mobile.test.ts
git commit -m "feat(auth): add dual-auth support (Bearer JWT + NextAuth cookie) in requireUserSession"
```

---

### Task 1.4: Create mobile login endpoint

**Files:**
- Create: `packages/server/src/app/api/auth/mobile/login/route.ts`
- Create: `packages/server/src/app/api/auth/mobile/login/__tests__/route.test.ts`

**Step 1: Write tests**

```typescript
// route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));

vi.mock('@/lib/mobile-auth', () => ({
  generateAccessToken: vi.fn().mockResolvedValue('mock_access_token'),
  generateRefreshToken: vi.fn().mockReturnValue('mock_refresh_token'),
  hashRefreshToken: vi.fn().mockResolvedValue('mock_hash'),
  getRefreshTokenExpiry: vi.fn().mockReturnValue(new Date('2026-04-05')),
}));

vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));

import { POST } from '../route';
import { db } from '@/lib/db';
import bcrypt from 'bcryptjs';

describe('POST /api/auth/mobile/login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 for missing fields', async () => {
    const req = new Request('http://localhost/api/auth/mobile/login', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 for unknown email', async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(null);
    const req = new Request('http://localhost/api/auth/mobile/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@x.com', password: 'pass1234', deviceId: 'dev1' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong password', async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: 'u1', email: 'x@x.com', passwordHash: 'hash', role: 'USER', isBlocked: false,
    } as any);
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
    const req = new Request('http://localhost/api/auth/mobile/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@x.com', password: 'wrong', deviceId: 'dev1' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 for blocked user', async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: 'u1', email: 'x@x.com', passwordHash: 'hash', role: 'USER', isBlocked: true,
    } as any);
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    const req = new Request('http://localhost/api/auth/mobile/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@x.com', password: 'pass1234', deviceId: 'dev1' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns tokens for valid credentials', async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: 'u1', email: 'x@x.com', passwordHash: 'hash', role: 'USER', isBlocked: false,
    } as any);
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    vi.mocked(db.refreshToken.create).mockResolvedValue({} as any);

    const req = new Request('http://localhost/api/auth/mobile/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@x.com', password: 'pass1234', deviceId: 'dev1' }),
    });
    const res = await POST(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data.accessToken).toBe('mock_access_token');
    expect(data.data.refreshToken).toBe('mock_refresh_token');
    expect(data.data.expiresIn).toBe(900);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/app/api/auth/mobile/login`
Expected: FAIL — route not found.

**Step 3: Implement the login endpoint**

```typescript
// packages/server/src/app/api/auth/mobile/login/route.ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { apiResponse, apiError } from '@/lib/api-utils';
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiry,
} from '@/lib/mobile-auth';
import { logger } from '@/lib/logger';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { email, password, deviceId } = parsed.data;

    const user = await db.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, passwordHash: true, role: true, isBlocked: true },
    });

    if (!user || !user.passwordHash) {
      return apiError('Invalid credentials', 401);
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      return apiError('Invalid credentials', 401);
    }

    if (user.isBlocked) {
      return apiError('Account is blocked', 403);
    }

    // Invalidate existing refresh tokens for this device
    await db.refreshToken.updateMany({
      where: { userId: user.id, deviceId, rotatedAt: null },
      data: { rotatedAt: new Date() },
    });

    const accessToken = await generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = generateRefreshToken();
    const tokenHash = await hashRefreshToken(refreshToken);

    await db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        deviceId,
        expiresAt: getRefreshTokenExpiry(),
      },
    });

    // Update lastLoginAt
    db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    }).catch(() => {});

    logger.info({ userId: user.id, deviceId }, 'Mobile login successful');

    return apiResponse({
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes
    });
  } catch (err) {
    logger.error({ err }, 'Mobile login error');
    return apiError('Internal server error', 500);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/server && pnpm test -- src/app/api/auth/mobile/login`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/server/src/app/api/auth/mobile/login/
git commit -m "feat(auth): add mobile login endpoint with device-bound refresh tokens"
```

---

### Task 1.5: Create mobile refresh endpoint with rotation and reuse detection

**Files:**
- Create: `packages/server/src/app/api/auth/mobile/refresh/route.ts`

**Step 1: Implement the refresh endpoint**

```typescript
// packages/server/src/app/api/auth/mobile/refresh/route.ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiResponse, apiError } from '@/lib/api-utils';
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyRefreshTokenHash,
  getRefreshTokenExpiry,
} from '@/lib/mobile-auth';
import { logger } from '@/lib/logger';

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = refreshSchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { refreshToken, deviceId } = parsed.data;

    // Find all non-expired tokens for this device
    const candidates = await db.refreshToken.findMany({
      where: {
        deviceId,
        expiresAt: { gt: new Date() },
      },
      include: { user: { select: { id: true, email: true, role: true, isBlocked: true } } },
    });

    // Try to find a matching token
    let matchedToken = null;
    for (const candidate of candidates) {
      if (await verifyRefreshTokenHash(refreshToken, candidate.tokenHash)) {
        matchedToken = candidate;
        break;
      }
    }

    if (!matchedToken) {
      return apiError('Invalid refresh token', 401);
    }

    // REUSE DETECTION: if token was already rotated, someone is replaying it
    if (matchedToken.rotatedAt) {
      logger.warn(
        { userId: matchedToken.userId, deviceId, tokenId: matchedToken.id },
        'Refresh token reuse detected — revoking all tokens for user'
      );

      // Revoke ALL refresh tokens for this user (nuclear option)
      await db.refreshToken.updateMany({
        where: { userId: matchedToken.userId, rotatedAt: null },
        data: { rotatedAt: new Date() },
      });

      return apiError('Token reuse detected. All sessions revoked. Please login again.', 401);
    }

    const { user } = matchedToken;

    if (user.isBlocked) {
      return apiError('Account is blocked', 403);
    }

    // Rotate: mark old token as used
    await db.refreshToken.update({
      where: { id: matchedToken.id },
      data: { rotatedAt: new Date() },
    });

    // Issue new tokens
    const newRefreshToken = generateRefreshToken();
    const newTokenHash = await hashRefreshToken(newRefreshToken);

    await db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: newTokenHash,
        deviceId,
        expiresAt: getRefreshTokenExpiry(),
      },
    });

    const accessToken = await generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return apiResponse({
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
    });
  } catch (err) {
    logger.error({ err }, 'Mobile token refresh error');
    return apiError('Internal server error', 500);
  }
}
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/auth/mobile/refresh/
git commit -m "feat(auth): add mobile refresh endpoint with token rotation and reuse detection"
```

---

### Task 1.6: Create mobile logout endpoint

**Files:**
- Create: `packages/server/src/app/api/auth/mobile/logout/route.ts`

**Step 1: Implement logout**

```typescript
// packages/server/src/app/api/auth/mobile/logout/route.ts
import { db } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

export async function POST() {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;
    const { user } = result;

    // Revoke all refresh tokens for this user
    const { count } = await db.refreshToken.updateMany({
      where: { userId: user.id, rotatedAt: null },
      data: { rotatedAt: new Date() },
    });

    logger.info({ userId: user.id, revokedCount: count }, 'Mobile logout — all tokens revoked');

    return apiResponse({ success: true });
  } catch (err) {
    logger.error({ err }, 'Mobile logout error');
    return apiError('Internal server error', 500);
  }
}
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/auth/mobile/logout/
git commit -m "feat(auth): add mobile logout endpoint (revokes all refresh tokens)"
```

---

### Task 1.7: Create Xcode project with Swift Package modules

**Files:**
- Create: `packages/ios/DevGhost.xcodeproj` (via Xcode)
- Create: `packages/ios/DevGhost/DevGhostApp.swift`
- Create: `packages/ios/DevGhost/ContentView.swift`
- Create: `packages/ios/Packages/Core/Package.swift`
- Create: `packages/ios/Packages/SharedUI/Package.swift`
- Create: `packages/ios/Packages/Features/Package.swift`

> **Note:** This task requires Xcode. Create the project manually or via `xcodegen` / `tuist`.

**Step 1: Create the Xcode project**

Create a new iOS App project in Xcode:
- Product Name: `DevGhost`
- Organization Identifier: `com.devghost`
- Interface: SwiftUI
- Language: Swift
- Minimum Deployments: iOS 17.0
- Save to: `packages/ios/`

**Step 2: Create Core Swift Package**

```swift
// packages/ios/Packages/Core/Package.swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Core",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "Core", targets: ["Core"]),
    ],
    dependencies: [],
    targets: [
        .target(name: "Core", path: "Sources"),
        .testTarget(name: "CoreTests", dependencies: ["Core"], path: "Tests"),
    ]
)
```

**Step 3: Create SharedUI Swift Package**

```swift
// packages/ios/Packages/SharedUI/Package.swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SharedUI",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "SharedUI", targets: ["SharedUI"]),
    ],
    dependencies: [],
    targets: [
        .target(name: "SharedUI", path: "Sources"),
        .testTarget(name: "SharedUITests", dependencies: ["SharedUI"], path: "Tests"),
    ]
)
```

**Step 4: Create Features Swift Package**

```swift
// packages/ios/Packages/Features/Package.swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Features",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "Features", targets: ["Features"]),
    ],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../SharedUI"),
    ],
    targets: [
        .target(name: "Features", dependencies: ["Core", "SharedUI"], path: "Sources"),
        .testTarget(name: "FeaturesTests", dependencies: ["Features"], path: "Tests"),
    ]
)
```

**Step 5: Add packages as dependencies in Xcode project**

In Xcode: File → Add Package Dependencies → Add Local → select each package under `Packages/`.

**Step 6: Commit**

```bash
git add packages/ios/
git commit -m "feat(ios): scaffold Xcode project with Core, SharedUI, Features Swift Packages"
```

---

### Task 1.8: Port Ghost constants and types to Swift (Core package)

**Files:**
- Create: `packages/ios/Packages/Core/Sources/Models/GhostMetric.swift`
- Create: `packages/ios/Packages/Core/Sources/Models/OrderStatus.swift`
- Create: `packages/ios/Packages/Core/Sources/Models/AnalysisJobStatus.swift`
- Create: `packages/ios/Packages/Core/Sources/Models/Order.swift`
- Create: `packages/ios/Packages/Core/Sources/Models/User.swift`
- Create: `packages/ios/Packages/Core/Sources/Models/AnalysisProgress.swift`
- Create: `packages/ios/Packages/Core/Sources/Models/BillingModels.swift`
- Create: `packages/ios/Packages/Core/Sources/Constants/GhostConstants.swift`
- Create: `packages/ios/Packages/Core/Sources/Utils/GhostUtils.swift`
- Create: `packages/ios/Packages/Core/Tests/GhostUtilsTests.swift`

**Step 1: Write tests for Ghost utility functions**

```swift
// packages/ios/Packages/Core/Tests/GhostUtilsTests.swift
import XCTest
@testable import Core

final class GhostUtilsTests: XCTestCase {

    func testCalcGhostPercentRaw_normalCase() {
        // 30 hours over 10 days = 3.0 avg = 100%
        let result = GhostUtils.calcGhostPercentRaw(totalEffortHours: 30, actualWorkDays: 10)
        XCTAssertEqual(result, 100.0, accuracy: 0.01)
    }

    func testCalcGhostPercentRaw_zeroDays() {
        let result = GhostUtils.calcGhostPercentRaw(totalEffortHours: 10, actualWorkDays: 0)
        XCTAssertNil(result)
    }

    func testCalcGhostPercent_withShare() {
        // 15h / 10 days = 1.5 avg, share=0.5, adjusted norm = 3.0*0.5 = 1.5, ghost = 100%
        let result = GhostUtils.calcGhostPercent(totalEffortHours: 15, actualWorkDays: 10, share: 0.5)
        XCTAssertEqual(result, 100.0, accuracy: 0.01)
    }

    func testCalcGhostPercent_zeroShare() {
        let result = GhostUtils.calcGhostPercent(totalEffortHours: 15, actualWorkDays: 10, share: 0)
        XCTAssertNil(result)
    }

    func testGhostColor_excellent() {
        XCTAssertEqual(GhostUtils.ghostColor(percent: 130), .green)
    }

    func testGhostColor_good() {
        XCTAssertEqual(GhostUtils.ghostColor(percent: 105), .green)
    }

    func testGhostColor_warning() {
        XCTAssertEqual(GhostUtils.ghostColor(percent: 85), .yellow)
    }

    func testGhostColor_low() {
        XCTAssertEqual(GhostUtils.ghostColor(percent: 60), .red)
    }

    func testGhostColor_nil() {
        XCTAssertEqual(GhostUtils.ghostColor(percent: nil), .gray)
    }

    func testFormatGhostPercent() {
        XCTAssertEqual(GhostUtils.formatGhostPercent(123.456), "123%")
        XCTAssertEqual(GhostUtils.formatGhostPercent(nil), "N/A")
    }
}
```

**Step 2: Run tests to verify they fail**

Run: In Xcode, Cmd+U on CoreTests target.
Expected: FAIL — types not found.

**Step 3: Implement constants**

```swift
// packages/ios/Packages/Core/Sources/Constants/GhostConstants.swift
import Foundation

public enum GhostConstants {
    public static let norm: Double = 3.0
    public static let maxDailyEffort: Double = 5.0
    public static let maxSpreadDays: Int = 5
    public static let minWorkDaysForGhost: Int = 1
    public static let minCustomRangeDays: Int = 30

    public enum Threshold {
        public static let excellent: Double = 120
        public static let good: Double = 100
        public static let warning: Double = 80
    }
}
```

**Step 4: Implement models**

```swift
// packages/ios/Packages/Core/Sources/Models/GhostMetric.swift
import Foundation

public struct GhostMetric: Codable, Identifiable, Sendable {
    public var id: String { developerId }
    public let developerId: String
    public let developerName: String
    public let developerEmail: String
    public let periodType: PeriodType
    public let totalEffortHours: Double
    public let actualWorkDays: Int
    public let avgDailyEffort: Double
    public let ghostPercentRaw: Double
    public let ghostPercent: Double
    public let share: Double
    public let shareAutoCalculated: Bool
    public let commitCount: Int
    public let hasEnoughData: Bool
    public let overheadHours: Double?
}

public enum PeriodType: String, Codable, CaseIterable, Sendable {
    case allTime = "ALL_TIME"
    case year = "YEAR"
    case quarter = "QUARTER"
    case month = "MONTH"
    case week = "WEEK"
    case day = "DAY"

    public var isGhostEligible: Bool {
        switch self {
        case .allTime, .year, .quarter, .month: return true
        case .week, .day: return false
        }
    }
}
```

```swift
// packages/ios/Packages/Core/Sources/Models/OrderStatus.swift
import Foundation

public enum OrderStatus: String, Codable, Sendable {
    case draft = "DRAFT"
    case developersLoaded = "DEVELOPERS_LOADED"
    case readyForAnalysis = "READY_FOR_ANALYSIS"
    case processing = "PROCESSING"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case insufficientCredits = "INSUFFICIENT_CREDITS"
}
```

```swift
// packages/ios/Packages/Core/Sources/Models/AnalysisJobStatus.swift
import Foundation

public enum AnalysisJobStatus: String, Codable, Sendable {
    case pending = "PENDING"
    case running = "RUNNING"
    case llmComplete = "LLM_COMPLETE"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case failedRetryable = "FAILED_RETRYABLE"
    case failedFatal = "FAILED_FATAL"
    case cancelled = "CANCELLED"

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .failedFatal, .cancelled: return true
        default: return false
        }
    }

    public var isRetrying: Bool { self == .failedRetryable }
}
```

```swift
// packages/ios/Packages/Core/Sources/Models/Order.swift
import Foundation

public struct Order: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String?
    public let status: OrderStatus
    public let createdAt: Date
    public let completedAt: Date?
    public let metrics: OrderMetricsSummary?
}

public struct OrderMetricsSummary: Codable, Sendable {
    public let avgGhostPercent: Double?
    public let totalEffortHours: Double?
    public let totalCommitsAnalyzed: Int?
}

public struct OrderSummary: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String?
    public let status: OrderStatus
    public let avgGhostPercent: Double?
    public let developerCount: Int
    public let commitCount: Int
    public let totalWorkDays: Int
    public let createdAt: Date
    public let completedAt: Date?
}
```

```swift
// packages/ios/Packages/Core/Sources/Models/User.swift
import Foundation

public struct User: Codable, Sendable {
    public let id: String
    public let email: String
    public let role: UserRole
    public let name: String?
    public let githubUsername: String?
    public let createdAt: Date
}

public enum UserRole: String, Codable, Sendable {
    case user = "USER"
    case admin = "ADMIN"
}
```

```swift
// packages/ios/Packages/Core/Sources/Models/AnalysisProgress.swift
import Foundation

public struct AnalysisProgress: Codable, Sendable {
    public let jobId: String
    public let status: AnalysisJobStatus
    public let progress: Double
    public let currentStep: String?
    public let currentCommit: String?
    public let totalCommits: Int?
    public let startedAt: Date?
    public let eta: String?
}
```

```swift
// packages/ios/Packages/Core/Sources/Models/BillingModels.swift
import Foundation

public struct BalanceInfo: Codable, Sendable {
    public let permanent: Int
    public let subscription: Int
    public let reserved: Int
    public let available: Int
    public let subscriptionExpiresAt: Date?
}

public struct CreditPack: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let credits: Int
    public let priceUsd: Double
    public let appStoreProductId: String?
}

public struct Transaction: Codable, Identifiable, Sendable {
    public let id: String
    public let type: String
    public let amount: Int
    public let wallet: String
    public let balanceAfter: Int
    public let description: String?
    public let createdAt: Date
}
```

**Step 5: Implement utility functions**

```swift
// packages/ios/Packages/Core/Sources/Utils/GhostUtils.swift
import Foundation
import SwiftUI

public enum GhostColorValue: Sendable {
    case green, yellow, red, gray

    public var color: Color {
        switch self {
        case .green: return .green
        case .yellow: return .yellow
        case .red: return .red
        case .gray: return .gray
        }
    }
}

public enum GhostUtils {

    public static func calcGhostPercentRaw(totalEffortHours: Double, actualWorkDays: Int) -> Double? {
        guard actualWorkDays >= GhostConstants.minWorkDaysForGhost else { return nil }
        let avgDaily = totalEffortHours / Double(actualWorkDays)
        return (avgDaily / GhostConstants.norm) * 100
    }

    public static func calcGhostPercent(totalEffortHours: Double, actualWorkDays: Int, share: Double) -> Double? {
        guard actualWorkDays >= GhostConstants.minWorkDaysForGhost, share > 0 else { return nil }
        let avgDaily = totalEffortHours / Double(actualWorkDays)
        return (avgDaily / (GhostConstants.norm * share)) * 100
    }

    public static func ghostColor(percent: Double?) -> GhostColorValue {
        guard let percent else { return .gray }
        if percent >= GhostConstants.Threshold.good { return .green }
        if percent >= GhostConstants.Threshold.warning { return .yellow }
        return .red
    }

    public static func formatGhostPercent(_ percent: Double?) -> String {
        guard let percent else { return "N/A" }
        return "\(Int(percent.rounded()))%"
    }
}
```

**Step 6: Run tests to verify they pass**

Run: In Xcode, Cmd+U on CoreTests target.
Expected: All 10 tests PASS.

**Step 7: Commit**

```bash
git add packages/ios/Packages/Core/
git commit -m "feat(ios): port Ghost constants, models, and utility functions to Swift"
```

---

### Task 1.9: Implement APIClient and AuthManager (Core package)

**Files:**
- Create: `packages/ios/Packages/Core/Sources/Networking/APIClient.swift`
- Create: `packages/ios/Packages/Core/Sources/Networking/APIResponse.swift`
- Create: `packages/ios/Packages/Core/Sources/Networking/Endpoint.swift`
- Create: `packages/ios/Packages/Core/Sources/Auth/AuthManager.swift`
- Create: `packages/ios/Packages/Core/Sources/Auth/KeychainService.swift`

**Step 1: Implement API response wrapper**

```swift
// packages/ios/Packages/Core/Sources/Networking/APIResponse.swift
import Foundation

public struct APIResponse<T: Decodable>: Decodable {
    public let success: Bool
    public let data: T?
    public let error: String?
}

public enum APIError: Error, LocalizedError {
    case unauthorized
    case tokenExpired
    case serverError(String)
    case network(Error)
    case decodable(Error)
    case blocked

    public var errorDescription: String? {
        switch self {
        case .unauthorized: return "Please login again"
        case .tokenExpired: return "Session expired"
        case .serverError(let msg): return msg
        case .network(let err): return err.localizedDescription
        case .decodable(let err): return "Data parsing error: \(err.localizedDescription)"
        case .blocked: return "Account is blocked"
        }
    }
}
```

**Step 2: Implement Endpoint abstraction**

```swift
// packages/ios/Packages/Core/Sources/Networking/Endpoint.swift
import Foundation

public struct Endpoint {
    public let path: String
    public let method: HTTPMethod
    public let body: Encodable?
    public let queryItems: [URLQueryItem]?

    public init(
        path: String,
        method: HTTPMethod = .get,
        body: Encodable? = nil,
        queryItems: [URLQueryItem]? = nil
    ) {
        self.path = path
        self.method = method
        self.body = body
        self.queryItems = queryItems
    }

    public enum HTTPMethod: String {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case patch = "PATCH"
        case delete = "DELETE"
    }
}
```

**Step 3: Implement KeychainService**

```swift
// packages/ios/Packages/Core/Sources/Auth/KeychainService.swift
import Foundation
import Security

public final class KeychainService: Sendable {
    public static let shared = KeychainService()
    private init() {}

    private let service = "com.devghost.app"

    public func save(_ data: Data, for key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        SecItemDelete(query as CFDictionary)

        var addQuery = query
        addQuery[kSecValueData as String] = data

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    public func load(for key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    public func delete(for key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    public func deleteAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }

    public enum KeychainError: Error {
        case saveFailed(OSStatus)
    }
}
```

**Step 4: Implement AuthManager**

```swift
// packages/ios/Packages/Core/Sources/Auth/AuthManager.swift
import Foundation
import Observation

@Observable
public final class AuthManager {
    public private(set) var isAuthenticated = false
    public private(set) var currentUser: User?

    private let keychain = KeychainService.shared

    private enum Keys {
        static let accessToken = "accessToken"
        static let refreshToken = "refreshToken"
        static let deviceId = "deviceId"
    }

    public var accessToken: String? {
        guard let data = keychain.load(for: Keys.accessToken) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public var deviceId: String {
        if let data = keychain.load(for: Keys.deviceId),
           let id = String(data: data, encoding: .utf8) {
            return id
        }
        let newId = UUID().uuidString
        try? keychain.save(Data(newId.utf8), for: Keys.deviceId)
        return newId
    }

    public init() {
        isAuthenticated = accessToken != nil
    }

    public func saveTokens(accessToken: String, refreshToken: String) throws {
        try keychain.save(Data(accessToken.utf8), for: Keys.accessToken)
        try keychain.save(Data(refreshToken.utf8), for: Keys.refreshToken)
        isAuthenticated = true
    }

    public func getRefreshToken() -> String? {
        guard let data = keychain.load(for: Keys.refreshToken) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func logout() {
        keychain.deleteAll()
        isAuthenticated = false
        currentUser = nil
    }

    public func setUser(_ user: User) {
        currentUser = user
    }
}
```

**Step 5: Implement APIClient**

```swift
// packages/ios/Packages/Core/Sources/Networking/APIClient.swift
import Foundation

@Observable
public final class APIClient {
    private let baseURL: URL
    private let session: URLSession
    private let authManager: AuthManager
    private let decoder: JSONDecoder

    private var isRefreshing = false
    private var refreshContinuations: [CheckedContinuation<String, Error>] = []

    public init(baseURL: URL, authManager: AuthManager) {
        self.baseURL = baseURL
        self.authManager = authManager
        self.session = URLSession(configuration: .default)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)

            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = iso.date(from: dateString) { return date }

            iso.formatOptions = [.withInternetDateTime]
            if let date = iso.date(from: dateString) { return date }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(dateString)"
            )
        }
        self.decoder = decoder
    }

    public func request<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
        let response: APIResponse<T> = try await performRequest(endpoint)
        guard response.success, let data = response.data else {
            throw APIError.serverError(response.error ?? "Unknown error")
        }
        return data
    }

    public func requestVoid(_ endpoint: Endpoint) async throws {
        let response: APIResponse<EmptyData> = try await performRequest(endpoint)
        guard response.success else {
            throw APIError.serverError(response.error ?? "Unknown error")
        }
    }

    private func performRequest<T: Decodable>(_ endpoint: Endpoint) async throws -> APIResponse<T> {
        var urlComponents = URLComponents(url: baseURL.appendingPathComponent(endpoint.path), resolvingAgainstBaseURL: true)!
        urlComponents.queryItems = endpoint.queryItems

        var request = URLRequest(url: urlComponents.url!)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let token = authManager.accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body = endpoint.body {
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        let (data, urlResponse) = try await session.data(for: request)

        guard let httpResponse = urlResponse as? HTTPURLResponse else {
            throw APIError.network(URLError(.badServerResponse))
        }

        if httpResponse.statusCode == 401 {
            // Try refresh
            let newToken = try await refreshAccessToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, retryResponse) = try await session.data(for: request)

            guard let retryHttp = retryResponse as? HTTPURLResponse else {
                throw APIError.network(URLError(.badServerResponse))
            }

            if retryHttp.statusCode == 401 {
                authManager.logout()
                throw APIError.tokenExpired
            }

            return try decoder.decode(APIResponse<T>.self, from: retryData)
        }

        if httpResponse.statusCode == 403 {
            throw APIError.blocked
        }

        do {
            return try decoder.decode(APIResponse<T>.self, from: data)
        } catch {
            throw APIError.decodable(error)
        }
    }

    private func refreshAccessToken() async throws -> String {
        guard let refreshToken = authManager.getRefreshToken() else {
            authManager.logout()
            throw APIError.tokenExpired
        }

        // Mutex: if already refreshing, wait for the result
        if isRefreshing {
            return try await withCheckedThrowingContinuation { continuation in
                refreshContinuations.append(continuation)
            }
        }

        isRefreshing = true

        do {
            var urlComponents = URLComponents(url: baseURL.appendingPathComponent("/api/auth/mobile/refresh"), resolvingAgainstBaseURL: true)!
            var request = URLRequest(url: urlComponents.url!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            let body = try JSONEncoder().encode([
                "refreshToken": refreshToken,
                "deviceId": authManager.deviceId,
            ])
            request.httpBody = body

            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                authManager.logout()
                throw APIError.tokenExpired
            }

            struct RefreshResponse: Decodable {
                let success: Bool
                let data: TokenData?
                struct TokenData: Decodable {
                    let accessToken: String
                    let refreshToken: String
                }
            }

            let refreshResponse = try decoder.decode(RefreshResponse.self, from: data)
            guard let tokens = refreshResponse.data else {
                authManager.logout()
                throw APIError.tokenExpired
            }

            try authManager.saveTokens(
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken
            )

            isRefreshing = false
            for continuation in refreshContinuations {
                continuation.resume(returning: tokens.accessToken)
            }
            refreshContinuations.removeAll()

            return tokens.accessToken
        } catch {
            isRefreshing = false
            for continuation in refreshContinuations {
                continuation.resume(throwing: error)
            }
            refreshContinuations.removeAll()
            throw error
        }
    }
}

// Helper for encoding Encodable in a type-erased way
private struct AnyEncodable: Encodable {
    private let encode: (Encoder) throws -> Void

    init(_ value: Encodable) {
        self.encode = { try value.encode(to: $0) }
    }

    func encode(to encoder: Encoder) throws {
        try encode(encoder)
    }
}

private struct EmptyData: Decodable {}
```

**Step 6: Commit**

```bash
git add packages/ios/Packages/Core/Sources/
git commit -m "feat(ios): implement APIClient with auto-refresh, AuthManager with Keychain, and networking layer"
```

---

### Task 1.10: Create app shell with TabView and auth gate

**Files:**
- Modify: `packages/ios/DevGhost/DevGhostApp.swift`
- Modify: `packages/ios/DevGhost/ContentView.swift`
- Create: `packages/ios/Packages/Features/Sources/Auth/LoginView.swift`
- Create: `packages/ios/Packages/Features/Sources/Auth/RegisterView.swift`

**Step 1: Implement DevGhostApp entry point**

```swift
// packages/ios/DevGhost/DevGhostApp.swift
import SwiftUI
import Core
import Features

@main
struct DevGhostApp: App {
    @State private var authManager = AuthManager()
    @State private var apiClient: APIClient

    init() {
        let auth = AuthManager()
        let baseURL = URL(string: ProcessInfo.processInfo.environment["API_BASE_URL"] ?? "http://localhost:3000")!
        _authManager = State(initialValue: auth)
        _apiClient = State(initialValue: APIClient(baseURL: baseURL, authManager: auth))
    }

    var body: some Scene {
        WindowGroup {
            if authManager.isAuthenticated {
                ContentView()
            } else {
                LoginView()
            }
        }
        .environment(authManager)
        .environment(apiClient)
    }
}
```

**Step 2: Implement ContentView with TabView**

```swift
// packages/ios/DevGhost/ContentView.swift
import SwiftUI
import Core

struct ContentView: View {
    @Environment(AuthManager.self) private var authManager

    var body: some View {
        TabView {
            Tab("Orders", systemImage: "list.bullet.rectangle") {
                NavigationStack {
                    Text("Orders — Coming Soon")
                        .navigationTitle("Orders")
                }
            }

            Tab("Explore", systemImage: "globe") {
                NavigationStack {
                    Text("Explore — Coming Soon")
                        .navigationTitle("Explore")
                }
            }

            Tab("Billing", systemImage: "creditcard") {
                NavigationStack {
                    Text("Billing — Coming Soon")
                        .navigationTitle("Billing")
                }
            }

            Tab("Profile", systemImage: "person.circle") {
                NavigationStack {
                    Text("Profile — Coming Soon")
                        .navigationTitle("Profile")
                }
            }

            if authManager.currentUser?.role == .admin {
                Tab("Admin", systemImage: "gearshape.2") {
                    NavigationStack {
                        Text("Admin — Coming Soon")
                            .navigationTitle("Admin")
                    }
                }
            }
        }
    }
}
```

**Step 3: Implement LoginView**

```swift
// packages/ios/Packages/Features/Sources/Auth/LoginView.swift
import SwiftUI
import Core

public struct LoginView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(APIClient.self) private var apiClient

    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showRegister = false

    public init() {}

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    SecureField("Password", text: $password)
                        .textContentType(.password)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }

                Section {
                    Button(action: login) {
                        if isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Sign In")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(email.isEmpty || password.isEmpty || isLoading)
                }

                Section {
                    Button("Create Account") {
                        showRegister = true
                    }
                }
            }
            .navigationTitle("DevGhost")
            .sheet(isPresented: $showRegister) {
                RegisterView()
            }
        }
    }

    private func login() {
        isLoading = true
        errorMessage = nil

        Task {
            do {
                struct LoginBody: Encodable {
                    let email: String
                    let password: String
                    let deviceId: String
                }

                struct LoginResponse: Decodable {
                    let accessToken: String
                    let refreshToken: String
                    let expiresIn: Int
                }

                let response: LoginResponse = try await apiClient.request(Endpoint(
                    path: "/api/auth/mobile/login",
                    method: .post,
                    body: LoginBody(
                        email: email,
                        password: password,
                        deviceId: authManager.deviceId
                    )
                ))

                try authManager.saveTokens(
                    accessToken: response.accessToken,
                    refreshToken: response.refreshToken
                )
            } catch let error as APIError {
                errorMessage = error.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}
```

**Step 4: Implement RegisterView**

```swift
// packages/ios/Packages/Features/Sources/Auth/RegisterView.swift
import SwiftUI
import Core

public struct RegisterView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthManager.self) private var authManager
    @Environment(APIClient.self) private var apiClient

    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var referralCode = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    public init() {}

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    SecureField("Password", text: $password)
                        .textContentType(.newPassword)

                    SecureField("Confirm Password", text: $confirmPassword)
                        .textContentType(.newPassword)
                }

                Section("Optional") {
                    TextField("Referral Code", text: $referralCode)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }

                Section {
                    Button(action: register) {
                        if isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Create Account")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(!isFormValid || isLoading)
                }
            }
            .navigationTitle("Register")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var isFormValid: Bool {
        !email.isEmpty && password.count >= 8 && password == confirmPassword
    }

    private func register() {
        isLoading = true
        errorMessage = nil

        Task {
            do {
                struct RegisterBody: Encodable {
                    let email: String
                    let password: String
                    let referralCode: String?
                }

                struct RegisterResponse: Decodable {
                    let id: String
                    let email: String
                }

                let _: RegisterResponse = try await apiClient.request(Endpoint(
                    path: "/api/auth/register",
                    method: .post,
                    body: RegisterBody(
                        email: email,
                        password: password,
                        referralCode: referralCode.isEmpty ? nil : referralCode
                    )
                ))

                // Auto-login after registration
                struct LoginBody: Encodable {
                    let email: String
                    let password: String
                    let deviceId: String
                }

                struct LoginResponse: Decodable {
                    let accessToken: String
                    let refreshToken: String
                    let expiresIn: Int
                }

                let loginResponse: LoginResponse = try await apiClient.request(Endpoint(
                    path: "/api/auth/mobile/login",
                    method: .post,
                    body: LoginBody(
                        email: email,
                        password: password,
                        deviceId: authManager.deviceId
                    )
                ))

                try authManager.saveTokens(
                    accessToken: loginResponse.accessToken,
                    refreshToken: loginResponse.refreshToken
                )

                dismiss()
            } catch let error as APIError {
                errorMessage = error.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}
```

**Step 5: Commit**

```bash
git add packages/ios/
git commit -m "feat(ios): implement app shell with TabView, auth gate, login and register screens"
```

---

## Phase 2: Core Flow

Order management, GitHub OAuth, analysis progress, metrics display.

---

### Task 2.1: GitHub OAuth with PKCE (server endpoints)

**Files:**
- Create: `packages/server/src/app/api/github/mobile/authorize/route.ts`
- Create: `packages/server/src/app/api/github/mobile/exchange/route.ts`

Server needs two new endpoints for PKCE-based GitHub OAuth for iOS:

1. `GET /api/github/mobile/authorize` — generates state, stores code_challenge, redirects to GitHub
2. `POST /api/github/mobile/exchange` — verifies PKCE, exchanges one-time auth code for saved GitHub token

**Implementation details:**
- Store `{ state, codeChallenge, userId, expiresAt }` in a new `MobileOAuthState` table (or in-memory with TTL)
- GitHub callback redirects to universal link `https://devghost.app/github-callback?code=<one-time-code>&state=<state>`
- Exchange endpoint verifies code_verifier against stored code_challenge (S256)
- On success, saves GitHub access token to `User.githubAccessToken`

> Full implementation code is context-dependent on GitHub OAuth app configuration. Write tests for PKCE S256 verification and state management.

---

### Task 2.2: OrderListView and OrderDetailView (iOS)

**Files:**
- Create: `packages/ios/Packages/Features/Sources/Orders/OrderListView.swift`
- Create: `packages/ios/Packages/Features/Sources/Orders/OrderListViewModel.swift`
- Create: `packages/ios/Packages/Features/Sources/Orders/OrderDetailView.swift`
- Create: `packages/ios/Packages/Features/Sources/Orders/OrderDetailViewModel.swift`

Implement order list with pull-to-refresh, status badges, and KPI preview. OrderDetailView with tabbed sections (Metrics / Developers / Commits) using API endpoints `GET /api/orders` and `GET /api/orders/[id]`.

---

### Task 2.3: OrderCreateView wizard (iOS)

**Files:**
- Create: `packages/ios/Packages/Features/Sources/Orders/OrderCreateView.swift`
- Create: `packages/ios/Packages/Features/Sources/GitHub/RepoPickerView.swift`
- Create: `packages/ios/Packages/Features/Sources/Orders/PeriodConfigView.swift`

3-step wizard: repo selection → period config → confirm. Uses `GET /api/github/repos`, `GET /api/github/search`, `POST /api/orders`, `POST /api/orders/[id]/developers`, `POST /api/orders/[id]/analyze`.

---

### Task 2.4: AnalysisProgressView (iOS)

**Files:**
- Create: `packages/ios/Packages/Features/Sources/Analysis/AnalysisProgressView.swift`
- Create: `packages/ios/Packages/Features/Sources/Analysis/AnalysisProgressViewModel.swift`

Polls `GET /api/orders/[id]/progress` every 3 seconds. Displays step name, commit progress, ETA. Handles all `AnalysisJobStatus` states including retryable/fatal. Uses `Timer.publish` + `.task` modifier.

---

### Task 2.5: GhostMetricsView with KPI cards and developer table (iOS)

**Files:**
- Create: `packages/ios/Packages/Features/Sources/Metrics/GhostKPICardsView.swift`
- Create: `packages/ios/Packages/Features/Sources/Metrics/DeveloperListView.swift`
- Create: `packages/ios/Packages/Features/Sources/Metrics/DeveloperDetailView.swift`
- Create: `packages/ios/Packages/Features/Sources/Metrics/MetricsViewModel.swift`

KPI cards in `LazyVGrid(2x2)`, developer list with Ghost% and color indicator. Period selector (segmented picker). Uses `GET /api/orders/[id]/metrics?period=...`.

---

## Phase 3: Visualizations

### Task 3.1: GhostBubbleChart (Swift Charts)
### Task 3.2: GhostHeatmap (custom grid)
### Task 3.3: EffortTimeline chart
### Task 3.4: DeveloperDistribution chart
### Task 3.5: CommitListView

> Each task: create a SwiftUI view using Swift Charts (or custom grid for heatmap), wire to data from MetricsViewModel. See design document Section 5 for specifications.

---

## Phase 4: Billing & Notifications

### Task 4.1: Add AppStoreEvent and extend schema (server)
> Already done in Task 1.1 schema changes.

### Task 4.2: Implement /api/billing/ios-verify endpoint (server)

Verify JWS signed transaction via App Store Server API v2. Check `AppStoreEvent` for idempotency. Map `productId` → `CreditPack` via `appStoreProductId`. Create `CreditTransaction(type: IAP_PURCHASE)`. Create `AppStoreEvent` record.

### Task 4.3: Implement /api/billing/ios-webhook endpoint (server)

Handle App Store Server Notifications v2: `DID_RENEW`, `REFUND`, `REVOKE`. All idempotent via `AppStoreEvent.originalTransactionId`.

### Task 4.4: StoreManager (iOS)

`@Observable` class using StoreKit 2: `Product.products(for:)`, `product.purchase()`, `Transaction.updates` listener. Calls `POST /api/billing/ios-verify` after purchase, `Transaction.finish()` only after server confirmation.

### Task 4.5: BillingDashboardView (iOS)

Balance card, credit packs grid, subscription management, transaction history. Uses StoreManager + `GET /api/billing/balance`, `GET /api/billing/transactions`.

### Task 4.6: Push notifications (server + iOS)

Server: `POST /api/user/device-token`, APNs send service. iOS: request authorization, register device token, handle deep links from notifications.

---

## Phase 5: Social & Admin

### Task 5.1: ExploreGridView
### Task 5.2: PublicDashboardView + ShareView
### Task 5.3: DevProfileView
### Task 5.4: PublicationsView
### Task 5.5: ReferralView
### Task 5.6: AdminDashboardView (ADMIN only)

> Each task uses existing API endpoints. Standard SwiftUI List/Grid views with NavigationStack.

---

## Phase 6: Polish

### Task 6.1: SwiftData offline cache
### Task 6.2: Home Screen Widget (Ghost%)
### Task 6.3: Spotlight search integration
### Task 6.4: Accessibility audit
### Task 6.5: Security audit (Keychain, certificate pinning evaluation)
### Task 6.6: App Store submission preparation
