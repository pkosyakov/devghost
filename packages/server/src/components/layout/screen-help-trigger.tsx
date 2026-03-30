'use client';

import { CircleHelp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type ScreenHelpTriggerProps = {
  screenTitle: string;
  what: string;
  how: string;
  className?: string;
};

export function ScreenHelpTrigger({
  screenTitle,
  what,
  how,
  className,
}: ScreenHelpTriggerProps) {
  const t = useTranslations('common.screenHelp');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('h-8 w-8 shrink-0 text-muted-foreground', className)}
          aria-label={t('buttonLabel', { screen: screenTitle })}
        >
          <CircleHelp className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{screenTitle}</h3>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('purposeTitle')}
          </p>
          <p className="text-sm text-foreground">{what}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('howToUseTitle')}
          </p>
          <p className="text-sm text-foreground">{how}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
