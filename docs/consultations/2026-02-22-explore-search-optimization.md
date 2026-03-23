# Expert Consultation: Explore Search — Efficient Repository Discovery

**Date:** 2026-02-22
**Project:** DevGhost — Developer Efficiency Analytics
**Component:** Explore tab (`/orders/new`) — public repository search with activity filtering
**Status:** Design phase, seeking review before implementation

---

## Goal

Find public GitHub repositories matching specific team/activity criteria for developer productivity analysis:
- **Contributor count** in range (e.g. 2–15)
- **Commit activity** above threshold (e.g. 5+ commits/week over last 12 weeks)
- **Full-time developer ratio** (e.g. 50%+ of contributors commit regularly)

## Problem

GitHub Search API (REST) supports only basic qualifiers: keyword, language, stars, forks, size, pushed date, archived status. There is **no native filter** for contributor count, commit frequency, or team composition.

### Current Design (not yet implemented)

```
User enters keyword + filters
        │
        ▼
GitHub REST Search API ──► top 10 results
        │
        ▼
Parallel enrichment per repo (3 REST calls each):
  - GET /repos/{r}/contributors?per_page=1  → contributor count (Link header)
  - GET /repos/{r}/stats/commit_activity    → avg commits/week (12 weeks)
  - GET /repos/{r}/stats/contributors       → per-author weekly breakdown → full-time detection
        │
        ▼
Server-side filter by minContributors, maxContributors, minActivityScore, minFullTimeRatio
        │
        ▼
Stream results to client via SSE
```

### Why This Fails

1. **Tiny funnel**: only 10 candidates enter the pipeline. With strict filters (2–15 contributors, 5+ commits/week, 50%+ full-time), most or all get eliminated. Typical outcome: 0 results.

2. **Wasted API budget**: 30 REST calls (10 repos × 3 calls) spent on repos that get filtered out. With unauthenticated users (60 req/hr core limit), this exhausts the budget on a single search.

3. **Slow**: `/stats/*` endpoints often return 202 (computing) on first call, requiring 2s retry. Total pipeline: 5–15 seconds for 0 results.

4. **Can't just increase to 100**: enriching 100 repos = 300 REST calls. Exceeds rate limits, takes minutes.

## Proposed Solution: Two-Phase Pipeline with GraphQL Pre-Filter

### Key Insight

GitHub GraphQL API can return **mentionableUsers count** and **recent commit count** alongside search results in a **single request**. These serve as approximate proxies for contributor count and activity score, enabling cheap pre-filtering before expensive REST enrichment.

### Architecture

```
Phase 1: GraphQL Search + Pre-Filter (1 API call, ~2-5 rate limit points)
──────────────────────────────────────────────────────────────────────────

  search(query: "keyword language:X pushed:>90d stars:>=N", type: REPOSITORY, first: 100)
    → for each repo:
        mentionableUsers { totalCount }       ← proxy for contributor count
        defaultBranchRef.target.history {
          totalCount                          ← all-time commits
          recent: history(since: "3mo ago") {
            totalCount                        ← commits in last 3 months
          }
        }

  Pre-filter (in-memory, no API calls):
    - mentionableUsers.totalCount in [minContributors, maxContributors * 2]
      (wider range because mentionableUsers ≈ but ≠ contributors)
    - recent commits > threshold (e.g. 60 in 3 months ≈ 5/week)

  Output: ~15–25 candidates from 100 initial results


Phase 2: REST Enrichment (only surviving candidates)
────────────────────────────────────────────────────

  For top 10–15 candidates (capped):
    - GET /repos/{r}/contributors?per_page=1  → exact contributor count
    - GET /repos/{r}/stats/commit_activity    → exact avg commits/week
    - GET /repos/{r}/stats/contributors       → full-time detection

  Final filter with exact values

  Output: ~6–10 results, streamed via SSE
```

### Comparison

|                          | Current Design       | Proposed              |
|--------------------------|---------------------|-----------------------|
| Initial pool             | 10                  | **100**               |
| Pre-filter API cost      | 0                   | **1 GraphQL call**    |
| Repos entering enrichment| 10 (all)            | 10–15 (pre-filtered)  |
| REST calls for enrichment| 30                  | 30–45                 |
| **Total API calls**      | **31**              | **~35**               |
| Expected hit rate        | ~0–20%              | **~60–80%**           |
| Time to results          | 5–15s for 0 results | 5–10s for 6–10 results|

