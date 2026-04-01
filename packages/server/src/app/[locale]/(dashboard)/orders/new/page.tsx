'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  Search,
  Star,
  Lock,
  Globe,
  ChevronLeft,
  ChevronRight,
  Github,
  ArrowRight,
  Users,
  HardDrive,
  Calendar,
  Clock,
  Plus,
  X,
  AlertCircle,
  History,
  Sparkles,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  AnalysisPeriodSelector,
  type AnalysisPeriodSettings,
  type PeriodStatistics,
} from '@/components/analysis-period-selector';
import { formatFileSize, formatRelativeTime, formatDate } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { RepositorySourceType } from '@/types/repository';
import { ExploreTab } from '@/components/explore-tab';
import type { ExploreSearchResult } from '@/types/repository';
import { useTranslations } from 'next-intl';
import { ScreenHelpTrigger } from '@/components/layout/screen-help-trigger';

interface GitHubRepo {
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
  owner: {
    login: string;
    avatarUrl: string;
  };
  contributorsCount?: number | null; // Loaded separately or from API
  source?: RepositorySourceType; // 'connected' or 'public'
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

function buildNonJsonResponseError(response: Response, rawBody: string): Error {
  const body = rawBody.trim();
  const contentType = response.headers.get('content-type') || 'unknown';
  if (body.startsWith('<!DOCTYPE') || body.startsWith('<html')) {
    return new Error(`Server returned HTML instead of JSON (HTTP ${response.status})`);
  }
  return new Error(
    `Server returned unexpected response format (HTTP ${response.status}, content-type: ${contentType})`
  );
}

async function parseApiEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  const raw = await response.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as ApiEnvelope<T>;
  } catch {
    throw buildNonJsonResponseError(response, raw);
  }
}

