# Comprehensive Codebase Audit Fixes - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 47 issues identified in the December 24, 2025 code audit, prioritizing security, performance, and maintainability.

**Architecture:**
- Phase 1: Critical security fixes (immediate)
- Phase 2: API consistency and error handling
- Phase 3: Code duplication elimination (DRY)
- Phase 4: Performance optimizations (N+1 queries, memoization)
- Phase 5: TypeScript type safety
- Phase 6: Dead code removal
- Phase 7: React best practices

**Tech Stack:** Next.js 16, TypeScript, Prisma, React 19, Vitest

---

## Phase 1: Critical Security Fixes (Priority: IMMEDIATE)

### Task 1.1: Fix GitHub Token Authorization Header Format

**Files:**
- Modify: `src/app/api/github/period-stats/route.ts:84`

**Why:** Uses `Bearer` instead of `token` - GitHub API expects `token` format for Personal Access Tokens.

**Step 1: Locate the issue**

```typescript
// Current INCORRECT code at line 84:
headers['Authorization'] = `Bearer ${authToken}`;
```

**Step 2: Fix the authorization header**

Replace line 84:
```typescript
headers['Authorization'] = `token ${authToken}`;
```

**Step 3: Verify other GitHub API calls use correct format**

Run: `cd prototype && grep -rn "Bearer.*Token\|Bearer.*github" src/app/api/github/`
Expected: No other instances of incorrect Bearer usage

**Step 4: Commit**

```bash
cd prototype
git add src/app/api/github/period-stats/route.ts
git commit -m "fix(security): use correct 'token' auth header for GitHub API

GitHub API expects 'token <PAT>' format, not 'Bearer <PAT>'"
```

---

### Task 1.2: Add Whitelist for sortBy Parameter

**Files:**
- Modify: `src/app/api/orders/[id]/commits/route.ts:27-59`

**Why:** Direct use of user-provided `sortBy` parameter in Prisma query allows potential field enumeration.

**Step 1: Define allowed sort fields**

Add at top of file after imports:
```typescript
const ALLOWED_SORT_FIELDS = ['date', 'authorEmail', 'category', 'complexity', 'effortHours'] as const;
type SortField = typeof ALLOWED_SORT_FIELDS[number];

function isValidSortField(field: string): field is SortField {
  return ALLOWED_SORT_FIELDS.includes(field as SortField);
}
```

**Step 2: Validate sortBy parameter**

Replace lines 27-28:
```typescript
const sortByParam = url.searchParams.get('sortBy') || 'date';
const sortBy = isValidSortField(sortByParam) ? sortByParam : 'date';
```

**Step 3: Run tests**

Run: `cd prototype && pnpm test:run`
Expected: PASS

**Step 4: Commit**

```bash
cd prototype
git add src/app/api/orders/[id]/commits/route.ts
git commit -m "fix(security): add whitelist validation for sortBy parameter

Prevents enumeration of database fields through API"
```

---

### Task 1.3: Validate Repository Owner/Repo Format

**Files:**
- Modify: `src/app/api/github/repos/[owner]/[repo]/contributors/route.ts`

**Why:** No validation that owner/repo match valid GitHub format before using in URL - could allow path traversal.

**Step 1: Add validation helper**

Add after imports:
```typescript
// GitHub username: 1-39 chars, alphanumeric or hyphen, no consecutive hyphens, no start/end hyphen
// Repo name: 1-100 chars, alphanumeric, hyphen, underscore, period
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

function isValidGitHubOwner(owner: string): boolean {
  return GITHUB_OWNER_REGEX.test(owner) && !owner.includes('--');
}

function isValidGitHubRepo(repo: string): boolean {
  return GITHUB_REPO_REGEX.test(repo);
}
```

**Step 2: Add validation at route start**

After params extraction, add:
```typescript
const { owner, repo } = await params;

if (!isValidGitHubOwner(owner)) {
  return apiError('Invalid repository owner format', 400);
}
if (!isValidGitHubRepo(repo)) {
  return apiError('Invalid repository name format', 400);
}
```

**Step 3: Apply same validation to other GitHub routes**

Files to update:
- `src/app/api/github/repos/[owner]/[repo]/date-range/route.ts`
- `src/app/api/github/repos/[owner]/[repo]/route.ts`

