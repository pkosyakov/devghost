'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
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
import type { ExploreSearchResult } from '@/types/repository';

// ── Types ───────────────────────────────────────────────────

interface ExploreTabProps {
  selectedRepoIds: Set<number>;
  onToggleRepo: (repo: ExploreSearchResult) => void;
  githubConnected: boolean | null;
}

type SearchPhase = 'idle' | 'searching' | 'prefiltering' | 'enriching' | 'done';

// ── Constants ───────────────────────────────────────────────

const LANGUAGES = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'Rust',
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
    <TooltipProvider>
      <Tooltip>
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
      </Tooltip>
    </TooltipProvider>
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

  // Close EventSource on unmount
  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const isLoading = phase === 'searching' || phase === 'prefiltering' || phase === 'enriching';
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  const handleSearch = useCallback(() => {
    if (!query.trim() || isLoadingRef.current) return;

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

    es.addEventListener('phase', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data);
      setPhase(data.phase as SearchPhase);
      if (data.phase === 'enriching' && data.total) setPendingCount(data.total);
    });

    es.addEventListener('repo', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data);
      setResults((prev) => [...prev, data.repo]);
      setProgress(data.progress);
      setPendingCount((prev) => Math.max(0, prev - 1));
    });

    es.addEventListener('skip', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data);
      setProgress(data.progress);
      setPendingCount((prev) => Math.max(0, prev - 1));
    });

    es.addEventListener('error', (e: Event) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.error === 'rate_limited') {
          setError(`GitHub API rate limit exceeded. Retry in ${data.progress.split(':')[1]}s. ${!githubConnected ? 'Connect GitHub for higher limits.' : ''}`);
        } else if (data.error?.startsWith('search_failed')) {
          setError(`GitHub search failed (${data.error.split(':')[1]}). Try again later.`);
        }
        setProgress(data.progress);
        setPendingCount((prev) => Math.max(0, prev - 1));
      } catch {
        // EventSource native error (parse failed)
        Sentry.captureException(new Error('SSE error event parse failed'), {
          tags: { component: 'explore-search-sse' },
          extra: { query, lastEventId: (es as EventSource & { lastEventId?: string }).lastEventId },
        });
        setError('Connection lost. Try searching again.');
        setPhase('done');
        es.close();
      }
    });

    es.addEventListener('done', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data);
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
      Sentry.captureException(new Error('SSE connection lost'), {
        tags: { component: 'explore-search-sse' },
        extra: { query, lastEventId: (es as EventSource & { lastEventId?: string }).lastEventId },
      });
      setError('Connection lost. Try searching again.');
      setPhase('done');
      setPendingCount(0);
      es.close();
    };
  }, [query, language, minContributors, maxContributors, minActivityScore, minStars, minFullTimeRatio, sort, githubConnected]);

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
          {phase === 'prefiltering' && 'Pre-filtering candidates...'}
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
