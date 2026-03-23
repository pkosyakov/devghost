'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from '@/i18n/navigation';
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ArrowUp, ArrowDown, Minus, AlertTriangle, ChevronRight, BarChart2 } from 'lucide-react';
import { formatGhostPercent, ghostColor } from '@devghost/shared';
import { useTranslations } from 'next-intl';
import type { GhostMetric } from '@devghost/shared';

interface SpreadEntry {
  date: string;
  effort: number;
  commits: string[];
}

interface SourceEntry {
  date: string;
  estimated: number;
  placed: number;
  overhead: number;
  commits: string[];
}

interface DailyEffortData {
  spread: SpreadEntry[];
  sources: SourceEntry[];
}

interface GhostDeveloperTableProps {
  metrics: GhostMetric[];
  orderId: string;
  highlightedEmail?: string;
  onShareChange?: (email: string, share: number, auto: boolean) => void;
  readOnly?: boolean;
}

type SortKey = 'developerName' | 'commitCount' | 'actualWorkDays' | 'totalEffortHours' | 'avgDailyEffort' | 'overheadHours' | 'share' | 'ghostPercent';

const ghostBadgeStyles = {
  green: 'bg-green-100 text-green-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  red: 'bg-red-100 text-red-700',
  gray: 'bg-gray-100 text-gray-500',
};

const GhostIcon = ({ percent }: { percent: number | null }) => {
  if (percent === null) return <Minus className="h-3 w-3" />;
  if (percent >= 100) return <ArrowUp className="h-3 w-3" />;
  return <ArrowDown className="h-3 w-3" />;
};

