'use client';

import { useCallback, useMemo } from 'react';
import {
  startOfYear,
  endOfYear,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  subWeeks,
  subMonths,
} from 'date-fns';

export type AnalysisPeriodMode = 'ALL_TIME' | 'DATE_RANGE' | 'LAST_N_COMMITS';

export interface AnalysisPeriodSettings {
  mode: AnalysisPeriodMode;
  startDate?: Date;
  endDate?: Date;
  commitLimit?: number;
}

export interface PeriodPreset {
  label: string;
  getRange: () => { start: Date; end: Date };
}

interface UseAnalysisPeriodOptions {
  settings: AnalysisPeriodSettings;
  onChange: (settings: AnalysisPeriodSettings) => void;
  availableStartDate?: Date;
  availableEndDate?: Date;
}

export interface AnalysisPeriodHandlers {
  handleModeChange: (mode: AnalysisPeriodMode) => void;
  handleStartDateChange: (date: Date | undefined) => void;
  handleEndDateChange: (date: Date | undefined) => void;
  handleCommitLimitChange: (limit: number) => void;
  handlePresetClick: (preset: PeriodPreset) => void;
  isPresetSelected: (preset: PeriodPreset) => boolean;
  yearPresets: PeriodPreset[];
  recentPresets: PeriodPreset[];
  quarterPresets: (year: number) => PeriodPreset[];
  availableStartYear: number;
  currentYear: number;
}

/**
 * Shared hook for analysis period handling logic.
 * Eliminates duplication between AnalysisPeriodSelector and AnalysisPeriodInline.
 */
export function useAnalysisPeriod({
  settings,
  onChange,
  availableStartDate,
  availableEndDate,
}: UseAnalysisPeriodOptions): AnalysisPeriodHandlers {
  const handleModeChange = useCallback(
    (mode: AnalysisPeriodMode) => {
      if (mode === 'ALL_TIME') {
        onChange({ mode, startDate: undefined, endDate: undefined, commitLimit: undefined });
      } else if (mode === 'LAST_N_COMMITS') {
        onChange({ mode, startDate: undefined, endDate: undefined, commitLimit: settings.commitLimit || 50 });
      } else {
        onChange({
          mode,
          startDate: settings.startDate || availableStartDate,
          endDate: settings.endDate || availableEndDate,
          commitLimit: undefined,
        });
      }
    },
    [onChange, settings.startDate, settings.endDate, settings.commitLimit, availableStartDate, availableEndDate]
  );

  const handleStartDateChange = useCallback(
    (date: Date | undefined) => {
      onChange({ ...settings, startDate: date });
    },
    [onChange, settings]
  );

  const handleEndDateChange = useCallback(
    (date: Date | undefined) => {
      onChange({ ...settings, endDate: date });
    },
    [onChange, settings]
  );

  const handleCommitLimitChange = useCallback(
    (limit: number) => {
      onChange({ ...settings, commitLimit: limit });
    },
    [onChange, settings]
  );

  const handlePresetClick = useCallback(
    (preset: PeriodPreset) => {
      const { start, end } = preset.getRange();
      // Clamp to available range
      const clampedStart =
        availableStartDate && start < availableStartDate ? availableStartDate : start;
      const clampedEnd =
        availableEndDate && end > availableEndDate ? availableEndDate : end;
      onChange({
        mode: 'DATE_RANGE',
        startDate: clampedStart,
        endDate: clampedEnd,
      });
    },
    [onChange, availableStartDate, availableEndDate]
  );

  const isPresetSelected = useCallback(
    (preset: PeriodPreset) => {
      if (settings.mode !== 'DATE_RANGE' || !settings.startDate || !settings.endDate) {
        return false;
      }
      const { start, end } = preset.getRange();
      const clampedStart =
        availableStartDate && start < availableStartDate ? availableStartDate : start;
      const clampedEnd =
        availableEndDate && end > availableEndDate ? availableEndDate : end;
      return (
        settings.startDate.getTime() === clampedStart.getTime() &&
        settings.endDate.getTime() === clampedEnd.getTime()
      );
    },
    [settings.mode, settings.startDate, settings.endDate, availableStartDate, availableEndDate]
  );

  const currentYear = new Date().getFullYear();
  const availableStartYear = availableStartDate?.getFullYear() || 2020;

  const yearPresets = useMemo((): PeriodPreset[] => {
    const presets: PeriodPreset[] = [];
    for (let year = currentYear; year >= availableStartYear && presets.length < 5; year--) {
      const y = year; // Capture for closure
      presets.push({
        label: year.toString(),
        getRange: () => ({
          start: startOfYear(new Date(y, 0, 1)),
          end: endOfYear(new Date(y, 0, 1)),
        }),
      });
    }
    return presets;
  }, [currentYear, availableStartYear]);

  const recentPresets = useMemo((): PeriodPreset[] => {
    const now = new Date();
    return [
      {
        label: 'Last Week',
        getRange: () => {
          const lastWeek = subWeeks(now, 1);
          return { start: startOfWeek(lastWeek, { weekStartsOn: 1 }), end: endOfWeek(lastWeek, { weekStartsOn: 1 }) };
        },
      },
      {
        label: 'This Month',
        getRange: () => ({ start: startOfMonth(now), end: endOfMonth(now) }),
      },
      {
        label: 'Last 3 Months',
        getRange: () => ({ start: startOfMonth(subMonths(now, 2)), end: endOfMonth(now) }),
      },
      {
        label: 'Last 6 Months',
        getRange: () => ({ start: startOfMonth(subMonths(now, 5)), end: endOfMonth(now) }),
      },
    ];
  }, []);

  const quarterPresets = useCallback((year: number): PeriodPreset[] => {
    return [
      {
        label: 'Q1',
        getRange: () => ({ start: new Date(year, 0, 1), end: new Date(year, 2, 31) }),
      },
      {
        label: 'Q2',
        getRange: () => ({ start: new Date(year, 3, 1), end: new Date(year, 5, 30) }),
      },
      {
        label: 'Q3',
        getRange: () => ({ start: new Date(year, 6, 1), end: new Date(year, 8, 30) }),
      },
      {
        label: 'Q4',
        getRange: () => ({ start: new Date(year, 9, 1), end: new Date(year, 11, 31) }),
      },
    ];
  }, []);

  return {
    handleModeChange,
    handleStartDateChange,
    handleEndDateChange,
    handleCommitLimitChange,
    handlePresetClick,
    isPresetSelected,
    yearPresets,
    recentPresets,
    quarterPresets,
    availableStartYear,
    currentYear,
  };
}