export default function NewOrderPage() {
  const router = useRouter();
  const t = useTranslations('orders.new');
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [hasPrevPage, setHasPrevPage] = useState(false);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [orderName, setOrderName] = useState('');
  const [contributorsCounts, setContributorsCounts] = useState<Record<number, number | 'loading' | 'error'>>({});

  // Tab selection: 'connected' (OAuth repos), 'public' (public repo by URL), or 'explore' (search)
  type TabType = 'connected' | 'public' | 'explore';
  const [sourceType, setSourceType] = useState<TabType>('connected');
  const [publicRepoInput, setPublicRepoInput] = useState('');
  const [publicRepos, setPublicRepos] = useState<GitHubRepo[]>([]);
  const [loadingPublicRepo, setLoadingPublicRepo] = useState(false);
  const [publicRepoError, setPublicRepoError] = useState<string | null>(null);

  // Search state for public repos
  const [searchResults, setSearchResults] = useState<GitHubRepo[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const searchDropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Repository history (stored in localStorage)
  const [repoHistory, setRepoHistory] = useState<GitHubRepo[]>([]);

  // Period settings
  const [periodSettings, setPeriodSettings] = useState<AnalysisPeriodSettings>({
    mode: 'ALL_TIME',
  });
  const [availableDateRange, setAvailableDateRange] = useState<{
    minDate: Date;
    maxDate: Date;
  } | null>(null);
  const [loadingDateRange, setLoadingDateRange] = useState(false);

  // Period statistics
  const [periodStatistics, setPeriodStatistics] = useState<PeriodStatistics | null>(null);

  useEffect(() => {
    checkGitHubConnection();
  }, []);

  const handleConnectGitHub = useCallback(() => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/api/github/oauth?returnTo=${encodeURIComponent(returnTo)}`;
  }, []);

  // Load repository history from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('publicRepoHistory');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setRepoHistory(parsed.slice(0, 10)); // Keep max 10 items
        }
      }
    } catch (err) {
      console.error('Failed to load repo history:', err);
    }
  }, []);

  useEffect(() => {
    if (githubConnected) {
      fetchRepos();
    }
  }, [page, githubConnected]);

  // Load contributors count for visible repos
  useEffect(() => {
    if (repos.length === 0) return;

    repos.forEach((repo) => {
      if (contributorsCounts[repo.id] === undefined) {
        loadContributorsCount(repo);
      }
    });
  }, [repos]);

  // Load available date range when repositories are selected
  useEffect(() => {
    if (selectedRepos.length === 0) {
      setAvailableDateRange(null);
      return;
    }

    const loadDateRange = async () => {
      setLoadingDateRange(true);
      try {
        const repoNames = selectedRepos.map((r) => r.fullName).join(',');
        const response = await fetch(`/api/github/repos/date-range?repos=${encodeURIComponent(repoNames)}`);
        const data = await response.json();

        if (response.ok && data.success) {
          setAvailableDateRange({
            minDate: new Date(data.data.minDate),
            maxDate: new Date(data.data.maxDate),
          });
        }
      } catch (err) {
        console.error('Failed to load date range:', err);
      } finally {
        setLoadingDateRange(false);
      }
    };

    loadDateRange();
  }, [selectedRepos]);

  // Load period statistics when period changes
  useEffect(() => {
    if (selectedRepos.length === 0) {
      setPeriodStatistics(null);
      return;
    }

    // AbortController to cancel in-flight requests when period changes
    const abortController = new AbortController();

    const loadPeriodStats = async () => {
      setPeriodStatistics({ commitsCount: 0, developersCount: 0, isLoading: true, isEstimate: false });

      try {
        // Build filter params based on period mode
        const startDate = periodSettings.mode === 'DATE_RANGE' ? periodSettings.startDate : undefined;
        const endDate = periodSettings.mode === 'DATE_RANGE' ? periodSettings.endDate : undefined;
        const commitLimit = periodSettings.mode === 'LAST_N_COMMITS' ? periodSettings.commitLimit : undefined;

        // Aggregate stats from all selected repos in parallel
        const statsPromises = selectedRepos.map(async (repo) => {
          const [owner, repoName] = repo.fullName.split('/');
          const source = repo.source || 'connected';

          const params = new URLSearchParams({
            owner,
            repo: repoName,
            source,
          });

          if (startDate) {
            params.append('startDate', startDate.toISOString());
          }
          if (endDate) {
            params.append('endDate', endDate.toISOString());
          }
          if (commitLimit) {
            params.append('limit', commitLimit.toString());
          }

          const response = await fetch(`/api/github/period-stats?${params.toString()}`, {
            signal: abortController.signal,
          });
          const data = await response.json();

          if (response.ok && data.success) {
            return {
              commitsCount: data.data.commitsCount,
              developersCount: data.data.developersCount,
              isEstimate: data.data.isEstimate || false,
            };
          }
          return { commitsCount: 0, developersCount: 0, isEstimate: false };
        });

        const results = await Promise.all(statsPromises);

        // Check if request was aborted before updating state
        if (abortController.signal.aborted) {
          return;
        }

        // Aggregate results
        const totalCommits = results.reduce((sum, r) => sum + r.commitsCount, 0);
        // For developer count, use sum (will be deduplicated during actual analysis)
        const totalDevs = results.reduce((sum, r) => sum + r.developersCount, 0);
        // If ANY repo hit the limit, mark total as estimate
        const anyEstimate = results.some((r) => r.isEstimate);

        setPeriodStatistics({
          commitsCount: totalCommits,
          developersCount: totalDevs,
          isLoading: false,
          isEstimate: anyEstimate,
        });
      } catch (err) {
        // Ignore abort errors
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        console.error('Failed to load period stats:', err);
        setPeriodStatistics({ commitsCount: 0, developersCount: 0, isLoading: false, isEstimate: false });
      }
    };

    // Debounce the stats loading to avoid too many requests
    const timeoutId = setTimeout(loadPeriodStats, 500);
    return () => {
      clearTimeout(timeoutId);
      abortController.abort(); // Cancel any in-flight requests
    };
  }, [selectedRepos, periodSettings]);

  // Debounced search for public repos
  useEffect(() => {
    const trimmed = publicRepoInput.trim();

    // If empty or contains "/" (direct owner/repo input), don't search
    if (trimmed.length < 2 || trimmed.includes('/')) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    setSearchLoading(true);
    const timeoutId = setTimeout(async () => {
      try {
        const response = await fetch(`/api/github/search?q=${encodeURIComponent(trimmed)}`);
        const data = await response.json();
        if (response.ok && data.success) {
          setSearchResults(data.data.repositories);
          setShowSearchResults(true);
        } else {
          setSearchResults([]);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 400);

    return () => {
      clearTimeout(timeoutId);
      setSearchLoading(false);
    };
  }, [publicRepoInput]);

  // Close search dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        searchDropdownRef.current &&
        !searchDropdownRef.current.contains(e.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(e.target as Node)
      ) {
        setShowSearchResults(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Add repo from search results
  const addFromSearch = useCallback((repo: GitHubRepo) => {
    // Check if already added
    if (publicRepos.some((r) => r.id === repo.id) || selectedRepos.some((r) => r.id === repo.id)) {
      setPublicRepoError(t('alreadyAdded'));
      setShowSearchResults(false);
      return;
    }

    const newRepo: GitHubRepo = { ...repo, source: 'public' };
    setPublicRepos((prev) => [...prev, newRepo]);
    setSelectedRepos((prev) => [...prev, newRepo]);
    setPublicRepoInput('');
    setShowSearchResults(false);
    setSearchResults([]);
    saveToRepoHistory(newRepo);
  }, [publicRepos, selectedRepos]);

  // Format star count (e.g. 7800 → "7.8k")
  const formatStars = (count: number): string => {
    if (count >= 1000) {
      return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return count.toString();
  };

  const loadContributorsCount = async (repo: GitHubRepo) => {
    setContributorsCounts((prev) => ({ ...prev, [repo.id]: 'loading' }));
    try {
      const [owner, repoName] = repo.fullName.split('/');
      const response = await fetch(`/api/github/repos/${owner}/${repoName}/contributors`);
      const data = await response.json();
      if (response.ok && data.success) {
        setContributorsCounts((prev) => ({ ...prev, [repo.id]: data.data.count }));
      } else {
        setContributorsCounts((prev) => ({ ...prev, [repo.id]: 'error' }));
      }
    } catch {
      setContributorsCounts((prev) => ({ ...prev, [repo.id]: 'error' }));
    }
  };

  const checkGitHubConnection = async () => {
    try {
      const response = await fetch('/api/github/connect');
      const data = await response.json();
      setGithubConnected(data.success && data.data.isConnected);
      if (!data.success || !data.data.isConnected) {
        setLoading(false);
      }
    } catch {
      setGithubConnected(false);
      setLoading(false);
    }
  };

  const fetchRepos = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/github/repos?page=${page}&per_page=20&sort=updated&direction=desc`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t('failedFetchRepos'));
      }

      setRepos(data.data.repositories);
      setHasNextPage(data.data.pagination.hasNextPage);
      setHasPrevPage(data.data.pagination.hasPrevPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedFetchRepos'));
    } finally {
      setLoading(false);
    }
  };

  const toggleRepo = (repo: GitHubRepo) => {
    setSelectedRepos((prev) => {
      const isSelected = prev.some((r) => r.id === repo.id);
      if (isSelected) {
        return prev.filter((r) => r.id !== repo.id);
      }
      return [...prev, repo];
    });
  };

  // Add public repository by URL
  const addPublicRepo = async () => {
    if (!publicRepoInput.trim()) return;

    setLoadingPublicRepo(true);
    setPublicRepoError(null);

    try {
      const response = await fetch(
        `/api/github/public?repo=${encodeURIComponent(publicRepoInput.trim())}`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t('failedFetchRepo'));
      }

      const repo = data.data.repository;

      // Check if already added
      if (publicRepos.some((r) => r.id === repo.id) || selectedRepos.some((r) => r.id === repo.id)) {
        setPublicRepoError(t('alreadyAdded'));
        return;
      }

      // Add to public repos list with source marker
      const newRepo: GitHubRepo = {
        id: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        description: repo.description,
        url: repo.url,
        cloneUrl: repo.cloneUrl,
        language: repo.language,
        stars: repo.stars,
        updatedAt: repo.updatedAt || '',
        createdAt: repo.createdAt || '',
        pushedAt: repo.pushedAt || '',
        sizeKb: repo.sizeKb || 0,
        isPrivate: repo.isPrivate,
        defaultBranch: repo.defaultBranch || 'main',
        contributorsCount: repo.contributorsCount,
        owner: repo.owner,
        source: 'public',
      };

      setPublicRepos((prev) => [...prev, newRepo]);
      setSelectedRepos((prev) => [...prev, newRepo]);
      setPublicRepoInput('');

      // Save to history
      saveToRepoHistory(newRepo);
    } catch (err) {
      setPublicRepoError(err instanceof Error ? err.message : t('failedAddRepo'));
    } finally {
      setLoadingPublicRepo(false);
    }
  };

  // Save repository to history (localStorage)
  const saveToRepoHistory = (repo: GitHubRepo) => {
    try {
      const existing = localStorage.getItem('publicRepoHistory');
      let history: GitHubRepo[] = existing ? JSON.parse(existing) : [];

      // Remove if already exists (to move to top)
      history = history.filter((r) => r.id !== repo.id);

      // Add to beginning
      history.unshift(repo);

      // Keep max 10 items
      history = history.slice(0, 10);

      localStorage.setItem('publicRepoHistory', JSON.stringify(history));
      setRepoHistory(history);
    } catch (err) {
      console.error('Failed to save repo history:', err);
    }
  };

  // Add repository from history
  const addFromHistory = (repo: GitHubRepo) => {
    // Check if already added
    if (publicRepos.some((r) => r.id === repo.id) || selectedRepos.some((r) => r.id === repo.id)) {
      setPublicRepoError(t('alreadyAdded'));
      return;
    }

    setPublicRepos((prev) => [...prev, repo]);
    setSelectedRepos((prev) => [...prev, repo]);
  };

  // Remove from history
  const removeFromHistory = (repoId: number) => {
    try {
      const newHistory = repoHistory.filter((r) => r.id !== repoId);
      localStorage.setItem('publicRepoHistory', JSON.stringify(newHistory));
      setRepoHistory(newHistory);
    } catch (err) {
      console.error('Failed to remove from history:', err);
    }
  };

  // Remove public repository
  const removePublicRepo = (repoId: number) => {
    setPublicRepos((prev) => prev.filter((r) => r.id !== repoId));
    setSelectedRepos((prev) => prev.filter((r) => r.id !== repoId));
  };

  const handleCreate = async () => {
    if (selectedRepos.length === 0) return;

    setCreating(true);
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: orderName || undefined, // server generates name from repos if empty
          selectedRepos: selectedRepos.map((r) => ({
            id: r.id,
            name: r.name,
            full_name: r.fullName,
            url: r.url,
            clone_url: r.cloneUrl,
            language: r.language,
            stars: r.stars,
            is_private: r.isPrivate,
            owner: r.owner,
            default_branch: r.defaultBranch || 'main',
            source: r.source || 'connected',
            sizeKb: r.sizeKb,
          })),
          // Period settings
          analysisPeriodMode: periodSettings.mode,
          analysisStartDate: periodSettings.startDate?.toISOString(),
          analysisEndDate: periodSettings.endDate?.toISOString(),
          analysisCommitLimit: periodSettings.mode === 'LAST_N_COMMITS' ? periodSettings.commitLimit : undefined,
        }),
      });

      const data = await parseApiEnvelope<{ id?: string }>(response);

      if (!response.ok) {
        throw new Error(data.error || t('failedCreateOrder'));
      }

      const orderId = data.data?.id;
      if (!orderId) {
        throw new Error(t('failedCreateOrder'));
      }
      router.push(`/orders/${orderId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedCreateOrder'));
      setCreating(false);
    }
  };

  const filteredRepos = repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(search.toLowerCase()) ||
      repo.fullName.toLowerCase().includes(search.toLowerCase()) ||
      repo.description?.toLowerCase().includes(search.toLowerCase())
  );

  // When GitHub is not connected, we still allow public repos
  // No longer block the entire page

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Button variant="ghost" onClick={() => router.back()}>
            <ChevronLeft className="h-4 w-4 mr-2" />
            {t('back')}
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{t('title')}</h1>
            <p className="text-muted-foreground">
              {t('description')}
            </p>
          </div>
        </div>
        <ScreenHelpTrigger
          screenTitle={t('title')}
          what={t('help.what')}
          how={t('help.how')}
          className="mt-1"
        />
      </div>

      <div className="rounded-lg border border-dashed bg-muted/20 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <Label htmlFor="analysis-name-input" className="text-sm font-medium">
              {t('analysisNameOptional')}
            </Label>
            <p className="text-sm text-muted-foreground">{t('analysisNameHint')}</p>
          </div>
          <Input
            id="analysis-name-input"
            className="md:max-w-md"
            placeholder={t('analysisNamePlaceholder')}
            value={orderName}
            onChange={(e) => setOrderName(e.target.value)}
          />
        </div>
      </div>

      {/* Repository Selection */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('selectRepos')}</CardTitle>
              <CardDescription>
                {t('selectReposDescription')}
              </CardDescription>
            </div>
            {selectedRepos.length > 0 && (
              <Badge variant="secondary">
                {t('selectedCount', { count: selectedRepos.length })}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Source Type Selector */}
          <Tabs value={sourceType} onValueChange={(v) => setSourceType(v as TabType)}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="connected" className="flex items-center gap-2">
                <Github className="h-4 w-4" />
                {t('myRepos')}
              </TabsTrigger>
              <TabsTrigger value="public" className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t('publicRepo')}
              </TabsTrigger>
              <TabsTrigger value="explore" className="flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                {t('explore')}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {githubConnected !== true && (
            <Card className="border-dashed">
              <CardContent className="grid gap-3 pt-6 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('publicAccessTitle')}</p>
                  <p className="text-sm text-muted-foreground">{t('publicAccessDescription')}</p>
                </div>

                <div className="hidden h-12 w-px bg-border md:block" />

                <div className="flex flex-col gap-3 md:items-start">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t('privateAccessTitle')}</p>
                    <p className="text-sm text-muted-foreground">{t('privateAccessDescription')}</p>
                  </div>

                  <Button variant="outline" size="sm" onClick={handleConnectGitHub}>
                    <Github className="mr-2 h-4 w-4" />
                    {t('connectGithubNow')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Public Repo Input (when public source selected) */}
          {sourceType === 'public' && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    ref={searchInputRef}
                    placeholder={t('searchOrEnterRepo')}
                    value={publicRepoInput}
                    onChange={(e) => {
                      setPublicRepoInput(e.target.value);
                      setPublicRepoError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && publicRepoInput.includes('/')) {
                        e.preventDefault();
                        addPublicRepo();
                      }
                      if (e.key === 'Escape') {
                        setShowSearchResults(false);
                      }
                    }}
                    onFocus={() => {
                      if (searchResults.length > 0 && !publicRepoInput.includes('/')) {
                        setShowSearchResults(true);
                      }
                    }}
                    className="pl-9"
                    disabled={loadingPublicRepo}
                  />
                  {searchLoading && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                  )}

                  {/* Search results dropdown */}
                  {showSearchResults && searchResults.length > 0 && (
                    <div
                      ref={searchDropdownRef}
                      className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg max-h-80 overflow-auto"
                    >
                      {searchResults.map((repo) => {
                        const alreadyAdded = publicRepos.some((r) => r.id === repo.id) || selectedRepos.some((r) => r.id === repo.id);
                        return (
                          <div
                            key={repo.id}
                            className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                              alreadyAdded
                                ? 'opacity-50 cursor-default bg-muted/30'
                                : 'hover:bg-accent'
                            }`}
                            onClick={() => !alreadyAdded && addFromSearch(repo)}
                          >
                            <Avatar className="h-6 w-6 flex-shrink-0 mt-0.5">
                              <AvatarImage src={repo.owner.avatarUrl} alt={repo.owner.login} />
                              <AvatarFallback className="text-[10px]">{repo.owner.login[0]?.toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm truncate">{repo.fullName}</span>
                                <span className="flex items-center gap-0.5 text-xs text-muted-foreground flex-shrink-0">
                                  <Star className="h-3 w-3" />
                                  {formatStars(repo.stars)}
                                </span>
                                {repo.language && (
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 flex-shrink-0">
                                    {repo.language}
                                  </Badge>
                                )}
                                {alreadyAdded && (
                                  <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 flex-shrink-0">
                                    {t('added')}
                                  </Badge>
                                )}
                              </div>
                              {repo.description && (
                                <p className="text-xs text-muted-foreground truncate mt-0.5">
                                  {repo.description}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Show Add button only when input looks like owner/repo */}
                {publicRepoInput.includes('/') && (
                  <Button
                    onClick={addPublicRepo}
                    disabled={!publicRepoInput.trim() || loadingPublicRepo}
                  >
                    {loadingPublicRepo ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    <span className="ml-2">{t('add')}</span>
                  </Button>
                )}
              </div>

              {/* Public repo error */}
              {publicRepoError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{publicRepoError}</AlertDescription>
                </Alert>
              )}

              {/* Rate limit warning - only show if GitHub not connected */}
              {!githubConnected && (
                <p className="text-xs text-muted-foreground">
                  {t('rateLimitWarning')}
                </p>
              )}

              {/* Repository History */}
              {repoHistory.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <History className="h-4 w-4" />
                    <span>{t('recentRepositories')}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {repoHistory
                      .filter((r) => !publicRepos.some((pr) => pr.id === r.id) && !selectedRepos.some((sr) => sr.id === r.id))
                      .map((repo) => (
                        <div
                          key={repo.id}
                          className="group flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 hover:bg-muted rounded-md border text-sm cursor-pointer transition-colors"
                          onClick={() => addFromHistory(repo)}
                        >
                          <Avatar className="h-4 w-4">
                            <AvatarImage src={repo.owner.avatarUrl} alt={repo.owner.login} />
                            <AvatarFallback className="text-[8px]">{repo.owner.login[0]?.toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <span className="truncate max-w-[200px]">{repo.fullName}</span>
                          {repo.language && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                              {repo.language}
                            </Badge>
                          )}
                          <button
                            className="opacity-0 group-hover:opacity-100 ml-1 p-0.5 hover:bg-destructive/20 rounded transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFromHistory(repo.id);
                            }}
                            title={t('removeFromHistory')}
                          >
                            <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* List of added public repos */}
              {publicRepos.length > 0 && (
                <div className="border rounded-md">
                  <div className="p-2 space-y-1">
                    {publicRepos.map((repo) => (
                      <TooltipProvider key={repo.id}>
                        <div className="flex items-start gap-3 p-3 rounded-md bg-primary/5 border border-primary/20">
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
                            {/* Stats Row */}
                            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                              {repo.language && (
                                <Badge variant="secondary" className="text-xs">
                                  {repo.language}
                                </Badge>
                              )}
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Star className="h-3 w-3" />
                                {repo.stars.toLocaleString()}
                              </span>
                              {/* Contributors */}
                              {repo.contributorsCount !== undefined && (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <Users className="h-3 w-3" />
                                  {repo.contributorsCount?.toLocaleString() ?? '—'}
                                </span>
                              )}
                              {/* Size */}
                              {repo.sizeKb > 0 && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                      <HardDrive className="h-3 w-3" />
                                      {formatFileSize(repo.sizeKb)}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('repoSize')}</TooltipContent>
                                </Tooltip>
                              )}
                              {/* Last updated */}
                              {repo.pushedAt && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                      <Clock className="h-3 w-3" />
                                      {formatRelativeTime(repo.pushedAt)}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {t('lastPush', { date: formatDate(repo.pushedAt) })}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              {/* Created */}
                              {repo.createdAt && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                      <Calendar className="h-3 w-3" />
                                      {formatDate(repo.createdAt)}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('createdAt')}</TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 flex-shrink-0"
                            onClick={() => removePublicRepo(repo.id)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </TooltipProvider>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

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

          {/* Connected repos section */}
          {sourceType === 'connected' && (
            <>
              {/* Search (only for connected repos) */}
              {githubConnected && (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('searchRepos')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="p-4 text-center">
                  <p className="text-destructive mb-2">{error}</p>
                  <Button variant="outline" size="sm" onClick={fetchRepos}>
                    {t('retry')}
                  </Button>
                </div>
              )}

              {/* Loading / Repo List */}
              {githubConnected && (
                loading ? (
                  <div className="flex items-center justify-center h-48">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredRepos.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    {search ? t('noMatchingRepos') : t('noReposFound')}
                  </div>
                ) : (
            <>
              {/* Repository List */}
              <div className="border rounded-md max-h-96 overflow-auto">
                <div className="p-2 space-y-1">
                  {filteredRepos.map((repo) => {
                    const isSelected = selectedRepos.some((r) => r.id === repo.id);
                    const contribCount = contributorsCounts[repo.id];
                    return (
                      <TooltipProvider key={repo.id}>
                        <div
                          onClick={() => toggleRepo(repo)}
                          className={`flex items-start gap-3 p-3 rounded-md cursor-pointer transition-colors ${
                            isSelected ? 'bg-primary/10 border border-primary' : 'hover:bg-accent'
                          }`}
                        >
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRepo(repo)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1"
                          />
                          {/* Owner Avatar */}
                          <Avatar className="h-8 w-8 flex-shrink-0">
                            <AvatarImage src={repo.owner.avatarUrl} alt={repo.owner.login} />
                            <AvatarFallback>{repo.owner.login[0]?.toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{repo.fullName}</span>
                              {repo.isPrivate ? (
                                <Lock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                              ) : (
                                <Globe className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                              )}
                            </div>
                            {repo.description && (
                              <p className="text-sm text-muted-foreground truncate mt-0.5">
                                {repo.description}
                              </p>
                            )}
                            {/* Stats Row */}
                            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                              {repo.language && (
                                <Badge variant="secondary" className="text-xs">
                                  {repo.language}
                                </Badge>
                              )}
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Star className="h-3 w-3" />
                                {repo.stars}
                              </span>
                              {/* Contributors */}
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Users className="h-3 w-3" />
                                {contribCount === 'loading' ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : contribCount === 'error' ? (
                                  '—'
                                ) : (
                                  contribCount ?? '—'
                                )}
                              </span>
                              {/* Size */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <HardDrive className="h-3 w-3" />
                                    {formatFileSize(repo.sizeKb)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>{t('repoSize')}</TooltipContent>
                              </Tooltip>
                              {/* Last updated */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Clock className="h-3 w-3" />
                                    {formatRelativeTime(repo.pushedAt || repo.updatedAt)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t('lastPush', { date: formatDate(repo.pushedAt || repo.updatedAt) })}
                                </TooltipContent>
                              </Tooltip>
                              {/* Created */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Calendar className="h-3 w-3" />
                                    {formatDate(repo.createdAt)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>{t('createdAt')}</TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                        </div>
                      </TooltipProvider>
                    );
                  })}
                </div>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={!hasPrevPage || loading}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  {t('previous')}
                </Button>
                <span className="text-sm text-muted-foreground">{t('pageNumber', { page })}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!hasNextPage || loading}
                >
                  {t('next')}
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </>
                )
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Analysis Period */}
      {selectedRepos.length > 0 && (
        <AnalysisPeriodSelector
          settings={periodSettings}
          onChange={setPeriodSettings}
          availableStartDate={availableDateRange?.minDate}
          availableEndDate={availableDateRange?.maxDate}
          isLoadingDateRange={loadingDateRange}
          statistics={periodStatistics || undefined}
        />
      )}

      {/* Selected Repos Summary & Create Button */}
      {selectedRepos.length > 0 && (
        <Card className="shadow-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {t('reposSelected', { count: selectedRepos.length })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedRepos.map((r) => r.name).join(', ')}
                </p>
              </div>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4 mr-2" />
                )}
                {t('continue')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