/** Share input with local state + save on blur/Enter, toggleable auto/manual */
function ShareInput({
  value,
  autoCalculated,
  onChange,
}: {
  value: number;
  autoCalculated: boolean;
  onChange?: (share: number, auto: boolean) => void;
}) {
  const [local, setLocal] = useState(Math.round(value * 100));
  const prevServer = useRef(value);

  // Sync from server when server value changes (e.g. after refetch)
  useEffect(() => {
    if (value !== prevServer.current) {
      prevServer.current = value;
      setLocal(Math.round(value * 100));
    }
  }, [value]);

  const commit = useCallback(() => {
    const clamped = Math.max(1, Math.min(100, local));
    setLocal(clamped);
    if (clamped !== Math.round(value * 100)) {
      onChange?.(clamped / 100, false);
    }
  }, [local, value, onChange]);

  const toggleAuto = useCallback(() => {
    onChange?.(value, !autoCalculated);
  }, [value, autoCalculated, onChange]);

  return (
    <div className="flex items-center justify-end gap-1">
      <Input
        type="number"
        min={1}
        max={100}
        step={5}
        value={local}
        disabled={autoCalculated}
        onChange={(e) => setLocal(Number(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        className="w-16 h-7 text-right text-xs"
      />
      <span className="text-xs text-muted-foreground">%</span>
      <Badge
        variant="outline"
        className="text-[10px] px-1 cursor-pointer hover:bg-muted"
        onClick={toggleAuto}
      >
        {autoCalculated ? 'auto' : 'manual'}
      </Badge>
    </div>
  );
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = WEEKDAY_SHORT[d.getUTCDay()];
  return `${day} ${dateStr.slice(5)}`; // "Mon 02-17"
}

export function GhostDeveloperTable({
  metrics,
  orderId,
  highlightedEmail,
  onShareChange,
  readOnly,
}: GhostDeveloperTableProps) {
  const t = useTranslations('orders.metrics');
  const tTable = useTranslations('components.ghostTable');
  const [sortKey, setSortKey] = useState<SortKey>('ghostPercent');
  const [sortDesc, setSortDesc] = useState(true);
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);
  const [dailyData, setDailyData] = useState<DailyEffortData | null>(null);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef(new Map<string, DailyEffortData>());

  const toggleExpand = useCallback(async (email: string) => {
    if (expandedEmail === email) {
      setExpandedEmail(null);
      return;
    }
    setExpandedEmail(email);

    const cached = cacheRef.current.get(email);
    if (cached) {
      setDailyData(cached);
      return;
    }

    setDailyData(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/daily-effort?email=${encodeURIComponent(email)}`);
      const json = await res.json();
      const data: DailyEffortData = json.data ?? { spread: [], sources: [] };
      cacheRef.current.set(email, data);
      setDailyData(data);
    } catch {
      setDailyData(null);
    } finally {
      setLoading(false);
    }
  }, [expandedEmail, orderId]);

  const sorted = [...metrics].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (sortKey === 'developerName') {
      const sa = String(av ?? '');
      const sb = String(bv ?? '');
      return sortDesc ? sb.localeCompare(sa) : sa.localeCompare(sb);
    }
    const na = Number(av ?? 0);
    const nb = Number(bv ?? 0);
    return sortDesc ? nb - na : na - nb;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc(!sortDesc);
    else { setSortKey(key); setSortDesc(true); }
  };

  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          <TableHead onClick={() => handleSort('developerName')} className="cursor-pointer">{t('developer')}</TableHead>
          <TableHead onClick={() => handleSort('commitCount')} className="cursor-pointer text-right">{t('commits')}</TableHead>
          <TableHead onClick={() => handleSort('actualWorkDays')} className="cursor-pointer text-right">{t('workDays')}</TableHead>
          <TableHead onClick={() => handleSort('totalEffortHours')} className="cursor-pointer text-right">{t('effort')}</TableHead>
          <TableHead onClick={() => handleSort('avgDailyEffort')} className="cursor-pointer text-right">{t('avgDaily')}</TableHead>
          <TableHead onClick={() => handleSort('overheadHours')} className="cursor-pointer text-right">{t('overhead')}</TableHead>
          {!readOnly && <TableHead onClick={() => handleSort('share')} className="cursor-pointer text-right">{t('share')}</TableHead>}
          <TableHead onClick={() => handleSort('ghostPercent')} className="cursor-pointer text-right">{t('ghost')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map(m => {
          const color = m.hasEnoughData ? ghostColor(m.ghostPercent) : 'gray';
          const display = m.hasEnoughData ? m.ghostPercent : null;
          const isExpanded = expandedEmail === m.developerEmail;

          return (
            <React.Fragment key={m.developerEmail}>
              <TableRow
                className={`${readOnly ? '' : 'cursor-pointer'} hover:bg-muted/50 ${highlightedEmail === m.developerEmail ? 'ring-2 ring-yellow-300' : ''} ${isExpanded ? 'bg-muted/30' : ''}`}
                onClick={readOnly ? undefined : () => toggleExpand(m.developerEmail)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    {!readOnly && <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />}
                    <div>
                      <span className="font-medium">{m.developerName}</span>
                      <span className="text-xs text-muted-foreground ml-2">{m.developerEmail}</span>
                    </div>
                    {!readOnly && (
                      <Link
                        href={`/orders/${orderId}/developers/${encodeURIComponent(m.developerEmail)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-foreground transition-colors ml-1"
                        title="Detailed timeline"
                      >
                        <BarChart2 className="h-4 w-4" />
                      </Link>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">{m.commitCount}</TableCell>
                <TableCell className="text-right">{m.actualWorkDays}</TableCell>
                <TableCell className="text-right">{m.totalEffortHours.toFixed(1)}</TableCell>
                <TableCell className="text-right">{m.avgDailyEffort.toFixed(2)}</TableCell>
                <TableCell className="text-right">
                  {(m.overheadHours ?? 0) > 0 ? (
                    <span className={`inline-flex items-center gap-1 ${
                      (m.overheadHours ?? 0) > m.totalEffortHours * 0.2
                        ? 'text-amber-600 font-medium'
                        : 'text-muted-foreground'
                    }`}>
                      {(m.overheadHours ?? 0) > m.totalEffortHours * 0.2 && (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {(m.overheadHours ?? 0).toFixed(1)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                {!readOnly && (
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <ShareInput
                      value={m.share}
                      autoCalculated={m.shareAutoCalculated}
                      onChange={(share, auto) => onShareChange?.(m.developerEmail, share, auto)}
                    />
                  </TableCell>
                )}
                <TableCell className="text-right">
                  <Badge className={ghostBadgeStyles[color]}>
                    <GhostIcon percent={display} />
                    <span className="ml-1">{formatGhostPercent(display)}</span>
                  </Badge>
                </TableCell>
              </TableRow>
              {isExpanded && (
                <TableRow className="bg-muted/20 hover:bg-muted/20">
                  <TableCell colSpan={readOnly ? 7 : 8} className="px-6 py-3">
                    {loading ? (
                      <span className="text-sm text-muted-foreground">{tTable('loading')}</span>
                    ) : !dailyData || dailyData.spread.length === 0 ? (
                      <span className="text-sm text-muted-foreground">{tTable('noDailyEffort')}</span>
                    ) : (() => {
                      const { spread, sources } = dailyData;

                      // Build unified timeline: union of spread dates and source dates
                      const spreadMap = new Map(spread.map(d => [d.date, d]));
                      const sourceMap = new Map(sources.map(s => [s.date, s]));
                      const allDates = Array.from(new Set([
                        ...spread.map(d => d.date),
                        ...sources.map(s => s.date),
                      ])).sort();

                      const timeline = allDates.map(date => {
                        const sp = spreadMap.get(date);
                        const src = sourceMap.get(date);
                        return {
                          date,
                          placed: sp?.effort ?? 0,
                          spreadCommits: sp?.commits ?? [],
                          overhead: src?.overhead ?? 0,
                          estimated: src?.estimated ?? 0,
                          sourceCommits: src?.commits ?? [],
                          hasSpread: !!sp,
                          hasOverhead: (src?.overhead ?? 0) > 0,
                        };
                      });

                      const placedTotal = timeline.reduce((s, d) => s + d.placed, 0);
                      const totalOverhead = timeline.reduce((s, d) => s + d.overhead, 0);
                      const MAX_H = 5;

                      return (
                      <div className="space-y-2.5">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {tTable('effortTimeline')}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {timeline.map(d => {
                            const dayOfWeek = new Date(d.date + 'T00:00:00Z').getUTCDay();
                            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                            const total = d.placed + d.overhead;
                            const barMax = Math.max(total, MAX_H);
                            const placedPct = (d.placed / barMax) * 100;
                            const overheadPct = (d.overhead / barMax) * 100;

                            // Border color: red if overhead, amber if weekend, blue default
                            const borderColor = d.hasOverhead
                              ? 'border-red-300'
                              : isWeekend ? 'border-amber-200' : 'border-blue-200';

                            const title = [
                              d.hasSpread && `Placed: ${d.placed.toFixed(1)}h (${d.spreadCommits.length} commit${d.spreadCommits.length !== 1 ? 's' : ''})`,
                              d.hasOverhead && `Overhead: +${d.overhead.toFixed(1)}h (${d.estimated.toFixed(1)}h estimated, ${(d.estimated - d.overhead).toFixed(1)}h placed)`,
                              d.sourceCommits.length > 0 && `Commits: ${d.sourceCommits.map(h => h.slice(0, 7)).join(', ')}`,
                            ].filter(Boolean).join('\n');

                            return (
                              <div
                                key={d.date}
                                className={`relative rounded text-xs border bg-white overflow-hidden ${borderColor}`}
                                title={title}
                                style={{ minWidth: 'fit-content' }}
                              >
                                {/* Stacked bar background */}
                                <div className="absolute inset-0 flex">
                                  {d.placed > 0 && (
                                    <div
                                      className={`h-full ${isWeekend ? 'bg-amber-400' : 'bg-blue-400'} opacity-20`}
                                      style={{ width: `${placedPct}%` }}
                                    />
                                  )}
                                  {d.overhead > 0 && (
                                    <div
                                      className="h-full bg-red-400 opacity-25"
                                      style={{ width: `${overheadPct}%` }}
                                    />
                                  )}
                                </div>
                                {/* Content */}
                                <div className="relative px-2 py-1 font-mono whitespace-nowrap">
                                  {formatDate(d.date)}{' '}
                                  {d.placed > 0 && (
                                    <span className={`font-semibold ${isWeekend ? 'text-amber-700' : 'text-blue-700'}`}>
                                      {d.placed.toFixed(1)}h
                                    </span>
                                  )}
                                  {d.hasOverhead && (
                                    <span className="font-semibold text-red-600 ml-0.5">
                                      {d.placed > 0 ? ' ' : ''}+{d.overhead.toFixed(1)}h
                                    </span>
                                  )}
                                  {d.spreadCommits.length > 1 && (
                                    <span className="text-muted-foreground ml-1">({d.spreadCommits.length}c)</span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Summary line */}
                        <p className="text-xs text-muted-foreground">
                          {tTable('placedSummary', { hours: placedTotal.toFixed(1), days: spread.length })}
                          {totalOverhead > 0 && <span className="text-red-500 ml-2">+ {totalOverhead.toFixed(1)}{tTable('overheadSuffix')}</span>}
                          {' '}= {m.totalEffortHours.toFixed(1)}{tTable('totalSuffix')}
                        </p>
                      </div>
                      );
                    })()}
                  </TableCell>
                </TableRow>
              )}
            </React.Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
