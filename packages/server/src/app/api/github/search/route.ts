import { NextRequest } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { getAuthenticatedGitHubUser } from '@/lib/github-client';
import { logger } from '@/lib/logger';
import { getActivityLevel, preFilterCandidates } from '@/lib/explore-utils';
import { checkRateLimit } from '@/lib/rate-limit';

// ── Constants ───────────────────────────────────────────────

/** Max repos to enrich via REST /stats/* endpoints */
const MAX_ENRICH = 15;

// ── GitHub REST API types (snake_case) ──────────────────────

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

// ── GraphQL types ───────────────────────────────────────────

interface GQLRepoOwner {
  login: string;
  avatarUrl: string;
}

interface GQLRepo {
  id: string;
  databaseId: number;
  name: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  sshUrl: string;
  primaryLanguage: { name: string } | null;
  stargazerCount: number;
  updatedAt: string;
  createdAt: string;
  pushedAt: string | null;
  diskUsage: number | null;
  isPrivate: boolean;
  isFork: boolean;
  defaultBranchRef: {
    name: string;
    target: {
      history: {
        totalCount: number;
      };
    };
  } | null;
  owner: GQLRepoOwner;
  mentionableUsers: {
    totalCount: number;
  };
}

interface GQLSearchResponse {
  data: {
    search: {
      repositoryCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GQLRepo[];
    };
  };
  errors?: Array<{ message: string }>;
}

// ── GraphQL query ───────────────────────────────────────────

/** Per-page limit for GraphQL search. GitHub's resource limits reject
 *  first:100 when nested connections (mentionableUsers, history) are present.
 *  20 per page × up to 5 pages = 100 repos max scanned. */
const GQL_PAGE_SIZE = 20;
const GQL_MAX_PAGES = 5;

const EXPLORE_GRAPHQL_QUERY = `
query ExploreSearch($query: String!, $first: Int!, $after: String, $since: GitTimestamp!) {
  search(query: $query, type: REPOSITORY, first: $first, after: $after) {
    repositoryCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on Repository {
        id
        databaseId
        name
        nameWithOwner
        description
        url
        sshUrl
        primaryLanguage { name }
        stargazerCount
        updatedAt
        createdAt
        pushedAt
        diskUsage
        isPrivate
        isFork
        defaultBranchRef {
          name
          target {
            ... on Commit {
              history(since: $since) {
                totalCount
              }
            }
          }
        }
        owner {
          login
          avatarUrl
        }
        mentionableUsers(first: 1) {
          totalCount
        }
      }
    }
  }
}
`;

// ── Helpers ─────────────────────────────────────────────────

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
    'User-Agent': 'DevGhost',
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
  const url = `https://api.github.com/repos/${fullName}/stats/commit_activity`;

  let res = await ghFetch(url, token, limits);

  // GitHub Stats API returns 202 (accepted) while computing.
  // Retry up to 3 times with exponential backoff: 2s, 4s, 6s
  if (res.status === 202) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const delay = attempt * 2000;
      await new Promise((r) => setTimeout(r, delay));
      res = await ghFetch(url, token, limits);
      if (res.ok || res.status !== 202) break;
    }
  }

  if (!res.ok || res.status === 202) return null;

  const data: GHWeeklyActivity[] = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const last12 = data.slice(-12);
  return last12.reduce((sum, w) => sum + w.total, 0) / last12.length;
}

/** Get full-time-like author count and ratio. Returns null if stats unavailable (202).
 *  Retries up to 3 times with exponential backoff: 2s, 4s, 6s. */
async function getFullTimeStats(
  fullName: string,
  token: string | null,
  limits: RateLimits
): Promise<{ fullTimeCount: number; fullTimeRatio: number } | null> {
  const url = `https://api.github.com/repos/${fullName}/stats/contributors`;

  let res = await ghFetch(url, token, limits);

  // GitHub Stats API returns 202 (accepted) while computing.
  // Retry up to 3 times with exponential backoff: 2s, 4s, 6s
  if (res.status === 202) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const delay = attempt * 2000;
      await new Promise((r) => setTimeout(r, delay));
      res = await ghFetch(url, token, limits);
      if (res.ok || res.status !== 202) break;
    }
  }

  if (!res.ok || res.status === 202) return null;

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

// ── GraphQL search (Phase 1) ────────────────────────────────

