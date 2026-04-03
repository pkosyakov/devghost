'use client';

import { useState, useEffect, Fragment, useMemo, useCallback, useRef } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useSession } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { commitColor } from '@/components/developer-effort-chart';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  GitCommit,
  Clock,
  FileCode,
  Plus,
  Minus,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Loader2,
  Brain,
  Filter,
  Zap,
  ArrowUpDown,
  CalendarDays,
  Check,
  X,
} from 'lucide-react';

interface CommitAnalysis {
  id: string;
  commitHash: string;
  commitMessage: string;
  authorEmail: string;
  authorName: string;
  authorDate: string;
  repository: string;
  additions: number;
  deletions: number;
  filesCount: number;
  effortHours: number;
  category: string | null;
  complexity: string | null;
  confidence: number;
  analyzedAt: string;
}

interface CommitStats {
  totalCommits: number;
  totalEffortHours: number;
  totalAdditions: number;
  totalDeletions: number;
  avgConfidence: number;
  avgEffortHours: number;
}

interface CommitDistributionEntry {
  date: string;
  effort: number;
}

interface CommitAnalysisTableProps {
  orderId: string;
  authorEmail?: string;
  commitDistribution?: Record<string, CommitDistributionEntry[]>;
  highlightedCommit?: string | null;
}

type CommitSortField =
  | 'authorDate'
  | 'commitHash'
  | 'authorName'
  | 'category'
  | 'complexity'
  | 'additions'
  | 'effortHours'
  | 'confidence';

type CommitSortOrder = 'asc' | 'desc';

const categoryColors: Record<string, string> = {
  feature: 'bg-green-500',
  bugfix: 'bg-red-500',
  refactor: 'bg-blue-500',
  docs: 'bg-purple-500',
  test: 'bg-yellow-500',
  chore: 'bg-gray-500',
};

const complexityColors: Record<string, string> = {
  trivial: 'text-green-600',
  simple: 'text-lime-600',
  moderate: 'text-yellow-600',
  complex: 'text-orange-600',
  expert: 'text-red-600',
};

