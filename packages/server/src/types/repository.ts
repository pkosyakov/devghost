/**
 * Repository source types
 */
export type RepositorySourceType = 'connected' | 'public';

/**
 * Repository owner information
 */
export interface RepositoryOwner {
  login: string;
  avatarUrl: string;
}

/**
 * Selected repository for analysis
 * Used in Order.selectedRepos JSONB field
 */
export interface SelectedRepository {
  id: number;
  name: string;
  fullName: string;
  description?: string | null;
  url: string;
  cloneUrl: string;
  language: string | null;
  stars: number;
  isPrivate: boolean;
  defaultBranch: string;
  owner: RepositoryOwner;
  /** Source of the repository */
  source: RepositorySourceType;
  /** Size in KB (optional) */
  sizeKb?: number;
  /** Last update date (optional) */
  updatedAt?: string;
  /** Creation date (optional) */
  createdAt?: string;
  /** Last push date (optional) */
  pushedAt?: string;
}

/**
 * Repository from API response (before selection)
 */
export interface ApiRepository {
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
  defaultBranch?: string;
  owner: RepositoryOwner;
  source?: RepositorySourceType;
}

/**
 * Response from /api/github/repos (connected repositories)
 */
export interface ConnectedReposResponse {
  success: boolean;
  data?: {
    repositories: ApiRepository[];
    pagination: {
      page: number;
      perPage: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  };
  error?: string;
}

/**
 * Response from /api/github/public (public repository)
 */
export interface PublicRepoResponse {
  success: boolean;
  data?: {
    repository: ApiRepository & { source: 'public' };
  };
  error?: string;
}

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
  | { event: 'phase'; data: { phase: 'prefiltering'; total: number; candidates: number } }
  | { event: 'phase'; data: { phase: 'enriching'; total: number } }
  | { event: 'repo'; data: { index: number; repo: ExploreSearchResult; progress: string } }
  | { event: 'skip'; data: { index: number; fullName: string; reason: string; progress: string } }
  | { event: 'error'; data: { index: number; fullName: string; error: string; progress: string } }
  | { event: 'done'; data: { shown: number; skipped: number; errors: number; total: number } };