**Step 4: Commit**

```bash
cd prototype
git add src/app/api/github/repos/
git commit -m "fix(security): validate GitHub owner/repo format before API calls

Prevents path traversal and injection attacks"
```

---

### Task 1.4: Add Max PageSize Limit

**Files:**
- Modify: `src/app/api/orders/[id]/commits/route.ts:28`

**Why:** No bounds checking on page size - user could request pageSize=999999 causing memory exhaustion.

**Step 1: Add max limit constant**

Add at top:
```typescript
const MAX_PAGE_SIZE = 500;
```

**Step 2: Apply limit**

Replace line 28:
```typescript
const pageSize = Math.min(
  parseInt(url.searchParams.get('pageSize') || '50', 10),
  MAX_PAGE_SIZE
);
```

**Step 3: Commit**

```bash
cd prototype
git add src/app/api/orders/[id]/commits/route.ts
git commit -m "fix(security): add max page size limit to prevent memory exhaustion

Caps pageSize at 500 records"
```

---

### Task 1.5: Remove clonePath from API Response

**Files:**
- Modify: `src/app/api/cache/route.ts:109-115`

**Why:** Exposing `clonePath` to frontend reveals server directory structure.

**Step 1: Remove sensitive field from response**

At lines 109-115, remove `clonePath` from the response object:
```typescript
// Before:
{
  id: clone.id,
  clonePath: clone.clonePath,  // REMOVE THIS LINE
  sizeBytes: clone.sizeBytes,
  // ...
}

// After:
{
  id: clone.id,
  sizeBytes: clone.sizeBytes,
  // ... (without clonePath)
}
```

**Step 2: Commit**

```bash
cd prototype
git add src/app/api/cache/route.ts
git commit -m "fix(security): remove clonePath from cache API response

Prevents leaking server directory structure to clients"
```

---

## Phase 2: API Consistency and Error Handling

### Task 2.1: Standardize developer-settings Route

**Files:**
- Modify: `src/app/api/orders/[id]/developer-settings/route.ts`

**Why:** Route doesn't use `apiError()`/`apiResponse()` helpers, inconsistent with other routes.

**Step 1: Import helpers**

Add at top:
```typescript
import { apiResponse, apiError, getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
```

**Step 2: Replace inline responses**

Replace line 22:
```typescript
// Before:
return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
// After:
return apiError('Unauthorized', 401);
```

Apply same pattern to lines 34, 74, 87, 100, 108, 114, 120, 174, 187.

**Step 3: Use getOrderWithAuth helper**

Replace lines 17-40 with:
```typescript
const authResult = await getOrderWithAuth(id);
if (!authResult.success) {
  return orderAuthError(authResult);
}
const { order, session } = authResult;
```

**Step 4: Commit**

```bash
cd prototype
git add src/app/api/orders/[id]/developer-settings/route.ts
git commit -m "refactor(api): standardize developer-settings route to use helpers

Consistent error responses with other API routes"
```

---

### Task 2.2: Standardize Pagination Response Format

**Files:**
- Modify: `src/app/api/github/repos/route.ts:120-125`

**Why:** Uses `perPage`/`hasNextPage` while other routes use `pageSize`/`totalPages` - inconsistent API.

**Step 1: Update response format**

Replace lines 120-125:
```typescript
// Before:
pagination: { page, perPage, hasNextPage, hasPrevPage }

// After:
pagination: {
  page,
  pageSize: perPage,
  totalPages: hasNextPage ? page + 1 : page,
  hasNextPage,
  hasPrevPage: page > 1,
}
```

**Step 2: Commit**

```bash
cd prototype
git add src/app/api/github/repos/route.ts
git commit -m "refactor(api): standardize pagination response format

Consistent with other API routes using pageSize/totalPages"
```

---

### Task 2.3: Fix N+1 Query in Cache Route

**Files:**
- Modify: `src/app/api/cache/route.ts:97-135`

**Why:** Loops through orders and uses filter() in loop - O(n*m) complexity.

**Step 1: Build Map before loop**

