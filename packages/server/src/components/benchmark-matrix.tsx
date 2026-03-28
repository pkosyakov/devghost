'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Copy, Check, Trash2, Settings, Eye, EyeOff, Terminal } from 'lucide-react';
import { PipelineLog } from '@/components/pipeline-log';
import type { PipelineLogEntry } from '@/components/pipeline-log';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Run {
  jobId: string | null;
  logJobId: string;
  label: string;
  provider: string;
  model: string;
  createdAt: string;
  configFingerprint: string | null;
  routingProfile: {
    order: string[];
    ignore: string[];
    allowFallbacks: boolean;
    requireParameters: boolean;
  } | null;
  costUsd: number | null;
  promptRepeat: boolean;
  effectiveContextLength: number | null;
  fdV3Enabled: boolean;
  fdLargeModel: string | null;
  fdLargeProvider: string | null;
  status: string;
  totalHours: number;
  mae: number | null;
  correlation: number | null;
  completedCommits: number;
  totalCommits: number;
  fdCount: number;
}

interface Commit {
  sha: string;
  message: string;
  repository: string;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  estimates: Record<string, number>;
  methods: Record<string, string>;
  models: Record<string, string>;
  groundTruth: number | null;
}

interface CompareResponse {
  runs: Run[];
  commits: Commit[];
  groundTruthMeta?: {
    mode: 'consensus' | 'author' | null;
    selectedAuthor: string | null;
    availableAuthors: Array<{ author: string; commitCount: number }>;
    requestedAuthor: string | null;
    fallbackToConsensus: boolean;
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function deltaColor(delta: number): string {
  const abs = Math.abs(delta);
  if (abs <= 1) return 'text-green-600';
  if (abs <= 3) return 'text-yellow-600';
  return 'text-red-600';
}

function runKey(run: Run): string {
  return run.jobId ?? 'original';
}

/** Standard deviation for a numeric array (population). */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqDiffs = values.map(v => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * For each commit, calculate the std-dev of estimates across runs that share
 * the same configFingerprint (only groups with 2+ runs).
 * Returns a map: sha -> average sigma across all fingerprint groups.
 */
function calcSigmaPerCommit(
  runs: Run[],
  commits: Commit[]
): Map<string, number> {
  // Group runs by configFingerprint (skip nulls — original has no fingerprint)
  const fpGroups = new Map<string, Run[]>();
  for (const run of runs) {
    if (!run.configFingerprint) continue;
    const existing = fpGroups.get(run.configFingerprint) ?? [];
    existing.push(run);
    fpGroups.set(run.configFingerprint, existing);
  }

  // Only keep groups with 2+ runs
  const multiGroups = [...fpGroups.values()].filter(g => g.length >= 2);
  if (multiGroups.length === 0) return new Map();

  const result = new Map<string, number>();
  for (const commit of commits) {
    const groupSigmas: number[] = [];
    for (const group of multiGroups) {
      const vals = group
        .map(r => commit.estimates[runKey(r)])
        .filter((v): v is number => v != null);
      if (vals.length >= 2) {
        groupSigmas.push(stddev(vals));
      }
    }
    if (groupSigmas.length > 0) {
      const avg = groupSigmas.reduce((a, b) => a + b, 0) / groupSigmas.length;
      result.set(commit.sha, avg);
    }
  }
  return result;
}

function providerBadgeVariant(
  provider: string
): 'default' | 'secondary' | 'outline' | 'info' {
  const p = provider.toLowerCase();
  if (p === 'ollama') return 'secondary';
  if (p === 'openrouter') return 'info';
  return 'outline';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCtx(tokens: number | null): string | null {
  if (!tokens) return null;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return String(tokens);
}

/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                    */
/* ------------------------------------------------------------------ */

function MatrixSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-48" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  GT Author Management Dialog                                        */
/* ------------------------------------------------------------------ */

interface GTAuthorStat {
  author: string;
  count: number;
  totalHours: number;
  meanHours: number;
  medianHours: number;
  createdAt: string | null;
}

function ManageGTDialog({
  orderId,
  onDeleted,
}: {
  orderId: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmAuthor, setConfirmAuthor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading, refetch } = useQuery<{ authors: GTAuthorStat[] }>({
    queryKey: ['ground-truth-authors', orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/ground-truth`);
      if (!res.ok) throw new Error('Failed to fetch GT data');
      return res.json();
    },
    enabled: open,
  });

  const handleDelete = useCallback(async (author: string) => {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/orders/${orderId}/ground-truth?author=${encodeURIComponent(author)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error('Delete failed');
      setConfirmAuthor(null);
      refetch();
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }, [orderId, refetch, onDeleted]);

  const authors = data?.authors ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setConfirmAuthor(null); }}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          title="Manage GT authors"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>Ground Truth Authors</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2 py-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : authors.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">
            No ground truth data for this order.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Author</TableHead>
                  <TableHead className="text-right">Commits</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Mean</TableHead>
                  <TableHead className="text-right">Median</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {authors.map(a => (
                  <TableRow key={a.author}>
                    <TableCell className="font-medium text-sm">
                      {a.author}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {a.count}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {a.totalHours.toFixed(1)}h
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {a.meanHours.toFixed(2)}h
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {a.medianHours.toFixed(2)}h
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {a.createdAt
                        ? new Date(a.createdAt).toLocaleDateString('en-GB', {
                            day: '2-digit',
                            month: 'short',
                          })
                        : '--'}
                    </TableCell>
                    <TableCell>
                      {confirmAuthor === a.author ? (
                        <div className="flex gap-1">
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            disabled={deleting}
                            onClick={() => handleDelete(a.author)}
                          >
                            {deleting ? '...' : 'Yes'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            disabled={deleting}
                            onClick={() => setConfirmAuthor(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-destructive"
                          onClick={() => setConfirmAuthor(a.author)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function BenchmarkMatrix({ orderId }: { orderId: string }) {
  const [copied, setCopied] = useState(false);
  const [gtAuthor, setGtAuthor] = useState<string>('consensus');
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [confirmDeleteJobId, setConfirmDeleteJobId] = useState<string | null>(null);
  const [hiddenRuns, setHiddenRuns] = useState<Set<string>>(new Set());
  const [expandedLogJobId, setExpandedLogJobId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const logSectionRef = useRef<HTMLDivElement>(null);
  const cardHeaderRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery<CompareResponse>({
    queryKey: ['benchmark-compare', orderId, gtAuthor],
    queryFn: async () => {
      const search = new URLSearchParams();
      if (gtAuthor) search.set('gtAuthor', gtAuthor);
      const res = await fetch(`/api/orders/${orderId}/benchmark/compare?${search.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch comparison matrix');
      const json = await res.json();
      return json.data ?? json;
    },
    refetchInterval: 10_000,
  });

  // Resolve the real AnalysisJob ID for the expanded run's log
  const expandedLogRealJobId = useMemo(() => {
    if (!expandedLogJobId || !data) return null;
    const run = data.runs.find(r => runKey(r) === expandedLogJobId);
    return run?.logJobId ?? null;
  }, [expandedLogJobId, data]);

  // Fetch pipeline log for expanded run
  const { data: logData, isLoading: logLoading } = useQuery<PipelineLogEntry[]>({
    queryKey: ['benchmark-log', orderId, expandedLogRealJobId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/progress?jobId=${expandedLogRealJobId}`);
      if (!res.ok) return [];
      const json = await res.json();
      return (json.data?.log ?? []) as PipelineLogEntry[];
    },
    enabled: !!expandedLogRealJobId,
    staleTime: 30_000,
  });

  // Auto-scroll to log section when it opens or data arrives
  useEffect(() => {
    if (expandedLogJobId && !logLoading && logSectionRef.current) {
      logSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [expandedLogJobId, logLoading]);

  // Sort runs: Original first, then by MAE ascending (best first), null MAE last
  const sortedRuns = useMemo(() => {
    if (!data) return [];
    return [...data.runs].sort((a, b) => {
      if (a.jobId === null) return -1;
      if (b.jobId === null) return 1;
      // Both have MAE — sort ascending (lower is better)
      if (a.mae !== null && b.mae !== null) return a.mae - b.mae;
      // Null MAE goes last
      if (a.mae === null && b.mae !== null) return 1;
      if (a.mae !== null && b.mae === null) return -1;
      // Both null — fall back to createdAt
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [data]);

  // Visible runs (filtered by hiddenRuns)
  const visibleRuns = useMemo(
    () => sortedRuns.filter(r => !hiddenRuns.has(runKey(r))),
    [sortedRuns, hiddenRuns],
  );
  const hiddenCount = sortedRuns.length - visibleRuns.length;

  const toggleRunVisibility = useCallback((key: string) => {
    setHiddenRuns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Sigma map
  const sigmaMap = useMemo(() => {
    if (!data) return new Map<string, number>();
    return calcSigmaPerCommit(data.runs, data.commits);
  }, [data]);

  const hasSigma = sigmaMap.size > 0;
  const hasGT = useMemo(
    () => data?.commits.some(c => c.groundTruth != null) ?? false,
    [data]
  );
  const gtMeta = data?.groundTruthMeta;
  const gtHeader = gtMeta?.selectedAuthor
    ? gtMeta.selectedAuthor === 'consensus'
      ? 'GT (consensus)'
      : `GT (${gtMeta.selectedAuthor})`
    : 'GT';
  const gtTotalHours = useMemo(() => {
    if (!data) return null;
    const gtValues = data.commits
      .map(c => c.groundTruth)
      .filter((v): v is number => v != null);
    if (gtValues.length === 0) return null;
    const total = gtValues.reduce((sum, v) => sum + v, 0);
    return Math.round(total * 100) / 100;
  }, [data]);

  // Copy to clipboard as TSV
  const copyTsv = useCallback(() => {
    if (!data || sortedRuns.length === 0) return;

    const headers = [
      'SHA',
      'Message',
      'Repo',
      'Files',
      '+/-',
      ...sortedRuns.map(r => r.label),
      ...(hasGT ? [gtHeader] : []),
      ...(hasSigma ? ['sigma'] : []),
    ];

    const rows = data.commits.map(c => [
      c.sha.slice(0, 8),
      c.message.split('\n')[0]?.slice(0, 80) ?? '',
      c.repository,
      c.filesChanged,
      `+${c.linesAdded}/-${c.linesDeleted}`,
      ...sortedRuns.map(r => {
        const v = c.estimates[runKey(r)];
        const m = c.methods?.[runKey(r)];
        const model = c.models?.[runKey(r)];
        const fd = m?.startsWith('FD') ? ` FD${model ? `(${model.split('/').pop()})` : ''}` : '';
        return v != null ? `${v.toFixed(1)}${fd}` : '';
      }),
      ...(hasGT ? [c.groundTruth != null ? c.groundTruth.toFixed(1) : ''] : []),
      ...(hasSigma
        ? [sigmaMap.has(c.sha) ? sigmaMap.get(c.sha)!.toFixed(2) : '']
        : []),
    ]);

    // Summary row
    const summaryRow = [
      '',
      'SUMMARY',
      '',
      '',
      '',
      ...sortedRuns.map(r => `${r.totalHours.toFixed(1)}h`),
      ...(hasGT ? [gtTotalHours != null ? `${gtTotalHours.toFixed(1)}h` : ''] : []),
      ...(hasSigma ? [''] : []),
    ];

    const maeRow = [
      '',
      'MAE',
      '',
      '',
      '',
      ...sortedRuns.map(r => (r.mae != null ? r.mae.toFixed(2) : '')),
      ...(hasGT ? [''] : []),
      ...(hasSigma ? [''] : []),
    ];

    const lines = [headers, ...rows, summaryRow, maeRow].map(r =>
      r.map(String).join('\t')
    );

    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [data, sortedRuns, hasGT, hasSigma, sigmaMap, gtHeader, gtTotalHours]);

  const deleteRun = useCallback(async (jobId: string) => {
    setDeletingJobId(jobId);
    setConfirmDeleteJobId(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/benchmark/${jobId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      queryClient.invalidateQueries({ queryKey: ['benchmark-compare', orderId] });
    } finally {
      setDeletingJobId(null);
    }
  }, [orderId, queryClient]);

  /* -- Render -- */

  if (isLoading) return <MatrixSkeleton />;

  if (isError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-center">
            Failed to load benchmark comparison data.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.runs.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-center">
            No benchmark runs yet. Use the Benchmark Launcher above to start one.
          </p>
        </CardContent>
      </Card>
    );
  }

  const totalCols =
    3 + // sha, message, repo metadata
    visibleRuns.length +
    (hasGT ? 1 : 0) +
    (hasSigma ? 1 : 0);

  return (
    <Card>
      <CardHeader ref={cardHeaderRef} className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          Multi-Run Comparison Matrix
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {visibleRuns.length} run{visibleRuns.length !== 1 ? 's' : ''}
            {hiddenCount > 0 && ` (${hiddenCount} hidden)`}
            {' '}/ {data.commits.length} commit{data.commits.length !== 1 ? 's' : ''}
          </span>
          {hiddenCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => setHiddenRuns(new Set())}
            >
              Show all
            </Button>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          {(gtMeta?.availableAuthors.length ?? 0) > 0 && (
            <>
              <Select value={gtAuthor} onValueChange={setGtAuthor}>
                <SelectTrigger className="h-8 w-[220px] text-xs">
                  <SelectValue placeholder="GT source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="consensus">GT: Consensus (median)</SelectItem>
                  {gtMeta?.availableAuthors.map(({ author, commitCount }) => (
                    <SelectItem key={author} value={author}>
                      {author} ({commitCount})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ManageGTDialog
                orderId={orderId}
                onDeleted={() => {
                  queryClient.invalidateQueries({ queryKey: ['benchmark-compare', orderId] });
                }}
              />
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={copyTsv}
          >
            {copied ? (
              <Check className="h-4 w-4 mr-1 text-green-600" />
            ) : (
              <Copy className="h-4 w-4 mr-1" />
            )}
            {copied ? 'Copied' : 'Copy TSV'}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {/* Provider / model row */}
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-background min-w-[280px]">
                  Commit
                </TableHead>
                {visibleRuns.map(run => (
                  <TableHead
                    key={runKey(run)}
                    className="text-center min-w-[100px] relative"
                  >
                    <div className="flex flex-col items-center gap-1">
                      <Badge variant={providerBadgeVariant(run.provider)}>
                        {run.provider}
                      </Badge>
                      <span className="text-xs font-normal whitespace-nowrap">
                        {run.model}
                      </span>
                      {run.fdV3Enabled && run.fdLargeModel && (
                        <span className="text-[10px] text-orange-600 font-medium whitespace-nowrap">
                          50+ files: {run.fdLargeModel.split('/').pop()}
                        </span>
                      )}
                      {run.jobId !== null && (
                        <span className="text-[10px] text-muted-foreground">
                          {formatDate(run.createdAt)}
                        </span>
                      )}
                      {(run.promptRepeat || run.effectiveContextLength) && (
                        <div className="flex items-center gap-1 flex-wrap justify-center">
                          {run.effectiveContextLength && (
                            <Badge variant="outline" className="text-[10px]">
                              {formatCtx(run.effectiveContextLength)} ctx
                            </Badge>
                          )}
                          {run.promptRepeat && (
                            <Badge variant="outline" className="text-[10px]">
                              PR
                            </Badge>
                          )}
                        </div>
                      )}
                      {run.status !== 'COMPLETED' && run.jobId !== null && (
                        <Badge variant="warning" className="text-[10px]">
                          {run.status}
                        </Badge>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {run.completedCommits}/{run.totalCommits}
                      </span>
                      <div className="flex gap-0.5 mt-0.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className={`h-5 w-5 p-0 ${
                            expandedLogJobId === runKey(run)
                              ? 'text-green-500'
                              : 'text-muted-foreground/40 hover:text-muted-foreground'
                          }`}
                          onClick={() => setExpandedLogJobId(
                            expandedLogJobId === runKey(run) ? null : runKey(run)
                          )}
                          title="View pipeline log"
                        >
                          <Terminal className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0 text-muted-foreground/40 hover:text-muted-foreground"
                          onClick={() => toggleRunVisibility(runKey(run))}
                          title="Hide this run"
                        >
                          <EyeOff className="h-3 w-3" />
                        </Button>
                        {run.jobId !== null && (
                          confirmDeleteJobId === run.jobId ? (
                            <div className="flex gap-1">
                              <Button
                                variant="destructive"
                                size="sm"
                                className="h-5 px-1.5 text-[10px]"
                                disabled={deletingJobId === run.jobId}
                                onClick={() => deleteRun(run.jobId!)}
                              >
                                {deletingJobId === run.jobId ? '...' : 'Yes'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 px-1.5 text-[10px]"
                                onClick={() => setConfirmDeleteJobId(null)}
                              >
                                No
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0 text-muted-foreground/40 hover:text-destructive"
                              onClick={() => setConfirmDeleteJobId(run.jobId)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )
                        )}
                      </div>
                    </div>
                  </TableHead>
                ))}
                {hasGT && (
                  <TableHead className="text-center min-w-[70px]">
                    <span className="text-xs font-semibold">{gtHeader}</span>
                  </TableHead>
                )}
                {hasSigma && (
                  <TableHead className="text-center min-w-[70px]">
                    <span className="text-xs font-semibold">&sigma;</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>

            <TableBody>
              {/* Summary rows (moved to top) */}
              <TableRow className="bg-muted/40">
                <TableCell className="sticky left-0 z-10 bg-muted/40 font-semibold text-xs py-1.5">
                  Total Hours
                </TableCell>
                {visibleRuns.map(run => (
                  <TableCell
                    key={runKey(run)}
                    className="text-center font-mono tabular-nums text-xs font-semibold py-1.5"
                  >
                    {run.totalHours.toFixed(1)}
                  </TableCell>
                ))}
                {hasGT && (
                  <TableCell className="text-center font-mono tabular-nums text-xs font-semibold py-1.5">
                    {gtTotalHours != null ? gtTotalHours.toFixed(1) : '--'}
                  </TableCell>
                )}
                {hasSigma && <TableCell className="py-1.5" />}
              </TableRow>
              <TableRow className="bg-muted/40">
                <TableCell className="sticky left-0 z-10 bg-muted/40 font-semibold text-xs py-1.5">
                  MAE
                </TableCell>
                {visibleRuns.map(run => (
                  <TableCell
                    key={runKey(run)}
                    className="text-center font-mono tabular-nums text-xs py-1.5"
                  >
                    {run.mae != null ? (
                      <span
                        className={
                          run.mae <= 1
                            ? 'text-green-600'
                            : run.mae <= 3
                              ? 'text-yellow-600'
                              : 'text-red-600'
                        }
                      >
                        {run.mae.toFixed(2)}h
                      </span>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                ))}
                {hasGT && <TableCell className="py-1.5" />}
                {hasSigma && <TableCell className="py-1.5" />}
              </TableRow>
              <TableRow className="bg-muted/40">
                <TableCell className="sticky left-0 z-10 bg-muted/40 font-semibold text-xs py-1.5">
                  Correlation
                </TableCell>
                {visibleRuns.map(run => (
                  <TableCell
                    key={runKey(run)}
                    className="text-center font-mono tabular-nums text-xs py-1.5"
                  >
                    {run.correlation != null ? (
                      run.correlation.toFixed(3)
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                ))}
                {hasGT && <TableCell className="py-1.5" />}
                {hasSigma && <TableCell className="py-1.5" />}
              </TableRow>
              <TableRow className="bg-muted/40">
                <TableCell className="sticky left-0 z-10 bg-muted/40 font-semibold text-xs py-1.5">
                  Cost
                </TableCell>
                {visibleRuns.map(run => (
                  <TableCell
                    key={runKey(run)}
                    className="text-center font-mono tabular-nums text-xs py-1.5"
                  >
                    {run.costUsd != null ? (
                      `$${run.costUsd.toFixed(4)}`
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                ))}
                {hasGT && <TableCell className="py-1.5" />}
                {hasSigma && <TableCell className="py-1.5" />}
              </TableRow>
              {visibleRuns.some(r => r.fdCount > 0) && (
                <TableRow className="bg-muted/40 border-b">
                  <TableCell className="sticky left-0 z-10 bg-muted/40 font-semibold text-xs py-1.5">
                    FD commits
                  </TableCell>
                  {visibleRuns.map(run => (
                    <TableCell
                      key={runKey(run)}
                      className="text-center font-mono tabular-nums text-xs py-1.5"
                    >
                      {run.fdCount > 0 ? (
                        <span className="text-orange-600">{run.fdCount}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                  ))}
                  {hasGT && <TableCell className="py-1.5" />}
                  {hasSigma && <TableCell className="py-1.5" />}
                </TableRow>
              )}

              {data.commits.map(commit => {
                const gt = commit.groundTruth;
                const sigma = sigmaMap.get(commit.sha);

                return (
                  <TableRow key={commit.sha}>
                    {/* Commit info cell — sticky left */}
                    <TableCell className="sticky left-0 z-10 bg-background py-2">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-blue-600">
                            {commit.sha.slice(0, 8)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {commit.repository}
                          </span>
                        </div>
                        <span className="truncate max-w-[240px] text-xs text-muted-foreground">
                          {commit.message.split('\n')[0]?.slice(0, 80)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {commit.filesChanged} files, +{commit.linesAdded}/-{commit.linesDeleted}
                        </span>
                      </div>
                    </TableCell>

                    {/* Estimate cells */}
                    {visibleRuns.map(run => {
                      const key = runKey(run);
                      const val = commit.estimates[key];
                      const method = commit.methods?.[key];
                      const isFD = method?.startsWith('FD');
                      const delta = gt != null && val != null ? val - gt : null;

                      return (
                        <TableCell
                          key={key}
                          className="text-center py-2 font-mono tabular-nums text-sm"
                        >
                          {val != null ? (
                            <div className="flex flex-col items-center">
                              <div className="flex items-center gap-1">
                                <span>{val.toFixed(1)}</span>
                                {isFD && (
                                  <span
                                    className="text-[9px] font-semibold text-orange-500 leading-none"
                                    title={`${method}${commit.models?.[runKey(run)] ? ` (${commit.models[runKey(run)]})` : ''}`}
                                  >
                                    FD
                                  </span>
                                )}
                              </div>
                              {delta != null && (
                                <span
                                  className={`text-[10px] ${deltaColor(delta)}`}
                                >
                                  {delta >= 0 ? '+' : ''}
                                  {delta.toFixed(1)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">--</span>
                          )}
                        </TableCell>
                      );
                    })}

                    {/* Ground truth cell */}
                    {hasGT && (
                      <TableCell className="text-center py-2 font-mono tabular-nums text-sm font-semibold">
                        {gt != null ? gt.toFixed(1) : '--'}
                      </TableCell>
                    )}

                    {/* Sigma cell */}
                    {hasSigma && (
                      <TableCell className="text-center py-2 font-mono tabular-nums text-sm">
                        {sigma != null ? (
                          <span
                            className={sigma > 1 ? 'text-yellow-600' : 'text-muted-foreground'}
                          >
                            {sigma.toFixed(2)}
                          </span>
                        ) : (
                          '--'
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>

          </Table>
        </div>

        {/* Pipeline log for selected run */}
        {expandedLogJobId && (
          <div ref={logSectionRef} className="border-t px-4 pb-4">
            <div className="flex items-center gap-2 pt-3 mb-1">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                Pipeline Log: {
                  sortedRuns.find(r => runKey(r) === expandedLogJobId)?.label
                  ?? expandedLogJobId
                }
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => cardHeaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  Back to top
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => setExpandedLogJobId(null)}
                >
                  Close
                </Button>
              </div>
            </div>
            {logLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : logData && logData.length > 0 ? (
              <PipelineLog entries={logData} />
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No pipeline log available for this run.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
