'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Users, GitCommit, Calendar, Ghost, Info } from 'lucide-react';
import { formatGhostPercent, ghostColor, GHOST_NORM } from '@devghost/shared';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { useTranslations } from 'next-intl';

interface GhostKpiCardsProps {
  avgGhostPercent: number | null;
  developerCount: number;
  commitCount: number;
  totalWorkDays: number;
  ghostNormHours?: number;
}

const colorClasses = {
  green: 'text-green-600 bg-green-50',
  yellow: 'text-yellow-600 bg-yellow-50',
  red: 'text-red-600 bg-red-50',
  gray: 'text-gray-500 bg-gray-50',
};

export function GhostKpiCards({
  avgGhostPercent,
  developerCount,
  commitCount,
  totalWorkDays,
  ghostNormHours = GHOST_NORM,
}: GhostKpiCardsProps) {
  const t = useTranslations('kpi');
  const color = ghostColor(avgGhostPercent);

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t('avgGhost')}</p>
              <div className={`flex items-center text-2xl font-bold ${colorClasses[color]?.split(' ')[0] ?? ''}`}>
                {formatGhostPercent(avgGhostPercent)}
                {developerCount === 1 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="h-4 w-4 text-muted-foreground ml-1" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>{t('singleDevWarning', { norm: ghostNormHours.toFixed(1) })}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
            <div className={`p-3 rounded-full ${colorClasses[color]}`}>
              <Ghost className="h-5 w-5" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t('developers')}</p>
              <p className="text-2xl font-bold">{developerCount}</p>
            </div>
            <div className="p-3 rounded-full bg-blue-50 text-blue-600">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t('commits')}</p>
              <p className="text-2xl font-bold">{commitCount.toLocaleString()}</p>
            </div>
            <div className="p-3 rounded-full bg-purple-50 text-purple-600">
              <GitCommit className="h-5 w-5" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t('workDays')}</p>
              <p className="text-2xl font-bold">{totalWorkDays.toLocaleString()}</p>
            </div>
            <div className="p-3 rounded-full bg-amber-50 text-amber-600">
              <Calendar className="h-5 w-5" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
