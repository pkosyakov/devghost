# Explore Search v2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the REST-only explore search pipeline with a two-phase GraphQL pre-filter + REST enrichment pipeline that returns 6-10 results instead of 0.

**Architecture:** Phase 1 uses a single GraphQL query to fetch 100 repos with `mentionableUsers.totalCount` and `history(since:).totalCount` for cheap in-memory pre-filtering. Phase 2 enriches only the ~15 surviving candidates via REST `/stats/*` endpoints for exact metrics. SSE streaming unchanged.

**Tech Stack:** Next.js App Router (SSE via `ReadableStream`), GitHub GraphQL API v4 (raw `fetch`), GitHub REST API v3, existing `ExploreTab` component (minimal changes).

**Design doc:** `docs/plans/2026-02-22-explore-search-v2-design.md`

---

## Task 1: Add GraphQL helper to search route

**Files:**
- Modify: `packages/server/src/app/api/github/search/route.ts`

**Step 1: Add GraphQL query constant and types**

At the top of `route.ts`, after existing GitHub API type definitions, add:

```typescript
// ── GraphQL types ────────────────────────────────────────────

const EXPLORE_GRAPHQL_QUERY = `
query ExploreSearch($query: String!, $since: GitTimestamp!) {
  rateLimit { cost remaining resetAt }
  search(query: $query, type: REPOSITORY, first: 100) {
    repositoryCount
    nodes {
      ... on Repository {
        databaseId
        nameWithOwner
        name
        description
        url
        stargazerCount
        forkCount
        isArchived
        isFork
        primaryLanguage { name }
        pushedAt
        createdAt
        updatedAt
        diskUsage
        defaultBranchRef {
          name
          target {
            ... on Commit {
              history { totalCount }
              recent: history(since: $since) { totalCount }
            }
          }
        }
        mentionableUsers(first: 1) { totalCount }
        owner {
          login
          avatarUrl
        }
      }
    }
  }
}`;

interface GQLRepo {
  databaseId: number;
  nameWithOwner: string;
  name: string;
  description: string | null;
  url: string;
  stargazerCount: number;
  forkCount: number;
  isArchived: boolean;
  isFork: boolean;
  primaryLanguage: { name: string } | null;
  pushedAt: string;
  createdAt: string;
  updatedAt: string;
  diskUsage: number;
  defaultBranchRef: {
    name: string;
    target: {
      history: { totalCount: number };
      recent: { totalCount: number };
    };
  } | null;
  mentionableUsers: { totalCount: number };
  owner: { login: string; avatarUrl: string };
}

interface GQLSearchResponse {
  data: {
    rateLimit: { cost: number; remaining: number; resetAt: string };
    search: {
      repositoryCount: number;
      nodes: (GQLRepo | null)[];
    };
  };
  errors?: Array<{ message: string }>;
}
```

**Step 2: Add `graphqlSearch` function**

After the `ghFetch` helper:

```typescript
/** Phase 1: GraphQL search with mentionableUsers + recent commit count.
 *  Returns null if no token (GraphQL requires auth) or on any error. */
async function graphqlSearch(
  searchQuery: string,
  token: string | null,
): Promise<GQLRepo[] | null> {
  // GraphQL API requires authentication — no unauthenticated access
  if (!token) {
    logger.info('No GitHub token — skipping GraphQL, using REST fallback');
    return null;
  }

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'DevGhost',
    'Authorization': `bearer ${token}`,
  };

  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: EXPLORE_GRAPHQL_QUERY,
        variables: { query: searchQuery, since },
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'GraphQL search failed, will fallback to REST');
      return null;
    }

    const json: GQLSearchResponse = await res.json();

    if (json.errors?.length) {
      logger.warn({ errors: json.errors }, 'GraphQL search returned errors');
      return null;
    }

    logger.info(
      { cost: json.data.rateLimit.cost, remaining: json.data.rateLimit.remaining },
      'GraphQL search completed'
    );

    // Filter out nulls (deleted repos) and forks that slipped through
    return json.data.search.nodes.filter(
      (n): n is GQLRepo => n !== null && !n.isFork && !n.isArchived
    );
  } catch (err) {
    logger.warn({ err }, 'GraphQL search threw, will fallback to REST');
    return null;
  }
}
```

