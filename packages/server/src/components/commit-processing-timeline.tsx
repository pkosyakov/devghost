'use client';

import { useMemo, useState } from 'react';
import type { AnalysisEventEntry } from '@/components/analysis-event-log';
import type { PipelineLogEntry } from '@/components/pipeline-log';

interface TimelineChildRun {
  id: string;
  label: string;
  startedAtMs: number;
  finishedAtMs: number;
  wallTimeMs: number;
  error?: string | null;
}

interface TimelineCommitRow {
  id: string;
  sha: string;
  method: string;
  status: 'ok' | 'error' | 'skip';
  repo?: string | null;
  subject?: string | null;
  startedAtMs: number;
  finishedAtMs: number;
  wallTimeMs: number;
  fdChildren: TimelineChildRun[];
}

interface CommitProcessingTimelineProps {
  events: AnalysisEventEntry[];
  pipelineEntries: PipelineLogEntry[];
  jobStartedAt?: string | null;
  title: string;
  emptyLabel: string;
  spanLabel: string;
  showChildrenLabel: string;
  hideChildrenLabel: string;
  commitLegendLabel: string;
  fdChildLegendLabel: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function commitColorClass(row: TimelineCommitRow): string {
  if (row.status === 'error' || row.method === 'error') return 'bg-red-500/85';
  if (row.method.startsWith('FD')) return 'bg-amber-500/85';
  if (row.status === 'skip') return 'bg-slate-400/80';
  return 'bg-sky-500/85';
}

function parseFdChildren(payload: Record<string, unknown> | null): TimelineChildRun[] {
  if (!payload) return [];
  const raw = payload.fdChildren;
  if (!Array.isArray(raw)) return [];

  const children: TimelineChildRun[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const row = asRecord(raw[index]);
    if (!row) continue;

    const finish = asNumber(row.finishedAtMs) ?? asNumber(row.finished_at_ms);
    const start = asNumber(row.startedAtMs) ?? asNumber(row.started_at_ms);
    const wall = asNumber(row.wallTimeMs) ?? asNumber(row.wall_time_ms) ?? asNumber(row.durationMs) ?? asNumber(row.duration_ms);

    const normalizedFinish = finish ?? (start != null && wall != null ? start + wall : null);
    const normalizedStart = start ?? (normalizedFinish != null && wall != null ? normalizedFinish - wall : null);
    if (normalizedStart == null || normalizedFinish == null) continue;

    children.push({
      id: asString(row.id) ?? `child-${index + 1}`,
      label: asString(row.label) ?? `child-${index + 1}`,
      startedAtMs: normalizedStart,
      finishedAtMs: normalizedFinish,
      wallTimeMs: Math.max(0, wall ?? (normalizedFinish - normalizedStart)),
      error: asString(row.error),
    });
  }

  children.sort((a, b) => a.startedAtMs - b.startedAtMs || a.finishedAtMs - b.finishedAtMs);
  return children;
}

export function CommitProcessingTimeline({
  events,
  pipelineEntries,
  jobStartedAt,
  title,
  emptyLabel,
  spanLabel,
  showChildrenLabel,
  hideChildrenLabel,
  commitLegendLabel,
  fdChildLegendLabel,
}: CommitProcessingTimelineProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => {
    const startedBoundaryMs = jobStartedAt ? new Date(jobStartedAt).getTime() : null;
    const bySha = new Map<string, TimelineCommitRow>();

    for (const event of events) {
      if (event.code !== 'LLM_COMMIT_RESULT' || !event.sha) continue;
      const eventTs = new Date(event.createdAt).getTime();
      if (!Number.isFinite(eventTs)) continue;
      if (startedBoundaryMs != null && eventTs + 1_000 < startedBoundaryMs) continue;

      const payload = asRecord(event.payload);
      const method = asString(payload?.method) ?? 'unknown';
      const status: TimelineCommitRow['status'] =
        method === 'error' || event.level.toLowerCase() === 'error'
          ? 'error'
          : method === 'root_commit_skip'
            ? 'skip'
            : 'ok';

      const finish =
        asNumber(payload?.commitFinishedAtMs)
        ?? asNumber(payload?.commit_finished_at_ms)
        ?? eventTs;
      const startRaw =
        asNumber(payload?.commitStartedAtMs)
        ?? asNumber(payload?.commit_started_at_ms);
      const wallRaw =
        asNumber(payload?.commitWallTimeMs)
        ?? asNumber(payload?.commit_wall_time_ms)
        ?? asNumber(payload?.durationMs)
        ?? asNumber(payload?.duration_ms);
      const start = startRaw ?? (wallRaw != null ? finish - wallRaw : finish);
      const wall = Math.max(0, wallRaw ?? (finish - start));

      const row: TimelineCommitRow = {
        id: event.id,
        sha: event.sha,
        method,
        status,
        repo: event.repo,
        subject: asString(payload?.subject),
        startedAtMs: start,
        finishedAtMs: finish,
        wallTimeMs: wall,
        fdChildren: parseFdChildren(payload),
      };

      const commitKey = `${event.repo ?? 'repo'}:${event.sha}`;
      const previous = bySha.get(commitKey);
      if (!previous || previous.finishedAtMs <= row.finishedAtMs) {
        bySha.set(commitKey, row);
      }
    }

    for (const entry of pipelineEntries) {
      if (!entry.sha) continue;
      const commitKey = `${entry.repo ?? 'repo'}:${entry.sha}`;
      if (bySha.has(commitKey)) continue;
      const finish = entry.finishedAtMs ?? entry.ts;
      const wall = Math.max(0, (entry.wallTimeMs ?? entry.durationMs ?? 0));
      const start = entry.startedAtMs ?? (wall > 0 ? finish - wall : finish);
      const status: TimelineCommitRow['status'] = entry.status;
      bySha.set(commitKey, {
        id: `pipeline-${entry.sha}-${entry.ts}`,
        sha: entry.sha,
        method: entry.method ?? 'unknown',
        status,
        repo: entry.repo ?? null,
        subject: null,
        startedAtMs: start,
        finishedAtMs: finish,
        wallTimeMs: wall,
        fdChildren: [],
      });
    }

    return Array.from(bySha.values())
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.finishedAtMs - b.finishedAtMs)
      .slice(-300);
  }, [events, pipelineEntries, jobStartedAt]);

  const bounds = useMemo(() => {
    if (rows.length === 0) return null;
    let min = rows[0]!.startedAtMs;
    let max = rows[0]!.finishedAtMs;
    for (const row of rows) {
      if (row.startedAtMs < min) min = row.startedAtMs;
      if (row.finishedAtMs > max) max = row.finishedAtMs;
      for (const child of row.fdChildren) {
        if (child.startedAtMs < min) min = child.startedAtMs;
        if (child.finishedAtMs > max) max = child.finishedAtMs;
      }
    }
    return { min, max, span: Math.max(1, max - min) };
  }, [rows]);

  if (!bounds || rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  const laneStyle = (start: number, finish: number) => {
    const left = ((start - bounds.min) / bounds.span) * 100;
    const width = Math.max(0.6, ((finish - start) / bounds.span) * 100);
    return {
      left: `${Math.max(0, Math.min(left, 100))}%`,
      width: `${Math.max(0.6, Math.min(width, 100 - left))}%`,
    };
  };

  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{spanLabel}: {formatDuration(bounds.span)}</span>
      </div>

      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-sky-500/85" />
          {commitLegendLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-amber-500/85" />
          {fdChildLegendLabel}
        </span>
      </div>

      <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
        {rows.map((row) => {
          const rowKey = `${row.sha}-${row.id}`;
          const hasChildren = row.fdChildren.length > 0;
          const isExpanded = Boolean(expanded[rowKey]);

          return (
            <div key={rowKey} className="space-y-1.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-foreground/90 w-20 shrink-0 truncate">{row.sha.slice(0, 8)}</span>
                <span className="text-muted-foreground truncate">{row.method}</span>
                {row.subject && <span className="text-muted-foreground/80 truncate">· {row.subject}</span>}
                <span className="ml-auto text-muted-foreground tabular-nums">{formatDuration(row.wallTimeMs)}</span>
                {hasChildren && (
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }))}
                    className="text-[11px] text-blue-600 hover:text-blue-700"
                  >
                    {isExpanded ? hideChildrenLabel : showChildrenLabel}
                  </button>
                )}
              </div>

              <div className="relative h-3 rounded bg-background/70 border">
                <div
                  className={`absolute top-0 h-full rounded ${commitColorClass(row)}`}
                  style={laneStyle(row.startedAtMs, row.finishedAtMs)}
                />
              </div>

              {isExpanded && hasChildren && (
                <div className="pl-4 space-y-1">
                  {row.fdChildren.map((child) => (
                    <div key={`${rowKey}-${child.id}`} className="space-y-1">
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="truncate">{child.label}</span>
                        <span className="ml-auto tabular-nums">{formatDuration(child.wallTimeMs)}</span>
                      </div>
                      <div className="relative h-2 rounded bg-background/60 border">
                        <div
                          className={`absolute top-0 h-full rounded ${child.error ? 'bg-red-400/80' : 'bg-amber-500/80'}`}
                          style={laneStyle(child.startedAtMs, child.finishedAtMs)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