Replace lines 97-135:
```typescript
// Build Map for O(1) lookups
const clonesByOrder = new Map<string, typeof allClones>();
for (const clone of allClones) {
  const orderId = clone.orderId;
  if (!clonesByOrder.has(orderId)) {
    clonesByOrder.set(orderId, []);
  }
  clonesByOrder.get(orderId)!.push(clone);
}

// Now use Map in loop
for (const order of userOrders) {
  const orderClones = clonesByOrder.get(order.id) || [];
  // ... rest of processing
}
```

**Step 2: Commit**

```bash
cd prototype
git add src/app/api/cache/route.ts
git commit -m "perf(api): fix N+1 query pattern in cache route

Uses Map for O(1) lookups instead of filter() in loop"
```

---

### Task 2.4: Parallelize Repository Fetches

**Files:**
- Modify: `src/app/api/orders/[id]/developers/route.ts:287-301`

**Why:** Sequential `await` in loop for repo commits - wastes time when repos are independent.

**Step 1: Convert to Promise.all**

Replace lines 287-301:
```typescript
// Before (sequential):
for (const repo of selectedRepos) {
  const commits = await fetchRepoCommits(...);
  allCommits.push(...commits);
}

// After (parallel):
const commitPromises = selectedRepos.map(repo => fetchRepoCommits(
  repo.owner,
  repo.name,
  accessToken,
  startDate,
  endDate
));
const commitArrays = await Promise.all(commitPromises);
const allCommits = commitArrays.flat();
```

**Step 2: Commit**

```bash
cd prototype
git add src/app/api/orders/[id]/developers/route.ts
git commit -m "perf(api): parallelize repository commit fetches

Uses Promise.all instead of sequential awaits"
```

---

## Phase 3: Code Duplication Elimination (DRY)

### Task 3.1: Extract Analysis Period Handlers Hook

**Files:**
- Create: `src/hooks/use-analysis-period.ts`
- Modify: `src/components/analysis-period-selector.tsx`

**Why:** ~200 lines duplicated across 3 components (AnalysisPeriodSelector, AnalysisPeriodInline, AnalysisPeriodDisplay).

**Step 1: Create shared hook**

Create `src/hooks/use-analysis-period.ts`:
```typescript
import { useCallback, useMemo } from 'react';

export interface AnalysisPeriodState {
  mode: 'all' | 'range';
  startDate: Date | null;
  endDate: Date | null;
  minDate: Date;
  maxDate: Date;
}

export interface AnalysisPeriodHandlers {
  handleModeChange: (mode: 'all' | 'range') => void;
  handleStartDateChange: (date: Date | null) => void;
  handleEndDateChange: (date: Date | null) => void;
  handlePresetClick: (preset: { start: Date; end: Date }) => void;
  isPresetSelected: (preset: { start: Date; end: Date }) => boolean;
  yearPresets: { label: string; start: Date; end: Date }[];
  recentPresets: { label: string; start: Date; end: Date }[];
}

export function useAnalysisPeriod(
  state: AnalysisPeriodState,
  onChange: (updates: Partial<AnalysisPeriodState>) => void
): AnalysisPeriodHandlers {
  const { mode, startDate, endDate, minDate, maxDate } = state;

  const handleModeChange = useCallback((newMode: 'all' | 'range') => {
    if (newMode === 'all') {
      onChange({ mode: 'all', startDate: minDate, endDate: maxDate });
    } else {
      onChange({ mode: 'range' });
    }
  }, [minDate, maxDate, onChange]);

  const handleStartDateChange = useCallback((date: Date | null) => {
    onChange({ startDate: date });
  }, [onChange]);

  const handleEndDateChange = useCallback((date: Date | null) => {
    onChange({ endDate: date });
  }, [onChange]);

  const handlePresetClick = useCallback((preset: { start: Date; end: Date }) => {
    const clampedStart = new Date(Math.max(preset.start.getTime(), minDate.getTime()));
    const clampedEnd = new Date(Math.min(preset.end.getTime(), maxDate.getTime()));
    onChange({ mode: 'range', startDate: clampedStart, endDate: clampedEnd });
  }, [minDate, maxDate, onChange]);

  const isPresetSelected = useCallback((preset: { start: Date; end: Date }) => {
    if (mode !== 'range' || !startDate || !endDate) return false;
    const clampedStart = new Date(Math.max(preset.start.getTime(), minDate.getTime()));
    const clampedEnd = new Date(Math.min(preset.end.getTime(), maxDate.getTime()));
    return (
      startDate.getTime() === clampedStart.getTime() &&
      endDate.getTime() === clampedEnd.getTime()
    );
  }, [mode, startDate, endDate, minDate, maxDate]);

  const currentYear = new Date().getFullYear();
  const availableStartYear = minDate.getFullYear();

  const yearPresets = useMemo(() => {
    const presets = [];
    for (let year = currentYear; year >= availableStartYear; year--) {
      presets.push({
        label: year.toString(),
        start: new Date(year, 0, 1),
        end: new Date(year, 11, 31),
      });
    }
    return presets;
  }, [currentYear, availableStartYear]);

  const recentPresets = useMemo(() => [
    { label: 'Last 3 months', start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), end: new Date() },
    { label: 'Last 6 months', start: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), end: new Date() },
    { label: 'Last year', start: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), end: new Date() },
  ], []);

  return {
    handleModeChange,
    handleStartDateChange,
    handleEndDateChange,
    handlePresetClick,
    isPresetSelected,
    yearPresets,
    recentPresets,
  };
}
```

