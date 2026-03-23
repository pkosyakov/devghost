# Explore Tab — Public Repository Search with Activity Filtering

**Date:** 2026-02-22
**Status:** Approved
**Location:** `/orders/new` — new "Explore" tab alongside "My Repositories" and "Public Repository"

## Overview

Advanced public repository search on the order creation page. Users search by keyword and get results pre-filtered by team size, commit activity, and full-time developer patterns. Server-side pipeline handles enrichment and filtering; results stream to the client via SSE as they become ready.

## Architecture

### Server-side Search Pipeline

```
Client (Explore tab)                    Server (GET /api/github/search, SSE)
─────────────────                       ─────────────────────────────────────

keyword + filters ──── GET (SSE) ────→  1. Build GitHub Search query:
                                           q="{keyword} pushed:>{90d ago}
                                              stars:>={minStars}
                                              archived:false
                                              language:{lang}"

                                        2. GET /search/repositories → top 10

                 ◄──── SSE: phase ────  3. Stream: { phase: "enriching", total: 10 }

                                        4. Parallel enrich each repo:
                                           - GET /repos/{r}/contributors?per_page=1
                                             → parse Link header → total count
                                           - GET /repos/{r}/stats/commit_activity
                                             → avg commits/week (last 12 weeks)
                                           - GET /repos/{r}/stats/contributors
                                             → per-author weekly breakdown

                 ◄──── SSE: repo ─────  5. Stream each enriched repo (if passes filters)
                 ◄──── SSE: skip ─────     or skip event (if filtered out)

                 ◄──── SSE: done ─────  6. Stream: { phase: "done", shown: N, total: 10 }
```

### Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `q` | string | required | Search keyword |
| `language` | string | - | Programming language filter |
| `minContributors` | number | 2 | Min contributors |
| `maxContributors` | number | 15 | Max contributors |
| `minActivityScore` | number | 5 | Min commits/week (12-week avg) |
| `minStars` | number | 0 | Min stargazer count |
| `minFullTimeRatio` | number | 0.5 | Min ratio of full-time-like authors |
| `sort` | string | "stars" | Sort: stars, updated (GitHub API native) |

### Authentication

- If user has `githubAccessToken` — use it (5000 core req/hr)
- Otherwise — unauthenticated (60 core req/hr) with warning in UI
- Search API limit is 10 req/min regardless of auth

## Activity Scoring

Based on `/repos/{r}/stats/commit_activity` (52 weeks of data):

```
activityScore = avg(commits for last 12 weeks)

Levels:
  Low:    < 3 commits/week   (gray)
  Medium: 3-10 commits/week  (yellow)
  High:   > 10 commits/week  (green)
```

## Full-time Detection

Based on `/repos/{r}/stats/contributors` — per-author weekly breakdown:

```
For each author over last 12 weeks:
  active_weeks = weeks where commits > 0
  consistency = active_weeks / 12

Author is "full-time-like" if:
  consistency >= 0.6 (commits in 7+ of 12 weeks)
  AND total_commits >= 20 over 12 weeks

full_time_count = authors meeting both criteria
full_time_ratio = full_time_count / total_contributors
```

## SSE Protocol

### Event Types

```typescript
// 1. Search started
event: phase
data: { "phase": "searching", "query": "fastapi language:python ..." }

// 2. Enrichment started
event: phase
data: { "phase": "enriching", "total": 10 }

// 3. Repo passed filters
event: repo
data: { "index": 0, "repo": { "fullName": "...", ... }, "progress": "1/10" }

// 4. Repo filtered out
event: skip
data: { "index": 1, "fullName": "...", "reason": "contributors: 142", "progress": "2/10" }

// 5. Enrichment error for one repo (non-fatal)
event: error
data: { "index": 3, "fullName": "...", "error": "rate_limited", "progress": "4/10" }

// 6. Complete
event: done
data: { "shown": 6, "skipped": 3, "errors": 1, "total": 10 }
```

## Error Handling

