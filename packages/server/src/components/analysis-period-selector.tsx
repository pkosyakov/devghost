'use client';

import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/ui/date-picker';
import { Calendar, Clock, Hash, Loader2, AlertCircle, Users, GitCommit } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  useAnalysisPeriod,
  type AnalysisPeriodMode,
  type AnalysisPeriodSettings,
} from '@/hooks/use-analysis-period';

export type { AnalysisPeriodMode, AnalysisPeriodSettings };

const DATE_LOCALES: Record<string, Locale> = { ru, en: enUS };

// Statistics for period
export interface PeriodStatistics {
  commitsCount: number;
  developersCount: number;
  isLoading?: boolean;
  isEstimate?: boolean; // True when commit count exceeds API pagination limit
}

interface AnalysisPeriodSelectorProps {
  settings: AnalysisPeriodSettings;
  onChange: (settings: AnalysisPeriodSettings) => void;
  availableStartDate?: Date;
  availableEndDate?: Date;
  isLoadingDateRange?: boolean;
  disabled?: boolean;
  className?: string;
  // Statistics for selected period
  statistics?: PeriodStatistics;
}

export function AnalysisPeriodSelector({
  settings,
  onChange,
  availableStartDate,
  availableEndDate,
  isLoadingDateRange = false,
  disabled = false,
  className,
  statistics,
}: AnalysisPeriodSelectorProps) {
  const t = useTranslations('components.analysisPeriod');
  const currentLocale = useLocale();
  const dateLocale = DATE_LOCALES[currentLocale];
  const {
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
  } = useAnalysisPeriod({
    settings,
    onChange,
    availableStartDate,
    availableEndDate,
  });

  const isValidRange =
    settings.mode === 'ALL_TIME' ||
    settings.mode === 'LAST_N_COMMITS' ||
    (settings.startDate && settings.endDate && settings.startDate <= settings.endDate);

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          {t('title')}
        </CardTitle>
        <CardDescription>
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode Selection */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleModeChange('ALL_TIME')}
            disabled={disabled}
            className={cn(
              'flex-1 px-4 py-3 rounded-lg border-2 transition-all text-left',
              settings.mode === 'ALL_TIME'
                ? 'border-primary bg-primary/5'
                : 'border-muted hover:border-muted-foreground/20',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <span className="font-medium">{t('allTime')}</span>
              <Badge variant="secondary" className="text-xs">
                {t('default')}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t('allTimeDescription')}
            </p>
          </button>

          <button
            type="button"
            onClick={() => handleModeChange('DATE_RANGE')}
            disabled={disabled || isLoadingDateRange}
            className={cn(
              'flex-1 px-4 py-3 rounded-lg border-2 transition-all text-left',
              settings.mode === 'DATE_RANGE'
                ? 'border-primary bg-primary/5'
                : 'border-muted hover:border-muted-foreground/20',
              (disabled || isLoadingDateRange) && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              <span className="font-medium">{t('dateRange')}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t('dateRangeDescription')}
            </p>
          </button>

          <button
            type="button"
            onClick={() => handleModeChange('LAST_N_COMMITS')}
            disabled={disabled}
            className={cn(
              'flex-1 px-4 py-3 rounded-lg border-2 transition-all text-left',
              settings.mode === 'LAST_N_COMMITS'
                ? 'border-primary bg-primary/5'
                : 'border-muted hover:border-muted-foreground/20',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="flex items-center gap-2">
              <Hash className="h-4 w-4" />
              <span className="font-medium">{t('lastNCommits')}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t('lastNDescription')}
            </p>
          </button>
        </div>

        {/* Available Date Range Info */}
        {isLoadingDateRange && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 bg-muted/50 rounded-lg">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('loadingDateRange')}
          </div>
        )}

        {!isLoadingDateRange && availableStartDate && availableEndDate && (
          <div className="text-sm text-muted-foreground p-3 bg-muted/50 rounded-lg">
            <span className="font-medium">{t('availableRange')}:</span>{' '}
            {format(availableStartDate, 'MMM d, yyyy', { locale: dateLocale })} -{' '}
            {format(availableEndDate, 'MMM d, yyyy', { locale: dateLocale })}
          </div>
        )}

        {/* Quick Period Presets */}
        {settings.mode === 'DATE_RANGE' && !isLoadingDateRange && (
          <div className="space-y-3">
            {/* Year Presets */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('year')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {yearPresets.map((preset) => (
                  <Button
                    key={preset.label}
                    variant={isPresetSelected(preset) ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => handlePresetClick(preset)}
                    disabled={disabled}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Quarter Presets by Year */}
            {(() => {
              const quarterYears = [];
              for (let year = currentYear; year >= availableStartYear && quarterYears.length < 3; year--) {
                quarterYears.push(year);
              }
              return quarterYears.map((year) => {
                const yearQuarterPresets = quarterPresets(year);
                return (
                  <div key={year} className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">{t('quarter')} {year}</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {yearQuarterPresets.map((preset) => (
                        <Button
                          key={`${year}-${preset.label}`}
                          variant={isPresetSelected(preset) ? 'default' : 'outline'}
                          size="sm"
                          className="h-7 px-2.5 text-xs"
                          onClick={() => handlePresetClick(preset)}
                          disabled={disabled}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              });
            })()}

            {/* Recent Period Presets */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('recent')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {recentPresets.map((preset) => (
                  <Button
                    key={preset.label}
                    variant={isPresetSelected(preset) ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => handlePresetClick(preset)}
                    disabled={disabled}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Commit Limit Input */}
        {settings.mode === 'LAST_N_COMMITS' && (
          <div className="space-y-3">
            <Label>{t('numberOfCommits')}</Label>
            <Input
              type="number"
              min={1}
              max={10000}
              value={settings.commitLimit ?? 50}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val > 0) handleCommitLimitChange(val);
              }}
              disabled={disabled}
              className="max-w-[200px]"
            />
            <div className="flex flex-wrap gap-1.5">
              {[50, 100, 200, 500].map((n) => (
                <Button
                  key={n}
                  variant={settings.commitLimit === n ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => handleCommitLimitChange(n)}
                  disabled={disabled}
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Date Range Picker */}
        {settings.mode === 'DATE_RANGE' && (
          <div className="space-y-3">
            <Label>{t('selectDateRange')}</Label>
            <DateRangePicker
              startDate={settings.startDate}
              endDate={settings.endDate}
              onStartDateChange={handleStartDateChange}
              onEndDateChange={handleEndDateChange}
              minDate={availableStartDate}
              maxDate={availableEndDate || new Date()}
              disabled={disabled}
            />

            {/* Validation Message */}
            {!isValidRange && settings.startDate && settings.endDate && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {t('invalidRange')}
              </div>
            )}
          </div>
        )}

        {/* Period Statistics */}
        {statistics && (
          <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg">
            {statistics.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('loadingStats')}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <GitCommit className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    <span className="font-semibold">
                      {statistics.isEstimate ? `${statistics.commitsCount.toLocaleString()}+` : statistics.commitsCount.toLocaleString()}
                    </span>
                    <span className="text-muted-foreground ml-1">{t('commitsLabel')}</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    <span className="font-semibold">{statistics.developersCount.toLocaleString()}</span>
                    <span className="text-muted-foreground ml-1">{t('developersLabel')}</span>
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Compact inline version for use in dialogs
interface AnalysisPeriodInlineProps {
  settings: AnalysisPeriodSettings;
  onChange: (settings: AnalysisPeriodSettings) => void;
  availableStartDate?: Date;
  availableEndDate?: Date;
  isLoadingDateRange?: boolean;
  disabled?: boolean;
  className?: string;
}

export function AnalysisPeriodInline({
  settings,
  onChange,
  availableStartDate,
  availableEndDate,
  isLoadingDateRange = false,
  disabled = false,
  className,
}: AnalysisPeriodInlineProps) {
  const t = useTranslations('components.analysisPeriod');
  const currentLocale = useLocale();
  const dateLocale = DATE_LOCALES[currentLocale];
  const {
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
  } = useAnalysisPeriod({
    settings,
    onChange,
    availableStartDate,
    availableEndDate,
  });

  // Generate quarter years for display
  const quarterYears: number[] = [];
  for (let year = currentYear; year >= availableStartYear && quarterYears.length < 3; year--) {
    quarterYears.push(year);
  }

  return (
    <div className={cn('space-y-3', className)}>
      <Label className="flex items-center gap-2">
        <Calendar className="h-4 w-4" />
        {t('title')}
      </Label>

      {/* Mode Toggle */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => handleModeChange('ALL_TIME')}
          disabled={disabled}
          className={cn(
            'flex-1 px-3 py-2 rounded-md border text-sm transition-all',
            settings.mode === 'ALL_TIME'
              ? 'border-primary bg-primary/10 font-medium'
              : 'border-muted hover:bg-muted',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        >
          {t('allTime')}
        </button>
        <button
          type="button"
          onClick={() => handleModeChange('DATE_RANGE')}
          disabled={disabled || isLoadingDateRange}
          className={cn(
            'flex-1 px-3 py-2 rounded-md border text-sm transition-all',
            settings.mode === 'DATE_RANGE'
              ? 'border-primary bg-primary/10 font-medium'
              : 'border-muted hover:bg-muted',
            (disabled || isLoadingDateRange) && 'opacity-50 cursor-not-allowed'
          )}
        >
          {isLoadingDateRange ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('loading')}
            </span>
          ) : (
            t('dateRange')
          )}
        </button>
        <button
          type="button"
          onClick={() => handleModeChange('LAST_N_COMMITS')}
          disabled={disabled}
          className={cn(
            'flex-1 px-3 py-2 rounded-md border text-sm transition-all',
            settings.mode === 'LAST_N_COMMITS'
              ? 'border-primary bg-primary/10 font-medium'
              : 'border-muted hover:bg-muted',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        >
          {t('lastN')}
        </button>
      </div>

      {/* Available Range Info */}
      {!isLoadingDateRange && availableStartDate && availableEndDate && (
        <p className="text-xs text-muted-foreground">
          {t('availableRange')}: {format(availableStartDate, 'MMM yyyy', { locale: dateLocale })} -{' '}
          {format(availableEndDate, 'MMM yyyy', { locale: dateLocale })}
        </p>
      )}

      {/* Quick Period Presets */}
      {settings.mode === 'DATE_RANGE' && !isLoadingDateRange && (
        <div className="space-y-2">
          {/* Year Presets */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('year')}</Label>
            <div className="flex flex-wrap gap-1">
              {yearPresets.map((preset) => (
                <Button
                  key={preset.label}
                  variant={isPresetSelected(preset) ? 'default' : 'outline'}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => handlePresetClick(preset)}
                  disabled={disabled}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Quarter Presets by Year */}
          {quarterYears.map((year) => {
            const yearQuarterPresets = quarterPresets(year);
            return (
              <div key={year} className="space-y-1">
                <Label className="text-xs text-muted-foreground">{t('quarter')} {year}</Label>
                <div className="flex flex-wrap gap-1">
                  {yearQuarterPresets.map((preset) => (
                    <Button
                      key={`${year}-${preset.label}`}
                      variant={isPresetSelected(preset) ? 'default' : 'outline'}
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => handlePresetClick(preset)}
                      disabled={disabled}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Recent Period Presets */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('recent')}</Label>
            <div className="flex flex-wrap gap-1">
              {recentPresets.map((preset) => (
                <Button
                  key={preset.label}
                  variant={isPresetSelected(preset) ? 'default' : 'outline'}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => handlePresetClick(preset)}
                  disabled={disabled}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Commit Limit Input (inline) */}
      {settings.mode === 'LAST_N_COMMITS' && (
        <div className="space-y-2">
          <Input
            type="number"
            min={1}
            max={10000}
            value={settings.commitLimit ?? 50}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val > 0) handleCommitLimitChange(val);
            }}
            disabled={disabled}
            className="max-w-[160px]"
          />
          <div className="flex flex-wrap gap-1">
            {[50, 100, 200, 500].map((n) => (
              <Button
                key={n}
                variant={settings.commitLimit === n ? 'default' : 'outline'}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => handleCommitLimitChange(n)}
                disabled={disabled}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Date Range Picker */}
      {settings.mode === 'DATE_RANGE' && (
        <DateRangePicker
          startDate={settings.startDate}
          endDate={settings.endDate}
          onStartDateChange={handleStartDateChange}
          onEndDateChange={handleEndDateChange}
          minDate={availableStartDate}
          maxDate={availableEndDate || new Date()}
          disabled={disabled}
        />
      )}
    </div>
  );
}

// Read-only display of period settings
interface AnalysisPeriodDisplayProps {
  mode: AnalysisPeriodMode;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  commitLimit?: number | null;
  className?: string;
}

export function AnalysisPeriodDisplay({
  mode,
  startDate,
  endDate,
  commitLimit,
  className,
}: AnalysisPeriodDisplayProps) {
  const t = useTranslations('components.analysisPeriod');
  const currentLocale = useLocale();
  const dateLocale = DATE_LOCALES[currentLocale];
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  return (
    <div className={cn('flex items-center gap-2 text-sm', className)}>
      <Calendar className="h-4 w-4 text-muted-foreground" />
      {mode === 'ALL_TIME' ? (
        <span>{t('allTime')}</span>
      ) : mode === 'LAST_N_COMMITS' ? (
        <span>{t('lastCommits', { count: commitLimit ?? '?' })}</span>
      ) : start && end ? (
        <span>
          {format(start, 'MMM d, yyyy', { locale: dateLocale })} - {format(end, 'MMM d, yyyy', { locale: dateLocale })}
        </span>
      ) : (
        <span className="text-muted-foreground">{t('dateRangeNotSet')}</span>
      )}
    </div>
  );
}