**Step 2: Refactor AnalysisPeriodSelector to use hook**

In `analysis-period-selector.tsx`, replace duplicate handler functions with:
```typescript
import { useAnalysisPeriod } from '@/hooks/use-analysis-period';

// Inside component:
const handlers = useAnalysisPeriod(
  { mode, startDate, endDate, minDate, maxDate },
  (updates) => {
    if (updates.mode !== undefined) setMode(updates.mode);
    if (updates.startDate !== undefined) setStartDate(updates.startDate);
    if (updates.endDate !== undefined) setEndDate(updates.endDate);
  }
);

// Use handlers.handleModeChange, handlers.handlePresetClick, etc.
```

**Step 3: Apply same refactor to AnalysisPeriodInline**

Remove duplicate function definitions, use the hook instead.

**Step 4: Run tests**

Run: `cd prototype && pnpm build`
Expected: Build succeeds

**Step 5: Commit**

```bash
cd prototype
git add src/hooks/use-analysis-period.ts src/components/analysis-period-selector.tsx
git commit -m "refactor: extract useAnalysisPeriod hook to eliminate duplication

Reduces ~200 lines of duplicated logic across 3 components"
```

---

### Task 3.2: Consolidate AI Provider Config

**Files:**
- Create: `src/lib/ai-providers.ts`
- Modify: `src/components/analysis-settings.tsx`
- Modify: `src/components/rerun-analysis-dialog.tsx`

**Why:** `providerInfo`, `AIProvider` type duplicated in two component files.

**Step 1: Create shared config file**

Create `src/lib/ai-providers.ts`:
```typescript
export type AIProvider = 'CLAUDE' | 'OPENAI' | 'OLLAMA' | 'OPENROUTER';
export type ProcessingMode = 'AUTO' | 'GITHUB_API' | 'LOCAL_CLONE';

export interface ProviderInfo {
  name: string;
  description: string;
  icon: string;
  requiresApiKey: boolean;
  apiKeyEnvVar?: string;
}

export const providerInfo: Record<AIProvider, ProviderInfo> = {
  CLAUDE: {
    name: 'Claude (Anthropic)',
    description: 'Best quality analysis, recommended for production',
    icon: '🧠',
    requiresApiKey: true,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  },
  OPENAI: {
    name: 'GPT-4 (OpenAI)',
    description: 'Fast and reliable, good balance of speed and quality',
    icon: '🤖',
    requiresApiKey: true,
    apiKeyEnvVar: 'OPENAI_API_KEY',
  },
  OLLAMA: {
    name: 'Ollama (Local)',
    description: 'Free, runs locally, requires Ollama installation',
    icon: '🦙',
    requiresApiKey: false,
  },
  OPENROUTER: {
    name: 'OpenRouter',
    description: 'Access to multiple models via single API',
    icon: '🔀',
    requiresApiKey: true,
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
  },
};

export const processingModeInfo: Record<ProcessingMode, { name: string; description: string }> = {
  AUTO: {
    name: 'Auto',
    description: 'Automatically choose best method based on repository size',
  },
  GITHUB_API: {
    name: 'GitHub API',
    description: 'Fetch commits via GitHub API (faster for small repos)',
  },
  LOCAL_CLONE: {
    name: 'Local Clone',
    description: 'Clone repository locally (better for large repos)',
  },
};
```

