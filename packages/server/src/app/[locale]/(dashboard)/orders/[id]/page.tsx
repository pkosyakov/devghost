'use client';

import { useState, useEffect, useRef, use, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@/i18n/navigation';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { GhostKpiCards } from '@/components/ghost-kpi-cards';
import { GhostDistributionPanel } from '@/components/ghost-distribution-panel';
import { GhostDeveloperTable } from '@/components/ghost-developer-table';
import { GhostPeriodSelector } from '@/components/ghost-period-selector';
import { CommitAnalysisTable } from '@/components/commit-analysis-table';
import { BenchmarkLauncher } from '@/components/benchmark-launcher';
import { BenchmarkMatrix } from '@/components/benchmark-matrix';
import { PipelineLog } from '@/components/pipeline-log';
import { AnalysisEventLog } from '@/components/analysis-event-log';
import { CommitProcessingTimeline } from '@/components/commit-processing-timeline';
import { EffortTimeline } from '@/components/effort-timeline';
import type { PipelineLogEntry } from '@/components/pipeline-log';
import type { AnalysisEventEntry } from '@/components/analysis-event-log';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { EditScopePanel, type AnalysisPeriodSettings } from '@/components/edit-scope-panel';
import { GHOST_NORM, type GhostMetric, type GhostEligiblePeriod } from '@devghost/shared';
import { Link } from '@/i18n/navigation';
import {
  Loader2,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Play,
  RefreshCw,
  AlertCircle,
  Users,
  Terminal,
  Square,
  Settings2,
  CalendarRange,
  Coins,
  AlertTriangle,
  Share2,
  FolderGit2,
  UsersRound,
} from 'lucide-react';
import { PublishModal } from '@/components/publish-modal';
import { ShareLinkCard } from '@/components/share-link-card';
import { useTranslations, useLocale } from 'next-intl';
import { useToast } from '@/hooks/use-toast';
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';

// Fetch analysis details
async function fetchOrder(id: string) {
  const res = await fetch(`/api/orders/${id}`);
  if (!res.ok) throw new Error('Failed to fetch analysis');
  const json = await res.json();
  return json.data;
}

// Fetch metrics for analysis with period filter
async function fetchMetrics(id: string, period: GhostEligiblePeriod): Promise<GhostMetric[]> {
  const res = await fetch(`/api/orders/${id}/metrics?period=${period}`);
  if (!res.ok) return [];
  const json = await res.json();
  return json.data ?? [];
}

// Update developer share
async function updateShare(orderId: string, email: string, share: number, auto: boolean) {
  const res = await fetch(`/api/orders/${orderId}/developer-settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ developerEmail: email, share, shareAutoCalculated: auto }),
  });
  if (!res.ok) throw new Error('Failed to update share');
  return res.json();
}

// Fetch LLM provider info for cost estimate
async function fetchLlmInfo() {
  const res = await fetch('/api/llm-info');
  if (!res.ok) return null;
  const json = await res.json();
  return json.data as { provider: string; model: string; costPerCommitUsd: number } | null;
}

// Fetch user's credit balance
async function fetchBalance() {
  const res = await fetch('/api/billing/balance');
  if (!res.ok) return null;
  const json = await res.json();
  return json.data as { balance: { available: number; permanent: number; subscription: number; reserved: number } } | null;
}

async function fetchAdminDemoLiveMode(): Promise<boolean> {
  const res = await fetch('/api/admin/llm-settings');
  if (!res.ok) return false;
  const json = await res.json().catch(() => null);
  return Boolean(json?.data?.demoLiveMode);
}

interface AnalysisProgressData {
  jobId: string;
  type: string;
  status: string;
  progress: number;
  currentStep: string | null;
  currentCommit: number | null;
  totalCommits: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  totalPromptTokens: number | null;
  totalCompletionTokens: number | null;
  totalLlmCalls: number | null;
  totalCostUsd: number | null;
  cloneSizeMb: number | null;
  llmConcurrency: number;
  fdLlmConcurrency?: number;
  executionMode: string;
  modalCallId: string | null;
  heartbeatAt: string | null;
  updatedAt: string;
  createdAt: string;
  retryCount: number;
  maxRetries: number;
  currentRepoName: string | null;
  orderStatus: string;
  log: PipelineLogEntry[];
  events: AnalysisEventEntry[];
  eventCursor: string | null;
}

type GhostNormMode = 'fixed' | 'median';

// Fetch analysis progress
async function fetchProgress(
  id: string,
  since?: number,
  sinceEventId?: string,
): Promise<AnalysisProgressData | null> {
  const params = new URLSearchParams();
  if (since) params.set('since', String(since));
  if (sinceEventId) params.set('sinceEventId', sinceEventId);
  const query = params.toString();
  const url = query
    ? `/api/orders/${id}/progress?${query}`
    : `/api/orders/${id}/progress`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.data;
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  DEVELOPERS_LOADED: 'bg-blue-100 text-blue-700',
  READY_FOR_ANALYSIS: 'bg-yellow-100 text-yellow-700',
  PROCESSING: 'bg-purple-100 text-purple-700',
  COMPLETED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-orange-100 text-orange-700',
  INSUFFICIENT_CREDITS: 'bg-amber-100 text-amber-700',
};

// ==================== Elapsed Timer ====================

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function formatSizeFromMb(sizeMb: number): string {
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`;
  if (sizeMb >= 100) return `${Math.round(sizeMb)} MB`;
  return `${sizeMb.toFixed(1)} MB`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left == null || right == null) return null;
  return (left + right) / 2;
}

function sumSelectedRepoSizeKb(selectedRepos: unknown): number {
  if (!Array.isArray(selectedRepos)) return 0;
  return selectedRepos.reduce((sum, repo) => {
    if (!repo || typeof repo !== 'object') return sum;
    const sizeKb = toPositiveNumber((repo as Record<string, unknown>).sizeKb) ?? 0;
    return sum + sizeKb;
  }, 0);
}

/** Ticking clock — returns current timestamp updating every second. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

// ==================== Pipeline Live Log ====================

// PipelineLogEntry and PipelineLog imported from @/components/pipeline-log

/** Convert order DB fields to AnalysisPeriodSettings for the UI selector */
function orderToScopeSettings(order: {
  analysisPeriodMode: string;
  analysisYears?: number[] | null;
  analysisStartDate?: string | Date | null;
  analysisEndDate?: string | Date | null;
  analysisCommitLimit?: number | null;
}): AnalysisPeriodSettings {
  // SELECTED_YEARS not supported in UI selector — convert to DATE_RANGE
  if (order.analysisPeriodMode === 'SELECTED_YEARS' && order.analysisYears?.length) {
    const minYear = Math.min(...order.analysisYears);
    const maxYear = Math.max(...order.analysisYears);
    return {
      mode: 'DATE_RANGE',
      startDate: new Date(`${minYear}-01-01`),
      endDate: new Date(`${maxYear}-12-31`),
    };
  }
  return {
    mode: (order.analysisPeriodMode as AnalysisPeriodSettings['mode']) || 'ALL_TIME',
    startDate: order.analysisStartDate ? new Date(order.analysisStartDate) : undefined,
    endDate: order.analysisEndDate ? new Date(order.analysisEndDate) : undefined,
    commitLimit: order.analysisCommitLimit ?? undefined,
  };
}

/** Format a short date like "Sep 9, 2024" */
function fmtDate(d: string | Date | null | undefined, locale: string = 'en-US'): string | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Human-readable description of analysis scope */
function formatScopeDescription(order: {
  analysisPeriodMode: string;
  analysisYears?: number[] | null;
  analysisStartDate?: string | Date | null;
  analysisEndDate?: string | Date | null;
  analysisCommitLimit?: number | null;
}, tDetail: (key: string, values?: Record<string, string | number | Date>) => string, dateLocale: string = 'en-US'): string {
  switch (order.analysisPeriodMode) {
    case 'DATE_RANGE': {
      const start = fmtDate(order.analysisStartDate, dateLocale);
      const end = fmtDate(order.analysisEndDate, dateLocale);
      if (start && end) return `${start} — ${end}`;
      if (start) return tDetail('detail.scopeFrom', { date: start });
      if (end) return tDetail('detail.scopeUntil', { date: end });
      return tDetail('detail.scopeDateRange');
    }
    case 'SELECTED_YEARS': {
      const years = order.analysisYears?.slice().sort((a, b) => a - b);
      if (years?.length) return tDetail('detail.scopeYears', { years: years.join(', ') });
      return tDetail('detail.scopeSelectedYears');
    }
    case 'LAST_N_COMMITS': {
      const n = order.analysisCommitLimit;
      return n ? tDetail('detail.scopeLastNCommits', { count: n.toLocaleString() }) : tDetail('detail.scopeLastNCommitsFallback');
    }
    default:
      return tDetail('detail.scopeAllCommits');
  }
}

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const { toast } = useToast();
  const t = useTranslations('orders');
  const { data: stageData } = useWorkspaceStage();
  const isFirstRun = stageData?.workspaceStage === 'first_data';
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
  const [highlightedEmail, setHighlightedEmail] = useState<string>();
  const [period, setPeriod] = useState<GhostEligiblePeriod>('ALL_TIME');
  const [ghostNormMode, setGhostNormMode] = useState<GhostNormMode>('fixed');
  const isAdmin = session?.user?.role === 'ADMIN';

  // Contributor selection state
  const [excludedDevelopers, setExcludedDevelopers] = useState<Set<string>>(new Set());
  const [contributorSearch, setContributorSearch] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [showCompletedLog, setShowCompletedLog] = useState(false);
  const [showEditScope, setShowEditScope] = useState(false);
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [pipelineLog, setPipelineLog] = useState<PipelineLogEntry[]>([]);
  const logSinceRef = useRef<number>(0);
  const [jobEvents, setJobEvents] = useState<AnalysisEventEntry[]>([]);
  const eventCursorRef = useRef<string | null>(null);

  const [benchmarkJobId, setBenchmarkJobId] = useState<string | null>(null);
  const [benchmarkLog, setBenchmarkLog] = useState<PipelineLogEntry[]>([]);
  const benchmarkLogSinceRef = useRef<number>(0);
  const [benchmarkEvents, setBenchmarkEvents] = useState<AnalysisEventEntry[]>([]);
  const benchmarkEventCursorRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [publishRepo, setPublishRepo] = useState<string | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const { data: demoLiveModeEnabled = false } = useQuery({
    queryKey: ['admin-demo-live-mode'],
    queryFn: fetchAdminDemoLiveMode,
    enabled: isAdmin,
    staleTime: 30_000,
    refetchInterval: isAdmin ? 30_000 : false,
  });
  const livePollMs = isAdmin && demoLiveModeEnabled ? 300 : 1000;

  const { data: order, isLoading: orderLoading } = useQuery({
    queryKey: ['order', id],
    queryFn: () => fetchOrder(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Poll while PROCESSING to detect completion
      if (status === 'PROCESSING') return livePollMs;
      // Poll after Start Analysis to catch READY_FOR_ANALYSIS → PROCESSING transition
      if (analysisStarted) return livePollMs;
      return false;
    },
  });

  const now = useNow(order?.status === 'PROCESSING');

  const { data: metrics = [] } = useQuery({
    queryKey: ['metrics', id, period],
    queryFn: () => fetchMetrics(id, period),
    enabled: order?.status === 'COMPLETED',
  });

  const shareMutation = useMutation({
    mutationFn: ({ email, share, auto }: { email: string; share: number; auto: boolean }) =>
      updateShare(id, email, share, auto),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['metrics', id] });
    },
  });

  const { data: progress } = useQuery<AnalysisProgressData | null>({
    queryKey: ['progress', id],
    queryFn: async () => {
      const since = logSinceRef.current || undefined;
      const sinceEventId = eventCursorRef.current || undefined;
      const data = await fetchProgress(id, since, sinceEventId);
      if (data?.jobId && !analysisJobId) {
        setAnalysisJobId(data.jobId);
      }
      if (data?.log?.length) {
        if (since) {
          // Incremental update (PROCESSING polling): append new entries
          setPipelineLog(prev => [...prev, ...data.log]);
        } else {
          // Full log (first load or COMPLETED): replace entirely
          setPipelineLog(data.log);
        }
        logSinceRef.current = data.log[data.log.length - 1].ts;
      }
      if (data?.events?.length) {
        if (sinceEventId) {
          setJobEvents((prev) => {
            const merged = new Map(prev.map((event) => [event.id, event]));
            for (const event of data.events) {
              merged.set(event.id, event);
            }
            return Array.from(merged.values()).sort((a, b) => {
              const aId = BigInt(a.id);
              const bId = BigInt(b.id);
              if (aId < bId) return -1;
              if (aId > bId) return 1;
              return 0;
            });
          });
        } else {
          setJobEvents(data.events);
        }
      }
      if (data?.eventCursor) {
        eventCursorRef.current = data.eventCursor;
      }
      return data;
    },
    enabled:
      (order?.status === 'PROCESSING' || order?.status === 'COMPLETED') &&
      !(analysisStarted && order?.status !== 'PROCESSING'),
    refetchInterval: order?.status === 'PROCESSING' ? livePollMs : false,
  });

  const { data: llmInfo } = useQuery({
    queryKey: ['llm-info'],
    queryFn: fetchLlmInfo,
    enabled: order?.status === 'DEVELOPERS_LOADED' || order?.status === 'READY_FOR_ANALYSIS',
    staleTime: 60_000,
  });

  const { data: balanceData } = useQuery({
    queryKey: ['billing-balance'],
    queryFn: fetchBalance,
    enabled: order?.status === 'DEVELOPERS_LOADED' || order?.status === 'READY_FOR_ANALYSIS' || order?.status === 'INSUFFICIENT_CREDITS',
    staleTime: 30_000,
  });

  const prepareAnalysisLaunch = useCallback(() => {
    setAnalysisStarted(true);
    setAnalysisJobId(null);
    setPipelineLog([]);
    logSinceRef.current = 0;
    setJobEvents([]);
    eventCursorRef.current = null;
    queryClient.removeQueries({ queryKey: ['progress', id] });
  }, [id, queryClient]);

  const analyzeMutation = useMutation({
    mutationFn: async (opts: { excludedDevelopers?: string[] } | void) => {
      const endpoint = isAdmin
        ? `/api/admin/orders/${id}/rerun`
        : `/api/orders/${id}/analyze`;
      const res = await fetch(endpoint, {
        method: 'POST',
        ...(opts && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Analysis failed');
      }
      return res.json();
    },
    onMutate: () => {
      prepareAnalysisLaunch();
    },
    onSuccess: (data) => {
      setAnalysisJobId(data.data?.jobId ?? null);
      queryClient.invalidateQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['metrics', id] });
    },
    onError: () => {
      setAnalysisStarted(false);
    },
  });

  const scopeMutation = useMutation({
    mutationFn: async ({ settings, forceRecalculate }: { settings: AnalysisPeriodSettings; forceRecalculate: boolean }) => {
      const res = await fetch(`/api/orders/${id}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysisPeriodMode: settings.mode,
          analysisStartDate: settings.startDate?.toISOString(),
          analysisEndDate: settings.endDate?.toISOString(),
          analysisCommitLimit: settings.commitLimit,
          forceRecalculate,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Analysis failed');
      }
      return res.json();
    },
    onMutate: () => {
      prepareAnalysisLaunch();
    },
    onSuccess: (data) => {
      setShowEditScope(false);
      setAnalysisJobId(data.data?.jobId ?? null);
      queryClient.invalidateQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['metrics', id] });
    },
    onError: () => {
      setAnalysisStarted(false);
    },
  });

  const handleScopeSubmit = (settings: AnalysisPeriodSettings, forceRecalculate: boolean) => {
    scopeMutation.mutate({ settings, forceRecalculate });
  };

  const cancelJobMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const res = await fetch(`/api/orders/${id}/jobs/${jobId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Cancel failed');
      }
      return res.json();
    },
    onSuccess: (_data, jobId) => {
      // If this was the primary analysis job, reset state
      if (jobId === analysisJobId) {
        setAnalysisJobId(null);
      }
      // If this was the benchmark job, clear benchmark state
      if (jobId === benchmarkJobId) {
        setBenchmarkJobId(null);
        queryClient.invalidateQueries({ queryKey: ['benchmarks', id] });
      }
      queryClient.invalidateQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['progress', id] });
    },
  });

  const { data: benchmarkProgress } = useQuery<AnalysisProgressData | null>({
    queryKey: ['benchmark-progress', id, benchmarkJobId],
    queryFn: async () => {
      if (!benchmarkJobId) return null;
      const params = new URLSearchParams();
      params.set('jobId', benchmarkJobId);
      if (benchmarkLogSinceRef.current) params.set('since', String(benchmarkLogSinceRef.current));
      if (benchmarkEventCursorRef.current) params.set('sinceEventId', benchmarkEventCursorRef.current);
      const url = `/api/orders/${id}/progress?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      const data = json.data as AnalysisProgressData | null;
      if (data?.log?.length) {
        if (benchmarkLogSinceRef.current) {
          setBenchmarkLog(prev => [...prev, ...data.log]);
        } else {
          setBenchmarkLog(data.log);
        }
        benchmarkLogSinceRef.current = data.log[data.log.length - 1].ts;
      }
      if (data?.events?.length) {
        if (benchmarkEventCursorRef.current) {
          setBenchmarkEvents((prev) => {
            const merged = new Map(prev.map((e) => [e.id, e]));
            for (const event of data.events) merged.set(event.id, event);
            return Array.from(merged.values()).sort((a, b) => {
              const aId = BigInt(a.id);
              const bId = BigInt(b.id);
              if (aId < bId) return -1;
              if (aId > bId) return 1;
              return 0;
            });
          });
        } else {
          setBenchmarkEvents(data.events);
        }
      }
      if (data?.eventCursor) {
        benchmarkEventCursorRef.current = data.eventCursor;
      }
      if (data?.status === 'COMPLETED' || data?.status === 'FAILED' || data?.status === 'CANCELLED'
          || data?.status === 'FAILED_FATAL' || data?.status === 'FAILED_RETRYABLE') {
        setBenchmarkJobId(null);
        queryClient.invalidateQueries({ queryKey: ['benchmarks', id] });
        if (data?.status === 'COMPLETED') {
          setActiveTab('benchmark');
        }
      }
      return data;
    },
    enabled: isAdmin && !!benchmarkJobId,
    refetchInterval: benchmarkJobId ? livePollMs : false,
  });

  const benchmarkNow = useNow(!!benchmarkJobId);

  // Benchmark diagnostics — mirrors main analysis heartbeat/stale detection
  const bmHeartbeatAgeMs = benchmarkProgress?.heartbeatAt ? benchmarkNow - new Date(benchmarkProgress.heartbeatAt).getTime() : null;
  const bmUpdateAgeMs = benchmarkProgress?.updatedAt ? benchmarkNow - new Date(benchmarkProgress.updatedAt).getTime() : null;
  const bmIsPendingStale = benchmarkProgress?.status === 'PENDING' && bmUpdateAgeMs != null && bmUpdateAgeMs > 2 * 60 * 1000;
  const bmIsHeartbeatStale = benchmarkProgress?.status === 'RUNNING' && bmHeartbeatAgeMs != null && bmHeartbeatAgeMs > 2 * 60 * 1000;
  const bmIsHeartbeatCritical = benchmarkProgress?.status === 'RUNNING' && bmHeartbeatAgeMs != null && bmHeartbeatAgeMs > 10 * 60 * 1000;

  const { data: benchmarkRuns = [] } = useQuery<{ id: string; status: string; llmModel: string | null; completedAt: string | null; createdAt: string }[]>({
    queryKey: ['benchmarks', id],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${id}/benchmark`);
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    },
    enabled: isAdmin && order?.status === 'COMPLETED',
  });

  // Auto-detect running benchmark job (e.g., after page refresh)
  useEffect(() => {
    if (benchmarkJobId) return;
    const running = benchmarkRuns.find((r: { status: string }) =>
      r.status === 'PENDING' || r.status === 'RUNNING'
    );
    if (running) {
      setBenchmarkJobId(running.id);
    }
  }, [benchmarkRuns, benchmarkJobId]);

  // Clear analysisStarted flag once order transitions to PROCESSING
  // Reset logSinceRef and force-refresh progress on completion so the full
  // persisted log is loaded from DB (not stale incremental cache)
  useEffect(() => {
    if (order?.status === 'PROCESSING' || order?.status === 'COMPLETED' || order?.status === 'FAILED' || order?.status === 'INSUFFICIENT_CREDITS') {
      setAnalysisStarted(false);
    }
    if (order?.status === 'COMPLETED' || order?.status === 'FAILED' || order?.status === 'READY_FOR_ANALYSIS' || order?.status === 'INSUFFICIENT_CREDITS') {
      setAnalysisJobId(null);
      logSinceRef.current = 0;
      eventCursorRef.current = null;
      setJobEvents([]);
      queryClient.invalidateQueries({ queryKey: ['progress', id] });
      queryClient.invalidateQueries({ queryKey: ['workspace-stage'] });
    }
  }, [order?.status, queryClient, id]);

  // Hydrate excludedDevelopers from persisted order state
  useEffect(() => {
    if (order?.excludedDevelopers && Array.isArray(order.excludedDevelopers) && order.excludedDevelopers.length > 0) {
      setExcludedDevelopers(new Set(order.excludedDevelopers as string[]));
    }
  }, [order?.excludedDevelopers]);

  // Auto-extract developers when order is in DRAFT status
  useEffect(() => {
    if (
      order?.status === 'DRAFT' &&
      (!order.selectedDevelopers || order.selectedDevelopers.length === 0) &&
      !extracting &&
      !orderLoading
    ) {
      handleExtractDevelopers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.status, order?.selectedDevelopers?.length, orderLoading]);

  // --- Handlers ---

  const handleExtractDevelopers = async () => {
    setExtracting(true);
    setExtractError(null);
    try {
      const res = await fetch(`/api/orders/${id}/developers`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to extract developers');
      }
      // Refetch order to get updated status and developers
      queryClient.invalidateQueries({ queryKey: ['order', id] });
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Failed to extract developers');
    } finally {
      setExtracting(false);
    }
  };

  const handleToggleExclude = useCallback((email: string) => {
    setExcludedDevelopers((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(email)) {
        newSet.delete(email);
      } else {
        newSet.add(email);
      }
      return newSet;
    });
  }, []);

  const handleStartAnalysis = useCallback(() => {
    analyzeMutation.mutate({
      excludedDevelopers: Array.from(excludedDevelopers),
    });
  }, [excludedDevelopers, analyzeMutation]);

  // Contributor selector derived values
  const allDevelopers = useMemo(
    () => (order?.selectedDevelopers ?? []) as any[],
    [order?.selectedDevelopers]
  );
  const filteredDevelopers = useMemo(() => {
    if (!contributorSearch) return allDevelopers;
    const q = contributorSearch.toLowerCase();
    return allDevelopers.filter((d: any) =>
      d.name?.toLowerCase().includes(q) ||
      d.email?.toLowerCase().includes(q) ||
      d.login?.toLowerCase().includes(q)
    );
  }, [allDevelopers, contributorSearch]);

  const includedCount = allDevelopers.filter((d: any) => !excludedDevelopers.has(d.email)).length;
  const totalDevCount = allDevelopers.length;
  const activeCommitCount = allDevelopers
    .filter((d: any) => d.email && !excludedDevelopers.has(d.email))
    .reduce((sum: number, d: any) => sum + (d.commitCount ?? d.commit_count ?? 0), 0);

  // Credit estimation — mirrors analyze route logic
  const estimatedCredits = useMemo(() => {
    if (!order?.selectedDevelopers) return 0;
    const devs = order.selectedDevelopers as Array<{ email?: string; commit_count?: number; commitCount?: number }>;
    let total = 0;
    for (const d of devs) {
      if (d.email && excludedDevelopers.has(d.email)) continue;
      total += d.commit_count ?? d.commitCount ?? 0;
    }
    return Math.max(1, total);
  }, [order?.selectedDevelopers, excludedDevelopers]);

  const availableCredits = balanceData?.balance?.available ?? 0;
  const hasEnoughCredits = availableCredits >= estimatedCredits;
  const creditDeficit = Math.max(0, estimatedCredits - availableCredits);
  const canStartAnalysis = hasEnoughCredits || isAdmin;
  const heartbeatAgeMs = progress?.heartbeatAt ? now - new Date(progress.heartbeatAt).getTime() : null;
  const updateAgeMs = progress?.updatedAt ? now - new Date(progress.updatedAt).getTime() : null;
  const isPendingStale = progress?.status === 'PENDING' && updateAgeMs != null && updateAgeMs > 2 * 60 * 1000;
  const isHeartbeatStale = progress?.status === 'RUNNING' && heartbeatAgeMs != null && heartbeatAgeMs > 2 * 60 * 1000;
  const isHeartbeatCritical = progress?.status === 'RUNNING' && heartbeatAgeMs != null && heartbeatAgeMs > 10 * 60 * 1000;
  const isPostProcessingStale = progress?.status === 'LLM_COMPLETE' && updateAgeMs != null && updateAgeMs > 5 * 60 * 1000;
  const repoSizeMb = useMemo(() => {
    const totalRepoSizeKb = sumSelectedRepoSizeKb(order?.selectedRepos);
    if (totalRepoSizeKb <= 0) return null;
    return +(totalRepoSizeKb / 1024).toFixed(1);
  }, [order?.selectedRepos]);
  const cloneSizeMb = progress?.cloneSizeMb ?? null;
  const cloneSavedMb = useMemo(() => {
    if (repoSizeMb == null || cloneSizeMb == null) return null;
    const saved = repoSizeMb - cloneSizeMb;
    if (saved <= 0) return null;
    return +saved.toFixed(1);
  }, [repoSizeMb, cloneSizeMb]);
  const cloneSavedPercent = useMemo(() => {
    if (repoSizeMb == null || cloneSizeMb == null || repoSizeMb <= 0) return null;
    const savedRatio = (repoSizeMb - cloneSizeMb) / repoSizeMb;
    if (savedRatio <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(savedRatio * 100)));
  }, [repoSizeMb, cloneSizeMb]);

  const quickTopUpMutation = useMutation({
    mutationFn: async (amount: number) => {
      const userId = session?.user?.id;
      if (!userId) {
        throw new Error('Current user session is unavailable');
      }

      const res = await fetch('/api/admin/credits/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          amount,
          reason: `Quick admin top-up from order ${id}`,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? 'Failed to adjust credits');
      }

      return json.data;
    },
    onSuccess: (_data, amount) => {
      queryClient.invalidateQueries({ queryKey: ['billing-balance'] });
      toast.success(t('detail.adminQuickTopUpSuccess', { count: amount }));
    },
    onError: (error: Error) => {
      toast.error(t('detail.adminQuickTopUpFailed'), error.message);
    },
  });

  // --- Render ---

  if (orderLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!order) {
    return <div className="text-center p-8">{t('detail.orderNotFound')}</div>;
  }

  const normCandidates = metrics
    .filter((m: GhostMetric) => m.hasEnoughData && Number.isFinite(m.avgDailyEffort) && m.avgDailyEffort > 0)
    .map((m: GhostMetric) => m.avgDailyEffort);
  const medianGhostNorm = median(normCandidates);
  const effectiveGhostNorm = ghostNormMode === 'median' && medianGhostNorm != null
    ? medianGhostNorm
    : GHOST_NORM;
  const effectiveGhostNormMode: GhostNormMode = ghostNormMode === 'median' && medianGhostNorm != null
    ? 'median'
    : 'fixed';
  const displayMetrics: GhostMetric[] = metrics.map((metric: GhostMetric) => {
    if (!metric.hasEnoughData || metric.actualWorkDays <= 0) {
      return metric;
    }
    const avgDailyEffort = metric.avgDailyEffort;
    const raw = (avgDailyEffort / effectiveGhostNorm) * 100;
    const adjusted = metric.share > 0
      ? (avgDailyEffort / (effectiveGhostNorm * metric.share)) * 100
      : null;
    return {
      ...metric,
      ghostPercentRaw: Number.isFinite(raw) ? raw : null,
      ghostPercent: adjusted != null && Number.isFinite(adjusted) ? adjusted : null,
    };
  });

  // Calculate aggregate KPIs from displayed metrics (respect selected Ghost Norm mode)
  const activeMetrics = displayMetrics.filter((m: GhostMetric) => m.hasEnoughData);
  const avgGhost = activeMetrics.length > 0
    ? activeMetrics.reduce((sum: number, m: GhostMetric) => sum + (m.ghostPercent ?? 0), 0) / activeMetrics.length
    : null;
  const totalCommits = displayMetrics.reduce((sum: number, m: GhostMetric) => sum + m.commitCount, 0);
  const totalWorkDays = displayMetrics.reduce((sum: number, m: GhostMetric) => sum + m.actualWorkDays, 0);
  const normNumberFormat = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
  const effectiveGhostNormLabel = normNumberFormat.format(effectiveGhostNorm);
  const medianGhostNormLabel = medianGhostNorm != null
    ? normNumberFormat.format(medianGhostNorm)
    : null;

  const repoCount = Array.isArray(order.selectedRepos) ? order.selectedRepos.length : 0;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
          <ChevronLeft className="h-4 w-4 mr-1" /> {t('detail.back')}
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{order.name}</h1>
        </div>
        <Badge className={statusColors[order.status] ?? ''}>
          {tStatus(order.status)}
        </Badge>
      </div>

      {/* ================================================================ */}
      {/* DRAFT — Auto-extract developers                                  */}
      {/* ================================================================ */}
      {order.status === 'DRAFT' && (
        <Card>
          <CardContent className="pt-6">
            {extracting ? (
              <div className="text-center space-y-4">
                <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                <div>
                  <p className="font-medium">{t('detail.extracting')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('detail.fetchingCommits', { count: repoCount })}
                  </p>
                </div>
              </div>
            ) : extractError ? (
              <div className="text-center space-y-3">
                <AlertCircle className="h-8 w-8 text-red-500 mx-auto" />
                <p className="text-sm text-red-600">{extractError}</p>
                <Button onClick={handleExtractDevelopers} variant="outline">
                  <RefreshCw className="h-4 w-4 mr-2" /> {t('detail.retry')}
                </Button>
              </div>
            ) : (
              <div className="text-center space-y-4">
                <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                <p className="text-muted-foreground">
                  {t('detail.preparingExtract', { count: repoCount })}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ================================================================ */}
      {/* DEVELOPERS_LOADED / READY_FOR_ANALYSIS — Contributor Selector    */}
      {/* ================================================================ */}
      {(order.status === 'DEVELOPERS_LOADED' || order.status === 'READY_FOR_ANALYSIS') && !analysisStarted && (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">{t('contributorSelector.title')}</h3>
              <p className="text-sm text-muted-foreground">
                {t('contributorSelector.subtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {t('contributorSelector.included', { count: includedCount })}
              </span>
              {excludedDevelopers.size > 0 && (
                <span className="text-sm text-muted-foreground">
                  {t('contributorSelector.excluded', { count: excludedDevelopers.size })}
                </span>
              )}
            </div>
          </div>

          {/* Select all / Deselect all */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExcludedDevelopers(new Set())}
            >
              {t('contributorSelector.selectAll')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const allEmails = new Set(
                  allDevelopers.map((d: any) => d.email).filter(Boolean)
                );
                setExcludedDevelopers(allEmails);
              }}
            >
              {t('contributorSelector.deselectAll')}
            </Button>
          </div>

          {/* Search */}
          <Input
            placeholder={t('contributorSelector.searching')}
            value={contributorSearch}
            onChange={(e) => setContributorSearch(e.target.value)}
          />

          {/* Contributor list */}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {filteredDevelopers.map((dev: any) => {
              const isExcluded = excludedDevelopers.has(dev.email);
              return (
                <div
                  key={dev.email}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-lg border',
                    isExcluded && 'opacity-50'
                  )}
                >
                  <Checkbox
                    checked={!isExcluded}
                    onCheckedChange={() => handleToggleExclude(dev.email)}
                  />
                  {dev.avatarUrl && (
                    <img src={dev.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{dev.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {dev.email}
                      {dev.login && ` (@${dev.login})`}
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground whitespace-nowrap">
                    {t('contributorSelector.commits', { count: dev.commitCount ?? dev.commit_count ?? 0 })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Billing preflight */}
          <div className="space-y-3 pt-4 border-t">
            {/* LLM provider + cost info */}
            {llmInfo && estimatedCredits > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" className={
                  llmInfo.provider === 'openrouter'
                    ? 'border-blue-300 text-blue-700 bg-blue-50'
                    : 'border-green-300 text-green-700 bg-green-50'
                }>
                  {llmInfo.provider === 'openrouter' ? 'OpenRouter' : 'Ollama'}
                </Badge>
                <span>
                  {llmInfo.provider === 'openrouter' ? (
                    <>
                      ~<span className="font-medium text-foreground">
                        ${(estimatedCredits * (llmInfo.costPerCommitUsd ?? 0)).toFixed(4)}
                      </span>{' '}
                      {t('detail.costForCommits', { count: estimatedCredits })}
                    </>
                  ) : (
                    <>{t('detail.freeLocalProcessing', { count: estimatedCredits })}</>
                  )}
                </span>
                <span className="text-xs text-muted-foreground/70">{llmInfo.model}</span>
              </div>
            )}

            {/* Credit balance check */}
            {balanceData && (
              <div className={`flex items-center gap-2 text-sm rounded-md border px-3 py-2 ${
                hasEnoughCredits
                  ? 'border-blue-200 bg-blue-50/50 text-blue-800'
                  : 'border-amber-200 bg-amber-50/50 text-amber-800'
              }`}>
                <Coins className="h-4 w-4 flex-shrink-0" />
                <span>
                  {t('detail.creditsWillBeUsed', { estimated: estimatedCredits })}
                  {' '}{t('detail.creditsAvailable', { count: availableCredits })}
                </span>
                {!hasEnoughCredits && (
                  <span className="ml-auto text-amber-700 font-medium flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {t('detail.deficit', { count: estimatedCredits - availableCredits })}
                  </span>
                )}
              </div>
            )}

            {/* Start Analysis / Insufficient credits */}
            {!canStartAnalysis && balanceData ? (
              <div className="space-y-2">
                <Button disabled>
                  <Play className="h-4 w-4 mr-2" />
                  {t('contributorSelector.startAnalysis')}
                </Button>
                <p className="text-sm text-amber-700">
                  {t('detail.notEnoughCredits')}{' '}
                  <Link href="/billing" className="underline font-medium hover:text-amber-900">
                    {t('detail.buyCreditsLink')}
                  </Link>{' '}
                  {t('detail.buyCreditsToProceed')}
                </p>
                {isAdmin && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="secondary"
                      onClick={() => quickTopUpMutation.mutate(creditDeficit)}
                      disabled={quickTopUpMutation.isPending || creditDeficit <= 0 || !session?.user?.id}
                    >
                      {quickTopUpMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Coins className="h-4 w-4 mr-2" />
                      )}
                      {t('detail.adminQuickTopUp', { count: creditDeficit })}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t('detail.adminQuickTopUpHint')}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {isAdmin && !hasEnoughCredits && (
                  <p className="text-xs text-amber-700">
                    {t('detail.adminCreditBypassHint')}
                  </p>
                )}
                <Button
                  onClick={handleStartAnalysis}
                  disabled={includedCount === 0 || analyzeMutation.isPending}
                >
                  {analyzeMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  {t('contributorSelector.startAnalysis')}
                </Button>
              </div>
            )}

            {analyzeMutation.isError && (
              <p className="text-sm text-red-600">
                {analyzeMutation.error instanceof Error ? analyzeMutation.error.message : t('detail.analysisFailed')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* INSUFFICIENT_CREDITS — Paused, needs top-up                      */}
      {/* ================================================================ */}
      {order.status === 'INSUFFICIENT_CREDITS' && !analysisStarted && (
        <Card className="border-amber-200">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-amber-700 mb-3">
              <AlertTriangle className="h-5 w-5" />
              <span className="font-medium">{t('detail.analysisPaused')}</span>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              {t('detail.analysisPausedDescription')}
              {balanceData && (
                <> {t('detail.creditsCurrently', { count: availableCredits })}</>
              )}
            </p>
            <div className="flex items-center gap-3">
              <Link href="/billing">
                <Button>
                  <Coins className="h-4 w-4 mr-2" />
                  {t('detail.topUpAndResume')}
                </Button>
              </Link>
              {isAdmin && creditDeficit > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => quickTopUpMutation.mutate(creditDeficit)}
                  disabled={quickTopUpMutation.isPending || !session?.user?.id}
                >
                  {quickTopUpMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Coins className="h-4 w-4 mr-2" />
                  )}
                  {t('detail.adminQuickTopUp', { count: creditDeficit })}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => analyzeMutation.mutate()}
                disabled={analyzeMutation.isPending}
              >
                {analyzeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {t('detail.retryAnalysis')}
              </Button>
            </div>
            {analyzeMutation.isError && (
              <p className="text-sm text-red-600 mt-3">
                {analyzeMutation.error instanceof Error ? analyzeMutation.error.message : t('detail.analysisFailed')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ================================================================ */}
      {/* PROCESSING — Progress                                            */}
      {/* ================================================================ */}
      {(order.status === 'PROCESSING' || analysisStarted) && (() => {
        const isLaunchingTransition = analysisStarted && order.status !== 'PROCESSING';
        const startedAt = !isLaunchingTransition && progress?.startedAt ? new Date(progress.startedAt) : null;
        const elapsed = startedAt ? now - startedAt.getTime() : 0;
        return (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t('detail.analysisInProgress')}
                </CardTitle>
                {analysisJobId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => cancelJobMutation.mutate(analysisJobId)}
                    disabled={cancelJobMutation.isPending}
                  >
                    {cancelJobMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Square className="h-4 w-4 mr-1" />
                    )}
                    {cancelJobMutation.isPending ? t('detail.cancelling') : t('detail.cancel')}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Progress value={isLaunchingTransition ? 2 : (progress?.progress ?? 0)} />
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>{isLaunchingTransition ? t('detail.preparing') : (progress?.currentStep ?? t('detail.preparing'))}</span>
                <span>
                  {t('detail.commitsProgress', {
                    current: isLaunchingTransition ? 0 : (progress?.currentCommit ?? 0),
                    total: isLaunchingTransition ? '?' : (progress?.totalCommits ?? '?'),
                  })}
                </span>
              </div>

              {/* Timing & clone info */}
              <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
                {startedAt && (
                  <span>
                    {t('detail.started', { time: startedAt.toLocaleTimeString('en-GB', { hour12: false }) })}
                  </span>
                )}
                {elapsed > 0 && (
                  <span className="tabular-nums">
                    {t('detail.elapsed', { time: formatElapsed(elapsed) })}
                  </span>
                )}
                {repoSizeMb != null && repoSizeMb > 0 && (
                  <span>
                    {t('detail.repositorySize', { size: formatSizeFromMb(repoSizeMb) })}
                  </span>
                )}
                {!isLaunchingTransition && cloneSizeMb != null && cloneSizeMb > 0 && (
                  <span>
                    {t('detail.clone', { size: formatSizeFromMb(cloneSizeMb) })}
                  </span>
                )}
                {!isLaunchingTransition && cloneSavedMb != null && cloneSavedPercent != null && (
                  <span className="text-emerald-700">
                    {t('detail.cloneSaved', {
                      size: formatSizeFromMb(cloneSavedMb),
                      percent: cloneSavedPercent,
                    })}
                  </span>
                )}
                {!isLaunchingTransition && progress?.llmProvider && (
                  <span className="border-l pl-4 ml-2">
                    {progress.llmProvider === 'openrouter' ? 'OpenRouter' : 'Ollama'}
                    {progress.llmModel && (
                      <span className="ml-1 text-foreground/70">{progress.llmModel}</span>
                    )}
                    {progress.llmConcurrency != null && (
                      <span className="ml-2 text-foreground/50">
                        {progress.llmConcurrency}×
                        {progress.fdLlmConcurrency != null
                          && progress.fdLlmConcurrency !== progress.llmConcurrency && (
                            <> / FD {progress.fdLlmConcurrency}×</>
                          )}
                      </span>
                    )}
                  </span>
                )}
              </div>

              {/* Runtime diagnostics */}
              {!isLaunchingTransition && progress && (
                <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                  <div className="text-xs font-medium">{t('detail.progressDiagnosticsTitle')}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
                    <div>
                      <span className="text-muted-foreground">{t('detail.jobStatusLabel')}:</span>{' '}
                      <span className="font-mono">{progress.status}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">{t('detail.executionModeLabel')}:</span>{' '}
                      <span className="font-mono">
                        {progress.executionMode === 'modal'
                          ? t('detail.executionModeModal')
                          : t('detail.executionModeLocal')}
                      </span>
                    </div>
                    {progress.currentRepoName && (
                      <div className="md:col-span-2">
                        <span className="text-muted-foreground">{t('detail.currentRepoLabel')}:</span>{' '}
                        <span className="font-mono">{progress.currentRepoName}</span>
                      </div>
                    )}
                    {progress.modalCallId && (
                      <div className="md:col-span-2">
                        <span className="text-muted-foreground">{t('detail.modalCallLabel')}:</span>{' '}
                        <span className="font-mono">{progress.modalCallId}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">{t('detail.retryLabel')}:</span>{' '}
                      <span className="font-mono">{progress.retryCount}/{progress.maxRetries}</span>
                    </div>
                    {progress.executionMode === 'modal' && (
                      <>
                        <div>
                          <span className="text-muted-foreground">{t('detail.heartbeatLabel')}:</span>{' '}
                          <span className="font-mono">
                            {heartbeatAgeMs != null ? t('detail.secondsAgo', { time: formatElapsed(heartbeatAgeMs) }) : 'n/a'}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">{t('detail.lastUpdateLabel')}:</span>{' '}
                          <span className="font-mono">
                            {updateAgeMs != null ? t('detail.secondsAgo', { time: formatElapsed(updateAgeMs) }) : 'n/a'}
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {progress.error && (
                    <div className="rounded-md border border-red-200 bg-red-50/70 px-2 py-1 text-xs text-red-700">
                      {t('detail.workerError', { error: progress.error })}
                    </div>
                  )}

                  {isPendingStale && (
                    <div className="rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1 text-xs text-amber-800">
                      {t('detail.pendingStaleHint')}
                    </div>
                  )}

                  {(isHeartbeatStale || isHeartbeatCritical) && (
                    <div className={`rounded-md border px-2 py-1 text-xs ${
                      isHeartbeatCritical
                        ? 'border-red-200 bg-red-50/70 text-red-700'
                        : 'border-amber-200 bg-amber-50/70 text-amber-800'
                    }`}>
                      {isHeartbeatCritical
                        ? t('detail.heartbeatCriticalHint')
                        : t('detail.heartbeatStaleHint')}
                    </div>
                  )}

                  {isPostProcessingStale && (
                    <div className="rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1 text-xs text-amber-800">
                      {t('detail.postProcessingStaleHint')}
                    </div>
                  )}
                </div>
              )}

              <CommitProcessingTimeline
                events={jobEvents}
                pipelineEntries={pipelineLog}
                jobStartedAt={progress?.startedAt ?? null}
                title={t('detail.commitTimelineTitle')}
                emptyLabel={t('detail.commitTimelineEmpty')}
                spanLabel={t('detail.commitTimelineSpan')}
                showChildrenLabel={t('detail.commitTimelineShowChildren')}
                hideChildrenLabel={t('detail.commitTimelineHideChildren')}
                commitLegendLabel={t('detail.commitTimelineLegendCommit')}
                fdChildLegendLabel={t('detail.commitTimelineLegendFdChild')}
              />

              {/* Live diagnostics events */}
              {jobEvents.length > 0 ? (
                <AnalysisEventLog
                  entries={jobEvents}
                  title={t('detail.liveEventsTitle')}
                  copyLabel={t('detail.copyEvents')}
                  copiedLabel={t('detail.copiedEvents')}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('detail.noLiveEventsHint')}
                </p>
              )}

              {/* Live pipeline log */}
              {pipelineLog.length > 0 ? (
                <PipelineLog entries={pipelineLog} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('detail.noLiveLogHint')}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* ================================================================ */}
      {/* FAILED — Error and Retry                                         */}
      {/* ================================================================ */}
      {order.status === 'FAILED' && !analysisStarted && (
        <Card className="border-red-200">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600 mb-2">
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">{t('detail.analysisFailed')}</span>
            </div>
            <p className="text-sm text-muted-foreground">{order.errorMessage ?? t('detail.unknownError')}</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => analyzeMutation.mutate()}
              disabled={analyzeMutation.isPending}
            >
              <RefreshCw className="h-4 w-4 mr-2" /> {t('detail.retry')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ================================================================ */}
      {/* COMPLETED — Full dashboard                                       */}
      {/* ================================================================ */}
      {order.status === 'COMPLETED' && !analysisStarted && (
        <>
          {isFirstRun && (
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="pt-6">
                <div className="space-y-3">
                  <div>
                    <p className="font-medium">{t('onboardingHandoff.title')}</p>
                    <p className="text-sm text-muted-foreground">{t('onboardingHandoff.description')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href="/people">
                      <Button variant="default" size="sm">
                        <Users className="h-4 w-4 mr-2" />
                        {t('onboardingHandoff.peopleCta')}
                      </Button>
                    </Link>
                    <Link href="/repositories">
                      <Button variant="outline" size="sm">
                        <FolderGit2 className="h-4 w-4 mr-2" />
                        {t('onboardingHandoff.repositoriesCta')}
                      </Button>
                    </Link>
                    <Link href="/repositories">
                      <Button variant="outline" size="sm">
                        <UsersRound className="h-4 w-4 mr-2" />
                        {t('onboardingHandoff.teamCta')}
                      </Button>
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          <div className="flex items-center justify-between">
            {progress?.totalCostUsd != null && progress.totalCostUsd > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('detail.analysisCost', {
                  cost: `$${progress.totalCostUsd.toFixed(4)}`,
                  tokens: `${(progress.totalPromptTokens ?? 0).toLocaleString()} + ${(progress.totalCompletionTokens ?? 0).toLocaleString()}`,
                  calls: progress.totalLlmCalls ?? 0,
                  model: progress.llmModel ?? 'unknown',
                })}
              </p>
            ) : progress?.llmProvider === 'ollama' ? (
              <p className="text-sm text-muted-foreground">
                {t('detail.processedLocally', {
                  model: progress.llmModel ?? 'unknown',
                  calls: progress.totalLlmCalls ?? 0,
                  tokens: `${(progress.totalPromptTokens ?? 0).toLocaleString()} + ${(progress.totalCompletionTokens ?? 0).toLocaleString()}`
                })}
              </p>
            ) : <div />}
            <div className="flex items-center gap-2">
              {Array.isArray(order.selectedRepos) && order.selectedRepos.map((r: Record<string, unknown>) => {
                const fullName = (r.full_name ?? r.fullName ?? `${(r.owner as any)?.login}/${r.name}`) as string;
                return (
                  <Button
                    key={fullName}
                    variant="outline"
                    size="sm"
                    onClick={() => setPublishRepo(fullName)}
                  >
                    <Share2 className="h-4 w-4 mr-2" />
                    {t('detail.publish')}{order.selectedRepos.length > 1 ? ` ${fullName}` : ''}
                  </Button>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowEditScope(!showEditScope)}
              >
                <Settings2 className="h-4 w-4 mr-2" />
                {t('detail.editScope')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => analyzeMutation.mutate()}
                disabled={analyzeMutation.isPending}
              >
                {analyzeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {t('detail.reAnalyze')}
              </Button>
            </div>
          </div>

          {/* Publish modal */}
          {publishRepo && (
            <PublishModal
              open={!!publishRepo}
              onOpenChange={(open) => { if (!open) setPublishRepo(null); }}
              orderId={id}
              repository={publishRepo}
              developers={
                Array.isArray(order.extractedDevelopers)
                  ? (order.extractedDevelopers as Array<{ email: string; name: string | null }>).map(d => ({
                      email: d.email,
                      name: d.name ?? null,
                    }))
                  : metrics.map((m: GhostMetric) => ({
                      email: m.developerEmail,
                      name: m.developerName ?? null,
                    }))
              }
              onPublished={(token) => setShareToken(token)}
            />
          )}

          {/* Share link card */}
          {shareToken && <ShareLinkCard token={shareToken} />}

          {showEditScope && (
            <EditScopePanel
              currentSettings={orderToScopeSettings(order)}
              onSubmit={handleScopeSubmit}
              onCancel={() => setShowEditScope(false)}
              isSubmitting={scopeMutation.isPending}
              availableStartDate={order.availableStartDate ? new Date(order.availableStartDate) : undefined}
              availableEndDate={order.availableEndDate ? new Date(order.availableEndDate) : undefined}
              modeChangeWarning={
                order.analysisPeriodMode === 'SELECTED_YEARS'
                  ? t('detail.modeChangeWarning', { years: (order.analysisYears as number[])?.join(', ') })
                  : undefined
              }
            />
          )}

          {/* Benchmark */}
          {isAdmin && <BenchmarkLauncher
            orderId={id}
            disabled={!!benchmarkJobId}
            commitCount={totalCommits || undefined}
            avgInputTokens={
              progress?.totalPromptTokens && progress?.totalLlmCalls
                ? Math.round(progress.totalPromptTokens / progress.totalLlmCalls)
                : undefined
            }
            onLaunched={(jobId) => {
              setBenchmarkJobId(jobId);
              setBenchmarkLog([]);
              benchmarkLogSinceRef.current = 0;
              setBenchmarkEvents([]);
              benchmarkEventCursorRef.current = null;
            }}
          />}

          {/* Inline benchmark progress — rich display matching main analysis */}
          {isAdmin && benchmarkJobId && benchmarkProgress && (() => {
            const bmStartedAt = benchmarkProgress.startedAt ? new Date(benchmarkProgress.startedAt) : null;
            const bmElapsed = bmStartedAt ? benchmarkNow - bmStartedAt.getTime() : 0;
            return (
              <Card className="border-purple-200">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      {t('detail.benchmarkInProgress')}
                    </CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => cancelJobMutation.mutate(benchmarkJobId)}
                      disabled={cancelJobMutation.isPending}
                    >
                      {cancelJobMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Square className="h-4 w-4 mr-1" />
                      )}
                      {cancelJobMutation.isPending ? t('detail.cancelling') : t('detail.cancel')}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Progress value={benchmarkProgress.progress ?? 0} />
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>{benchmarkProgress.currentStep ?? t('detail.preparing')}</span>
                    <span>
                      {t('detail.commitsProgress', {
                        current: benchmarkProgress.currentCommit ?? 0,
                        total: benchmarkProgress.totalCommits ?? '?',
                      })}
                    </span>
                  </div>

                  {/* Timing & provider info */}
                  <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
                    {bmStartedAt && (
                      <span>
                        {t('detail.started', { time: bmStartedAt.toLocaleTimeString('en-GB', { hour12: false }) })}
                      </span>
                    )}
                    {bmElapsed > 0 && (
                      <span className="tabular-nums">
                        {t('detail.elapsed', { time: formatElapsed(bmElapsed) })}
                      </span>
                    )}
                    {benchmarkProgress.cloneSizeMb != null && benchmarkProgress.cloneSizeMb > 0 && (
                      <span>
                        {t('detail.clone', { size: formatSizeFromMb(benchmarkProgress.cloneSizeMb) })}
                      </span>
                    )}
                    {benchmarkProgress.llmProvider && (
                      <span className="border-l pl-4 ml-2">
                        {benchmarkProgress.llmProvider === 'openrouter' ? 'OpenRouter' : 'Ollama'}
                        {benchmarkProgress.llmModel && (
                          <span className="ml-1 text-foreground/70">{benchmarkProgress.llmModel}</span>
                        )}
                        {benchmarkProgress.llmConcurrency != null && (
                          <span className="ml-2 text-foreground/50">
                            {benchmarkProgress.llmConcurrency}x
                            {benchmarkProgress.fdLlmConcurrency != null
                              && benchmarkProgress.fdLlmConcurrency !== benchmarkProgress.llmConcurrency && (
                                <> / FD {benchmarkProgress.fdLlmConcurrency}x</>
                              )}
                          </span>
                        )}
                      </span>
                    )}
                  </div>

                  {/* Runtime diagnostics */}
                  <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                    <div className="text-xs font-medium">{t('detail.progressDiagnosticsTitle')}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
                      <div>
                        <span className="text-muted-foreground">{t('detail.jobStatusLabel')}:</span>{' '}
                        <span className="font-mono">{benchmarkProgress.status}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">{t('detail.executionModeLabel')}:</span>{' '}
                        <span className="font-mono">
                          {benchmarkProgress.executionMode === 'modal'
                            ? t('detail.executionModeModal')
                            : t('detail.executionModeLocal')}
                        </span>
                      </div>
                      {benchmarkProgress.currentRepoName && (
                        <div className="md:col-span-2">
                          <span className="text-muted-foreground">{t('detail.currentRepoLabel')}:</span>{' '}
                          <span className="font-mono">{benchmarkProgress.currentRepoName}</span>
                        </div>
                      )}
                      {benchmarkProgress.modalCallId && (
                        <div className="md:col-span-2">
                          <span className="text-muted-foreground">{t('detail.modalCallLabel')}:</span>{' '}
                          <span className="font-mono">{benchmarkProgress.modalCallId}</span>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">{t('detail.retryLabel')}:</span>{' '}
                        <span className="font-mono">{benchmarkProgress.retryCount}/{benchmarkProgress.maxRetries}</span>
                      </div>
                      {benchmarkProgress.executionMode === 'modal' && (
                        <>
                          <div>
                            <span className="text-muted-foreground">{t('detail.heartbeatLabel')}:</span>{' '}
                            <span className="font-mono">
                              {bmHeartbeatAgeMs != null ? t('detail.secondsAgo', { time: formatElapsed(bmHeartbeatAgeMs) }) : 'n/a'}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('detail.lastUpdateLabel')}:</span>{' '}
                            <span className="font-mono">
                              {bmUpdateAgeMs != null ? t('detail.secondsAgo', { time: formatElapsed(bmUpdateAgeMs) }) : 'n/a'}
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    {benchmarkProgress.error && (
                      <div className="rounded-md border border-red-200 bg-red-50/70 px-2 py-1 text-xs text-red-700">
                        {t('detail.workerError', { error: benchmarkProgress.error })}
                      </div>
                    )}

                    {bmIsPendingStale && (
                      <div className="rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1 text-xs text-amber-800">
                        {t('detail.pendingStaleHint')}
                      </div>
                    )}

                    {(bmIsHeartbeatStale || bmIsHeartbeatCritical) && (
                      <div className={`rounded-md border px-2 py-1 text-xs ${
                        bmIsHeartbeatCritical
                          ? 'border-red-200 bg-red-50/70 text-red-700'
                          : 'border-amber-200 bg-amber-50/70 text-amber-800'
                      }`}>
                        {bmIsHeartbeatCritical
                          ? t('detail.heartbeatCriticalHint')
                          : t('detail.heartbeatStaleHint')}
                      </div>
                    )}
                  </div>

                  <CommitProcessingTimeline
                    events={benchmarkEvents}
                    pipelineEntries={benchmarkLog}
                    jobStartedAt={benchmarkProgress.startedAt ?? null}
                    title={t('detail.commitTimelineTitle')}
                    emptyLabel={t('detail.commitTimelineEmpty')}
                    spanLabel={t('detail.commitTimelineSpan')}
                    showChildrenLabel={t('detail.commitTimelineShowChildren')}
                    hideChildrenLabel={t('detail.commitTimelineHideChildren')}
                    commitLegendLabel={t('detail.commitTimelineLegendCommit')}
                    fdChildLegendLabel={t('detail.commitTimelineLegendFdChild')}
                  />

                  {/* Live diagnostics events */}
                  {benchmarkEvents.length > 0 ? (
                    <AnalysisEventLog
                      entries={benchmarkEvents}
                      title={t('detail.liveEventsTitle')}
                      copyLabel={t('detail.copyEvents')}
                      copiedLabel={t('detail.copiedEvents')}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t('detail.noLiveEventsHint')}
                    </p>
                  )}

                  {/* Live pipeline log */}
                  {benchmarkLog.length > 0 ? (
                    <PipelineLog entries={benchmarkLog} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t('detail.noLiveLogHint')}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          {/* Collapsible runtime log (events + pipeline log) */}
          {(jobEvents.length > 0 || pipelineLog.length > 0) && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowCompletedLog(!showCompletedLog)}
              >
                <Terminal className="h-4 w-4 mr-1" />
                {t('detail.pipelineLog', { count: pipelineLog.length + jobEvents.length })}
                {showCompletedLog ? (
                  <ChevronUp className="h-4 w-4 ml-1" />
                ) : (
                  <ChevronDown className="h-4 w-4 ml-1" />
                )}
              </Button>
              {showCompletedLog && (
                <div className="space-y-3">
                  <CommitProcessingTimeline
                    events={jobEvents}
                    pipelineEntries={pipelineLog}
                    jobStartedAt={progress?.startedAt ?? null}
                    title={t('detail.commitTimelineTitle')}
                    emptyLabel={t('detail.commitTimelineEmpty')}
                    spanLabel={t('detail.commitTimelineSpan')}
                    showChildrenLabel={t('detail.commitTimelineShowChildren')}
                    hideChildrenLabel={t('detail.commitTimelineHideChildren')}
                    commitLegendLabel={t('detail.commitTimelineLegendCommit')}
                    fdChildLegendLabel={t('detail.commitTimelineLegendFdChild')}
                  />
                  {jobEvents.length > 0 && (
                    <AnalysisEventLog
                      entries={jobEvents}
                      title={t('detail.liveEventsTitle')}
                      copyLabel={t('detail.copyEvents')}
                      copiedLabel={t('detail.copiedEvents')}
                    />
                  )}
                  {pipelineLog.length > 0 && <PipelineLog entries={pipelineLog} />}
                </div>
              )}
            </div>
          )}

          <GhostKpiCards
            avgGhostPercent={avgGhost}
            developerCount={displayMetrics.length}
            commitCount={totalCommits}
            totalWorkDays={totalWorkDays}
            ghostNormHours={effectiveGhostNorm}
          />

          {/* Commit date range & analysis scope */}
          {(() => {
            const repoStart = fmtDate(order.availableStartDate, dateLocale);
            const repoEnd = fmtDate(order.availableEndDate, dateLocale);
            const scope = formatScopeDescription(order, t, dateLocale);
            const isPartial = order.analysisPeriodMode !== 'ALL_TIME';
            const displayCommits = totalCommits || order.totalCommits || 0;
            return (repoStart && repoEnd) ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                <CalendarRange className="h-4 w-4 flex-shrink-0" />
                <span>{t('detail.repoDateRange', { start: repoStart, end: repoEnd })}</span>
                <span className="text-muted-foreground/40">&middot;</span>
                {isPartial ? (
                  <Badge variant="outline" className="border-amber-300 text-amber-700 bg-amber-50 text-xs font-normal">
                    {scope}
                  </Badge>
                ) : (
                  <span>{scope}</span>
                )}
                {displayCommits > 0 && (
                  <>
                    <span className="text-muted-foreground/40">&middot;</span>
                    <span>{t('detail.commitsAnalyzed', { count: displayCommits.toLocaleString() })}</span>
                  </>
                )}
              </div>
            ) : null;
          })()}

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="overview">{t('detail.overview')}</TabsTrigger>
              <TabsTrigger value="commits">{t('detail.commits')}</TabsTrigger>
              {isAdmin && <TabsTrigger value="benchmark">
                {t('detail.benchmark')}
                {benchmarkRuns.filter(r => r.status === 'COMPLETED').length > 0 && (
                  <span className="ml-1 text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full">
                    {benchmarkRuns.filter(r => r.status === 'COMPLETED').length}
                  </span>
                )}
              </TabsTrigger>}
              <TabsTrigger value="calendar">{t('detail.effortTimeline')}</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-6">
              <div className="flex justify-end items-center gap-2 flex-wrap">
                <GhostPeriodSelector value={period} onChange={setPeriod} />
                <Select value={ghostNormMode} onValueChange={(value) => setGhostNormMode(value as GhostNormMode)}>
                  <SelectTrigger className="w-[320px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">{t('detail.ghostNormModeFixed', { hours: GHOST_NORM.toFixed(1) })}</SelectItem>
                    <SelectItem value="median">{t('detail.ghostNormModeMedian')}</SelectItem>
                  </SelectContent>
                </Select>
                <Badge variant="outline" className="text-xs">
                  {t('detail.ghostNormCurrent', { hours: effectiveGhostNormLabel })}
                </Badge>
              </div>
              {ghostNormMode === 'median' && effectiveGhostNormMode === 'fixed' && (
                <p className="text-xs text-muted-foreground text-right">
                  {t('detail.ghostNormMedianFallback', { hours: GHOST_NORM.toFixed(1) })}
                </p>
              )}
              {ghostNormMode === 'median' && medianGhostNormLabel && (
                <p className="text-xs text-muted-foreground text-right">
                  {t('detail.ghostNormMedianValue', { hours: medianGhostNormLabel })}
                </p>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>{t('detail.ghostDistribution')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <GhostDistributionPanel
                    metrics={displayMetrics}
                    onDeveloperClick={(email) => router.push(`/orders/${id}/developers/${encodeURIComponent(email)}`)}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('detail.developersTitle')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <GhostDeveloperTable
                    metrics={displayMetrics}
                    orderId={id}
                    highlightedEmail={highlightedEmail}
                    onShareChange={(email, share, auto) => shareMutation.mutate({ email, share, auto })}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="commits">
              <CommitAnalysisTable orderId={id} />
            </TabsContent>

            {isAdmin && (
              <TabsContent value="benchmark">
                <BenchmarkMatrix orderId={id} />
              </TabsContent>
            )}

            <TabsContent value="calendar">
              <EffortTimeline orderId={id} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