/**
 * Fetch repos via GitHub GraphQL API with mentionableUsers + recent commit counts.
 * Paginates in batches of GQL_PAGE_SIZE (20) up to GQL_MAX_PAGES (5) to avoid
 * GitHub's per-query resource limits (RESOURCE_LIMITS_EXCEEDED with first:100).
 * Returns null if no token (GraphQL requires auth) or if all pages fail.
 */
async function graphqlSearch(
  searchQuery: string,
  sinceDateISO: string,
  token: string | null
): Promise<GQLRepo[] | null> {
  if (!token) {
    logger.debug('GraphQL search skipped: no token');
    return null;
  }

  const allRepos: GQLRepo[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < GQL_MAX_PAGES; page++) {
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `bearer ${token}`,
          'User-Agent': 'DevGhost',
        },
        body: JSON.stringify({
          query: EXPLORE_GRAPHQL_QUERY,
          variables: {
            query: searchQuery,
            first: GQL_PAGE_SIZE,
            after: cursor,
            since: sinceDateISO,
          },
        }),
        cache: 'no-store',
      });

      if (!res.ok) {
        logger.warn({ status: res.status, page }, 'GraphQL search HTTP error');
        // If first page fails, return null (fallback to REST).
        // If later page fails, return what we have so far.
        return allRepos.length > 0 ? allRepos : null;
      }

      const body: GQLSearchResponse = await res.json();

      if (body.errors && body.errors.length > 0) {
        logger.warn({ errors: body.errors, page }, 'GraphQL search returned errors');
        return allRepos.length > 0 ? allRepos : null;
      }

      if (!body.data?.search?.nodes) {
        logger.warn({ page }, 'GraphQL search returned no data.search.nodes');
        return allRepos.length > 0 ? allRepos : null;
      }

      const validNodes = body.data.search.nodes.filter((n) => n && n.nameWithOwner);
      allRepos.push(...validNodes);

      logger.debug(
        { page, fetched: validNodes.length, total: allRepos.length, hasMore: body.data.search.pageInfo.hasNextPage },
        'GraphQL search page complete'
      );

      // Stop if no more pages
      if (!body.data.search.pageInfo.hasNextPage) break;
      cursor = body.data.search.pageInfo.endCursor;
    } catch (err) {
      logger.warn({ err, page }, 'GraphQL search page exception');
      return allRepos.length > 0 ? allRepos : null;
    }
  }

  logger.info({ totalFetched: allRepos.length }, 'GraphQL search complete');
  return allRepos.length > 0 ? allRepos : null;
}

/**
 * Convert a GraphQL repo node to the REST-like GHSearchRepo shape
 * so the enrichment phase can treat them uniformly.
 */
function gqlToRestShape(gql: GQLRepo): GHSearchRepo {
  return {
    id: gql.databaseId,
    name: gql.name,
    full_name: gql.nameWithOwner,
    description: gql.description,
    html_url: gql.url,
    // GraphQL doesn't return clone_url directly; construct from url
    clone_url: `${gql.url}.git`,
    language: gql.primaryLanguage?.name ?? null,
    stargazers_count: gql.stargazerCount,
    updated_at: gql.updatedAt,
    created_at: gql.createdAt,
    pushed_at: gql.pushedAt ?? gql.updatedAt,
    size: gql.diskUsage ?? 0,
    private: gql.isPrivate,
    default_branch: gql.defaultBranchRef?.name ?? 'main',
    owner: {
      login: gql.owner.login,
      avatar_url: gql.owner.avatarUrl,
    },
  };
}

