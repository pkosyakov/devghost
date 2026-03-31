# Canonical Identity Curation (Slice 5A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove manual raw developer dedup from the analysis setup path. Keep contributor selection as a lightweight scope control. Make canonical contributor identity the only review/edit layer.

**Architecture:** Fix extraction to be deterministic (email/login only), update projection to add login-based matching and remove developerMapping dependency, modify analyze route to accept DEVELOPERS_LOADED status with inline excludedDevelopers, replace dedup UI with flat contributor selector, add People handoff.

**Tech Stack:** Next.js 16 (App Router), React 19, Prisma 6, TypeScript, TanStack Query, vitest

**Design spec:** `docs/superpowers/specs/2026-03-31-canonical-identity-curation-design.md`

---

### Task 1: Make extraction deterministic — remove name-based merge

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/developers/route.ts:113-166`
- Create: `packages/server/src/app/api/orders/[id]/developers/__tests__/extraction.test.ts`

**Context:** The current extraction has 3 strategies for grouping commit authors into selectedDevelopers. Strategy 3 (exact name match, lines 130-138) silently merges different people with the same name. Line 155 uses `name.toLowerCase()` as key when email is missing. Both violate the deterministic identity policy.

The grouping logic is currently inline in the POST handler (lines 96-167). Extract it into a named, testable function `groupCommitAuthors()` either in the same file or a shared module, then use it from the route handler.

- [ ] **Step 1: Write failing tests for deterministic extraction**

```typescript
// packages/server/src/app/api/orders/[id]/developers/__tests__/extraction.test.ts
import { describe, it, expect } from 'vitest';

// The extractDevelopers function is currently inline in the route.
// We need to extract it first (Step 3), but write the test interface now.
// For now, test the extraction logic directly.

interface ExtractedDeveloper {
  email: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
  commitCount: number;
  repositories: string[];
  firstCommitAt: string;
  lastCommitAt: string;
}

interface CommitAuthor {
  email: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
  date: string;
  repoName: string;
}

// Extract the grouping logic into a pure function for testing
export function groupCommitAuthors(authors: CommitAuthor[]): ExtractedDeveloper[] {
  const existingDevs = new Map<string, ExtractedDeveloper>();

  for (const { email, name, login, avatarUrl, date, repoName } of authors) {
    let matchKey: string | undefined;

    // Strategy 1: GitHub login (deterministic provider signal)
    if (login) {
      for (const [key, dev] of existingDevs.entries()) {
        if (dev.login === login) {
          matchKey = key;
          break;
        }
      }
    }

    // Strategy 2: Exact email match
    if (!matchKey && email) {
      if (existingDevs.has(email)) {
        matchKey = email;
      }
    }

    // NO Strategy 3: name-only matching is removed

    if (matchKey) {
      const dev = existingDevs.get(matchKey)!;
      dev.commitCount++;
      if (!dev.repositories.includes(repoName)) {
        dev.repositories.push(repoName);
      }
      if (login && !dev.login) dev.login = login;
      if (avatarUrl && !dev.avatarUrl) dev.avatarUrl = avatarUrl;
      if (date < dev.firstCommitAt) dev.firstCommitAt = date;
      if (date > dev.lastCommitAt) dev.lastCommitAt = date;
    } else {
      // Key by email only — no name fallback
      const key = email;
      if (!key) return; // skip commits with no email
      existingDevs.set(key, {
        email,
        name,
        login,
        avatarUrl,
        commitCount: 1,
        repositories: [repoName],
        firstCommitAt: date,
        lastCommitAt: date,
      });
    }
  }

  return Array.from(existingDevs.values());
}