### GraphQL Query Draft

```graphql
query ExploreSearch($query: String!) {
  rateLimit { cost remaining resetAt }
  search(query: $query, type: REPOSITORY, first: 100) {
    repositoryCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Repository {
        databaseId
        nameWithOwner
        description
        url
        stargazerCount
        forkCount
        primaryLanguage { name }
        pushedAt
        createdAt
        isArchived
        isPrivate
        defaultBranchRef {
          name
          target {
            ... on Commit {
              history { totalCount }
              recent: history(since: $since) { totalCount }
            }
          }
        }
        mentionableUsers(first: 0) { totalCount }
      }
    }
  }
}
```

Variables:
```json
{
  "query": "fastapi language:python pushed:>2025-11-24 archived:false stars:>=50",
  "since": "2025-11-24T00:00:00Z"
}
```

## Open Questions for Expert

### 1. mentionableUsers as contributor proxy — how reliable?

`mentionableUsers` includes people who participated in issues, discussions, commits — not exactly the same as REST `/contributors` (which counts commit authors). From research:
- Sometimes smaller than contributor count (misses anonymous/bot contributors)
- Sometimes larger (includes issue participants who never committed)
- No clear documentation on exact criteria

**Question:** Is this proxy good enough for pre-filtering with a wider tolerance band (e.g. if target is 2–15, pre-filter at 1–30)? Are there better GraphQL fields? `assignableUsers` requires push access and won't work for public repos we don't own.

### 2. GraphQL rate limit cost for this query

A single `search` with `first: 100` and nested fields costs variable points. The `rateLimit { cost }` field reports actual cost after execution.

**Question:** What is the expected cost of this query? If it's 10+ points, should we reduce `first` to 50? Is there a way to estimate cost before execution?

### 3. history(since:) totalCount accuracy

`history(since: ...) { totalCount }` on the default branch only. Doesn't account for:
- Commits on other branches not merged
- Merge commits vs actual commits

**Question:** Is totalCount of recent commits a good enough proxy for "commits/week"? Should we account for merge commits somehow?

### 4. Alternative: fetch 100 via REST Search + paginate, then GraphQL batch?

Another approach: REST search returns 100 results (per_page=100), then batch-query those 100 repos via GraphQL `nodes(ids: [...])` to get mentionableUsers + history in one call.

**Question:** Is this better or worse than doing it all in GraphQL search? REST search returns `node_id` for each repo which can be used in GraphQL `nodes()` query.

### 5. Edge cases

- Repos with no default branch (empty repos) — `defaultBranchRef` will be null
- Monorepos with huge commit counts — `history.totalCount` may be very large
- Forks — should we exclude forks from search? (`fork:false` qualifier)

### 6. Are there better approaches entirely?

Other options considered but not deeply evaluated:
- **Libraries.io API**: has `contributions_count` per package, but only for packages in registries (npm, PyPI, etc.), not arbitrary repos
- **GH Archive + BigQuery**: could pre-compute "repos with N contributors and X commits/week" but requires BigQuery setup, billing, and periodic refresh
- **OSS Insight (ossinsight.io)**: uses TiDB + GH Archive, has API for repo activity metrics — but unclear if it has a search endpoint

**Question:** Any other data sources or approaches worth considering?

## Context

### System Overview

DevGhost analyzes developer productivity by:
1. User selects GitHub repositories (this is where Explore search helps)
2. System clones repos, extracts commit data
3. LLM-based effort estimation per commit
4. Calculates developer metrics (productivity, effective rate, cost)

The Explore tab helps users discover interesting public repos to analyze — repos with active teams of manageable size, not single-person projects or massive 500+ contributor projects.

### Technical Stack
- Next.js 16 (App Router), React 19
- SSE streaming for progressive results
- GitHub REST API v3 (currently) + potentially GraphQL v4

### Relevant Files
- Design doc: `docs/plans/2026-02-22-explore-search-design.md`
- Implementation plan: `docs/plans/2026-02-22-explore-search-implementation.md`
