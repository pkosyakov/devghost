# Explore Search v2 — Two-Phase GraphQL + REST Pipeline

**Date:** 2026-02-22
**Status:** Approved
**Supersedes:** `2026-02-22-explore-search-design.md` (REST-only approach)
**Location:** `/orders/new` — "Explore" tab

## Problem

v1 design searched 10 repos via REST, enriched all 10 (30 API calls), then filtered — resulting in 0 results with strict criteria. Contributor count, commit frequency, and full-time ratio are not searchable via GitHub Search API.

## Solution: Two-Phase Pipeline

### Phase 1: GraphQL Pre-Filter (1 API call, ~1-2 rate limit points)

Single GraphQL query fetches 100 search results with lightweight proxy metrics:
- `mentionableUsers.totalCount` — proxy for contributor count (over-counts: includes watchers, issue participants)
- `history(since: 3mo ago).totalCount` — proxy for commit activity

Pre-filter in memory with wide tolerance bands, no additional API calls.

### Phase 2: REST Enrichment (only surviving candidates)

Top 10-15 pre-filtered repos get exact metrics via REST `/stats/*` endpoints:
- Exact contributor count (Link header trick)
- Exact avg commits/week (12-week breakdown)
- Full-time detection (per-author weekly stats)

Final filter with exact values, stream results via SSE.

## Architecture

```
Client (Explore tab)                    Server (GET /api/github/search, SSE)
─────────────────                       ─────────────────────────────────────

keyword + filters ──── GET (SSE) ────→  1. Build GitHub search query:
                                           q="{keyword} pushed:>{90d ago}
                                              stars:>={minStars}
                                              fork:false
                                              archived:false
                                              language:{lang}"

                                        2. GraphQL search → 100 results with:
                                           - mentionableUsers { totalCount }
                                           - history.totalCount (all-time)
                                           - history(since: 3mo).totalCount

                 ◄──── SSE: phase ────  3. Stream: { phase: "prefiltering", total: 100 }

                                        4. In-memory pre-filter:
                                           - mentionableUsers in [1, maxContrib * 3]
                                           - recentCommits >= minActivity * 12
                                           → ~15-25 candidates

                 ◄──── SSE: phase ────  5. Stream: { phase: "enriching", total: N }

                                        6. REST enrich top 15 (batches of 3):
                                           - GET /contributors → exact count
                                           - GET /stats/commit_activity → avg/week
                                           - GET /stats/contributors → full-time

                 ◄──── SSE: repo ─────  7. Stream each enriched repo (if passes)
                 ◄──── SSE: skip ─────     or skip event

                 ◄──── SSE: done ─────  8. Stream: { phase: "done", shown: N, total: M }
```

## GraphQL Query

```graphql
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
        homepageUrl
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
}
```

**Variables:**
```json
{
  "query": "fastapi language:python pushed:>2025-11-24 fork:false archived:false stars:>=50 sort:stars",
  "since": "2025-11-24T00:00:00Z"
}
```

**Sort:** GraphQL search accepts `sort:stars` / `sort:updated` as query qualifiers (same as web UI). Must be included in the query string.

**Cost:** ~1-2 points. `mentionableUsers(first: 1)` fetches one node — negligible overhead. 5000 points/hr with token.

**Auth requirement:** GitHub GraphQL API **requires authentication** (token). Without token → automatic fallback to REST-only search.

## Pre-Filter Logic

```typescript
// mentionableUsers is larger than actual contributors.
// Use wide tolerance: if target is [min, max], pre-filter at [1, max * 3]
const mentionableMin = Math.max(1, minContributors - 1);
const mentionableMax = maxContributors * 3;

// recentCommits (3 months) as proxy for activity.
// Target: minActivityScore commits/week → need minActivityScore * 13 commits in ~13 weeks
const minRecentCommits = Math.max(1, Math.floor(minActivityScore * 13 * 0.5));
// 0.5 multiplier accounts for merge commits inflating the count

candidates = repos.filter(repo => {
  if (!repo.defaultBranchRef?.target) return false;  // empty repo
  const mentionable = repo.mentionableUsers.totalCount;
  const recentCommits = repo.defaultBranchRef.target.recent.totalCount;
  return mentionable >= mentionableMin
      && mentionable <= mentionableMax
      && recentCommits >= minRecentCommits;
});
```

## SSE Protocol

Same event types as v1, with one new phase:

```typescript
// New: pre-filtering phase
event: phase
data: { "phase": "prefiltering", "total": 100, "query": "..." }

// Updated: enriching shows how many passed pre-filter
event: phase
data: { "phase": "enriching", "total": 15, "prefiltered": 85 }

// Rest unchanged: repo, skip, error, done
```

## Query Parameters

Same as v1 — no client-side changes needed:

| Param | Type | Default | Description |
|---|---|---|---|
| `q` | string | required | Search keyword |
| `language` | string | - | Programming language filter |
| `minContributors` | number | 2 | Min contributors |
| `maxContributors` | number | 15 | Max contributors |
| `minActivityScore` | number | 5 | Min commits/week |
| `minStars` | number | 0 | Min stargazer count |
| `minFullTimeRatio` | number | 0.5 | Min full-time ratio |
| `sort` | string | "stars" | Sort: stars, updated |

## Error Handling

| Scenario | Behavior |
|---|---|
| GraphQL rate limit | `error` event, fallback to REST-only search (10 results) |
| GraphQL returns errors | Log, fallback to REST-only search |
| 0 candidates after pre-filter | `done` with `shown: 0`, UI: "No repos match criteria" |
| REST enrichment rate limit | Stop enrichment, return partial results |
| No token (unauthenticated) | GraphQL **requires auth** — fallback to REST-only search (10 results, 60 req/hr) |

## Key Design Decisions

1. **`fork:false` in search query** — forks inherit upstream commit history and falsely pass filters
2. **`mentionableUsers(first: 1)`** — `first: 1` instead of `first: 0` for defensive coding (docs say min is 1, though 0 works in practice). Overhead of one node is negligible, `totalCount` is the same regardless.
3. **`sort:stars`/`sort:updated` in query string** — GraphQL search uses same qualifiers as web UI. Sort must be embedded in the query string, not as a separate parameter.
4. **Wide tolerance band** — mentionableUsers over-counts; compensate with `max * 3` ceiling
5. **Cap enrichment at 15** — even if 25 pass pre-filter, limit REST calls to 45 (15 × 3)
6. **No `@octokit/graphql`** — use raw `fetch` POST to `https://api.github.com/graphql`, same pattern as existing `ghFetch`
7. **Graceful degradation** — if GraphQL fails (no token, rate limit, errors), fall back to REST-only v1 search (10 results). REST fallback preserves `default_branch` from response.
8. **GraphQL requires auth** — unauthenticated users always get REST-only path. This is acceptable degradation — they also have 60 req/hr REST limit.
