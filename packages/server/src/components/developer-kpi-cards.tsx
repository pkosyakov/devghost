'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Ghost, Clock, Calendar, TrendingUp, AlertTriangle, GitCommit } from 'lucide-react';
import { formatGhostPercent, ghostColor } from '@devghost/shared';
import type { GhostMetric } from '@devghost/shared';

interface DeveloperKpiCardsProps {
  metric: GhostMetric | null;
  isLoading?: boolean;
}

const ghostColorClasses = {
  green: 'text-green-600 bg-green-50',
  yellow: 'text-yellow-600 bg-yellow-50',
  red: 'text-red-600 bg-red-50',
  gray: 'text-gray-500 bg-gray-50',
};

export function DeveloperKpiCards({ metric, isLoading }: DeveloperKpiCardsProps) {
  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6">
              <div className="h-12 animate-pulse bg-muted rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!metric) return null;

  const color = metric.hasEnoughData ? ghostColor(metric.ghostPercent) : 'gray';
  const ghostDisplay = metric.hasEnoughData ? metric.ghostPercent : null;

  const cards = [
    {
      label: 'Ghost %',
      value: formatGhostPercent(ghostDisplay),
      icon: Ghost,
      colorClass: ghostColorClasses[color],
      valueClass: ghostColorClasses[color]?.split(' ')[0] ?? '',
    },
    {
      label: 'Total Effort',
      value: `${metric.totalEffortHours.toFixed(1)}h`,
      icon: Clock,
      colorClass: 'text-blue-600 bg-blue-50',
    },
    {
      label: 'Work Days',
      value: metric.actualWorkDays.toString(),
      icon: Calendar,
      colorClass: 'text-amber-600 bg-amber-50',
    },
    {
      label: 'Avg Daily',
      value: `${metric.avgDailyEffort.toFixed(2)}h`,
      icon: TrendingUp,
      colorClass: 'text-indigo-600 bg-indigo-50',
    },
    {
      label: 'Overhead',
      value: `${(metric.overheadHours ?? 0).toFixed(1)}h`,
      icon: AlertTriangle,
      colorClass: (metric.overheadHours ?? 0) > 0
        ? 'text-red-600 bg-red-50'
        : 'text-gray-500 bg-gray-50',
      tooltip: 'Estimated effort exceeds what could be placed into working days. May indicate AI-assisted code generation.',
    },
    {
      label: 'Commits',
      value: metric.commitCount.toLocaleString(),
      icon: GitCommit,
      colorClass: 'text-purple-600 bg-purple-50',
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.label} title={card.tooltip}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{card.label}</p>
                  <p className={`text-2xl font-bold ${card.valueClass ?? ''}`}>
                    {card.value}
                  </p>
                </div>
                <div className={`p-3 rounded-full ${card.colorClass}`}>
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