**Step 2: Update analysis-settings.tsx**

Replace lines 72-133 with import:
```typescript
import { AIProvider, ProcessingMode, providerInfo, processingModeInfo } from '@/lib/ai-providers';
```

Remove local type and object definitions.

**Step 3: Update rerun-analysis-dialog.tsx**

Same as step 2 - import from shared file.

**Step 4: Commit**

```bash
cd prototype
git add src/lib/ai-providers.ts src/components/analysis-settings.tsx src/components/rerun-analysis-dialog.tsx
git commit -m "refactor: consolidate AI provider config to shared module

Eliminates duplication between analysis-settings and rerun-analysis-dialog"
```

---

### Task 3.3: Consolidate DeveloperGroup Interface

**Files:**
- Modify: `src/components/developer-group.tsx`
- Modify: `src/lib/deduplication.ts`

**Why:** `DeveloperGroup` interface defined in both files.

**Step 1: Keep single definition in deduplication.ts**

Ensure `src/lib/deduplication.ts` exports the interface:
```typescript
export interface DeveloperGroup {
  id: string;
  developers: Developer[];
  primary: Developer;
  suggested: boolean;
}
```

**Step 2: Remove duplicate from developer-group.tsx**

Remove lines 13-22 (the interface definition) and import from deduplication:
```typescript
import { DeveloperGroup } from '@/lib/deduplication';
```

**Step 3: Commit**

```bash
cd prototype
git add src/components/developer-group.tsx src/lib/deduplication.ts
git commit -m "refactor: consolidate DeveloperGroup interface to single source

Removed duplicate definition from developer-group.tsx"
```

---

## Phase 4: Performance Optimizations

### Task 4.1: Add React.memo to List Components

**Files:**
- Modify: `src/components/developer-card.tsx`
- Modify: `src/components/developer-group.tsx`
- Modify: `src/components/inline-edit-cell.tsx`
- Modify: `src/components/excluded-developers-section.tsx`

**Why:** Components rendered in lists re-render unnecessarily when parent updates.

**Step 1: Wrap DeveloperCard with React.memo**

In `developer-card.tsx`, change:
```typescript
// Before:
export function DeveloperCard({ ... }: DeveloperCardProps) {

// After:
import { memo } from 'react';

function DeveloperCardComponent({ ... }: DeveloperCardProps) {
  // ... existing implementation
}

export const DeveloperCard = memo(DeveloperCardComponent);
```

**Step 2: Apply same pattern to other components**

Repeat for:
- `developer-group.tsx` → `DeveloperGroupCard`
- `inline-edit-cell.tsx` → `InlineEditCell`
- `excluded-developers-section.tsx` → `ExcludedDevelopersSection`

**Step 3: Add displayName for debugging**

After each memo:
```typescript
DeveloperCard.displayName = 'DeveloperCard';
```

**Step 4: Commit**

```bash
cd prototype
git add src/components/developer-card.tsx src/components/developer-group.tsx src/components/inline-edit-cell.tsx src/components/excluded-developers-section.tsx
git commit -m "perf(react): add React.memo to list-rendered components

Prevents unnecessary re-renders in developer lists and tables"
```

---

### Task 4.2: Add useCallback to Table Handlers

**Files:**
- Modify: `src/components/commit-analysis-table.tsx:142-169`

**Why:** `toggleRow` and `toggleExpand` functions recreated on every render.

**Step 1: Wrap with useCallback**

Replace lines 142-152:
```typescript
const toggleRow = useCallback((id: string) => {
  setExpandedRows(prev => {
    const next = new Set(prev);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    return next;
  });
}, []);
```

Apply same pattern to `toggleExpand` at lines 159-169.

**Step 2: Commit**

```bash
cd prototype
git add src/components/commit-analysis-table.tsx
git commit -m "perf(react): memoize table toggle handlers with useCallback"
```

---

## Phase 5: TypeScript Type Safety

### Task 5.1: Replace 'any' Types in Git Strategies

