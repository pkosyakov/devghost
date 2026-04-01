'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  Trash2,
  Database,
  Activity,
  AlertTriangle,
  HeartPulse,
  CheckCircle2,
  XCircle,
  Clock3,
  Play,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslations } from 'next-intl';

type HealthStatus = 'pass' | 'warn' | 'fail';
type AtomicStepStatus = 'pass' | 'warn' | 'pending' | 'missing';

interface MonitoringData {
  activeJobs: {
    id: string;
    status: string;
    progress: number;
    currentStep: string | null;
    startedAt: string | null;
    createdAt: string;
    updatedAt: string;
    heartbeatAt: string | null;
    executionMode: string;
    modalCallId: string | null;
    retryCount: number;
    maxRetries: number;
    orderId: string;
    orderName: string;
    ownerEmail: string;
  }[];
  recentFailed: {
    id: string;
    error: string | null;
    completedAt: string | null;
    orderId: string;
    orderName: string;
    ownerEmail: string;
  }[];
  cache: { totalMb: number; repos: number; diffs: number; llm: number; available: boolean };
  pipeline: {
    checkedAt: string;
    mode: string;
    endpointHost: string | null;
    watchdogLastEventAt: string | null;
    watchdogLastEventCode: string | null;
    counts: { pass: number; warn: number; fail: number };
    checks: {
      id: string;
      status: HealthStatus;
      summary: string;
      details: string | null;
    }[];
    stuckJobs: {
      id: string;
      orderId: string;
      orderName: string;
      ownerEmail: string;
      status: string;
      progress: number;
      currentStep: string | null;
      retryCount: number;
      maxRetries: number;
      modalCallId: string | null;
      createdAt: string;
      updatedAt: string;
      heartbeatAt: string | null;
      ageSec: number;
      sinceUpdateSec: number;
      heartbeatLagSec: number | null;
      lastEventCode: string | null;
      lastEventLevel: string | null;
      lastEventMessage: string | null;
      lastEventAt: string | null;
      missingAtomicSteps: string[];
      atomicSteps: {
        id: string;
        status: AtomicStepStatus;
        occurredAt: string | null;
        code: string | null;
      }[];
    }[];
  };
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'n/a';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function healthIcon(status: HealthStatus) {
  if (status === 'pass') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'warn') return <Clock3 className="h-4 w-4 text-amber-500" />;
  return <XCircle className="h-4 w-4 text-red-500" />;
}

function healthBadgeClass(status: HealthStatus): string {
  if (status === 'pass') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700';
  if (status === 'warn') return 'border-amber-500/40 bg-amber-500/10 text-amber-700';
  return 'border-red-500/40 bg-red-500/10 text-red-700';
}

function stepBadgeClass(status: AtomicStepStatus): string {
  if (status === 'pass') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700';
  if (status === 'warn') return 'border-amber-500/40 bg-amber-500/10 text-amber-700';
  if (status === 'missing') return 'border-red-500/40 bg-red-500/10 text-red-700';
  return 'border-slate-400/40 bg-slate-400/10 text-slate-600';
}

