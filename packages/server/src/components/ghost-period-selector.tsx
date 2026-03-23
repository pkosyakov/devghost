'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { GHOST_ELIGIBLE_PERIODS } from '@devghost/shared';
import type { GhostEligiblePeriod } from '@devghost/shared';

interface PeriodSelectorProps {
  value: GhostEligiblePeriod;
  onChange: (period: GhostEligiblePeriod) => void;
}

const labels: Record<GhostEligiblePeriod, string> = {
  ALL_TIME: 'All Time',
  YEAR: 'Year',
  QUARTER: 'Quarter',
  MONTH: 'Month',
};

export function GhostPeriodSelector({ value, onChange }: PeriodSelectorProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as GhostEligiblePeriod)}>
      <SelectTrigger className="w-[180px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GHOST_ELIGIBLE_PERIODS.map(period => (
          <SelectItem key={period} value={period}>{labels[period]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