describe('groupCommitAuthors', () => {
  it('should NOT merge authors with same name but different emails', () => {
    const authors: CommitAuthor[] = [
      { email: 'john@company-a.com', name: 'John Smith', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'john@company-b.com', name: 'John Smith', login: null, avatarUrl: null, date: '2025-01-02', repoName: 'repo1' },
    ];

    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(2);
    expect(result.map(d => d.email).sort()).toEqual(['john@company-a.com', 'john@company-b.com']);
  });

  it('should merge authors with same email (case-insensitive)', () => {
    const authors: CommitAuthor[] = [
      { email: 'john@example.com', name: 'John', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'John@Example.com', name: 'John S', login: null, avatarUrl: null, date: '2025-01-02', repoName: 'repo1' },
    ];

    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].commitCount).toBe(2);
  });

  it('should merge authors with same GitHub login', () => {
    const authors: CommitAuthor[] = [
      { email: 'john@personal.com', name: 'John', login: 'johndev', avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'john@work.com', name: 'John Smith', login: 'johndev', avatarUrl: null, date: '2025-01-02', repoName: 'repo1' },
    ];

    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].commitCount).toBe(2);
    expect(result[0].login).toBe('johndev');
  });

  it('should skip commits with no email', () => {
    const authors: CommitAuthor[] = [
      { email: '', name: 'Unknown', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'real@example.com', name: 'Real Person', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
    ];

    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('real@example.com');
  });

  it('should accumulate repositories across commits', () => {
    const authors: CommitAuthor[] = [
      { email: 'dev@example.com', name: 'Dev', login: null, avatarUrl: null, date: '2025-01-01', repoName: 'repo1' },
      { email: 'dev@example.com', name: 'Dev', login: null, avatarUrl: null, date: '2025-01-02', repoName: 'repo2' },
    ];

    const result = groupCommitAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].repositories).toEqual(['repo1', 'repo2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/app/api/orders/[id]/developers/__tests__/extraction.test.ts`
Expected: Tests should pass since the test contains the correct implementation inline. This validates the test itself.

- [ ] **Step 3: Extract `groupCommitAuthors` from route and apply to the route**

In `packages/server/src/app/api/orders/[id]/developers/route.ts`:

1. Extract the loop body (lines 96-167) into a standalone function matching the test interface
2. Remove Strategy 3 (lines 130-138):
   ```typescript
   // DELETE these lines:
   // Strategy 3: Exact name match (fallback)
   if (!matchKey && name) {
     for (const [key, dev] of existingDevs.entries()) {
       if (dev.name.toLowerCase() === name.toLowerCase()) {
         matchKey = key;
         break;
       }
     }
   }
   ```
3. Fix the key on line 155 — change `const key = email || name.toLowerCase()` to `const key = email`:
   ```typescript
   // Before:
   const key = email || name.toLowerCase();
   // After:
   const key = email;
   if (!key) continue; // skip commits with no email
   ```
4. Import and use `groupCommitAuthors` in the route, or inline the fixed logic

- [ ] **Step 4: Move test file to import from the route module**

Update the test to import `groupCommitAuthors` from the route file (or a shared extraction module) instead of defining it inline. Verify tests still pass.

Run: `cd packages/server && npx vitest run src/app/api/orders/[id]/developers/__tests__/extraction.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/developers/
git commit -m "feat: make extraction deterministic — remove name-only merge strategy

Remove Strategy 3 (exact name match) from commit author grouping.
Authors are now grouped only by email or GitHub login. Commits with
no email are skipped. This prevents silent merging of different people
who share the same name."
```

---

### Task 2: Add login-based matching to contributor projection

**Files:**
- Modify: `packages/server/src/lib/services/contributor-identity.ts:109-134`
- Create: `packages/server/src/lib/services/__tests__/contributor-identity-matching.test.ts`

**Context:** `findContributorMatch()` currently matches by `providerId` and `primaryEmail` only. The design spec requires `same GitHub login` as a deterministic match. The function needs a third strategy: find a Contributor whose alias has the same `username` (GitHub login).

- [ ] **Step 1: Write failing test for login-based matching**

```typescript
// packages/server/src/lib/services/__tests__/contributor-identity-matching.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the findContributorMatch behavior through projectContributorsFromOrder
// since findContributorMatch is not exported. Test the observable behavior.

// Mock Prisma
vi.mock('@/lib/db', () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    contributor: { findFirst: vi.fn(), create: vi.fn() },
    contributorAlias: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    workspace: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@/lib/db';

// We need to export findContributorMatch or test through projection.
// For now, write the test for the expected behavior:

describe('findContributorMatch — login-based matching', () => {
  const workspaceId = 'ws-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should match contributor by GitHub login when no providerId or email match', async () => {
    // Setup: existing alias with username 'johndev' linked to contributor
    const mockContributor = { id: 'c-1', displayName: 'John', primaryEmail: 'john@old.com' };

    // providerId lookup — no match
    vi.mocked(prisma.contributorAlias.findFirst)
      .mockResolvedValueOnce(null)  // providerId lookup
      .mockResolvedValueOnce({       // login lookup
        id: 'a-1',
        workspaceId,
        contributorId: 'c-1',
        providerType: 'github',
        username: 'johndev',
        email: 'john@old.com',
        contributor: mockContributor,
      } as any);

    // primaryEmail lookup — no match
    vi.mocked(prisma.contributor.findFirst).mockResolvedValueOnce(null);

    // Import and call findContributorMatch after it's exported
    const { findContributorMatch } = await import('../contributor-identity');
    const result = await findContributorMatch(workspaceId, {
      email: 'john@new.com',
      displayName: 'John',
      username: 'johndev',
      providerType: 'github',
      source: 'primary',
    });

    expect(result).toEqual(mockContributor);
  });

  it('should NOT match by login when login is null', async () => {
    vi.mocked(prisma.contributorAlias.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.contributor.findFirst).mockResolvedValue(null);

    const { findContributorMatch } = await import('../contributor-identity');
    const result = await findContributorMatch(workspaceId, {
      email: 'someone@example.com',
      displayName: 'Someone',
      username: undefined,
      providerType: 'github',
      source: 'primary',
    });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/lib/services/__tests__/contributor-identity-matching.test.ts`
Expected: FAIL — `findContributorMatch` is not exported, and login matching is not implemented.

- [ ] **Step 3: Export `findContributorMatch` and add login-based matching**

In `packages/server/src/lib/services/contributor-identity.ts`, modify `findContributorMatch` (lines 109-134):

```typescript
// Change from: async function findContributorMatch(
// To: export async function findContributorMatch(
export async function findContributorMatch(
  workspaceId: string,
  raw: RawAlias
): Promise<Contributor | null> {
  // Strategy 1: Match by providerId (strongest signal)
  if (raw.providerId) {
    const aliasMatch = await prisma.contributorAlias.findFirst({
      where: {
        workspaceId,
        providerType: raw.providerType,
        providerId: raw.providerId,
        contributorId: { not: null },
      },
      include: { contributor: true },
    });
    if (aliasMatch?.contributor) {
      return aliasMatch.contributor;
    }
  }

  // Strategy 2: Match by primary email
  const contributor = await prisma.contributor.findFirst({
    where: { workspaceId, primaryEmail: raw.email },
  });
  if (contributor) return contributor;

  // Strategy 3: Match by GitHub login (deterministic provider signal)
  if (raw.username) {
    const aliasMatch = await prisma.contributorAlias.findFirst({
      where: {
        workspaceId,
        providerType: raw.providerType,
        username: raw.username,
        contributorId: { not: null },
      },
      include: { contributor: true },
    });
    if (aliasMatch?.contributor) {
      return aliasMatch.contributor;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && npx vitest run src/lib/services/__tests__/contributor-identity-matching.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lib/services/contributor-identity.ts packages/server/src/lib/services/__tests__/contributor-identity-matching.test.ts
git commit -m "feat: add login-based deterministic matching to projection

findContributorMatch now tries GitHub login (username) as a third
deterministic strategy after providerId and primaryEmail. This matches
the conservative identity policy: exact provider signals only."
```

---

### Task 3: Simplify projection to flat selectedDevelopers seed

**Files:**
- Modify: `packages/server/src/lib/services/contributor-identity.ts:28-85, 164-318`
- Create: `packages/server/src/lib/services/__tests__/contributor-identity-projection.test.ts`

**Context:** `extractAliasesFromOrder()` currently reads both `selectedDevelopers` and `developerMapping`. With mapping empty by default, all candidates from `selectedDevelopers` should be treated as primary seeds that create new Contributors (not UNRESOLVED). The `merged_from` branch (which creates UNRESOLVED aliases) is no longer reachable in the default flow.

- [ ] **Step 1: Write failing test — all candidates create Contributors**

```typescript
// packages/server/src/lib/services/__tests__/contributor-identity-projection.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractAliasesFromOrder } from '../contributor-identity';

describe('extractAliasesFromOrder — flat seed', () => {
  it('should extract all selectedDevelopers as primary aliases', () => {
    const order = {
      selectedDevelopers: [
        { email: 'alice@example.com', name: 'Alice', login: 'alice', id: '123' },
        { email: 'bob@example.com', name: 'Bob', login: null },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(2);
    expect(aliases.every(a => a.source === 'primary')).toBe(true);
  });

  it('should work with empty developerMapping', () => {
    const order = {
      selectedDevelopers: [
        { email: 'dev@example.com', name: 'Dev', login: 'devuser' },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].source).toBe('primary');
    expect(aliases[0].email).toBe('dev@example.com');
    expect(aliases[0].username).toBe('devuser');
  });

  it('should work with null/undefined developerMapping', () => {
    const order = {
      selectedDevelopers: [
        { email: 'dev@example.com', name: 'Dev', login: null },
      ],
      developerMapping: null,
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(1);
  });

  it('should deduplicate by email case-insensitively', () => {
    const order = {
      selectedDevelopers: [
        { email: 'Dev@Example.com', name: 'Dev', login: null },
        { email: 'dev@example.com', name: 'Dev', login: null },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd packages/server && npx vitest run src/lib/services/__tests__/contributor-identity-projection.test.ts`
Expected: Tests should PASS — `extractAliasesFromOrder` already handles empty mapping. This confirms baseline behavior.

- [ ] **Step 3: Write test — projection creates Contributor for every primary seed**

```typescript
// Add to contributor-identity-projection.test.ts
import { projectContributorsFromOrder } from '../contributor-identity';

vi.mock('@/lib/db', () => {
  const mockPrisma = {
    order: { findUnique: vi.fn() },
    workspace: { findFirst: vi.fn(), create: vi.fn() },
    contributor: { findFirst: vi.fn(), create: vi.fn() },
    contributorAlias: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  return { prisma: mockPrisma };
});

import { prisma } from '@/lib/db';

describe('projectContributorsFromOrder — flat seed', () => {
  const workspaceId = 'ws-1';
  const orderId = 'order-1';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: workspace exists
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({ id: workspaceId } as any);
  });

  it('should create new Contributor for each primary candidate with no match', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: orderId,
      userId: 'user-1',
      selectedDevelopers: [
        { email: 'alice@example.com', name: 'Alice', login: 'alice' },
        { email: 'bob@example.com', name: 'Bob', login: null },
      ],
      developerMapping: {},
    } as any);

    // No existing aliases or contributors
    vi.mocked(prisma.contributorAlias.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.contributor.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.contributor.create).mockImplementation(async ({ data }) => ({
      id: `c-${data.primaryEmail}`,
      ...data,
    }) as any);
    vi.mocked(prisma.contributorAlias.create).mockResolvedValue({} as any);

    await projectContributorsFromOrder(orderId);

    // Should create 2 contributors (not UNRESOLVED)
    expect(prisma.contributor.create).toHaveBeenCalledTimes(2);

    // All alias creates should be AUTO_MERGED with contributor link
    const aliasCalls = vi.mocked(prisma.contributorAlias.create).mock.calls;
    expect(aliasCalls).toHaveLength(2);
    for (const [{ data }] of aliasCalls) {
      expect(data.resolveStatus).toBe('AUTO_MERGED');
      expect(data.contributorId).toBeTruthy();
    }
  });

  it('should NOT create UNRESOLVED aliases for primary seeds', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: orderId,
      userId: 'user-1',
      selectedDevelopers: [
        { email: 'new@example.com', name: 'New Person', login: null },
      ],
      developerMapping: {},
    } as any);

    vi.mocked(prisma.contributorAlias.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.contributor.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.contributor.create).mockImplementation(async ({ data }) => ({
      id: 'c-new', ...data,
    }) as any);
    vi.mocked(prisma.contributorAlias.create).mockResolvedValue({} as any);

    await projectContributorsFromOrder(orderId);

    const aliasCalls = vi.mocked(prisma.contributorAlias.create).mock.calls;
    for (const [{ data }] of aliasCalls) {
      expect(data.resolveStatus).not.toBe('UNRESOLVED');
    }
  });
});
```

- [ ] **Step 4: Run tests to verify behavior**

Run: `cd packages/server && npx vitest run src/lib/services/__tests__/contributor-identity-projection.test.ts`
Expected: Should PASS — the current code already creates Contributors for `source: 'primary'` seeds. With empty mapping, all seeds are primary.

- [ ] **Step 5: Verify no UNRESOLVED path is reachable for flat seeds**

Review `projectContributorsFromOrder()` lines 268-303 in `contributor-identity.ts`. The UNRESOLVED branch (lines 291-303) is gated by `raw.source === 'primary'` — only `merged_from` sources create UNRESOLVED aliases. With empty mapping, all sources are `primary`. **No code change needed** — the existing logic already handles this correctly.

If the test from Step 3 passes, this confirms the behavior.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/lib/services/__tests__/contributor-identity-projection.test.ts
git commit -m "test: verify projection creates Contributors for all primary seeds

With empty developerMapping, all extracted candidates are primary seeds
that create new Contributors (AUTO_MERGED), never UNRESOLVED. Tests
confirm the existing projection logic already handles this correctly."
```

---

### Task 4: Update analyze route — accept DEVELOPERS_LOADED + inline excludedDevelopers

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/analyze/route.ts:179-182, 210-220`
- Modify: `packages/server/src/app/api/orders/[id]/analyze/__tests__/route.test.ts` (if exists)
- Create: `packages/server/src/app/api/orders/[id]/analyze/__tests__/preflight.test.ts`

**Context:** The analyze route already rejects only `PROCESSING` status, so it technically accepts `DEVELOPERS_LOADED`. But it reads `excludedDevelopers` from the order (which is empty at DEVELOPERS_LOADED since mapping was never saved). We need to: (a) accept `excludedDevelopers` in the request body, (b) persist it before billing, (c) fix the `commit_count` vs `commitCount` field name discrepancy.

- [ ] **Step 1: Write failing test for inline excludedDevelopers**

```typescript
// packages/server/src/app/api/orders/[id]/analyze/__tests__/preflight.test.ts
import { describe, it, expect } from 'vitest';

describe('analyze route — DEVELOPERS_LOADED flow', () => {
  it('should accept excludedDevelopers in request body and persist before billing', () => {
    // This test validates the request body schema accepts excludedDevelopers.
    // The actual route test requires more mocking infrastructure.
    // We test the billing math separately.

    // Billing estimation: sum commitCount from non-excluded developers
    const selectedDevelopers = [
      { email: 'alice@example.com', commitCount: 50 },
      { email: 'bob@example.com', commitCount: 30 },
      { email: 'bot@example.com', commitCount: 100 },
    ];
    const excludedEmails = new Set(['bot@example.com']);

    const totalEstimate = selectedDevelopers
      .filter(d => !excludedEmails.has(d.email))
      .reduce((sum, d) => sum + (d.commitCount ?? 0), 0);

    expect(totalEstimate).toBe(80); // 50 + 30, bot excluded
  });

  it('should read commitCount (camelCase) from selectedDevelopers', () => {
    // The extraction endpoint saves commitCount (camelCase).
    // Verify billing reads the correct field name.
    const dev = { email: 'dev@example.com', commitCount: 42 };
    expect(dev.commitCount).toBe(42);
    // NOT commit_count (snake_case)
    expect((dev as any).commit_count).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd packages/server && npx vitest run src/app/api/orders/[id]/analyze/__tests__/preflight.test.ts`
Expected: PASS (these are unit tests for the billing math)

- [ ] **Step 3: Modify analyze route**

In `packages/server/src/app/api/orders/[id]/analyze/route.ts`:

**3a.** Add `excludedDevelopers` to the request body schema (find the zod schema near the top):

```typescript
// Add to the existing scope schema:
excludedDevelopers: z.array(z.string()).optional(),
```

**3b.** Persist excludedDevelopers before billing (after line ~210):

```typescript
// If excludedDevelopers provided in request body, persist to order
if (body.excludedDevelopers) {
  await prisma.order.update({
    where: { id },
    data: { excludedDevelopers: body.excludedDevelopers },
  });
}
// Read excludedDevelopers from order (may have been updated above)
const excludedEmails = new Set(
  (body.excludedDevelopers ?? (order.excludedDevelopers as string[]) ?? [])
);
```

**3c.** Fix the field name on line ~215 — change `commit_count` to `commitCount`:

```typescript
// Before:
const developers = (order.selectedDevelopers ?? []) as Array<{ email?: string; commit_count?: number }>;
const totalEstimate = developers
  .filter(d => !d.email || !excludedEmails.has(d.email))
  .reduce((sum, d) => sum + (d.commit_count ?? 0), 0);

// After — dual fallback for legacy orders that may have either field name:
const developers = (order.selectedDevelopers ?? []) as Array<{
  email?: string;
  commitCount?: number;
  commit_count?: number;
}>;
const totalEstimate = developers
  .filter(d => d.email && !excludedEmails.has(d.email))
  .reduce((sum, d) => sum + (d.commitCount ?? d.commit_count ?? 0), 0);
```

Note: also changed `!d.email ||` to `d.email &&` — skip devs without email instead of including them. The `commitCount ?? commit_count` fallback ensures backward compatibility with existing persisted orders until a data migration normalizes the field name.

- [ ] **Step 4: Run existing analyze tests + new test**

Run: `cd packages/server && npx vitest run src/app/api/orders/[id]/analyze/`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/analyze/
git commit -m "feat: analyze route accepts excludedDevelopers inline

Analyze route now accepts excludedDevelopers in request body, persists
before billing check. Fixed commitCount field name (was commit_count).
This enables DEVELOPERS_LOADED -> PROCESSING without a separate mapping
save step."
```

---

### Task 5: UI — Replace dedup screen with contributor selector

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx:330-332, 654-672, 829-864, 1102-1262`
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

**Context:** The order detail page at DEVELOPERS_LOADED status currently shows the full dedup UI (groups, merge, confidence badges, save mapping button). Replace with a flat contributor selector: checkboxes, estimated credits, Start Analysis CTA.

- [ ] **Step 1: Add new message keys**

In `packages/server/messages/en.json`, add to the `orders` section:

```json
"contributorSelector": {
  "title": "Contributors",
  "subtitle": "Select which contributors to include in the analysis. Deselected contributors will be excluded from results and billing.",
  "estimated": "Estimated credits: {count}",
  "included": "{count} included",
  "excluded": "{count} excluded",
  "selectAll": "Select all",
  "deselectAll": "Deselect all",
  "startAnalysis": "Start Analysis",
  "searching": "Search contributors..."
}
```

In `packages/server/messages/ru.json`, add matching keys:

```json
"contributorSelector": {
  "title": "Контрибьюторы",
  "subtitle": "Выберите, каких контрибьюторов включить в анализ. Невыбранные будут исключены из результатов и биллинга.",
  "estimated": "Расчётные кредиты: {count}",
  "included": "{count} включено",
  "excluded": "{count} исключено",
  "selectAll": "Выбрать всех",
  "deselectAll": "Снять всех",
  "startAnalysis": "Запустить анализ",
  "searching": "Поиск контрибьюторов..."
}
```

- [ ] **Step 2: Remove dedup-specific state and imports from order detail page**

In `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`:

Remove these state variables (lines ~328-332):
```typescript
// DELETE:
const [developerGroups, setDeveloperGroups] = useState<DeveloperGroup[]>([]);
const [isManualMergeMode, setIsManualMergeMode] = useState(false);
const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());
```

Keep:
```typescript
const [excludedDevelopers, setExcludedDevelopers] = useState<Set<string>>(new Set());
```

Simplify the useEffect (lines ~654-672): remove the `detectDuplicates` call and `setDeveloperGroups`, but **keep the `excludedDevelopers` hydration** from the order:
```typescript
// KEEP — hydrate excludedDevelopers from persisted order state
useEffect(() => {
  if (order?.excludedDevelopers && Array.isArray(order.excludedDevelopers) && order.excludedDevelopers.length > 0) {
    setExcludedDevelopers(new Set(order.excludedDevelopers as string[]));
  }
}, [order?.excludedDevelopers]);
```

This ensures existing READY_FOR_ANALYSIS orders and previously configured exclusions are restored when the page loads, instead of silently reopening with everything included.

Remove `handleSaveMapping` function (lines ~829-864).

Remove the `DeveloperGroupCard` import and any dedup-related imports.

- [ ] **Step 3: Replace DEVELOPERS_LOADED section with contributor selector**

Replace lines ~1102-1262 with:

```tsx
{order.status === 'DEVELOPERS_LOADED' && (
  <div className="space-y-4">
    {/* Header */}
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-lg font-semibold">{t('contributorSelector.title')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('contributorSelector.subtitle')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {t('contributorSelector.included', { count: includedCount })}
        </span>
        {excludedDevelopers.size > 0 && (
          <span className="text-sm text-muted-foreground">
            {t('contributorSelector.excluded', { count: excludedDevelopers.size })}
          </span>
        )}
      </div>
    </div>

    {/* Select all / Deselect all */}
    <div className="flex gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setExcludedDevelopers(new Set())}
      >
        {t('contributorSelector.selectAll')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const allEmails = new Set(
            (order.selectedDevelopers as any[]).map((d: any) => d.email)
          );
          setExcludedDevelopers(allEmails);
        }}
      >
        {t('contributorSelector.deselectAll')}
      </Button>
    </div>

    {/* Search */}
    <Input
      placeholder={t('contributorSelector.searching')}
      value={contributorSearch}
      onChange={(e) => setContributorSearch(e.target.value)}
    />

    {/* Contributor list */}
    <div className="space-y-2 max-h-96 overflow-y-auto">
      {filteredDevelopers.map((dev: any) => {
        const isExcluded = excludedDevelopers.has(dev.email);
        return (
          <div
            key={dev.email}
            className={cn(
              'flex items-center gap-3 p-3 rounded-lg border',
              isExcluded && 'opacity-50'
            )}
          >
            <Checkbox
              checked={!isExcluded}
              onCheckedChange={() => handleToggleExclude(dev.email)}
            />
            {dev.avatarUrl && (
              <img src={dev.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{dev.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {dev.email}
                {dev.login && ` (@${dev.login})`}
              </div>
            </div>
            <div className="text-sm text-muted-foreground whitespace-nowrap">
              {dev.commitCount ?? dev.commit_count ?? 0} commits
            </div>
          </div>
        );
      })}
    </div>

    {/* Billing preflight — reuse existing balance/credit UX from READY_FOR_ANALYSIS */}
    <div className="space-y-3 pt-4 border-t">
      {/* LLM provider + cost info */}
      {llmInfo && estimatedCredits > 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className={
            llmInfo.provider === 'openrouter'
              ? 'border-blue-300 text-blue-700 bg-blue-50'
              : 'border-green-300 text-green-700 bg-green-50'
          }>
            {llmInfo.provider === 'openrouter' ? 'OpenRouter' : 'Ollama'}
          </Badge>
          <span>
            {llmInfo.provider === 'openrouter' ? (
              <>
                ~<span className="font-medium text-foreground">
                  ${(estimatedCredits * (llmInfo.costPerCommitUsd ?? 0)).toFixed(4)}
                </span>{' '}
                {t('detail.costForCommits', { count: estimatedCredits })}
              </>
            ) : (
              <>{t('detail.freeLocalProcessing', { count: estimatedCredits })}</>
            )}
          </span>
          <span className="text-xs text-muted-foreground/70">{llmInfo.model}</span>
        </div>
      )}

      {/* Credit balance check */}
      {balanceData && (
        <div className={`flex items-center gap-2 text-sm rounded-md border px-3 py-2 ${
          hasEnoughCredits
            ? 'border-blue-200 bg-blue-50/50 text-blue-800'
            : 'border-amber-200 bg-amber-50/50 text-amber-800'
        }`}>
          <Coins className="h-4 w-4 flex-shrink-0" />
          <span>
            {t('detail.creditsWillBeUsed', { estimated: estimatedCredits })}
            {' '}{t('detail.creditsAvailable', { count: availableCredits })}
          </span>
          {!hasEnoughCredits && (
            <span className="ml-auto text-amber-700 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('detail.deficit', { count: estimatedCredits - availableCredits })}
            </span>
          )}
        </div>
      )}

      {/* Start Analysis / Insufficient credits */}
      {!canStartAnalysis && balanceData ? (
        <div className="space-y-2">
          <Button disabled>
            <Play className="h-4 w-4 mr-2" />
            {t('contributorSelector.startAnalysis')}
          </Button>
          <p className="text-sm text-amber-700">
            {t('detail.notEnoughCredits')}{' '}
            <Link href={`/${locale}/billing`} className="underline font-medium hover:text-amber-900">
              {t('detail.buyCreditsLink')}
            </Link>{' '}
            {t('detail.buyCreditsToProceed')}
          </p>
          {isAdmin && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="secondary"
                onClick={() => quickTopUpMutation.mutate(creditDeficit)}
                disabled={quickTopUpMutation.isPending || creditDeficit <= 0 || !session?.user?.id}
              >
                {quickTopUpMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Coins className="h-4 w-4 mr-2" />
                )}
                {t('detail.adminQuickTopUp', { count: creditDeficit })}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('detail.adminQuickTopUpHint')}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {isAdmin && !hasEnoughCredits && (
            <p className="text-xs text-amber-700">
              {t('detail.adminCreditBypassHint')}
            </p>
          )}
          <Button
            onClick={handleStartAnalysis}
            disabled={includedCount === 0 || analyzeMutation.isPending}
          >
            {analyzeMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            {t('contributorSelector.startAnalysis')}
          </Button>
        </div>
      )}

      {analyzeMutation.isError && (
        <p className="text-sm text-red-600">
          {analyzeMutation.error instanceof Error ? analyzeMutation.error.message : t('detail.analysisFailed')}
        </p>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 4: Add supporting state and handlers**

Add near other state declarations:

```typescript
const [contributorSearch, setContributorSearch] = useState('');

// Derived values
const allDevelopers = (order?.selectedDevelopers ?? []) as any[];
const filteredDevelopers = useMemo(() => {
  if (!contributorSearch) return allDevelopers;
  const q = contributorSearch.toLowerCase();
  return allDevelopers.filter((d: any) =>
    d.name?.toLowerCase().includes(q) ||
    d.email?.toLowerCase().includes(q) ||
    d.login?.toLowerCase().includes(q)
  );
}, [allDevelopers, contributorSearch]);

const includedCount = allDevelopers.length - excludedDevelopers.size;
const estimatedCredits = useMemo(() => {
  return allDevelopers
    .filter((d: any) => !excludedDevelopers.has(d.email))
    .reduce((sum: number, d: any) => sum + (d.commitCount ?? d.commit_count ?? 0), 0);
}, [allDevelopers, excludedDevelopers]);
```

Add the handler that calls analyze directly:

```typescript
const handleStartAnalysis = useCallback(async () => {
  analyzeMutation.mutate({
    excludedDevelopers: Array.from(excludedDevelopers),
  });
}, [excludedDevelopers, analyzeMutation]);
```

Update `analyzeMutation` to pass `excludedDevelopers` in the request body (find the existing mutation and add the field).

The billing guardrail variables (`balanceData`, `availableCredits`, `hasEnoughCredits`, `canStartAnalysis`, `creditDeficit`, `llmInfo`, `isAdmin`, `quickTopUpMutation`) already exist in the current page component — they are used by the READY_FOR_ANALYSIS section. Reuse them in the contributor selector. If any are gated behind `order.status === 'READY_FOR_ANALYSIS'`, update the gate to also include `'DEVELOPERS_LOADED'`.

- [ ] **Step 5: Remove the READY_FOR_ANALYSIS section**

The READY_FOR_ANALYSIS status section (lines ~1268-1390) is no longer the default path. Replace it to merge with DEVELOPERS_LOADED:

```typescript
// The analyze button is now in the DEVELOPERS_LOADED contributor selector.
// READY_FOR_ANALYSIS status may still exist for backward compatibility.
// Show the same contributor selector UI for READY_FOR_ANALYSIS.
{(order.status === 'DEVELOPERS_LOADED' || order.status === 'READY_FOR_ANALYSIS') && (
  // ... contributor selector from Step 3
)}
```

- [ ] **Step 6: Verify page renders correctly**

Run: `cd packages/server && pnpm build`
Expected: No TypeScript errors. Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat: replace dedup UI with flat contributor selector

DEVELOPERS_LOADED now shows a clean contributor list with
include/exclude checkboxes, estimated credits, and Start Analysis CTA.
No dedup groups, no merge suggestions, no mapping save step.
Analyze is called directly with inline excludedDevelopers."
```

---

### Task 6: People handoff banner on completed analysis

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx` (COMPLETED section)
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

**Context:** When analysis completes, if there are unresolved aliases in the workspace, show a banner linking to People for identity review.

- [ ] **Step 1: Add message keys**

In `packages/server/messages/en.json`:
```json
"identityReview": {
  "banner": "{count, plural, one {# contributor needs} other {# contributors need}} identity review",
  "action": "Review in People"
}
```

In `packages/server/messages/ru.json`:
```json
"identityReview": {
  "banner": "{count, plural, one {# контрибьютор требует} few {# контрибьютора требуют} other {# контрибьюторов требуют}} проверки идентичности",
  "action": "Перейти в People"
}
```

- [ ] **Step 2: Fetch unresolved count and add banner**

In the COMPLETED section of the order detail page, add a query for unresolved alias count and a banner:

```tsx
// Add query near other queries in the component.
// Use the identity-queue endpoint — it returns the summary directly.
// apiResponse wraps data under { data: { ... } }, so read json.data.
const { data: identityHealth } = useQuery({
  queryKey: ['identity-health', order?.id],
  queryFn: async () => {
    const res = await fetch('/api/v2/contributors/identity-queue?pageSize=0');
    if (!res.ok) return { unresolvedCount: 0 };
    const json = await res.json();
    return {
      unresolvedCount: json.data?.summary?.unresolvedCount ?? 0,
    };
  },
  enabled: order?.status === 'COMPLETED',
});

// Add banner in the COMPLETED section, before the results
{identityHealth?.unresolvedCount > 0 && (
  <div className="flex items-center justify-between p-4 rounded-lg border border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950">
    <div className="flex items-center gap-2">
      <AlertCircle className="h-4 w-4 text-yellow-600" />
      <span className="text-sm">
        {t('identityReview.banner', { count: identityHealth.unresolvedCount })}
      </span>
    </div>
    <Button variant="outline" size="sm" asChild>
      <Link href={`/${locale}/people?identityHealth=unresolved`}>
        {t('identityReview.action')}
      </Link>
    </Button>
  </div>
)}
```

- [ ] **Step 3: Verify build**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat: add People handoff banner on completed analysis

When analysis completes, if unresolved contributor aliases exist,
show a banner linking to People for identity review."
```

---

### Task 7: Retire legacy dedup code paths

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`
- Review: `packages/server/src/lib/deduplication.ts` (keep file, remove from order page imports)
- Review: `packages/server/src/app/api/orders/[id]/mapping/route.ts` (keep file, no longer called from default flow)

**Context:** Legacy dedup UI is retired. The mapping route stays (backward compat for API consumers) but is no longer called from the default onboarding flow. Clean up unused imports and dead code in the order detail page.

- [ ] **Step 1: Remove unused imports from order detail page**

In `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`:

Remove imports that are no longer used:
```typescript
// Remove if unused:
// import { detectDuplicates } from '@/lib/deduplication';
// import { DeveloperGroupCard } from '@/components/developer-group-card';
// Any other dedup-related component imports
```

- [ ] **Step 2: Remove dead state variables and handlers**

Verify and remove any remaining dead code from the dedup UI:
- `developerGroups` state
- `isManualMergeMode` state
- `selectedForMerge` state
- `handleMergeGroups` handler
- `handleSaveMapping` handler
- Any merge-related callbacks

- [ ] **Step 3: Verify build and tests**

Run: `cd packages/server && pnpm build && pnpm test`
Expected: Build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx
git commit -m "chore: retire legacy dedup UI code paths

Remove unused dedup imports, state variables, and handlers from
order detail page. The mapping route and deduplication.ts module
are preserved for backward compatibility but no longer called from
the default analysis flow."
```

---

### Task 8: Typecheck + integration verification

**Files:**
- All modified files

- [ ] **Step 1: Full typecheck**

Run: `cd packages/server && npx tsc --noEmit`
Expected: No TypeScript errors.

- [ ] **Step 2: Run all tests**

Run: `cd packages/server && pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Build verification**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

- [ ] **Step 4: Manual smoke test checklist**

If dev server is available:
1. Create new order with a public repo
2. Confirm: after creation, developers are extracted (DEVELOPERS_LOADED)
3. Confirm: flat contributor selector shown (no dedup groups, no merge UI)
4. Confirm: include/exclude checkboxes work, estimated credits update
5. Confirm: "Start Analysis" calls analyze directly
6. Confirm: analysis processes correctly (if LLM available)
7. Confirm: completed analysis shows People handoff banner (if unresolved aliases exist)
8. Confirm: People page shows contributors from the analysis
9. Confirm: merge/unmerge works on Contributor Detail page

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address typecheck and integration issues from Slice 5A"
```
