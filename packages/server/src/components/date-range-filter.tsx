'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export interface DateRange {
  /** Index into allDates for visual position (updates during drag) */
  startIdx: number;
  endIdx: number;
}

interface DateRangeFilterProps {
  /** Sorted unique YYYY-MM-DD date strings from effort data */
  allDates: string[];
  /** Current visual slider position */
  sliderPos: [number, number] | null;
  /** Committed range (for labels showing "X of Y") */
  committedRange: [number, number] | null;
  onSliderChange: (range: [number, number]) => void;
  onSliderCommit: (range: [number, number]) => void;
}

/** Find the closest index in a sorted date array for a given date string. */
function findClosestIdx(allDates: string[], date: string): number {
  if (allDates.length === 0) return 0;
  // Binary search for first date >= target
  let lo = 0;
  let hi = allDates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (allDates[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  // lo is now the first index >= date, check if lo-1 is closer
  if (lo > 0 && date < allDates[lo]) {
    const diffPrev = dateDiffDays(allDates[lo - 1], date);
    const diffCurr = dateDiffDays(date, allDates[lo]);
    if (diffPrev <= diffCurr) return lo - 1;
  }
  return lo;
}

function dateDiffDays(a: string, b: string): number {
  return Math.abs(
    (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000
  );
}

function formatDate(dateStr: string, locale: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function subtractDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function DateRangeFilter({
  allDates,
  sliderPos,
  committedRange,
  onSliderChange,
  onSliderCommit,
}: DateRangeFilterProps) {
  const t = useTranslations('orders.detail');
  const locale = useLocale();

  const maxIdx = Math.max(0, allDates.length - 1);
  const visStartIdx = sliderPos ? Math.min(sliderPos[0], maxIdx) : 0;
  const visEndIdx = sliderPos ? Math.min(sliderPos[1], maxIdx) : maxIdx;
  const visIsFullRange = visStartIdx === 0 && visEndIdx === maxIdx;
  const daysInRange = visEndIdx - visStartIdx + 1;

  // Set range by date strings (for inputs & presets)
  const setDateRange = useCallback((fromDate: string, toDate: string) => {
    const s = findClosestIdx(allDates, fromDate);
    const e = findClosestIdx(allDates, toDate);
    const sorted: [number, number] = [Math.min(s, e), Math.max(s, e)];
    onSliderChange(sorted);
    onSliderCommit(sorted);
  }, [allDates, onSliderChange, onSliderCommit]);

  const resetToFull = useCallback(() => {
    onSliderChange([0, maxIdx]);
    onSliderCommit([0, maxIdx]);
  }, [maxIdx, onSliderChange, onSliderCommit]);

  // Presets computed from today
  const presets = useMemo(() => {
    if (allDates.length === 0) return [];
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const year = today.getUTCFullYear();
    const lastDate = allDates[allDates.length - 1];
    const effectiveTo = lastDate < todayStr ? lastDate : todayStr;

    return [
      { key: 'presetLast30', from: subtractDays(today, 30), to: effectiveTo },
      { key: 'presetLast90', from: subtractDays(today, 90), to: effectiveTo },
      { key: 'presetThisYear', from: `${year}-01-01`, to: effectiveTo },
      { key: 'presetLastYear', from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
    ] as { key: string; from: string; to: string }[];
  }, [allDates]);

  if (allDates.length < 2) return null;

  return (
    <div className="space-y-2">
      {/* Preset buttons + date inputs row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Presets */}
        <div className="flex items-center gap-1">
          {presets.map(p => (
            <Button
              key={p.key}
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => setDateRange(p.from, p.to)}
            >
              {t(p.key)}
            </Button>
          ))}
          <Button
            variant={visIsFullRange ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs px-2"
            onClick={resetToFull}
          >
            {t('presetAll')}
          </Button>
        </div>

        <div className="flex-1" />

        {/* Date inputs */}
        <div className="flex items-center gap-1.5 text-xs">
          <label className="text-muted-foreground">{t('dateFrom')}</label>
          <Input
            type="date"
            className="h-7 w-[130px] text-xs"
            min={allDates[0]}
            max={allDates[maxIdx]}
            value={allDates[visStartIdx]}
            onChange={(e) => {
              if (e.target.value) setDateRange(e.target.value, allDates[visEndIdx]);
            }}
          />
          <label className="text-muted-foreground">{t('dateTo')}</label>
          <Input
            type="date"
            className="h-7 w-[130px] text-xs"
            min={allDates[0]}
            max={allDates[maxIdx]}
            value={allDates[visEndIdx]}
            onChange={(e) => {
              if (e.target.value) setDateRange(allDates[visStartIdx], e.target.value);
            }}
          />
        </div>
      </div>

      {/* Slider */}
      <div className="space-y-1">
        <Slider
          aria-label={t('sliderAriaLabel')}
          min={0}
          max={maxIdx}
          step={1}
          value={[visStartIdx, visEndIdx]}
          onValueChange={([s, e]) => onSliderChange([s, e])}
          onValueCommit={([s, e]) => onSliderCommit([s, e])}
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{formatDate(allDates[visStartIdx], locale)}</span>
          <span>
            {visIsFullRange
              ? t('sliderFullRange', { count: allDates.length })
              : t('sliderSubRange', { selected: daysInRange, total: allDates.length })}
          </span>
          <span>{formatDate(allDates[visEndIdx], locale)}</span>
        </div>
      </div>
    </div>
  );
}