export default function AdminMonitoringPage() {
  const t = useTranslations('admin.monitoring');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<MonitoringData>({
    queryKey: ['admin-monitoring'],
    queryFn: async () => {
      const res = await fetch('/api/admin/monitoring');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    refetchInterval: 10_000,
  });

  const triggerWatchdog = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/watchdog/trigger', { method: 'POST' });
      const json = await res.json();
      if (!json.ok && !json.success) throw new Error(json.error ?? 'Watchdog trigger failed');
      return json;
    },
    onSuccess: (responseData) => {
      queryClient.invalidateQueries({ queryKey: ['admin-monitoring'] });
      toast({ title: t('watchdogTriggered'), description: t('watchdogProcessed', { count: responseData.processed ?? 0 }) });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const clearCache = useMutation({
    mutationFn: async (level: string) => {
      const res = await fetch(`/api/cache?level=${level}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json;
    },
    onSuccess: (responseData) => {
      queryClient.invalidateQueries({ queryKey: ['admin-monitoring'] });
      toast({ title: t('cacheCleared'), description: t('freedMb', { mb: responseData.freedMb }) });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) return null;

  const atomicStepLabels: Record<string, string> = {
    job_created: t('atomicJobCreated'),
    modal_flags_saved: t('atomicModalFlagsSaved'),
    llm_snapshot_saved: t('atomicLlmSnapshotSaved'),
    modal_trigger_accepted: t('atomicModalTriggerAccepted'),
    worker_acquired: t('atomicWorkerAcquired'),
    heartbeat_thread_started: t('atomicHeartbeatStarted'),
    repo_start: t('atomicRepoStart'),
    worker_llm_complete: t('atomicWorkerLlmComplete'),
    post_processing_start: t('atomicPostProcessingStart'),
    post_processing_done: t('atomicPostProcessingDone'),
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* Pipeline Health */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HeartPulse className="h-5 w-5" />
              <CardTitle>{t('pipelineHealth')}</CardTitle>
            </div>
            <Button
              size="sm"
              disabled={triggerWatchdog.isPending}
              onClick={() => triggerWatchdog.mutate()}
            >
              {triggerWatchdog.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {t('triggerWatchdog')}
            </Button>
          </div>
          <CardDescription>{t('pipelineHealthDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge className={healthBadgeClass('pass')}>{t('checksPass', { count: data.pipeline.counts.pass })}</Badge>
            <Badge className={healthBadgeClass('warn')}>{t('checksWarn', { count: data.pipeline.counts.warn })}</Badge>
            <Badge className={healthBadgeClass('fail')}>{t('checksFail', { count: data.pipeline.counts.fail })}</Badge>
            <Badge variant="outline">{t('pipelineModeValue', { mode: data.pipeline.mode })}</Badge>
            {data.pipeline.endpointHost && (
              <Badge variant="outline">{t('endpointHostValue', { host: data.pipeline.endpointHost })}</Badge>
            )}
          </div>

          <div className="space-y-2">
            {data.pipeline.checks.map((check) => (
              <div key={check.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {healthIcon(check.status)}
                    <p className="text-sm font-medium">{check.summary}</p>
                  </div>
                  <Badge className={healthBadgeClass(check.status)}>
                    {check.status.toUpperCase()}
                  </Badge>
                </div>
                {check.details && (
                  <p className="mt-1 text-xs text-muted-foreground">{check.details}</p>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">
                {t('stuckJobs', { count: data.pipeline.stuckJobs.length })}
              </p>
              <Badge
                className={data.pipeline.stuckJobs.length > 0 ? healthBadgeClass('fail') : healthBadgeClass('pass')}
              >
                {data.pipeline.stuckJobs.length > 0 ? t('needsAttention') : t('allGood')}
              </Badge>
            </div>

            {data.pipeline.stuckJobs.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('noStuckJobs')}</p>
            ) : (
              <div className="space-y-3">
                {data.pipeline.stuckJobs.map((job) => (
                  <div key={job.id} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{job.orderName}</p>
                        <p className="text-xs text-muted-foreground">{job.ownerEmail}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{job.status}</Badge>
                        <Badge variant="outline">{job.progress}%</Badge>
                        <Badge variant="outline">{t('retryValue', { current: job.retryCount, max: job.maxRetries })}</Badge>
                      </div>
                    </div>

                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                      <p>{t('jobIdValue', { id: job.id })}</p>
                      <p>{t('modalCallValue', { id: job.modalCallId ?? 'n/a' })}</p>
                      <p>{t('ageValue', { value: formatAge(job.ageSec) })}</p>
                      <p>{t('updateLagValue', { value: formatAge(job.sinceUpdateSec) })}</p>
                      <p>{t('heartbeatLagValue', { value: formatAge(job.heartbeatLagSec) })}</p>
                      <p>{t('currentStepValue', { step: job.currentStep ?? 'n/a' })}</p>
                    </div>

                    {job.lastEventCode && (
                      <div className="mt-2 rounded bg-muted/50 p-2 text-xs">
                        <p className="font-medium">
                          {t('lastEventValue', {
                            code: job.lastEventCode,
                            level: job.lastEventLevel ?? 'n/a',
                            age: formatAge(
                              job.lastEventAt
                                ? Math.max(0, Math.floor((Date.now() - new Date(job.lastEventAt).getTime()) / 1000))
                                : null,
                            ),
                          })}
                        </p>
                        {job.lastEventMessage && (
                          <p className="mt-1 text-muted-foreground">{job.lastEventMessage}</p>
                        )}
                      </div>
                    )}

                    {job.missingAtomicSteps.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {job.missingAtomicSteps.map((stepId) => (
                          <Badge key={stepId} className={stepBadgeClass('missing')}>
                            {atomicStepLabels[stepId] ?? stepId}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className="mt-3 grid gap-1 md:grid-cols-2">
                      {job.atomicSteps.map((step) => (
                        <div
                          key={`${job.id}-${step.id}`}
                          className="flex items-center justify-between rounded border px-2 py-1 text-xs"
                        >
                          <span>{atomicStepLabels[step.id] ?? step.id}</span>
                          <Badge className={stepBadgeClass(step.status)}>
                            {step.status.toUpperCase()}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Active Jobs */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            <CardTitle>{t('activeJobs')}</CardTitle>
          </div>
          <CardDescription>{t('jobsRunning', { count: data.activeJobs.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.activeJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noActiveJobs')}</p>
          ) : (
            <div className="space-y-3">
              {data.activeJobs.map((job) => (
                <div key={job.id} className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="font-medium text-sm">{job.orderName}</p>
                    <p className="text-xs text-muted-foreground">{job.ownerEmail}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">{job.executionMode}</Badge>
                    <span className="text-sm text-muted-foreground">{job.currentStep ?? t('starting')}</span>
                    <Badge variant="outline">{job.progress}%</Badge>
                    <Badge>{job.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pipeline Cache */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            <CardTitle>{t('pipelineCache')}</CardTitle>
          </div>
          <CardDescription>{t('pipelineCacheDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.cache.available ? (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{data.cache.totalMb}</p>
                  <p className="text-xs text-muted-foreground">{t('totalMb')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{data.cache.repos}</p>
                  <p className="text-xs text-muted-foreground">{t('repoClones')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{data.cache.diffs}</p>
                  <p className="text-xs text-muted-foreground">{t('diffCache')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{data.cache.llm}</p>
                  <p className="text-xs text-muted-foreground">{t('llmCache')}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={clearCache.isPending}
                  onClick={() => clearCache.mutate('all')}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('clearAll')}
                </Button>
                <Button variant="outline" size="sm" disabled={clearCache.isPending} onClick={() => clearCache.mutate('llm')}>
                  {t('clearLlm')}
                </Button>
                <Button variant="outline" size="sm" disabled={clearCache.isPending} onClick={() => clearCache.mutate('diffs')}>
                  {t('clearDiffs')}
                </Button>
                <Button variant="outline" size="sm" disabled={clearCache.isPending} onClick={() => clearCache.mutate('repos')}>
                  {t('clearRepos')}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('naModalMode')}</p>
          )}
        </CardContent>
      </Card>

      {/* Recent Failures */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            <CardTitle>{t('recentFailures')}</CardTitle>
          </div>
          <CardDescription>{t('recentFailuresDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentFailed.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noRecentFailures')}</p>
          ) : (
            <div className="space-y-2">
              {data.recentFailed.map((job) => (
                <div key={job.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">{job.orderName}</p>
                    <span className="text-xs text-muted-foreground">
                      {job.completedAt ? new Date(job.completedAt).toLocaleString() : '\u2014'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{job.ownerEmail}</p>
                  {job.error && (
                    <p className="mt-1 text-xs text-destructive font-mono truncate">{job.error}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