| Scenario | Behavior |
|---|---|
| Search returns 0 results | `done` with `shown: 0`, UI: "No repositories found" |
| Search API rate limit (10/min) | `error` event with `retryAfter`, UI shows countdown |
| Core API rate limit (enrichment) | Stop enrichment, return partial results + warning |
| Single repo enrichment fails | `error` event for that repo, continue others |
| No token + near limit | Warning: "Connect GitHub for more results" |
| SSE connection dropped | Client closes stream, shows "Connection lost. Try again." (no auto-reconnect — stream is 3-8s, retry would duplicate results) |
| `/stats/*` returns 202 (computing) | Retry once after 2s, if still 202 — mark `metricsAvailable: false`, skip activity/full-time filters for this repo |

### Rate Limit Tracking

Server reads `X-RateLimit-Remaining` / `X-RateLimit-Reset` headers from every `ghFetch` response and updates a shared counter. Stops enrichment if `core.remaining < 3`. Warns about search limit if `search.remaining < 2`. Initial values come from the search response headers, then updated after each enrichment call.

## UI Design

### Explore Tab Layout

```
┌─────────────────────────────────────────────────────────────┐
│  My Repositories    Public Repository    ▶ Explore          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────┐  ┌──────────────────┐  │
│  │ Search repositories...          │  │  Search          │  │
│  └─────────────────────────────────┘  └──────────────────┘  │
│                                                             │
│  ┌─ Filters ──────────────────────────────────────────────┐ │
│  │  Language        Contributors      Activity            │ │
│  │  ┌──────────┐   ┌────┐  ┌────┐   ┌────────────────┐   │ │
│  │  │ Any    ▼ │   │ 2  │─ │ 15 │   │ 5+ commits/wk  │   │ │
│  │  └──────────┘   └────┘  └────┘   └────────────────┘   │ │
│  │                                                        │ │
│  │  Min Stars       Full-time ratio                       │ │
│  │  ┌──────────┐   ┌────────────────┐                     │ │
│  │  │ 50       │   │ 50%+         ▼ │                     │ │
│  │  └──────────┘   └────────────────┘                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ── Searching... (3/10 analyzed) ─────────────────────────  │
│                                                             │
│  ┌────────────────────────────────────────────────────┐     │
│  │  tiangolo/fastapi                         ⭐ 82.1k │     │
│  │  Python · Updated 2 days ago                       │     │
│  │  ████████████░  12.3 commits/wk    Contributors: 8 │     │
│  │  Full-time: 5/8 (63%)              High activity   │     │
│  │                                           [+ Add]  │     │
│  └────────────────────────────────────────────────────┘     │
│                                                             │
│  ┌ skeleton ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ ┐     │
│  │           Analyzing...                              │     │
│  └ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ ┘     │
│                                                             │
│  ── Found 6 of 10 matching filters ──────────────────────── │
│                                                             │
│  ⚠ Without GitHub connection: limited to 60 req/hr.        │
│    Connect GitHub for better results.                       │
└─────────────────────────────────────────────────────────────┘
```

### SSE-driven UX Flow

1. User clicks Search → filters lock (disabled), progress: "Searching GitHub..."
2. `phase: enriching` → "Analyzing activity... (0/10)"
3. `repo` events → cards appear as they pass filters, skeletons for pending
4. `skip` events → skeleton removed, progress counter updates
5. `done` → filters unlock, "Found 6 of 10 matching filters"

### Search Result Card Data

```typescript
interface SearchResult {
  // From Search API
  fullName: string
  description: string
  language: string
  stars: number
  pushedAt: string
  url: string
  cloneUrl: string
  defaultBranch: string
  owner: { login: string; avatarUrl: string }

  // From enrichment
  contributorsCount: number
  activityScore: number        // commits/week (12-week avg)
  activityLevel: 'low' | 'medium' | 'high'
  fullTimeCount: number
  fullTimeRatio: number        // fullTimeCount / contributorsCount
}
```

`[+ Add]` button adds to `selectedRepos` array with `source: 'public'`, same as existing tabs.

## Scope

### In scope
- New "Explore" tab on `/orders/new`
- `GET /api/github/search` SSE endpoint with enrichment pipeline
- Activity scoring (commits/week) and full-time detection
- Server-side filtering by contributors, activity, full-time ratio
- Rate limit awareness with auth-adaptive behavior
- Streaming UX with skeleton cards

### Out of scope
- Result caching (Redis/in-memory) — deferred
- Catalog/category browsing
- Pagination / "Load more" beyond top 10
- Saved searches / search history