export function CommitAnalysisTable({ orderId, authorEmail, commitDistribution, highlightedCommit }: CommitAnalysisTableProps) {
  const t = useTranslations('orders.commitsTab');
  const locale = useLocale();
  const { data: session } = useSession();
  const gtAuthor = session?.user?.email ?? '';
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';

  const categoryConfig: Record<string, { label: string; color: string }> = {
    feature: { label: t('catFeature'), color: categoryColors.feature },
    bugfix: { label: t('catBugfix'), color: categoryColors.bugfix },
    refactor: { label: t('catRefactor'), color: categoryColors.refactor },
    docs: { label: t('catDocs'), color: categoryColors.docs },
    test: { label: t('catTest'), color: categoryColors.test },
    chore: { label: t('catChore'), color: categoryColors.chore },
  };

  const complexityConfig: Record<string, { label: string; color: string }> = {
    trivial: { label: t('cxTrivial'), color: complexityColors.trivial },
    simple: { label: t('cxSimple'), color: complexityColors.simple },
    moderate: { label: t('cxModerate'), color: complexityColors.moderate },
    complex: { label: t('cxComplex'), color: complexityColors.complex },
    expert: { label: t('cxExpert'), color: complexityColors.expert },
  };
  const [commits, setCommits] = useState<CommitAnalysis[]>([]);
  const [stats, setStats] = useState<CommitStats | null>(null);
  const [categoryBreakdown, setCategoryBreakdown] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

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
  const [totalCount, setTotalCount] = useState(0);
  const [pageSize] = useState(25);

  // State for effort distribution expansion
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((hash: string) => {
    setExpandedCommits((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  // Ground truth inline editing
  const [gtMap, setGtMap] = useState<Map<string, number>>(new Map());
  const [gtEditing, setGtEditing] = useState<string | null>(null);
  const [gtSaving, setGtSaving] = useState<Set<string>>(new Set());
  const [gtSaved, setGtSaved] = useState<Set<string>>(new Set());
  const [gtError, setGtError] = useState<Set<string>>(new Set());
  const gtCancelledRef = useRef(false);

  // Fetch existing GT entries for this order
  useEffect(() => {
    if (!gtAuthor) return;
    fetch(`/api/orders/${orderId}/ground-truth`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.entries) return;
        const map = new Map<string, number>();
        for (const entry of data.entries) {
          if (entry.author === gtAuthor) {
            map.set(entry.commitHash, entry.hours);
          }
        }
        setGtMap(map);
      })
      .catch(() => {}); // GT is optional, don't block UI
  }, [orderId, gtAuthor]);

  const saveGt = useCallback(async (commitHash: string, value: string) => {
    if (!gtAuthor) return;

    // Empty value = clear the GT entry (local + DB)
    if (!value.trim()) {
      if (gtMap.has(commitHash)) {
        setGtMap(prev => {
          const next = new Map(prev);
          next.delete(commitHash);
          return next;
        });
        // Fire-and-forget DELETE for this single entry
        fetch(`/api/orders/${orderId}/ground-truth?author=${encodeURIComponent(gtAuthor)}&commitHash=${encodeURIComponent(commitHash)}`, {
          method: 'DELETE',
        }).catch(() => {});
      }
      return;
    }

    const hours = parseFloat(value);
    if (isNaN(hours) || hours < 0) return;

    setGtSaving(prev => new Set(prev).add(commitHash));
    try {
      const res = await fetch(`/api/orders/${orderId}/ground-truth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [{ commitHash, hours }],
          author: gtAuthor,
        }),
      });
      if (res.ok) {
        setGtMap(prev => new Map(prev).set(commitHash, hours));
        setGtSaved(prev => new Set(prev).add(commitHash));
        setTimeout(() => {
          setGtSaved(prev => {
            const next = new Set(prev);
            next.delete(commitHash);
            return next;
          });
        }, 1500);
      } else {
        setGtError(prev => new Set(prev).add(commitHash));
        setTimeout(() => {
          setGtError(prev => {
            const next = new Set(prev);
            next.delete(commitHash);
            return next;
          });
        }, 3000);
      }
    } catch {
      setGtError(prev => new Set(prev).add(commitHash));
      setTimeout(() => {
        setGtError(prev => {
          const next = new Set(prev);
          next.delete(commitHash);
          return next;
        });
      }, 3000);
    } finally {
      setGtSaving(prev => {
        const next = new Set(prev);
        next.delete(commitHash);
        return next;
      });
    }
  }, [orderId, gtAuthor, gtMap]);

  // Filters
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterComplexity, setFilterComplexity] = useState<string>('all');
  const [sortBy, setSortBy] = useState<CommitSortField>('authorDate');
  const [sortOrder, setSortOrder] = useState<CommitSortOrder>('desc');

  const handleFilterCategoryChange = useCallback((value: string) => {
    setPage(1);
    setFilterCategory(value);
  }, []);

  const handleFilterComplexityChange = useCallback((value: string) => {
    setPage(1);
    setFilterComplexity(value);
  }, []);

  const handleSortByChange = useCallback((value: string) => {
    setPage(1);
    setSortBy(value as CommitSortField);
  }, []);

  const handleSortOrderChange = useCallback((value: string) => {
    setPage(1);
    setSortOrder(value as CommitSortOrder);
  }, []);

  const handleSortByColumn = useCallback((column: CommitSortField) => {
    setPage(1);
    if (sortBy === column) {
      setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
      return;
    }
    setSortBy(column);
    setSortOrder('desc');
  }, [sortBy]);

  // Build distribution map from prop
  const distributionByCommit = useMemo(() => {
    if (!commitDistribution) return new Map<string, CommitDistributionEntry[]>();
    return new Map(Object.entries(commitDistribution));
  }, [commitDistribution]);

  const fetchCommits = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        sortBy,
        sortOrder,
      });

      if (filterCategory !== 'all') {
        params.set('category', filterCategory);
      }
      if (filterComplexity !== 'all') {
        params.set('complexity', filterComplexity);
      }
      if (authorEmail) {
        params.set('authorEmail', authorEmail);
      }

      const response = await fetch(`/api/orders/${orderId}/commits?${params}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch commits');
      }

      setCommits(data.data.commits);
      setStats(data.data.stats);
      setCategoryBreakdown(data.data.categoryBreakdown);
      setTotalPages(data.data.pagination.totalPages);
      setTotalCount(data.data.pagination.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch commits');
    } finally {
      setLoading(false);
    }
  }, [orderId, page, pageSize, filterCategory, filterComplexity, sortBy, sortOrder, authorEmail]);

  useEffect(() => {
    fetchCommits();
  }, [fetchCommits]);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(dateLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatEffort = (hours: number) => {
    if (hours < 1) {
      return `${Math.round(hours * 60)}m`;
    }
    return `${hours.toFixed(1)}h`;
  };

  const sortIcon = (column: CommitSortField) => {
    if (sortBy !== column) {
      return <ArrowUpDown className="h-3.5 w-3.5 opacity-60 group-hover:opacity-100" />;
    }
    return sortOrder === 'asc'
      ? <ChevronUp className="h-3.5 w-3.5" />
      : <ChevronDown className="h-3.5 w-3.5" />;
  };

  const sortHeaderButtonClass = (align: 'left' | 'center' | 'right' = 'left') => {
    const justifyClass =
      align === 'right'
        ? 'justify-end'
        : align === 'center'
          ? 'justify-center'
          : 'justify-start';
    return `group inline-flex w-full items-center ${justifyClass} gap-1 transition-colors hover:text-foreground`;
  };

  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={fetchCommits}>
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardDescription className="text-xs flex items-center gap-1">
                <GitCommit className="h-3 w-3" />
                {t('commits')}
              </CardDescription>
              <CardTitle className="text-lg">{stats.totalCommits}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardDescription className="text-xs flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {t('totalEffort')}
              </CardDescription>
              <CardTitle className="text-lg">{formatEffort(stats.totalEffortHours)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardDescription className="text-xs flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {t('avgEffort')}
              </CardDescription>
              <CardTitle className="text-lg">{formatEffort(stats.avgEffortHours)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardDescription className="text-xs flex items-center gap-1">
                <Brain className="h-3 w-3" />
                {t('confidence')}
              </CardDescription>
              <CardTitle className="text-lg">{(stats.avgConfidence * 100).toFixed(0)}%</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardDescription className="text-xs flex items-center gap-1 text-green-600">
                <Plus className="h-3 w-3" />
                {t('additions')}
              </CardDescription>
              <CardTitle className="text-lg text-green-600">+{stats.totalAdditions.toLocaleString()}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardDescription className="text-xs flex items-center gap-1 text-red-600">
                <Minus className="h-3 w-3" />
                {t('deletions')}
              </CardDescription>
              <CardTitle className="text-lg text-red-600">-{stats.totalDeletions.toLocaleString()}</CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}

      {/* Filters & Sorting */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Filters Section */}
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">{t('filters')}:</span>
            </div>

            <Select value={filterCategory} onValueChange={handleFilterCategoryChange}>
              <SelectTrigger className="w-[160px] h-9">
                <SelectValue placeholder={t('allCategories')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allCategories')}</SelectItem>
                {Object.entries(categoryConfig).map(([key, config]) => (
                  <SelectItem key={key} value={key}>
                    {config.label} {categoryBreakdown[key] ? `(${categoryBreakdown[key]})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={filterComplexity} onValueChange={handleFilterComplexityChange}>
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue placeholder={t('allComplexity')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allComplexity')}</SelectItem>
                {Object.entries(complexityConfig).map(([key, config]) => (
                  <SelectItem key={key} value={key}>{config.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Separator */}
            <div className="h-6 w-px bg-border mx-1" />

            {/* Sorting Section */}
            <div className="flex items-center gap-2">
              <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">{t('sort')}:</span>
            </div>

            <Select value={sortBy} onValueChange={handleSortByChange}>
              <SelectTrigger className="w-[120px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="commitHash">{t('commit')}</SelectItem>
                <SelectItem value="authorName">{t('author')}</SelectItem>
                <SelectItem value="category">{t('category')}</SelectItem>
                <SelectItem value="complexity">{t('complexity')}</SelectItem>
                <SelectItem value="authorDate">{t('date')}</SelectItem>
                <SelectItem value="additions">{t('changes')}</SelectItem>
                <SelectItem value="effortHours">{t('effortCol')}</SelectItem>
                <SelectItem value="confidence">{t('confidenceCol')}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sortOrder} onValueChange={handleSortOrderChange}>
              <SelectTrigger className="w-[130px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">{t('descending')}</SelectItem>
                <SelectItem value="asc">{t('ascending')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Commits Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : commits.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <GitCommit className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">{t('noData')}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="w-8 px-2"></th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('left')}
                          onClick={() => handleSortByColumn('commitHash')}
                          aria-label={`${t('sort')}: ${t('commit')}`}
                        >
                          {t('commit')}
                          {sortIcon('commitHash')}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('left')}
                          onClick={() => handleSortByColumn('authorName')}
                          aria-label={`${t('sort')}: ${t('author')}`}
                        >
                          {t('author')}
                          {sortIcon('authorName')}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('left')}
                          onClick={() => handleSortByColumn('category')}
                          aria-label={`${t('sort')}: ${t('category')}`}
                        >
                          {t('category')}
                          {sortIcon('category')}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('center')}
                          onClick={() => handleSortByColumn('complexity')}
                          aria-label={`${t('sort')}: ${t('complexity')}`}
                        >
                          {t('complexity')}
                          {sortIcon('complexity')}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('right')}
                          onClick={() => handleSortByColumn('additions')}
                          aria-label={`${t('sort')}: ${t('changes')}`}
                        >
                          {t('changes')}
                          {sortIcon('additions')}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('right')}
                          onClick={() => handleSortByColumn('effortHours')}
                          aria-label={`${t('sort')}: ${t('effortCol')}`}
                        >
                          {t('effortCol')}
                          {sortIcon('effortHours')}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider w-[80px]">
                        {t('gtCol')}
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('right')}
                          onClick={() => handleSortByColumn('confidence')}
                          aria-label={`${t('sort')}: ${t('confidenceCol')}`}
                        >
                          {t('confidenceCol')}
                          {sortIcon('confidence')}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <button
                          type="button"
                          className={sortHeaderButtonClass('right')}
                          onClick={() => handleSortByColumn('authorDate')}
                          aria-label={`${t('sort')}: ${t('dateCol')}`}
                        >
                          {t('dateCol')}
                          {sortIcon('authorDate')}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {commits.map((commit) => (
                      <Fragment key={commit.id}>
                        <tr
                          className="hover:bg-muted/30 cursor-pointer"
                          style={highlightedCommit === commit.commitHash ? {
                            boxShadow: `inset 0 0 0 2px ${commitColor(commit.commitHash)}`,
                            backgroundColor: `${commitColor(commit.commitHash)}15`,
                          } : undefined}
                          onClick={() => toggleRow(commit.id)}
                        >
                          <td className="px-2 py-3">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              aria-label={expandedRows.has(commit.id) ? 'Collapse details' : 'Expand details'}
                              aria-expanded={expandedRows.has(commit.id)}
                            >
                              {expandedRows.has(commit.id) ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </Button>
                          </td>
                          <td className="px-4 py-3">
                            <div className="max-w-[300px]">
                              <div className="flex items-center gap-2">
                                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                                  {commit.commitHash.slice(0, 7)}
                                </code>
                              </div>
                              <p className="text-sm mt-1 truncate">{commit.commitMessage}</p>
                              <p className="text-xs text-muted-foreground">{commit.repository}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div>
                              <span className="font-medium text-sm">{commit.authorName}</span>
                              <p className="text-xs text-muted-foreground">{commit.authorEmail}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {commit.category && categoryConfig[commit.category] ? (
                              <Badge
                                variant="secondary"
                                className={`${categoryConfig[commit.category].color} text-white`}
                              >
                                {categoryConfig[commit.category].label}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-sm">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {commit.complexity && complexityConfig[commit.complexity] ? (
                              <span className={`text-sm font-medium ${complexityConfig[commit.complexity].color}`}>
                                {complexityConfig[commit.complexity].label}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-sm">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2 text-sm">
                              <span className="text-green-600">+{commit.additions}</span>
                              <span className="text-red-600">-{commit.deletions}</span>
                              <span className="text-muted-foreground flex items-center gap-1">
                                <FileCode className="h-3 w-3" />
                                {commit.filesCount}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-medium">{formatEffort(commit.effortHours)}</span>
                              {distributionByCommit.has(commit.commitHash) && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleExpand(commit.commitHash);
                                  }}
                                  className="text-muted-foreground hover:text-foreground"
                                  title={t('showEffortSpread')}
                                >
                                  {expandedCommits.has(commit.commitHash) ? (
                                    <ChevronUp className="h-4 w-4" />
                                  ) : (
                                    <ChevronDown className="h-4 w-4" />
                                  )}
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                            {gtEditing === commit.commitHash ? (
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                className="w-[70px] h-7 px-1.5 text-sm text-right border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                                defaultValue={gtMap.get(commit.commitHash) ?? ''}
                                autoFocus
                                onFocus={() => { gtCancelledRef.current = false; }}
                                onBlur={(e) => {
                                  setGtEditing(null);
                                  if (gtCancelledRef.current) return;
                                  saveGt(commit.commitHash, e.target.value);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    (e.target as HTMLInputElement).blur();
                                  }
                                  if (e.key === 'Escape') {
                                    gtCancelledRef.current = true;
                                    setGtEditing(null);
                                  }
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-sm hover:text-foreground min-w-[40px] justify-end"
                                onClick={() => setGtEditing(commit.commitHash)}
                                title={t('gtCol')}
                              >
                                {gtSaving.has(commit.commitHash) ? (
                                  <Loader2 className="h-3 w-3 animate-spin" title={t('gtSaving')} />
                                ) : gtSaved.has(commit.commitHash) ? (
                                  <Check className="h-3 w-3 text-green-500" title={t('gtSaved')} />
                                ) : gtError.has(commit.commitHash) ? (
                                  <X className="h-3 w-3 text-red-500" title={t('gtError')} />
                                ) : null}
                                <span className={gtMap.has(commit.commitHash) ? 'font-medium' : 'text-muted-foreground'}>
                                  {gtMap.has(commit.commitHash) ? formatEffort(gtMap.get(commit.commitHash)!) : t('gtPlaceholder')}
                                </span>
                              </button>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="text-sm font-medium">
                              {(commit.confidence * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-muted-foreground">
                            {formatDate(commit.authorDate)}
                          </td>
                        </tr>
                        {/* Expanded Details Row */}
                        {expandedRows.has(commit.id) && (
                          <tr className="bg-muted/20">
                            <td colSpan={10} className="px-4 py-4">
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                {/* Commit Details */}
                                <div className="space-y-3">
                                  <h4 className="text-sm font-semibold flex items-center gap-2">
                                    <Zap className="h-4 w-4" />
                                    {t('details')}
                                  </h4>
                                  <div className="grid grid-cols-2 gap-2 text-sm">
                                    <div className="flex items-center gap-2">
                                      <Brain className="h-3 w-3 text-muted-foreground" />
                                      <span className="text-muted-foreground">{t('confidenceCol')}:</span>
                                      <span>{(commit.confidence * 100).toFixed(0)}%</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Clock className="h-3 w-3 text-muted-foreground" />
                                      <span className="text-muted-foreground">{t('effortCol')}:</span>
                                      <span>{formatEffort(commit.effortHours)}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <FileCode className="h-3 w-3 text-muted-foreground" />
                                      <span className="text-muted-foreground">{t('files')}:</span>
                                      <span>{commit.filesCount}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <GitCommit className="h-3 w-3 text-muted-foreground" />
                                      <span className="text-muted-foreground">{t('hash')}:</span>
                                      <code className="font-mono text-xs">{commit.commitHash.slice(0, 12)}</code>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        {/* Effort Distribution Row (chevron toggle) */}
                        {expandedCommits.has(commit.commitHash) && (() => {
                          const entries = distributionByCommit.get(commit.commitHash);
                          if (!entries?.length) return null;

                          const maxEffort = Math.max(...entries.map((d: { effort: number }) => d.effort));

                          return (
                            <tr className="bg-muted/30">
                              <td colSpan={10} className="px-8 py-3">
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2 text-sm">
                                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                    <span className="font-medium">{t('effortSpread')}</span>
                                    <span className="text-xs text-muted-foreground">
                                      ({t('effortSpreadSummary', { effort: formatEffort(commit.effortHours), count: entries.length })})
                                    </span>
                                  </div>
                                  <div className="space-y-1.5 max-w-lg">
                                    {entries.map((d: { date: string; effort: number }) => {
                                      const pct = maxEffort > 0 ? (d.effort / maxEffort) * 100 : 0;
                                      const dayOfWeek = new Date(d.date + 'T00:00:00Z').getUTCDay();
                                      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                      const dayLabel = [t('daySun'),t('dayMon'),t('dayTue'),t('dayWed'),t('dayThu'),t('dayFri'),t('daySat')][dayOfWeek];
                                      return (
                                        <div key={d.date} className="flex items-center gap-2 text-xs">
                                          <span className={`font-mono w-[100px] shrink-0 ${isWeekend ? 'text-amber-600' : 'text-muted-foreground'}`}>
                                            {dayLabel} {d.date.slice(5)}
                                          </span>
                                          <div className="flex-1 h-5 bg-muted/50 rounded overflow-hidden">
                                            <div
                                              className={`h-full rounded ${isWeekend ? 'bg-amber-400' : 'bg-blue-400'}`}
                                              style={{ width: `${Math.max(pct, 2)}%` }}
                                            />
                                          </div>
                                          <span className="w-[40px] text-right font-medium shrink-0">
                                            {d.effort.toFixed(1)}h
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        })()}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-sm text-muted-foreground">
                  {t('showing', { from: (page - 1) * pageSize + 1, to: Math.min(page * pageSize, totalCount), total: totalCount })}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(page - 1)}
                    disabled={page <= 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm">
                    {t('pageOf', { page, total: totalPages })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(page + 1)}
                    disabled={page >= totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