**Step 3: Add `preFilterCandidates` function**

```typescript
/** Pre-filter GraphQL results by mentionableUsers and recent commits */
function preFilterCandidates(
  repos: GQLRepo[],
  minContributors: number,
  maxContributors: number,
  minActivityScore: number,
): GQLRepo[] {
  // mentionableUsers over-counts (includes watchers, issue participants).
  // Use wide tolerance: lower bound -1, upper bound × 3.
  const mentionableMin = Math.max(1, minContributors - 1);
  const mentionableMax = maxContributors * 3;

  // recentCommits proxy: minActivityScore commits/week × ~13 weeks × 0.5 (merge commit buffer)
  const minRecentCommits = Math.max(1, Math.floor(minActivityScore * 13 * 0.5));

  return repos.filter((repo) => {
    const mentionable = repo.mentionableUsers.totalCount;
    if (mentionable < mentionableMin || mentionable > mentionableMax) return false;

    // Empty repos or repos without default branch
    if (!repo.defaultBranchRef?.target) return false;

    const recentCommits = repo.defaultBranchRef.target.recent.totalCount;
    if (recentCommits < minRecentCommits) return false;

    return true;
  });
}
```

**Step 4: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: No errors in `route.ts`

**Step 5: Commit**

```bash
git add packages/server/src/app/api/github/search/route.ts
git commit -m "feat(explore-v2): add GraphQL search + preFilter helpers"
```

---

## Task 2: Rewrite SSE pipeline to use two-phase approach

**Files:**
- Modify: `packages/server/src/app/api/github/search/route.ts`

**Step 1: Replace the `ReadableStream` body in `GET` handler**

Replace the entire `const stream = new ReadableStream({ ... })` block (lines ~245-468) with the new two-phase pipeline. The surrounding code (param parsing, token fetching, search query building) stays the same.

Add `fork:false` to the search query construction (after `archived:false`):

```typescript
  let searchQuery = `${q} pushed:>${pushedAfter} fork:false archived:false sort:${sort}`;
```

Replace the stream:

```typescript
  const MAX_ENRICH = 15;  // Cap REST enrichment to limit API calls

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseEvent(event, data)));

      try {
        // ── Phase 1: GraphQL Search + Pre-Filter ─────────────────
        send('phase', { phase: 'searching', query: searchQuery });

        const gqlRepos = await graphqlSearch(searchQuery, token);

        let candidates: Array<{
          gql: GQLRepo;
          fullName: string;
        }>;

        if (gqlRepos !== null) {
          // GraphQL succeeded — pre-filter
          const prefiltered = preFilterCandidates(
            gqlRepos, minContributors, maxContributors, minActivityScore
          );

          send('phase', {
            phase: 'prefiltering',
            total: gqlRepos.length,
            candidates: prefiltered.length,
          });

          candidates = prefiltered
            .slice(0, MAX_ENRICH)
            .map((r) => ({ gql: r, fullName: r.nameWithOwner }));
        } else {
          // GraphQL failed — fallback to REST search (top 10)
          logger.info('Falling back to REST search');
          const searchRes = await ghFetch(
            `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=${sort}&order=desc&per_page=10`,
            token, limits, true
          );

          if (!searchRes.ok) {
            const remaining = searchRes.headers.get('X-RateLimit-Remaining');
            if (remaining === '0') {
              const reset = searchRes.headers.get('X-RateLimit-Reset');
              const retryAfter = reset
                ? Math.max(0, parseInt(reset) - Math.floor(Date.now() / 1000))
                : 60;
              send('error', { index: -1, fullName: '', error: 'rate_limited', progress: `retryAfter:${retryAfter}` });
            } else {
              send('error', { index: -1, fullName: '', error: `search_failed:${searchRes.status}`, progress: '0/0' });
            }
            send('done', { shown: 0, skipped: 0, errors: 1, total: 0 });
            controller.close();
            return;
          }

          const searchData: GHSearchResponse = await searchRes.json();
          // Convert REST results to candidate format.
          // REST search response includes default_branch — preserve it.
          candidates = searchData.items.map((item) => ({
            gql: {
              databaseId: item.id,
              nameWithOwner: item.full_name,
              name: item.name,
              description: item.description,
              url: item.html_url,
              stargazerCount: item.stargazers_count,
              forkCount: 0,
              isArchived: false,
              isFork: false,
              primaryLanguage: item.language ? { name: item.language } : null,
              pushedAt: item.pushed_at,
              createdAt: item.created_at,
              updatedAt: item.updated_at,
              diskUsage: item.size,
              defaultBranchRef: {
                name: item.default_branch,
                target: { history: { totalCount: 0 }, recent: { totalCount: 0 } },
              },
              mentionableUsers: { totalCount: 0 },
              owner: { login: item.owner.login, avatarUrl: item.owner.avatar_url },
            } satisfies GQLRepo,
            fullName: item.full_name,
          }));
        }

        const total = candidates.length;

        if (total === 0) {
          send('done', { shown: 0, skipped: 0, errors: 0, total: 0 });
          controller.close();
          return;
        }

        // ── Phase 2: REST Enrichment ──────────────────────────────
        send('phase', { phase: 'enriching', total });

        let shown = 0;
        let skipped = 0;
        let errors = 0;

        for (let i = 0; i < total; i += 3) {
          const batch = candidates.slice(i, Math.min(i + 3, total));

          if (limits.coreRemaining < batch.length * 3) {
            for (let j = i; j < total; j++) {
              skipped++;
              send('skip', {
                index: j,
                fullName: candidates[j].fullName,
                reason: 'rate_limit_budget',
                progress: `${j + 1}/${total}`,
              });
            }
            break;
          }

          await Promise.allSettled(
            batch.map(async (candidate, batchIdx) => {
              const idx = i + batchIdx;
              const { gql, fullName } = candidate;

              try {
                const [contribCount, actScore, ftStats] = await Promise.all([
                  getContributorsCount(fullName, token, limits),
                  getActivityScore(fullName, token, limits),
                  getFullTimeStats(fullName, token, limits),
                ]);

                const contributorsCount = contribCount ?? 0;
                const metricsAvailable = actScore !== null && ftStats !== null;
                const activityScore = actScore;
                const fullTimeCount = ftStats?.fullTimeCount ?? null;
                const fullTimeRatio = ftStats?.fullTimeRatio ?? null;

                // Exact filter: contributors
                if (contributorsCount < minContributors || contributorsCount > maxContributors) {
                  skipped++;
                  send('skip', { index: idx, fullName, reason: `contributors:${contributorsCount}`, progress: `${idx + 1}/${total}` });
                  return;
                }

                // Exact filter: activity (only when metrics available)
                if (metricsAvailable) {
                  if (activityScore! < minActivityScore) {
                    skipped++;
                    send('skip', { index: idx, fullName, reason: `activity:${activityScore!.toFixed(1)}`, progress: `${idx + 1}/${total}` });
                    return;
                  }

                  if (fullTimeRatio! < minFullTimeRatio) {
                    skipped++;
                    send('skip', { index: idx, fullName, reason: `fulltime:${(fullTimeRatio! * 100).toFixed(0)}%`, progress: `${idx + 1}/${total}` });
                    return;
                  }
                }

                // Passed — build result from GQL data + REST enrichment
                shown++;
                send('repo', {
                  index: idx,
                  repo: {
                    id: gql.databaseId,
                    name: gql.name,
                    fullName: gql.nameWithOwner,
                    description: gql.description,
                    url: gql.url,
                    cloneUrl: `https://github.com/${gql.nameWithOwner}.git`,
                    language: gql.primaryLanguage?.name ?? null,
                    stars: gql.stargazerCount,
                    updatedAt: gql.updatedAt,
                    createdAt: gql.createdAt,
                    pushedAt: gql.pushedAt,
                    sizeKb: gql.diskUsage,
                    isPrivate: false,
                    defaultBranch: gql.defaultBranchRef?.name ?? 'main',  // GQL: always set (empty repos pre-filtered). REST fallback: preserved from response. 'main' is last-resort safety net.
                    owner: {
                      login: gql.owner.login,
                      avatarUrl: gql.owner.avatarUrl,
                    },
                    contributorsCount,
                    activityScore: activityScore !== null ? Math.round(activityScore * 10) / 10 : null,
                    activityLevel: activityScore !== null ? getActivityLevel(activityScore) : null,
                    fullTimeCount,
                    fullTimeRatio: fullTimeRatio !== null ? Math.round(fullTimeRatio * 100) / 100 : null,
                    metricsAvailable,
                  },
                  progress: `${idx + 1}/${total}`,
                });
              } catch {
                errors++;
                send('error', { index: idx, fullName, error: 'enrichment_failed', progress: `${idx + 1}/${total}` });
              }
            })
          );
        }

        send('done', { shown, skipped, errors, total });
        controller.close();
      } catch (err) {
        logger.error({ err }, 'Explore search stream error');
        send('error', { index: -1, fullName: '', error: 'internal_error', progress: '0/0' });
        send('done', { shown: 0, skipped: 0, errors: 1, total: 0 });
        controller.close();
      }
    },
  });