// ── SSE Route ───────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get('q')?.trim();
  if (!q || q.length < 2) {
    return apiError('Query must be at least 2 characters', 400);
  }

  // Parse filter params (NaN-safe: explicit zero must not be overridden)
  const VALID_LANGUAGES = new Set([
    'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'Rust',
    'C++', 'C#', 'Ruby', 'PHP', 'Swift', 'Kotlin',
  ]);
  const rawLang = params.get('language')?.trim() || '';
  const language = VALID_LANGUAGES.has(rawLang) ? rawLang : '';
  const parseIntSafe = (v: string | null, def: number) => { const n = parseInt(v ?? '', 10); return isNaN(n) ? def : n; };
  const parseFloatSafe = (v: string | null, def: number) => { const n = parseFloat(v ?? ''); return isNaN(n) ? def : n; };
  const minContributors = Math.max(0, parseIntSafe(params.get('minContributors'), 2));
  const maxContributors = Math.max(minContributors, parseIntSafe(params.get('maxContributors'), 15));
  const minActivityScore = Math.max(0, parseFloatSafe(params.get('minActivityScore'), 5));
  const minStars = Math.max(0, parseIntSafe(params.get('minStars'), 0));
  const minFullTimeRatio = Math.max(0, Math.min(1, parseFloatSafe(params.get('minFullTimeRatio'), 0.5)));
  const sort = params.get('sort') === 'updated' ? 'updated' : 'stars';

  // Get GitHub token if user is authenticated
  let token: string | null = null;
  let userId: string | undefined;
  try {
    const user = await getAuthenticatedGitHubUser();
    token = user?.githubAccessToken ?? null;
    userId = user?.id;
  } catch {
    // Continue without token
  }

  // Rate limit: 3 req/hour per user (or IP if unauthenticated)
  const rateLimited = await checkRateLimit(request, 'analysis', userId);
  if (rateLimited) return rateLimited;

  // Build GitHub search query
  const pushedAfter = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  let searchQuery = `${q} pushed:>${pushedAfter} archived:false fork:false sort:${sort}`;
  if (language && language.trim().length > 0) searchQuery += ` language:${language.trim()}`;
  if (minStars > 0) searchQuery += ` stars:>=${minStars}`;

  // "since" date for GraphQL history(since:) — same 90-day window
  const sinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Initialize rate limits (updated from actual response headers on each ghFetch).
  // Within a batch, concurrent ghFetch calls update this object in parallel —
  // the last response wins, which is safe since GitHub's remaining count is
  // monotonically decreasing (latest = most conservative). Budget check
  // happens between batches, not within them.
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
        // ── Phase 1: Search + GraphQL pre-filter ──────────────
        controller.enqueue(
          encoder.encode(sseEvent('phase', { phase: 'searching', query: searchQuery }))
        );

        let candidates: GHSearchRepo[];
        let usedGraphQL = false;

        // Try GraphQL first (requires auth token)
        const gqlRepos = await graphqlSearch(searchQuery, sinceDate, token);

        if (gqlRepos !== null) {
          usedGraphQL = true;
          logger.info({ count: gqlRepos.length }, 'GraphQL search returned repos');

          const filtered = preFilterCandidates(
            gqlRepos,
            minContributors,
            maxContributors,
            minActivityScore
          );

          logger.info(
            { before: gqlRepos.length, after: filtered.length },
            'GraphQL pre-filter complete'
          );

          // Pre-filter phase — sent after filtering so we can report candidates count
          controller.enqueue(
            encoder.encode(sseEvent('phase', {
              phase: 'prefiltering',
              total: gqlRepos.length,
              candidates: filtered.length,
            }))
          );

          // Convert to REST shape and cap at MAX_ENRICH
          candidates = filtered.slice(0, MAX_ENRICH).map(gqlToRestShape);
        } else {
          // Fallback: REST search (10 results, no pre-filter)
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
          // REST fallback preserves default_branch from REST response
          candidates = searchData.items;
        }

        const total = candidates.length;

        // ── Phase 2: REST enrichment ──────────────────────────
        controller.enqueue(
          encoder.encode(sseEvent('phase', { phase: 'enriching', total }))
        );

        let shown = 0;
        let skipped = 0;
        let errors = 0;

        // Process repos in parallel batches of 3 to manage rate limits
        for (let i = 0; i < total; i += 3) {
          const batch = candidates.slice(i, Math.min(i + 3, total));

          if (limits.coreRemaining < batch.length * 3) {
            for (let j = i; j < total; j++) {
              skipped++;
              controller.enqueue(
                encoder.encode(
                  sseEvent('skip', {
                    index: j,
                    fullName: candidates[j].full_name,
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

        controller.enqueue(
          encoder.encode(
            sseEvent('done', {
              shown,
              skipped,
              errors,
              total,
              ...(usedGraphQL ? { pipeline: 'graphql' } : { pipeline: 'rest' }),
            })
          )
        );
        controller.close();
      } catch (err) {
        logger.error({ err }, 'Explore search stream error');
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
