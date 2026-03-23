# Explore Tab — Public Repository Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "Explore" tab to `/orders/new` that searches public GitHub repositories with server-side filtering by activity score, contributor count, and full-time developer patterns, streaming results via SSE.

**Architecture:** New SSE API endpoint (`GET /api/github/search`) builds a GitHub Search query, fetches top 10, enriches each in parallel (contributors + commit_activity + contributor stats), filters server-side, and streams results. New `ExploreTab` component consumes the SSE stream and renders cards progressively.

**Tech Stack:** Next.js App Router (SSE via `ReadableStream`), GitHub REST API v3, React `EventSource`, existing shadcn/ui components (Tabs, Skeleton, Badge, Input, Select, Button).

**Design doc:** `docs/plans/2026-02-22-explore-search-design.md`

---

## Task 1: Add `explore` to RepositorySourceType

**Files:**
- Modify: `prototype/src/types/repository.ts:4`

**Step 1: Update the type**

In `prototype/src/types/repository.ts` line 4, change:
```typescript
export type RepositorySourceType = 'connected' | 'public';
```
to:
```typescript
export type RepositorySourceType = 'connected' | 'public' | 'explore';
```

**Step 2: Add SearchResult types**

Append to `prototype/src/types/repository.ts`:

```typescript
/**
 * Activity level based on commits/week
 */
export type ActivityLevel = 'low' | 'medium' | 'high';

/**
 * Enriched repository from Explore search
 */
export interface ExploreSearchResult {
  /** Base repository fields */
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  url: string;
  cloneUrl: string;
  language: string | null;
  stars: number;
  updatedAt: string;
  createdAt: string;
  pushedAt: string;
  sizeKb: number;
  isPrivate: boolean;
  defaultBranch: string;
  owner: RepositoryOwner;
  /** Enrichment fields */
  contributorsCount: number;
  activityScore: number | null;
  activityLevel: ActivityLevel | null;
  fullTimeCount: number | null;
  fullTimeRatio: number | null;
  /** False when /stats/* returned 202 and metrics are unavailable */
  metricsAvailable: boolean;
}

/**
 * SSE event types for /api/github/search
 */
export type ExploreSSEEvent =
  | { event: 'phase'; data: { phase: 'searching'; query: string } }
  | { event: 'phase'; data: { phase: 'enriching'; total: number } }
  | { event: 'repo'; data: { index: number; repo: ExploreSearchResult; progress: string } }
  | { event: 'skip'; data: { index: number; fullName: string; reason: string; progress: string } }
  | { event: 'error'; data: { index: number; fullName: string; error: string; progress: string } }
  | { event: 'done'; data: { shown: number; skipped: number; errors: number; total: number } };

/**
 * Explore search filter parameters
 */
export interface ExploreSearchFilters {
  q: string;
  language?: string;
  minContributors?: number;
  maxContributors?: number;
  minActivityScore?: number;
  minStars?: number;
  minFullTimeRatio?: number;
  sort?: 'stars' | 'updated';
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd /c/Projects/AI-Code\ Audit/prototype && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to repository.ts

**Step 4: Commit**

```bash
git add prototype/src/types/repository.ts
git commit -m "feat(explore): add ExploreSearchResult types and SSE event definitions"
```

---

## Task 2: Create SSE search API endpoint

**Files:**
- Create: `prototype/src/app/api/github/search/route.ts`

**Step 1: Create the route file**

Create `prototype/src/app/api/github/search/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import prisma from '@/lib/db';
import type { ActivityLevel } from '@/types/repository';

// ── GitHub API types (snake_case) ───────────────────────────

interface GHSearchResponse {
  total_count: number;
  items: GHSearchRepo[];
}

interface GHSearchRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  created_at: string;
  pushed_at: string;
  size: number;
  private: boolean;
  default_branch: string;
  owner: { login: string; avatar_url: string };
}

interface GHWeeklyActivity {
  total: number;
  week: number;
  days: number[];
}

interface GHContributorStats {
  author: { login: string } | null;
  total: number;
  weeks: { w: number; a: number; d: number; c: number }[];
}

// ── Helpers ─────────────────────────────────────────────────