```

**Step 2: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/server/src/app/api/github/search/route.ts
git commit -m "feat(explore-v2): rewrite SSE pipeline with GraphQL pre-filter + REST enrichment"
```

---

## Task 3: Update ExploreTab to handle new `prefiltering` phase

**Files:**
- Modify: `packages/server/src/components/explore-tab.tsx`

**Step 1: Add `prefiltering` to SearchPhase type and update progress display**

Change the `SearchPhase` type (line 46):

```typescript
type SearchPhase = 'idle' | 'searching' | 'prefiltering' | 'enriching' | 'done';
```

Update the `isLoading` check (line 133):

```typescript
  const isLoading = phase === 'searching' || phase === 'prefiltering' || phase === 'enriching';
```

Add prefiltering phase handler in `handleSearch` — in the `es.addEventListener('phase', ...)` callback, update the phase setter to handle the new phase:

```typescript
    es.addEventListener('phase', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data);
      setPhase(data.phase as SearchPhase);
      if (data.phase === 'enriching' && data.total) setPendingCount(data.total);
    });
```

Update the progress display (around line 371):

```typescript
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {phase === 'searching' && 'Searching GitHub...'}
          {phase === 'prefiltering' && 'Pre-filtering candidates...'}
          {phase === 'enriching' && `Analyzing activity... (${progress})`}
        </div>
      )}
```

**Step 2: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/server/src/components/explore-tab.tsx
git commit -m "feat(explore-v2): handle prefiltering phase in ExploreTab"
```

---

## Task 4: Add tests for pre-filter logic

**Files:**
- Create: `packages/server/src/lib/__tests__/explore-prefilter.test.ts`

**Step 1: Extract `preFilterCandidates` to a testable module**

Create `packages/server/src/lib/explore-utils.ts`:

```typescript
import type { ActivityLevel } from '@/types/repository';

