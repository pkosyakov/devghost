'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNow } from '@/hooks/use-now';
import { formatElapsed } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useDripFeed } from '@/hooks/use-drip-feed';
import type { ClientEvent, LeaderboardData } from '@/lib/services/client-event-mapper';
import {
  Loader2, Square, Play, RefreshCw, Pause, AlertCircle, XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

type TFunction = ReturnType<typeof useTranslations>;

// ── Odometer counter ───────────────────────────────────────────────

function AnimatedCounter({ value, label }: { value: number; label: string }) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const start = display;
    const diff = value - start;
    if (diff === 0) return;
    const duration = Math.min(400, Math.abs(diff) * 20);
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      setDisplay(Math.round(start + diff * progress));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="text-center">
      <div className="text-2xl font-bold tabular-nums">{display.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ── Feed event row ─────────────────────────────────────────────────

function FeedEvent({ event, t }: { event: ClientEvent; t: TFunction }) {
  const message = t(`clientProgress.${event.text.replace('clientProgress.', '')}`, event.params);

  if (event.tier === 'milestone') {
    return (
      <div className="py-2 border-t border-primary/20">
        <p className="text-sm font-semibold text-primary">{message}</p>
      </div>
    );
  }

  if (event.tier === 'micro') {
    return (
      <span className="text-xs text-muted-foreground">{message}</span>
    );
  }

  return (
    <p className="text-sm">{message}</p>
  );
}

// ── Leaderboard bar race ───────────────────────────────────────────

function LeaderboardRace({
  data,
  t,
}: {
  data: LeaderboardData;
  t: TFunction;
}) {
  const allParticipants = useMemo(() => {
    const devs = data.developers.map(d => ({
      id: d.id,
      name: d.name,
      hours: d.totalHours,
      isGhost: false,
    }));
    devs.push({
      id: '__ghost__',
      name: t('clientProgress.ghostLabel'),
      hours: data.ghost.totalHours,
      isGhost: true,
    });
    return devs.sort((a, b) => b.hours - a.hours);
  }, [data, t]);

  const maxHours = Math.max(...allParticipants.map(p => p.hours), 1);

  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium mb-2">
        {t('clientProgress.leaderboardTitle')}
      </h3>
      {allParticipants.map((participant, index) => (
        <div
          key={participant.id}
          className="flex items-center gap-2 transition-all duration-500 ease-in-out"
        >
          <div className="w-24 text-xs truncate text-right">
            {participant.isGhost ? (
              <span className="text-muted-foreground/60 italic">{participant.name}</span>
            ) : (
              participant.name
            )}
          </div>
          <div className="flex-1 h-6 bg-muted/30 rounded-sm overflow-hidden">
            <div
              className={`h-full rounded-sm transition-all duration-700 ease-out ${
                participant.isGhost
                  ? 'bg-primary/15 border border-dashed border-primary/30'
                  : 'bg-primary/70'
              }`}
              style={{ width: `${Math.max(2, (participant.hours / maxHours) * 100)}%` }}
            />
          </div>
          <div className="w-14 text-xs tabular-nums text-right">
            {participant.hours.toFixed(1)}h
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

interface ClientAnalysisProgressProps {
  progress: {
    jobId: string;
    status: string;
    progress: number;
    currentStep: string | null;
    currentCommit: number | null;
    totalCommits: number | null;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
    isPaused: boolean;
    pauseReason: string | null;
    isRetrying: boolean;
    currentRepoName: string | null;
    clientEvents: ClientEvent[];
    eventCursor: string | null;
    leaderboard: LeaderboardData;
  } | null;
  allClientEvents: ClientEvent[];
  repoSizeMb?: number | null;
  isAdmin: boolean;
  onToggleView: () => void;
  onCancel: () => void;
  onResume: () => void;
  onRetry: () => void;
  onDrainStart: () => void;
  onComplete: (terminalStatus: string) => void;
  cancelPending?: boolean;
  resumePending?: boolean;
}

export function ClientAnalysisProgress({
  progress,
  allClientEvents,
  repoSizeMb,
  isAdmin,
  onToggleView,
  onCancel,
  onResume,
  onRetry,
  onDrainStart,
  onComplete,
  cancelPending,
  resumePending,
}: ClientAnalysisProgressProps) {
  const t = useTranslations('orders');
  const feedRef = useRef<HTMLDivElement>(null);

  const jobStatus = progress?.status ?? 'PENDING';
  const isPaused = progress?.isPaused ?? false;
  const isRetrying = progress?.isRetrying ?? false;

  const {
    visibleEvents,
    counters,
    leaderboard,
    isDraining,
    isDrained,
  } = useDripFeed({
    rawEvents: allClientEvents,
    rawLeaderboard: progress?.leaderboard ?? { developers: [], ghost: { totalHours: 0 }, scopeWorkDays: 0 },
    jobStatus,
    isPaused,
  });

  useEffect(() => {
    if (isDraining) onDrainStart();
  }, [isDraining, onDrainStart]);

  useEffect(() => {
    if (isDrained) onComplete(jobStatus);
  }, [isDrained, onComplete, jobStatus]);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [visibleEvents.length]);

  const now = useNow(jobStatus === 'RUNNING' || jobStatus === 'PENDING');
  const startedAt = progress?.startedAt ? new Date(progress.startedAt) : null;
  const elapsed = startedAt ? now - startedAt.getTime() : 0;

  const groupedEvents = useMemo(() => {
    const groups: { events: ClientEvent[]; isMicroGroup: boolean }[] = [];
    let currentMicros: ClientEvent[] = [];

    for (const event of visibleEvents) {
      if (event.tier === 'micro') {
        currentMicros.push(event);
      } else {
        if (currentMicros.length > 0) {
          groups.push({ events: currentMicros, isMicroGroup: true });
          currentMicros = [];
        }
        groups.push({ events: [event], isMicroGroup: false });
      }
    }
    if (currentMicros.length > 0) {
      groups.push({ events: currentMicros, isMicroGroup: true });
    }
    return groups;
  }, [visibleEvents]);

  if (isRetrying && jobStatus === 'FAILED_RETRYABLE' && !isPaused) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
            <span className="font-medium text-amber-700">{t('clientProgress.retryingAutomatically')}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isTerminalFailed = isDrained && (
    jobStatus === 'FAILED'
    || jobStatus === 'FAILED_FATAL'
    || (jobStatus === 'FAILED_RETRYABLE' && !isRetrying && !isPaused)
  );
  const isTerminalCancelled = isDrained && jobStatus === 'CANCELLED';

  const currentPhase = progress?.currentStep ?? t('detail.preparing');

  return (
    <div className="space-y-4">
      {isPaused && (
        <Card className="border-amber-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Pause className="h-5 w-5 text-amber-600" />
              <span className="text-amber-700">{t('clientProgress.pausedBanner')}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {progress && progress.currentCommit != null && progress.totalCommits != null && (
              <div className="space-y-2">
                <Progress value={progress.progress} />
                <p className="text-xs text-muted-foreground">
                  {t('detail.preservedProgress', {
                    current: progress.currentCommit,
                    total: progress.totalCommits,
                  })}
                </p>
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button onClick={onResume} disabled={resumePending}>
                {resumePending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                {t('detail.resumeSameRun')}
              </Button>
              <Button variant="outline" onClick={onRetry}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('detail.freshRerun')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isTerminalFailed && (
        <Card className="border-red-200">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600 mb-2">
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">{t('clientProgress.analysisFailed')}</span>
            </div>
            <p className="text-sm text-muted-foreground">{progress?.error ?? t('clientProgress.genericError')}</p>
            <Button variant="outline" className="mt-4" onClick={onRetry}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('clientProgress.tryAgain')}
            </Button>
          </CardContent>
        </Card>
      )}
      {isTerminalCancelled && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-2">
              <XCircle className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium">{t('clientProgress.analysisCancelled')}</span>
            </div>
            <Button variant="outline" className="mt-4" onClick={onRetry}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('clientProgress.startNewAnalysis')}
            </Button>
          </CardContent>
        </Card>
      )}

      {!isTerminalFailed && !isTerminalCancelled && (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t('detail.analysisInProgress')}
            </CardTitle>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <Button variant="ghost" size="sm" onClick={onToggleView}>
                  {t('clientProgress.adminViewToggle')}
                </Button>
              )}
              {progress?.jobId && (
                <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelPending}>
                  {cancelPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Square className="h-4 w-4 mr-1" />}
                  {t('detail.cancel')}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={progress?.progress ?? 0} />
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>{currentPhase}</span>
            <span>{t('detail.commitsProgress', {
              current: progress?.currentCommit ?? 0,
              total: progress?.totalCommits ?? '?',
            })}</span>
          </div>

          <div className="grid grid-cols-3 gap-4 py-2">
            <AnimatedCounter value={counters.commits} label={t('clientProgress.commitsUnit', { count: counters.commits })} />
            <AnimatedCounter value={counters.files} label={t('clientProgress.filesChanged', { fileCount: counters.files })} />
            <AnimatedCounter value={counters.lines} label={t('clientProgress.linesChanged', { lineCount: counters.lines })} />
          </div>

          <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
            {startedAt && (
              <span>{t('detail.started', { time: startedAt.toLocaleTimeString('en-GB', { hour12: false }) })}</span>
            )}
            {elapsed > 0 && (
              <span className="tabular-nums">{t('detail.elapsed', { time: formatElapsed(elapsed) })}</span>
            )}
            {repoSizeMb != null && repoSizeMb > 0 && (
              <span>{t('detail.repositorySize', { size: repoSizeMb >= 1024 ? `${(repoSizeMb / 1024).toFixed(1)} GB` : `${Math.round(repoSizeMb)} MB` })}</span>
            )}
            {progress?.currentRepoName && (
              <span className="border-l pl-4 ml-2">{progress.currentRepoName}</span>
            )}
          </div>
        </CardContent>
      </Card>
      )}

      <Card>
        <CardContent className="pt-4">
          <div
            ref={feedRef}
            className="max-h-64 overflow-y-auto space-y-1 scroll-smooth"
          >
            {groupedEvents.map((group, i) => {
              if (group.isMicroGroup) {
                return (
                  <div key={`micro-${group.events[0].id}`} className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {group.events.map(e => (
                      <FeedEvent key={e.id} event={e} t={t} />
                    ))}
                  </div>
                );
              }
              return <FeedEvent key={group.events[0].id} event={group.events[0]} t={t} />;
            })}
            {visibleEvents.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('detail.preparing')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {leaderboard.developers.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <LeaderboardRace data={leaderboard} t={t} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