**Files:**
- Modify: `src/core/git/GitAnalysisEngine.ts:120`
- Modify: `src/core/git/strategies/ConservativeStrategy.ts:116`
- Modify: `src/core/git/strategies/PaginationStrategy.ts:133,150`
- Modify: `src/core/git/strategies/MetadataStrategy.ts:119,136`
- Modify: `src/core/git/strategies/GraphQLStrategy.ts:187`

**Why:** `any` type defeats TypeScript's type safety.

**Step 1: Create GitHub API response types**

Create `src/core/git/types/github-api.ts`:
```typescript
export interface GitHubCommitFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GitHubCommitAuthor {
  name: string;
  email: string;
  date: string;
}

export interface GitHubCommitResponse {
  sha: string;
  commit: {
    author: GitHubCommitAuthor;
    committer: GitHubCommitAuthor;
    message: string;
  };
  author: { login: string } | null;
  committer: { login: string } | null;
  files?: GitHubCommitFile[];
  stats?: {
    additions: number;
    deletions: number;
    total: number;
  };
}

export interface GitHubRepositoryMetadata {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  size: number;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
}
```

**Step 2: Update GitAnalysisEngine.ts**

Replace line 120:
```typescript
// Before:
files: (data.files || []).map((file: any) => ({

// After:
import { GitHubCommitFile } from './types/github-api';
files: (data.files || []).map((file: GitHubCommitFile) => ({
```

**Step 3: Update all Strategy classes**

Apply similar changes to:
- `ConservativeStrategy.ts:116` → use `GitHubCommitResponse`
- `PaginationStrategy.ts:133,150` → use `GitHubCommitResponse`, `GitHubRepositoryMetadata`
- `MetadataStrategy.ts:119,136` → use same types
- `GraphQLStrategy.ts:187` → use `GitHubRepositoryMetadata`

**Step 4: Run TypeScript check**

Run: `cd prototype && pnpm tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
cd prototype
git add src/core/git/
git commit -m "fix(types): replace 'any' with proper GitHub API types

Adds GitHubCommitResponse, GitHubRepositoryMetadata interfaces"
```

---

### Task 5.2: Add Return Types to Hook Functions

**Files:**
- Modify: `src/hooks/use-toast.ts:25,129,138,199`

**Why:** Missing return type annotations reduce code clarity.

**Step 1: Add return types**

```typescript
// Line 25
function genId(): string {

// Line 129
function dispatch(action: Action): void {

// Line 138
function toast({ ...props }: Toast): string {

// Line 199
function useToast(): {
  toast: typeof toast;
  dismiss: (toastId?: string) => void;
  toasts: ToasterToast[];
} {
```

**Step 2: Commit**

```bash
cd prototype
git add src/hooks/use-toast.ts
git commit -m "fix(types): add return type annotations to toast hook functions"
```

---

## Phase 6: Dead Code Removal

### Task 6.1: Remove Unused Config Functions

**Files:**
- Modify: `src/lib/config.ts`

**Why:** 4 functions exported but never imported anywhere.

**Step 1: Verify no usages**

Run:
```bash
cd prototype
grep -rn "getProviderFromEnum\|getProcessingModeFromEnum\|validateConfig\|logConfigSummary" src/ --include="*.ts" --include="*.tsx" | grep -v "config.ts"
```
Expected: No output

**Step 2: Remove unused functions**

Remove functions at lines:
- 212-215: `getProviderFromEnum()`
- 221-225: `getProcessingModeFromEnum()`
- 230-287: `validateConfig()`
- 292-325: `logConfigSummary()`

**Step 3: Run build**

Run: `cd prototype && pnpm build`
Expected: Build succeeds

**Step 4: Commit**

```bash
cd prototype
git add src/lib/config.ts
git commit -m "chore: remove 4 unused functions from config.ts

Removed getProviderFromEnum, getProcessingModeFromEnum, validateConfig, logConfigSummary"
```

---

### Task 6.2: Remove Unused Badge Helper

**Files:**
- Modify: `src/lib/badge-helpers.tsx:58`

**Why:** `getDeviationBadgeVariant()` exported but never used.

**Step 1: Verify no usages**

Run:
```bash
cd prototype
grep -rn "getDeviationBadgeVariant" src/ --include="*.ts" --include="*.tsx" | grep -v "badge-helpers.tsx"
```
Expected: No output

**Step 2: Remove function**

