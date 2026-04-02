'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  ChevronDown,
  ChevronUp,
  Settings2,
  RefreshCw,
  Share2,
  Terminal,
  Loader2,
  Square,
} from 'lucide-react';
import { BenchmarkLauncher } from '@/components/benchmark-launcher';
import { BenchmarkMatrix } from '@/components/benchmark-matrix';
import { PipelineLog } from '@/components/pipeline-log';
import { AnalysisEventLog } from '@/components/analysis-event-log';
import { CommitProcessingTimeline } from '@/components/commit-processing-timeline';
import { EditScopePanel, type AnalysisPeriodSettings } from '@/components/edit-scope-panel';
import { PublishModal } from '@/components/publish-modal';
import { ShareLinkCard } from '@/components/share-link-card';
import { AdminRerunControls, type AdminRerunOptions } from '@/components/admin-rerun-controls';
import type { PipelineLogEntry } from '@/components/pipeline-log';
import type { AnalysisEventEntry } from '@/components/analysis-event-log';
import type { GhostMetric } from '@devghost/shared';
import type { WorkspaceStage } from '@/hooks/use-workspace-stage';

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatSizeFromMb(sizeMb: number): string {
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`;
  if (sizeMb >= 100) return `${Math.round(sizeMb)} MB`;
  return `${sizeMb.toFixed(1)} MB`;
}

/** Convert order DB fields to AnalysisPeriodSettings for the UI selector */
function orderToScopeSettings(order: {
  analysisPeriodMode: string;
  analysisYears?: number[] | null;
  analysisStartDate?: string | Date | null;
  analysisEndDate?: string | Date | null;
  analysisCommitLimit?: number | null;
}): AnalysisPeriodSettings {
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

interface AnalysisTechnicalPanelProps {
  orderId: string;
  order: any; // Order type from API
  workspaceStage: WorkspaceStage;
  isAdmin: boolean;
  // Progress & diagnostics
  progress: any;
  jobEvents: AnalysisEventEntry[];
  pipelineLog: PipelineLogEntry[];
  // Benchmark
  benchmarkJobId: string | null;
  benchmarkProgress: any;
  benchmarkEvents: AnalysisEventEntry[];
  benchmarkLog: PipelineLogEntry[];
  benchmarkNow: number;
  onBenchmarkLaunched: (jobId: string) => void;
  // Mutations
  onAnalyze: () => void;
  analyzeIsPending: boolean;
  rerunOptions: AdminRerunOptions;
  onRerunOptionsChange: (options: AdminRerunOptions) => void;
  onCancelJob: (jobId: string) => void;
  cancelIsPending: boolean;
  // Scope
  onScopeSubmit: (settings: AnalysisPeriodSettings) => void;
  scopeIsPending: boolean;
  // Publish
  metrics: GhostMetric[];
  // Share token
  shareToken: string | null;
  onShareTokenChange: (token: string | null) => void;
}

export function AnalysisTechnicalPanel(props: AnalysisTechnicalPanelProps) {
  const {
    orderId,
    order,
    workspaceStage,
    isAdmin,
    progress,
    jobEvents,
    pipelineLog,
    benchmarkJobId,
    benchmarkProgress,
    benchmarkEvents,
    benchmarkLog,
    benchmarkNow,
    onBenchmarkLaunched,
    onAnalyze,
    analyzeIsPending,
    rerunOptions,
    onRerunOptionsChange,
    onCancelJob,
    cancelIsPending,
    onScopeSubmit,
    scopeIsPending,
    metrics,
    shareToken,
    onShareTokenChange,
  } = props;

  const t = useTranslations('orders');
  const tResults = useTranslations('analysisResults');
  const [isOpen, setIsOpen] = useState(workspaceStage !== 'first_data');
  const userToggled = useRef(false);
  useEffect(() => {
    if (!userToggled.current) {
      setIsOpen(workspaceStage !== 'first_data');
    }
  }, [workspaceStage]);
  const [publishRepo, setPublishRepo] = useState<string | null>(null);
  const [showEditScope, setShowEditScope] = useState(false);
  const [showCompletedLog, setShowCompletedLog] = useState(false);

  // Benchmark derived state
  const bmStartedAt = benchmarkProgress?.startedAt ? new Date(benchmarkProgress.startedAt) : null;
  const bmElapsed = bmStartedAt ? benchmarkNow - bmStartedAt.getTime() : 0;
  const bmHeartbeatAgeMs = benchmarkProgress?.heartbeatAt
    ? benchmarkNow - new Date(benchmarkProgress.heartbeatAt).getTime()
    : null;
  const bmUpdateAgeMs = benchmarkProgress?.updatedAt
    ? benchmarkNow - new Date(benchmarkProgress.updatedAt).getTime()
    : null;
  const bmIsPendingStale =
    benchmarkProgress?.status === 'PENDING' && bmUpdateAgeMs != null && bmUpdateAgeMs > 2 * 60 * 1000;
  const bmIsHeartbeatStale =
    benchmarkProgress?.status === 'RUNNING' && bmHeartbeatAgeMs != null && bmHeartbeatAgeMs > 2 * 60 * 1000;
  const bmIsHeartbeatCritical =
    benchmarkProgress?.status === 'RUNNING' && bmHeartbeatAgeMs != null && bmHeartbeatAgeMs > 10 * 60 * 1000;

  const totalCommits = progress?.totalCommits ?? order.totalCommits ?? 0;

  return (
    <Collapsible open={isOpen} onOpenChange={(open) => { userToggled.current = true; setIsOpen(open); }}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="flex items-center gap-2 text-muted-foreground">
          {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {tResults('technical.label')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-2">
        {/* Analysis cost line */}
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
              onClick={() => onAnalyze()}
              disabled={analyzeIsPending}
            >
              {analyzeIsPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {t('detail.reAnalyze')}
            </Button>
          </div>
        </div>

        {isAdmin && (
          <AdminRerunControls
            options={rerunOptions}
            onChange={onRerunOptionsChange}
            disabled={analyzeIsPending}
            compact
          />
        )}

        {/* Publish modal */}
        {publishRepo && (
          <PublishModal
            open={!!publishRepo}
            onOpenChange={(open) => { if (!open) setPublishRepo(null); }}
            orderId={orderId}
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
            onPublished={(token) => onShareTokenChange(token)}
          />
        )}

        {/* Share link card */}
        {shareToken && <ShareLinkCard token={shareToken} />}

        {/* Edit scope */}
        {showEditScope && (
          <EditScopePanel
            orderId={orderId}
            currentSettings={orderToScopeSettings(order)}
            onSubmit={onScopeSubmit}
            onCancel={() => setShowEditScope(false)}
            isSubmitting={scopeIsPending}
            availableStartDate={order.availableStartDate ? new Date(order.availableStartDate) : undefined}
            availableEndDate={order.availableEndDate ? new Date(order.availableEndDate) : undefined}
            modeChangeWarning={
              order.analysisPeriodMode === 'SELECTED_YEARS'
                ? t('detail.modeChangeWarning', { years: (order.analysisYears as number[])?.join(', ') })
                : undefined
            }
          />
        )}

        {/* Benchmark launcher (admin only) */}
        {isAdmin && (
          <BenchmarkLauncher
            orderId={orderId}
            disabled={!!benchmarkJobId}
            commitCount={totalCommits || undefined}
            avgInputTokens={
              progress?.totalPromptTokens && progress?.totalLlmCalls
                ? Math.round(progress.totalPromptTokens / progress.totalLlmCalls)
                : undefined
            }
            onLaunched={onBenchmarkLaunched}
          />
        )}

        {/* Inline benchmark progress */}
        {isAdmin && benchmarkJobId && benchmarkProgress && (() => {
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
                    onClick={() => onCancelJob(benchmarkJobId)}
                    disabled={cancelIsPending}
                  >
                    {cancelIsPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Square className="h-4 w-4 mr-1" />
                    )}
                    {cancelIsPending ? t('detail.cancelling') : t('detail.cancel')}
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

        {/* BenchmarkMatrix for completed benchmark runs */}
        {isAdmin && <BenchmarkMatrix orderId={orderId} />}

        {/* Collapsible completed pipeline log */}
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
      </CollapsibleContent>
    </Collapsible>
  );
}
