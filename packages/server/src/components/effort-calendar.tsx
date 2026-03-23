'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Calculator, Loader2, CalendarDays, AlertCircle } from 'lucide-react';

interface EffortCalendarProps {
  orderId: string;
}

interface DayDeveloper {
  email: string;
  effort: number;
}

interface CalendarDayData {
  date: string;
  totalEffort: number;
  hasOverflow: boolean;
  developers: DayDeveloper[];
}

export function EffortCalendar({ orderId }: EffortCalendarProps) {
  const queryClient = useQueryClient();
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['effort-distribution', orderId, 'date'],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/effort-distribution?groupBy=date`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
  });

  const calendarData = useMemo((): CalendarDayData[] => {
    const distribution = data?.data?.distribution;
    if (!distribution) return [];
    return distribution.sort(
      (a: CalendarDayData, b: CalendarDayData) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
  }, [data]);

  const handleRecalculate = async () => {
    setIsRecalculating(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/effort-distribution/recalculate`, {
        method: 'POST',
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || 'Failed to recalculate');
      }

      // Check if any records were created
      const resultData = result.data || result;
      if (resultData.dailyEffortRecords === 0) {
        const totalEffort = resultData.totalEffortHours || 0;
        if (totalEffort === 0) {
          setError(`No effort data to distribute. ${resultData.totalCommits} commits have 0 effort hours total.`);
        } else {
          setError('Distribution calculation returned 0 records.');
        }
        return;
      }

      // Invalidate queries and refetch to get new data
      await queryClient.invalidateQueries({ queryKey: ['effort-distribution', orderId] });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to recalculate');
    } finally {
      setIsRecalculating(false);
    }
  };

  const getColor = (effort: number, hasOverflow: boolean) => {
    if (hasOverflow) return 'bg-amber-400';
    const intensity = Math.min(effort / 4.8, 1);
    if (intensity < 0.25) return 'bg-blue-100';
    if (intensity < 0.5) return 'bg-blue-200';
    if (intensity < 0.75) return 'bg-blue-300';
    return 'bg-blue-400';
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!calendarData.length) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
          <CalendarDays className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <p className="text-muted-foreground mb-2">No effort distribution data available</p>
            <p className="text-sm text-muted-foreground mb-4">
              This order was analyzed before the effort distribution feature was added.
            </p>
          </div>
          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
          <Button onClick={handleRecalculate} disabled={isRecalculating}>
            {isRecalculating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Calculating...
              </>
            ) : (
              <>
                <Calculator className="h-4 w-4 mr-2" />
                Calculate Distribution
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Effort Calendar</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1">
          <TooltipProvider>
            {calendarData.map((day) => (
              <Tooltip key={day.date}>
                <TooltipTrigger>
                  <div
                    className={`w-4 h-4 rounded-sm ${getColor(day.totalEffort, day.hasOverflow)}`}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <div className="text-sm">
                    <div className="font-medium">{day.date}</div>
                    <div>Total: {day.totalEffort.toFixed(1)}h</div>
                    {day.hasOverflow && (
                      <div className="text-amber-600">Over daily limit</div>
                    )}
                    <div className="text-xs text-muted-foreground mt-1">
                      {day.developers.map((d) => (
                        <div key={d.email}>
                          {d.email.split('@')[0]}: {d.effort.toFixed(1)}h
                        </div>
                      ))}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
        </div>
        <div className="flex items-center gap-4 mt-4 text-xs text-muted-foreground">
          <span>Less</span>
          <div className="flex gap-1">
            <div className="w-3 h-3 rounded-sm bg-blue-100" />
            <div className="w-3 h-3 rounded-sm bg-blue-200" />
            <div className="w-3 h-3 rounded-sm bg-blue-300" />
            <div className="w-3 h-3 rounded-sm bg-blue-400" />
          </div>
          <span>More</span>
          <div className="w-3 h-3 rounded-sm bg-amber-400" />
          <span>Overflow</span>
        </div>
      </CardContent>
    </Card>
  );
}
