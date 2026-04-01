'use client';

import { useTranslations } from 'next-intl';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type AdminRerunOptions = {
  cacheMode: 'any' | 'model' | 'off';
  forceRecalculate: boolean;
};

interface AdminRerunControlsProps {
  options: AdminRerunOptions;
  onChange: (options: AdminRerunOptions) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function AdminRerunControls({
  options,
  onChange,
  disabled,
  compact = false,
}: AdminRerunControlsProps) {
  const t = useTranslations('orders.detail');

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className={compact ? 'text-xs text-muted-foreground space-y-2' : 'rounded-md border border-dashed p-3 text-xs text-muted-foreground space-y-3'}>
        <div className="space-y-1">
          <p className="font-medium text-foreground/80">{t('adminRerunOptionsTitle')}</p>
          <p>{t('adminRerunOptionsHint')}</p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span>{t('cacheModeLabel')}</span>
            <Select
              value={options.cacheMode}
              onValueChange={(value: 'any' | 'model' | 'off') => onChange({ ...options, cacheMode: value })}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="model">{t('cacheModeModel')}</SelectItem>
                <SelectItem value="any">{t('cacheModeAny')}</SelectItem>
                <SelectItem value="off">{t('cacheModeOff')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={options.forceRecalculate}
              onCheckedChange={(checked) => onChange({ ...options, forceRecalculate: checked === true })}
              disabled={disabled}
              className="h-4 w-4"
            />
            <span>{t('forceRecalculateLabel')}</span>
          </label>
        </div>

        <p>{t('forceRecalculateHint')}</p>
      </div>
    </div>
  );
}