export function getActivityLevel(score: number): ActivityLevel {
  if (score >= 10) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

export interface GQLRepoForFilter {
  mentionableUsers: { totalCount: number };
  defaultBranchRef: {
    target: {
      recent: { totalCount: number };
    };
  } | null;
}

/**
 * Pre-filter GraphQL results by mentionableUsers (proxy for contributors)
 * and recent commit count (proxy for activity score).
 *
 * Uses wide tolerance bands because mentionableUsers over-counts
 * (includes watchers, issue participants, not just committers).
 */
export function preFilterCandidates<T extends GQLRepoForFilter>(
  repos: T[],
  minContributors: number,
  maxContributors: number,
  minActivityScore: number,
): T[] {
  const mentionableMin = Math.max(1, minContributors - 1);
  const mentionableMax = maxContributors * 3;
  const minRecentCommits = Math.max(1, Math.floor(minActivityScore * 13 * 0.5));

  return repos.filter((repo) => {
    const mentionable = repo.mentionableUsers.totalCount;
    if (mentionable < mentionableMin || mentionable > mentionableMax) return false;
    if (!repo.defaultBranchRef?.target) return false;
    const recentCommits = repo.defaultBranchRef.target.recent.totalCount;
    if (recentCommits < minRecentCommits) return false;
    return true;
  });
}
```

**Step 2: Write the tests**

Create `packages/server/src/lib/__tests__/explore-prefilter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { preFilterCandidates, getActivityLevel } from '@/lib/explore-utils';

function makeRepo(mentionable: number, recentCommits: number | null) {
  return {
    mentionableUsers: { totalCount: mentionable },
    defaultBranchRef: recentCommits !== null
      ? { target: { recent: { totalCount: recentCommits } } }
      : null,
  };
}

describe('preFilterCandidates', () => {
  // Default filters: minContributors=2, maxContributors=15, minActivityScore=5
  const defaults = { min: 2, max: 15, activity: 5 };
  // minRecentCommits = floor(5 * 13 * 0.5) = 32
  // mentionableMin = max(1, 2-1) = 1
  // mentionableMax = 15 * 3 = 45

  it('passes repo with mentionable in range and enough commits', () => {
    const repos = [makeRepo(10, 50)];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(1);
  });

  it('rejects repo with 0 mentionableUsers (single-dev project proxy)', () => {
    const repos = [makeRepo(0, 100)];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('rejects repo with too many mentionableUsers (>max*3)', () => {
    const repos = [makeRepo(46, 100)];  // 46 > 15*3=45
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('passes repo at boundary of mentionableMax', () => {
    const repos = [makeRepo(45, 100)];  // 45 == 15*3
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(1);
  });

  it('rejects repo with too few recent commits', () => {
    const repos = [makeRepo(10, 31)];  // 31 < 32
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('passes repo at boundary of minRecentCommits', () => {
    const repos = [makeRepo(10, 32)];  // 32 == floor(5*13*0.5)
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(1);
  });

  it('rejects empty repo (no defaultBranchRef)', () => {
    const repos = [makeRepo(10, null)];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(0);
  });

  it('filters mixed set correctly', () => {
    const repos = [
      makeRepo(10, 50),   // pass
      makeRepo(0, 100),   // fail: mentionable=0
      makeRepo(10, 5),    // fail: low commits
      makeRepo(100, 50),  // fail: mentionable too high
      makeRepo(5, 40),    // pass
    ];
    const result = preFilterCandidates(repos, defaults.min, defaults.max, defaults.activity);
    expect(result).toHaveLength(2);
  });

  it('uses lower activity threshold for minActivityScore=1', () => {
    // minRecentCommits = floor(1 * 13 * 0.5) = 6
    const repos = [makeRepo(5, 6)];
    const result = preFilterCandidates(repos, 2, 15, 1);
    expect(result).toHaveLength(1);
  });
});

describe('getActivityLevel', () => {
  it('returns high for score >= 10', () => {
    expect(getActivityLevel(10)).toBe('high');
    expect(getActivityLevel(25)).toBe('high');
  });

  it('returns medium for 3 <= score < 10', () => {
    expect(getActivityLevel(3)).toBe('medium');
    expect(getActivityLevel(9.9)).toBe('medium');
  });

  it('returns low for score < 3', () => {
    expect(getActivityLevel(0)).toBe('low');
    expect(getActivityLevel(2.9)).toBe('low');
  });
});
```

**Step 3: Run the tests**

Run: `cd packages/server && npx vitest run src/lib/__tests__/explore-prefilter.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/server/src/lib/explore-utils.ts packages/server/src/lib/__tests__/explore-prefilter.test.ts
git commit -m "feat(explore-v2): extract preFilter logic to explore-utils with tests"
```

---

## Task 5: Update route.ts to import from explore-utils

**Files:**
- Modify: `packages/server/src/app/api/github/search/route.ts`

**Step 1: Replace inline `getActivityLevel` and `preFilterCandidates` with imports**

At the top of route.ts, replace:
```typescript
import type { ActivityLevel } from '@/types/repository';
```
with:
```typescript
import { getActivityLevel, preFilterCandidates } from '@/lib/explore-utils';
```

Remove the inline `getActivityLevel` function (lines ~46-50) and the inline `preFilterCandidates` function — they now live in `explore-utils.ts`.

**Step 2: Update GQLRepo interface**

Ensure `GQLRepo` extends `GQLRepoForFilter` from explore-utils (or just keep it as-is since TypeScript structural typing handles it).

**Step 3: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: No errors

**Step 4: Run all tests**

Run: `cd packages/server && npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add packages/server/src/app/api/github/search/route.ts
git commit -m "refactor(explore-v2): import preFilter and getActivityLevel from explore-utils"
```

---

## Task 6: Update SSE types in repository.ts

**Files:**
- Modify: `packages/server/src/types/repository.ts`

**Step 1: Add `prefiltering` phase to ExploreSSEEvent**

Update the `ExploreSSEEvent` type to include the new phase:

```typescript
export type ExploreSSEEvent =
  | { event: 'phase'; data: { phase: 'searching'; query: string } }
  | { event: 'phase'; data: { phase: 'prefiltering'; total: number; candidates: number } }
  | { event: 'phase'; data: { phase: 'enriching'; total: number } }
  | { event: 'repo'; data: { index: number; repo: ExploreSearchResult; progress: string } }
  | { event: 'skip'; data: { index: number; fullName: string; reason: string; progress: string } }
  | { event: 'error'; data: { index: number; fullName: string; error: string; progress: string } }
  | { event: 'done'; data: { shown: number; skipped: number; errors: number; total: number } };
```

**Step 2: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/server/src/types/repository.ts
git commit -m "feat(explore-v2): add prefiltering phase to ExploreSSEEvent type"
```

---

## Task 7: Smoke test

**Step 1: Start dev server**

Run: `cd packages/server && pnpm dev` (background, wait for "Ready" message, auto-terminate after test)

**Step 2: Test SSE endpoint with curl**

Run: `curl -N --max-time 30 "http://localhost:3000/api/github/search?q=fastapi&minContributors=2&maxContributors=50&minActivityScore=1&minFullTimeRatio=0&minStars=100"`

Expected output should show:
1. `event: phase` with `searching`
2. `event: phase` with `prefiltering` (total: ~100, candidates: ~15-25)
3. `event: phase` with `enriching` (total: 15 or less)
4. Multiple `event: repo` or `event: skip`
5. `event: done` with `shown: 5+`

**Step 3: Test with strict filters (previously 0 results)**

Run: `curl -N --max-time 30 "http://localhost:3000/api/github/search?q=web+framework&language=Python&minContributors=3&maxContributors=20&minActivityScore=5&minFullTimeRatio=0.5&minStars=500"`

Expected: `shown: 1+` (previously would return 0 with REST-only search)

**Step 4: Test REST fallback (unauthenticated)**

Open incognito browser, navigate to `http://localhost:3000/orders/new`, try Explore tab.
Note: GraphQL **requires authentication**. Without token, the server falls back to REST-only search (10 results, no pre-filtering). Verify that:
- Search still works (REST fallback)
- Results show, though fewer (no pre-filter advantage)
- Rate limit warning appears ("Connect GitHub for better results")

**Step 5: Commit fixes if needed**

```bash
git add -A
git commit -m "fix(explore-v2): smoke test fixes"
```

---

## Task 8: Build and lint verification

**Step 1: Run production build**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds

**Step 2: Run lint**

Run: `cd packages/server && pnpm lint`
Expected: No errors (warnings OK)

**Step 3: Run all tests**

Run: `cd packages/server && pnpm test 2>&1`
Expected: All tests pass

**Step 4: Commit fixes if needed**

```bash
git add -A
git commit -m "fix(explore-v2): build/lint fixes"
```