Remove `getDeviationBadgeVariant` function (approximately lines 58-70).

**Step 3: Commit**

```bash
cd prototype
git add src/lib/badge-helpers.tsx
git commit -m "chore: remove unused getDeviationBadgeVariant function"
```

---

## Phase 7: React Best Practices

### Task 7.1: Implement Error Boundary

**Files:**
- Modify: `src/components/error-boundary.tsx` (if exists) or Create
- Modify: `src/app/(dashboard)/layout.tsx`

**Why:** Error boundary exists but isn't used - any component error crashes entire page.

**Step 1: Verify/create error boundary component**

If `error-boundary.tsx` exists, verify it's properly implemented:
```typescript
'use client';

import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-4 border border-red-300 bg-red-50 rounded-lg">
          <h2 className="text-lg font-semibold text-red-800">Something went wrong</h2>
          <p className="text-sm text-red-600 mt-2">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

**Step 2: Add to dashboard layout**

In `src/app/(dashboard)/layout.tsx`:
```typescript
import { ErrorBoundary } from '@/components/error-boundary';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="...">
      <Sidebar />
      <main>
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </main>
    </div>
  );
}
```

**Step 3: Commit**

```bash
cd prototype
git add src/components/error-boundary.tsx src/app/(dashboard)/layout.tsx
git commit -m "feat(react): implement error boundary in dashboard layout

Prevents component errors from crashing entire page"
```

---

### Task 7.2: Add ARIA Labels to Interactive Elements

**Files:**
- Modify: `src/components/developer-card.tsx:76-82`
- Modify: `src/components/commit-analysis-table.tsx:472-479`
- Modify: `src/app/(dashboard)/orders/[id]/page.tsx:1751-1765`

**Why:** Missing accessibility labels for screen readers.

**Step 1: Add aria-label to radio input**

In `developer-card.tsx`, replace lines 76-82:
```typescript
<input
  type="radio"
  checked={isSelected}
  onChange={() => onSelect?.(developer.email)}
  className="..."
  aria-label={`Select ${developer.name || developer.email} as primary`}
/>
```

**Step 2: Add aria-label to expand buttons**

In `commit-analysis-table.tsx` at line 473:
```typescript
<Button
  variant="ghost"
  size="sm"
  onClick={() => toggleExpand(commit.commitHash)}
  aria-label={expanded ? 'Collapse details' : 'Expand details'}
  aria-expanded={expanded}
>
```

**Step 3: Add aria-sort to table headers**

In `orders/[id]/page.tsx`, add to sortable column headers:
```typescript
<th
  onClick={() => handleSort('email')}
  role="columnheader"
  aria-sort={sortColumn === 'email' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
  className="cursor-pointer"
>
```

**Step 4: Commit**

```bash
cd prototype
git add src/components/developer-card.tsx src/components/commit-analysis-table.tsx src/app/(dashboard)/orders/[id]/page.tsx
git commit -m "a11y: add ARIA labels to interactive elements

Improves screen reader support for radio inputs, expand buttons, and sortable tables"
```

---

## Summary

### Total Changes by Phase:

| Phase | Tasks | Files Modified | Lines Changed | Lines Removed |
|-------|-------|----------------|---------------|---------------|
| 1. Critical Security | 5 | 6 | ~60 | ~10 |
| 2. API Consistency | 4 | 4 | ~80 | ~40 |
| 3. DRY Refactoring | 3 | 7 | ~150 | ~200 |
| 4. Performance | 2 | 5 | ~30 | ~20 |
| 5. Type Safety | 2 | 8 | ~100 | ~15 |
| 6. Dead Code | 2 | 2 | 0 | ~80 |
| 7. React Best Practices | 2 | 4 | ~50 | ~5 |
| **Total** | **20** | **~36** | **~470** | **~370** |

### Net Result:
- **~100 lines reduction** overall
- **5 security vulnerabilities fixed**
- **3 N+1 query patterns eliminated**
- **~200 lines of duplicate code removed**
- **8 `any` types replaced with proper types**
- **4 unused functions removed**
- **Error boundary implemented**
- **Accessibility improved**

---

**Plan complete and saved to `docs/plans/2025-12-24-comprehensive-audit-fixes.md`.**

**Two execution options:**

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