function getActivityLevel(score: number): ActivityLevel {
  if (score >= 10) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Mutable rate limit state, updated from response headers */
interface RateLimits {
  coreRemaining: number;
  coreReset: number;
  searchRemaining: number;
  searchReset: number;
}

function updateRateLimits(res: Response, limits: RateLimits, isSearch: boolean) {
  const remaining = res.headers.get('X-RateLimit-Remaining');
  const reset = res.headers.get('X-RateLimit-Reset');
  if (remaining !== null) {
    const val = parseInt(remaining, 10);
    if (isSearch) {
      limits.searchRemaining = val;
      if (reset) limits.searchReset = parseInt(reset, 10);
    } else {
      limits.coreRemaining = val;
      if (reset) limits.coreReset = parseInt(reset, 10);
    }
  }
}

async function ghFetch(
  url: string,
  token: string | null,
  limits: RateLimits,
  isSearch = false
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'AI-Code-Audit',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  const res = await fetch(url, { headers, cache: 'no-store' });
  updateRateLimits(res, limits, isSearch);
  return res;
}

/** Get contributor count via Link header pagination trick */
async function getContributorsCount(
  fullName: string,
  token: string | null,
  limits: RateLimits
): Promise<number | null> {
  const res = await ghFetch(
    `https://api.github.com/repos/${fullName}/contributors?per_page=1&anon=1`,
    token, limits
  );
  if (!res.ok) return null;

  const linkHeader = res.headers.get('Link');
  if (linkHeader) {
    const lastMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
    if (lastMatch) return parseInt(lastMatch[1], 10);
  }
  const body = await res.json();
  return Array.isArray(body) ? body.length : null;
}

/** Get average commits/week for last 12 weeks. Returns null if stats unavailable (202). */
async function getActivityScore(
  fullName: string,
  token: string | null,
  limits: RateLimits
): Promise<number | null> {
  const res = await ghFetch(
    `https://api.github.com/repos/${fullName}/stats/commit_activity`,
    token, limits
  );
  // 202 = GitHub is computing stats, retry once
  if (res.status === 202) {
    await new Promise((r) => setTimeout(r, 2000));
    const retry = await ghFetch(
      `https://api.github.com/repos/${fullName}/stats/commit_activity`,
      token, limits
    );
    if (!retry.ok || retry.status === 202) return null;
    const data: GHWeeklyActivity[] = await retry.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const last12 = data.slice(-12);
    return last12.reduce((sum, w) => sum + w.total, 0) / last12.length;
  }
  if (!res.ok) return null;
  const data: GHWeeklyActivity[] = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const last12 = data.slice(-12);
  return last12.reduce((sum, w) => sum + w.total, 0) / last12.length;
}

/** Get full-time-like author count and ratio. Returns null if stats unavailable (202). */
async function getFullTimeStats(
  fullName: string,
  token: string | null,
  limits: RateLimits
): Promise<{ fullTimeCount: number; fullTimeRatio: number } | null> {
  const res = await ghFetch(
    `https://api.github.com/repos/${fullName}/stats/contributors`,
    token, limits
  );
  // 202 = computing, retry once
  if (res.status === 202) {
    await new Promise((r) => setTimeout(r, 2000));
    const retry = await ghFetch(
      `https://api.github.com/repos/${fullName}/stats/contributors`,
      token, limits
    );
    if (!retry.ok || retry.status === 202) return null;
    const data: GHContributorStats[] = await retry.json();
    return calcFullTime(data);
  }
  if (!res.ok) return null;
  const data: GHContributorStats[] = await res.json();
  return calcFullTime(data);
}

function calcFullTime(contributors: GHContributorStats[]) {
  if (!Array.isArray(contributors) || contributors.length === 0) return null;
  const last12Weeks = contributors.map((c) => {
    const weeks = c.weeks.slice(-12);
    const activeWeeks = weeks.filter((w) => w.c > 0).length;
    const totalCommits = weeks.reduce((s, w) => s + w.c, 0);
    return { consistency: activeWeeks / 12, totalCommits };
  });
  const fullTimeCount = last12Weeks.filter(
    (a) => a.consistency >= 0.6 && a.totalCommits >= 20
  ).length;
  return {
    fullTimeCount,
    fullTimeRatio: contributors.length > 0 ? fullTimeCount / contributors.length : 0,
  };
}

// ── SSE Route ───────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get('q')?.trim();
  if (!q || q.length < 2) {
    return new Response(
      JSON.stringify({ success: false, error: 'Query must be at least 2 characters' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Parse filter params (with NaN guard)
  const language = params.get('language')?.trim() || '';
  const minContributors = Math.max(0, parseInt(params.get('minContributors') || '2', 10) || 2);
  const maxContributors = Math.max(minContributors, parseInt(params.get('maxContributors') || '15', 10) || 15);
  const minActivityScore = Math.max(0, parseFloat(params.get('minActivityScore') || '5') || 5);
  const minStars = Math.max(0, parseInt(params.get('minStars') || '0', 10) || 0);
  const minFullTimeRatio = Math.max(0, Math.min(1, parseFloat(params.get('minFullTimeRatio') || '0.5') || 0.5));
  const sort = params.get('sort') === 'updated' ? 'updated' : 'stars';

  // Get GitHub token if user is authenticated
  let token: string | null = null;
  try {
    const session = await auth();
    if (session?.user?.email) {
      const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { githubAccessToken: true },
      });
      token = user?.githubAccessToken || null;
    }
  } catch {
    // Continue without token
  }

  // Build GitHub search query
  const pushedAfter = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  let searchQuery = `${q} pushed:>${pushedAfter} archived:false`;
  // Only add language filter if it's a non-empty, non-whitespace string
  if (language && language.trim().length > 0) searchQuery += ` language:${language.trim()}`;
  if (minStars > 0) searchQuery += ` stars:>=${minStars}`;

  // Initialize rate limits (will be updated from actual response headers)
  const limits: RateLimits = {
    coreRemaining: token ? 5000 : 60,
    coreReset: 0,
    searchRemaining: 10,
    searchReset: 0,
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Phase 1: Search
        controller.enqueue(
          encoder.encode(sseEvent('phase', { phase: 'searching', query: searchQuery }))
        );

        const searchRes = await ghFetch(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=${sort}&order=desc&per_page=10`,
          token, limits, true  // isSearch = true for search rate limit bucket
        );

        if (!searchRes.ok) {
          const remaining = searchRes.headers.get('X-RateLimit-Remaining');
          if (remaining === '0') {
            const reset = searchRes.headers.get('X-RateLimit-Reset');
            const retryAfter = reset
              ? Math.max(0, parseInt(reset) - Math.floor(Date.now() / 1000))
              : 60;
            controller.enqueue(
              encoder.encode(
                sseEvent('error', {
                  index: -1,
                  fullName: '',
                  error: `rate_limited`,
                  progress: `retryAfter:${retryAfter}`,
                })
              )
            );
          } else {
            controller.enqueue(
              encoder.encode(
                sseEvent('error', {
                  index: -1,
                  fullName: '',
                  error: `search_failed:${searchRes.status}`,
                  progress: '0/0',
                })
              )
            );
          }
          controller.enqueue(
            encoder.encode(
              sseEvent('done', { shown: 0, skipped: 0, errors: 1, total: 0 })
            )
          );
          controller.close();
          return;
        }

        const searchData: GHSearchResponse = await searchRes.json();
        const repos = searchData.items;
        const total = repos.length;

        // Phase 2: Enrich
        controller.enqueue(
          encoder.encode(sseEvent('phase', { phase: 'enriching', total }))
        );

        let shown = 0;
        let skipped = 0;
        let errors = 0;

        // Rate limits are now tracked via the shared `limits` object,
        // updated from real X-RateLimit-* headers by ghFetch()

        // Process repos in parallel batches of 3 to manage rate limits
        for (let i = 0; i < total; i += 3) {
          const batch = repos.slice(i, Math.min(i + 3, total));

          // Check real rate limit budget from response headers
          // Each repo needs ~3 requests (contributors, commit_activity, contributor_stats)
          if (limits.coreRemaining < batch.length * 3) {
            // Not enough budget — skip remaining repos
            for (let j = i; j < total; j++) {
              skipped++;
              controller.enqueue(
                encoder.encode(
                  sseEvent('skip', {
                    index: j,
                    fullName: repos[j].full_name,
                    reason: 'rate_limit_budget',
                    progress: `${j + 1}/${total}`,
                  })
                )
              );
            }
            break;
          }

          await Promise.allSettled(
            batch.map(async (repo, batchIdx) => {
              const idx = i + batchIdx;
              const fullName = repo.full_name;

              try {
                // Parallel enrichment: 3 requests per repo
                const [contribCount, actScore, ftStats] = await Promise.all([
                  getContributorsCount(fullName, token, limits),
                  getActivityScore(fullName, token, limits),
                  getFullTimeStats(fullName, token, limits),
                ]);

                const contributorsCount = contribCount ?? 0;
                // Metrics may be null if GitHub returned 202 (still computing)
                const metricsAvailable = actScore !== null && ftStats !== null;
                const activityScore = actScore;
                const fullTimeCount = ftStats?.fullTimeCount ?? null;
                const fullTimeRatio = ftStats?.fullTimeRatio ?? null;

                // Apply contributor filter (always available)
                if (contributorsCount < minContributors || contributorsCount > maxContributors) {
                  skipped++;
                  controller.enqueue(
                    encoder.encode(
                      sseEvent('skip', {
                        index: idx,
                        fullName,
                        reason: `contributors:${contributorsCount}`,
                        progress: `${idx + 1}/${total}`,
                      })
                    )
                  );
                  return;
                }

                // Only apply activity/full-time filters when metrics are available
                // When null (202 response), pass the repo through with metricsAvailable=false
                if (metricsAvailable) {
                  if (activityScore! < minActivityScore) {
                    skipped++;
                    controller.enqueue(
                      encoder.encode(
                        sseEvent('skip', {
                          index: idx,
                          fullName,
                          reason: `activity:${activityScore!.toFixed(1)}`,
                          progress: `${idx + 1}/${total}`,
                        })
                      )
                    );
                    return;
                  }

                  if (fullTimeRatio! < minFullTimeRatio) {
                    skipped++;
                    controller.enqueue(
                      encoder.encode(
                        sseEvent('skip', {
                          index: idx,
                          fullName,
                          reason: `fulltime:${(fullTimeRatio! * 100).toFixed(0)}%`,
                          progress: `${idx + 1}/${total}`,
                        })
                      )
                    );
                    return;
                  }
                }

                // Passed filters (or metrics unavailable — show with warning)
                shown++;
                controller.enqueue(
                  encoder.encode(
                    sseEvent('repo', {
                      index: idx,
                      repo: {
                        id: repo.id,
                        name: repo.name,
                        fullName: repo.full_name,
                        description: repo.description,
                        url: repo.html_url,
                        cloneUrl: repo.clone_url,
                        language: repo.language,
                        stars: repo.stargazers_count,
                        updatedAt: repo.updated_at,
                        createdAt: repo.created_at,
                        pushedAt: repo.pushed_at,
                        sizeKb: repo.size,
                        isPrivate: repo.private,
                        defaultBranch: repo.default_branch,
                        owner: {
                          login: repo.owner.login,
                          avatarUrl: repo.owner.avatar_url,
                        },
                        contributorsCount,
                        activityScore: activityScore !== null ? Math.round(activityScore * 10) / 10 : null,
                        activityLevel: activityScore !== null ? getActivityLevel(activityScore) : null,
                        fullTimeCount,
                        fullTimeRatio: fullTimeRatio !== null ? Math.round(fullTimeRatio * 100) / 100 : null,
                        metricsAvailable,
                      },
                      progress: `${idx + 1}/${total}`,
                    })
                  )
                );
              } catch {
                errors++;
                controller.enqueue(
                  encoder.encode(
                    sseEvent('error', {
                      index: idx,
                      fullName,
                      error: 'enrichment_failed',
                      progress: `${idx + 1}/${total}`,
                    })
                  )
                );
              }
            })
          );
        }

        // Done
        controller.enqueue(
          encoder.encode(sseEvent('done', { shown, skipped, errors, total }))
        );
        controller.close();
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            sseEvent('error', {
              index: -1,
              fullName: '',
              error: 'internal_error',
              progress: '0/0',
            })
          )
        );
        controller.enqueue(
          encoder.encode(sseEvent('done', { shown: 0, skipped: 0, errors: 1, total: 0 }))
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

**Step 2: Verify no TypeScript errors**

Run: `cd /c/Projects/AI-Code\ Audit/prototype && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 3: Commit**

```bash
git add prototype/src/app/api/github/search/route.ts
git commit -m "feat(explore): add SSE search endpoint with activity scoring and full-time detection"
```

---

## Task 3: Create ExploreTab component

**Files:**
- Create: `prototype/src/components/explore-tab.tsx`

**Step 1: Create the component**

Create `prototype/src/components/explore-tab.tsx`:

```tsx
'use client';

import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Search,
  Loader2,
  Star,
  Globe,
  Users,
  Clock,
  AlertCircle,
  TrendingUp,
  UserCheck,
} from 'lucide-react';
import { formatRelativeTime, formatDate } from '@/lib/utils';
import type { ExploreSearchResult, ExploreSearchFilters } from '@/types/repository';

// ── Types ───────────────────────────────────────────────────

interface ExploreTabProps {
  selectedRepoIds: Set<number>;
  onToggleRepo: (repo: ExploreSearchResult) => void;
  githubConnected: boolean | null;
}

type SearchPhase = 'idle' | 'searching' | 'enriching' | 'done';

// ── Constants ───────────────────────────────────────────────

const LANGUAGES = [
  '', 'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'Rust',
  'C++', 'C#', 'Ruby', 'PHP', 'Swift', 'Kotlin',
];

const ACTIVITY_PRESETS = [
  { label: '1+ commits/wk', value: 1 },
  { label: '3+ commits/wk', value: 3 },
  { label: '5+ commits/wk', value: 5 },
  { label: '10+ commits/wk', value: 10 },
];

const FULLTIME_PRESETS = [
  { label: 'Any', value: 0 },
  { label: '25%+', value: 0.25 },
  { label: '50%+', value: 0.5 },
  { label: '75%+', value: 0.75 },
];

// ── Activity Bar ────────────────────────────────────────────

function ActivityBar({ score, level }: { score: number; level: string }) {
  const maxScore = 20;
  const pct = Math.min(100, (score / maxScore) * 100);
  const color =
    level === 'high'
      ? 'bg-green-500'
      : level === 'medium'
        ? 'bg-yellow-500'
        : 'bg-gray-400';

  return (
    <Tooltip>
      <TooltipProvider>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2">
            <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {score.toFixed(1)} /wk
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {score.toFixed(1)} commits/week average (last 12 weeks) — {level} activity
        </TooltipContent>
      </TooltipProvider>
    </Tooltip>
  );
}

// ── Main Component ──────────────────────────────────────────

export function ExploreTab({ selectedRepoIds, onToggleRepo, githubConnected }: ExploreTabProps) {
  // Search state
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ExploreSearchResult[]>([]);
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ shown: number; total: number } | null>(null);

  // Filter state
  const [language, setLanguage] = useState('');
  const [minContributors, setMinContributors] = useState('2');
  const [maxContributors, setMaxContributors] = useState('15');
  const [minActivityScore, setMinActivityScore] = useState('5');
  const [minStars, setMinStars] = useState('0');
  const [minFullTimeRatio, setMinFullTimeRatio] = useState('0.5');
  const [sort, setSort] = useState<'stars' | 'updated'>('stars');

  // Skeletons count for pending repos
  const [pendingCount, setPendingCount] = useState(0);

  // EventSource ref for cleanup
  const esRef = useRef<EventSource | null>(null);

  const isLoading = phase === 'searching' || phase === 'enriching';

  const handleSearch = useCallback(() => {
    if (!query.trim() || isLoading) return;

    // Cleanup previous
    esRef.current?.close();
    setResults([]);
    setError(null);
    setSummary(null);
    setPhase('searching');
    setProgress('');
    setPendingCount(0);

    const params = new URLSearchParams({
      q: query.trim(),
      sort,
      ...(language.trim() && { language: language.trim() }),
      minContributors,
      maxContributors,
      minActivityScore,
      minStars,
      minFullTimeRatio,
    });

    const es = new EventSource(`/api/github/search?${params}`);
    esRef.current = es;

    es.addEventListener('phase', (e) => {
      const data = JSON.parse(e.data);
      setPhase(data.phase as SearchPhase);
      if (data.total) setPendingCount(data.total);
    });

    es.addEventListener('repo', (e) => {
      const data = JSON.parse(e.data);
      setResults((prev) => [...prev, data.repo]);
      setProgress(data.progress);
      setPendingCount((prev) => Math.max(0, prev - 1));
    });

    es.addEventListener('skip', (e) => {
      const data = JSON.parse(e.data);
      setProgress(data.progress);
      setPendingCount((prev) => Math.max(0, prev - 1));
    });

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.error === 'rate_limited') {
          setError(`GitHub API rate limit exceeded. Retry in ${data.progress.split(':')[1]}s. ${!githubConnected ? 'Connect GitHub for higher limits.' : ''}`);
        }
        setProgress(data.progress);
        setPendingCount((prev) => Math.max(0, prev - 1));
      } catch {
        // EventSource native error
        setError('Connection lost. Try searching again.');
        setPhase('done');
        es.close();
      }
    });

    es.addEventListener('done', (e) => {
      const data = JSON.parse(e.data);
      setSummary({ shown: data.shown, total: data.total });
      setPhase('done');
      setPendingCount(0);
      es.close();
    });

    // Native error handler
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // Normal close after done event
        return;
      }
      setError('Connection lost. Try searching again.');
      setPhase('done');
      setPendingCount(0);
      es.close();
    };
  }, [query, language, minContributors, maxContributors, minActivityScore, minStars, minFullTimeRatio, sort, isLoading, githubConnected]);

  return (
    <div className="space-y-4">
      {/* Search Input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search public repositories..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSearch();
              }
            }}
            className="pl-9"
            disabled={isLoading}
          />
        </div>
        <Button onClick={handleSearch} disabled={!query.trim() || isLoading}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-3 border rounded-md bg-muted/30">
        {/* Language */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Language</label>
          <Select value={language || '__any__'} onValueChange={(v) => setLanguage(v === '__any__' ? '' : v)} disabled={isLoading}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              {LANGUAGES.filter(Boolean).map((lang) => (
                <SelectItem key={lang} value={lang}>{lang}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Contributors range */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Contributors</label>
          <div className="flex gap-1 items-center">
            <Input
              type="number"
              value={minContributors}
              onChange={(e) => setMinContributors(e.target.value)}
              className="h-8 text-xs w-16"
              min={1}
              disabled={isLoading}
            />
            <span className="text-xs text-muted-foreground">—</span>
            <Input
              type="number"
              value={maxContributors}
              onChange={(e) => setMaxContributors(e.target.value)}
              className="h-8 text-xs w-16"
              min={1}
              disabled={isLoading}
            />
          </div>
        </div>

        {/* Activity */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Activity</label>
          <Select value={minActivityScore} onValueChange={setMinActivityScore} disabled={isLoading}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_PRESETS.map((p) => (
                <SelectItem key={p.value} value={String(p.value)}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Min Stars */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Min Stars</label>
          <Input
            type="number"
            value={minStars}
            onChange={(e) => setMinStars(e.target.value)}
            className="h-8 text-xs"
            min={0}
            disabled={isLoading}
          />
        </div>

        {/* Full-time ratio */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Full-time ratio</label>
          <Select value={minFullTimeRatio} onValueChange={setMinFullTimeRatio} disabled={isLoading}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FULLTIME_PRESETS.map((p) => (
                <SelectItem key={p.value} value={String(p.value)}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Sort */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Sort by</label>
          <Select value={sort} onValueChange={(v) => setSort(v as 'stars' | 'updated')} disabled={isLoading}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stars">Most Stars</SelectItem>
              <SelectItem value="updated">Recently Updated</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Rate limit warning */}
      {githubConnected === false && phase !== 'idle' && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Without GitHub connection: limited to 60 req/hr.
            Connect GitHub for better results.
          </AlertDescription>
        </Alert>
      )}

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Progress */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {phase === 'searching' && 'Searching GitHub...'}
          {phase === 'enriching' && `Analyzing activity... (${progress})`}
        </div>
      )}

      {/* Results */}
      {(results.length > 0 || pendingCount > 0) && (
        <div className="border rounded-md max-h-[500px] overflow-auto">
          <div className="p-2 space-y-1">
            {/* Rendered result cards */}
            {results.map((repo) => {
              const isSelected = selectedRepoIds.has(repo.id);
              return (
                <TooltipProvider key={repo.id}>
                  <div
                    onClick={() => onToggleRepo(repo)}
                    className={`flex items-start gap-3 p-3 rounded-md cursor-pointer transition-colors ${
                      isSelected ? 'bg-primary/10 border border-primary' : 'hover:bg-accent'
                    }`}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => onToggleRepo(repo)}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1"
                    />
                    <Avatar className="h-8 w-8 flex-shrink-0">
                      <AvatarImage src={repo.owner.avatarUrl} alt={repo.owner.login} />
                      <AvatarFallback>{repo.owner.login[0]?.toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{repo.fullName}</span>
                        <Globe className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      </div>
                      {repo.description && (
                        <p className="text-sm text-muted-foreground truncate mt-0.5">
                          {repo.description}
                        </p>
                      )}
                      {/* Stats Row 1: Basic */}
                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        {repo.language && (
                          <Badge variant="secondary" className="text-xs">{repo.language}</Badge>
                        )}
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Star className="h-3 w-3" />
                          {repo.stars >= 1000 ? `${(repo.stars / 1000).toFixed(1)}k` : repo.stars}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Users className="h-3 w-3" />
                          {repo.contributorsCount}
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              {formatRelativeTime(repo.pushedAt)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            Last push: {formatDate(repo.pushedAt)}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      {/* Stats Row 2: Enrichment (or metrics unavailable warning) */}
                      {repo.metricsAvailable ? (
                      <div className="flex items-center gap-4 mt-1.5">
                        <div className="flex items-center gap-1">
                          <TrendingUp className="h-3 w-3 text-muted-foreground" />
                          <ActivityBar score={repo.activityScore!} level={repo.activityLevel!} />
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <UserCheck className="h-3 w-3" />
                              {repo.fullTimeCount}/{repo.contributorsCount} full-time
                              ({Math.round(repo.fullTimeRatio! * 100)}%)
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {repo.fullTimeCount} of {repo.contributorsCount} contributors commit
                            regularly (7+ of last 12 weeks, 20+ commits)
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      ) : (
                      <div className="flex items-center gap-2 mt-1.5">
                        <AlertCircle className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground italic">
                          Activity metrics unavailable (GitHub is computing stats)
                        </span>
                      </div>
                      )}
                    </div>
                  </div>
                </TooltipProvider>
              );
            })}

            {/* Skeleton cards for pending repos */}
            {pendingCount > 0 &&
              Array.from({ length: Math.min(pendingCount, 5) }).map((_, i) => (
                <div key={`skeleton-${i}`} className="flex items-start gap-3 p-3">
                  <Skeleton className="h-4 w-4 mt-1 rounded" />
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Summary */}
      {summary && (
        <p className="text-sm text-muted-foreground text-center">
          Found {summary.shown} of {summary.total} matching filters
        </p>
      )}

      {/* Empty state */}
      {phase === 'done' && results.length === 0 && !error && (
        <div className="text-center py-8 text-muted-foreground">
          No repositories found matching your filters. Try broader criteria.
        </div>
      )}

      {/* Idle state */}
      {phase === 'idle' && (
        <div className="text-center py-8 text-muted-foreground">
          Search for public repositories with active development teams.
        </div>
      )}
    </div>
  );
}
```

**Step 2: Verify no TypeScript errors**

Run: `cd /c/Projects/AI-Code\ Audit/prototype && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 3: Commit**

```bash
git add prototype/src/components/explore-tab.tsx
git commit -m "feat(explore): add ExploreTab component with SSE streaming and activity cards"
```

---

## Task 4: Wire ExploreTab into orders/new page

**Files:**
- Modify: `prototype/src/app/(dashboard)/orders/new/page.tsx`

**Step 1: Add imports**

At top of file, add to lucide-react import (line 11-32) — add `Sparkles`:
```typescript
  Sparkles,
```

Add component import after line 53:
```typescript
import { ExploreTab } from '@/components/explore-tab';
import type { ExploreSearchResult } from '@/types/repository';
```

**Step 2: Update tabs from 2 columns to 3**

Change line 566:
```typescript
            <TabsList className="grid w-full grid-cols-2">
```
to:
```typescript
            <TabsList className="grid w-full grid-cols-3">
```

**Step 3: Add Explore tab trigger**

After line 574 (closing of Public Repository TabsTrigger), add:
```typescript
              <TabsTrigger value="explore" className="flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                Explore
              </TabsTrigger>
```

**Step 4: Add Explore tab content**

Find the section after the Public Repository content ends (before Period Settings / Continue button). Add the Explore tab rendering block. Look for the closing of the `sourceType === 'public'` conditional block and add after it:

```tsx
          {/* Explore Tab */}
          {sourceType === 'explore' && (
            <ExploreTab
              selectedRepoIds={new Set(selectedRepos.map((r) => r.id))}
              onToggleRepo={(repo: ExploreSearchResult) => {
                setSelectedRepos((prev) => {
                  const isSelected = prev.some((r) => r.id === repo.id);
                  if (isSelected) {
                    return prev.filter((r) => r.id !== repo.id);
                  }
                  return [...prev, {
                    id: repo.id,
                    name: repo.name,
                    fullName: repo.fullName,
                    description: repo.description,
                    url: repo.url,
                    cloneUrl: repo.cloneUrl,
                    language: repo.language,
                    stars: repo.stars,
                    updatedAt: repo.updatedAt,
                    createdAt: repo.createdAt,
                    pushedAt: repo.pushedAt,
                    sizeKb: repo.sizeKb,
                    isPrivate: repo.isPrivate,
                    defaultBranch: repo.defaultBranch,
                    owner: repo.owner,
                    source: 'public' as const,
                  }];
                });
              }}
              githubConnected={githubConnected}
            />
          )}
```

Note: `source` set to `'public'` intentionally — explore repos are public repos, the order creation API treats them the same way.

**Step 5: Verify no TypeScript errors**

Run: `cd /c/Projects/AI-Code\ Audit/prototype && npx tsc --noEmit --pretty 2>&1 | head -30`

**Step 6: Commit**

```bash
git add prototype/src/app/\(dashboard\)/orders/new/page.tsx
git commit -m "feat(explore): wire ExploreTab into order creation page as third tab"
```

---

## Task 5: Manual smoke test

**Step 1: Start dev server (background)**

Run: `cd /c/Projects/AI-Code\ Audit/prototype && pnpm dev &`
Wait for "Ready" message, then proceed. Keep the server running in background.

**Step 2: Test SSE endpoint directly**

Run: `curl -N --max-time 30 "http://localhost:3000/api/github/search?q=fastapi&minContributors=2&maxContributors=50&minActivityScore=1&minFullTimeRatio=0&minStars=100" 2>&1 | head -30`

Expected: SSE events streaming (event: phase, event: repo or event: skip, event: done)

**Step 3: Test in browser**

Navigate to http://localhost:3000/orders/new, verify:
1. Three tabs visible: My Repositories, Public Repository, Explore
2. Click Explore tab
3. Type "fastapi" in search, click Search
4. See "Searching GitHub..." then "Analyzing activity..."
5. Cards appear progressively with activity bars and full-time indicators
6. Cards with unavailable metrics show "Activity metrics unavailable" instead of bars
7. Filters are disabled during search, re-enabled on done
8. "Found N of 10 matching filters" summary appears
9. Clicking a card adds it to selected repos (visible in sticky footer)

**Step 4: Stop dev server**

Run: `kill %1` (or the PID of the pnpm dev process)

**Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(explore): smoke test fixes"
```

---

## Task 6: Build verification

**Step 1: Run production build**

Run: `cd /c/Projects/AI-Code\ Audit/prototype && pnpm build 2>&1 | tail -20`
Expected: Build succeeds with no errors

**Step 2: Run lint**

Run: `cd /c/Projects/AI-Code\ Audit/prototype && pnpm lint 2>&1 | tail -10`
Expected: No errors (warnings OK)

**Step 3: Commit any fixes**

If build/lint revealed issues, fix and commit.
