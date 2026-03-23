'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';
import { GHOST_NORM } from '@devghost/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DeveloperMultiSelect } from './developer-multi-select';
import { aggregateEffort, type EffortRow, type Period, type TimelineDeveloper } from './effort-timeline-utils';

/* ---------- types ---------- */

interface TimelineData {
  rows: EffortRow[];
  developers: TimelineDeveloper[];
}

interface EffortTimelineProps {
  orderId: string;
}

/* ---------- constants ---------- */

const PERIOD_VALUES: Period[] = ['day', 'week', 'month', 'quarter', 'year', 'all_time'];

/* ---------- component ---------- */

export function EffortTimeline({ orderId }: EffortTimelineProps) {
  const t = useTranslations('components.effortTimeline');
  const tp = useTranslations('components.periodSelector');

  const periodLabels: Record<Period, string> = {
    day: tp('day'),
    week: tp('week'),
    month: tp('month'),
    quarter: tp('quarter'),
    year: tp('year'),
    all_time: tp('allTime'),
  };
  const [period, setPeriod] = useState<Period>('week');
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const initialized = useRef(false);

  const { data, isLoading, isError } = useQuery<TimelineData>({
    queryKey: ['effort-timeline', orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/effort-timeline`);
      if (!res.ok) throw new Error('Failed to fetch effort timeline');
      const json = await res.json();
      return json.data; // { rows, developers }
    },
  });

  const rows = data?.rows ?? [];
  const developers = data?.developers ?? [];

  // Select all developers once when data first arrives
  useEffect(() => {
    if (developers.length > 0 && !initialized.current) {
      setSelectedEmails(developers.map(d => d.email));
      initialized.current = true;
    }
  }, [developers]);

  const buckets = useMemo(
    () => aggregateEffort(rows, period, selectedEmails),
    [rows, period, selectedEmails],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[300px] text-muted-foreground">
        {t('loading')}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-[300px] text-destructive">
        {t('error')}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] text-muted-foreground">
        {t('noData')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {PERIOD_VALUES.map(p => (
            <Button
              key={p}
              variant={period === p ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPeriod(p)}
            >
              {periodLabels[p]}
            </Button>
          ))}
        </div>
        <DeveloperMultiSelect
          developers={developers}
          selected={selectedEmails}
          onChange={setSelectedEmails}
        />
      </div>

      {selectedEmails.length === 0 ? (
        <div className="flex items-center justify-center h-[200px] text-muted-foreground">
          {t('selectDeveloper')}
        </div>
      ) : buckets.length === 0 ? (
        <div className="flex items-center justify-center h-[200px] text-muted-foreground">
          {t('noDataSelected')}
        </div>
      ) : (
        <>
          {/* Avg Productivity Chart (stacked: placed + overhead) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('avgProductivity')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={buckets} margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" fontSize={12} angle={buckets.length > 15 ? -45 : 0} textAnchor={buckets.length > 15 ? 'end' : 'middle'} height={buckets.length > 15 ? 60 : 30} />
                  <YAxis domain={[0, 'auto']} />
                  <ReferenceLine y={GHOST_NORM} stroke="#666" strokeDasharray="5 5" label={{ value: t('ghostNorm', { hours: GHOST_NORM }), position: 'right', fontSize: 11 }} />
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload?.length) return null;
                      const d = payload[0]!.payload;
                      return (
                        <div className="bg-white p-3 border rounded shadow text-sm">
                          <p className="font-bold">{d.label}</p>
                          <p><span className="inline-block w-3 h-3 rounded-sm mr-1 align-middle" style={{ backgroundColor: '#6366f1' }} />{t('placed')}: {d.avgPlacedByActive.toFixed(1)}h</p>
                          <p><span className="inline-block w-3 h-3 rounded-sm mr-1 align-middle" style={{ backgroundColor: '#f97316' }} />{t('overhead')}: {d.avgOverheadByActive.toFixed(1)}h</p>
                          <p className="font-semibold">{t('total')}: {d.avgByActive.toFixed(1)}h/day</p>
                          <p className="text-muted-foreground">{t('avgAllSelected')}: {d.avgByAll.toFixed(1)}h</p>
                          <p className="text-muted-foreground">{t('activeDevs', { active: d.activeCount, total: d.selectedCount })}</p>
                        </div>
                      );
                    }}
                  />
                  <Legend />
                  <Bar dataKey="avgPlacedByActive" stackId="avg" fill="#6366f1" name={t('placed')} />
                  <Bar dataKey="avgOverheadByActive" stackId="avg" fill="#f97316" name={t('overhead')} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Total Effort Chart (stacked: placed + overhead) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('totalEffort')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={buckets} margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" fontSize={12} angle={buckets.length > 15 ? -45 : 0} textAnchor={buckets.length > 15 ? 'end' : 'middle'} height={buckets.length > 15 ? 60 : 30} />
                  <YAxis />
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload?.length) return null;
                      const d = payload[0]!.payload;
                      return (
                        <div className="bg-white p-3 border rounded shadow text-sm">
                          <p className="font-bold">{d.label}</p>
                          <p><span className="inline-block w-3 h-3 rounded-sm mr-1 align-middle" style={{ backgroundColor: '#6366f1' }} />{t('placed')}: {d.placedHours.toFixed(1)}h</p>
                          <p><span className="inline-block w-3 h-3 rounded-sm mr-1 align-middle" style={{ backgroundColor: '#f97316' }} />{t('overhead')}: {d.overheadHours.toFixed(1)}h</p>
                          <p className="font-semibold">{t('total')}: {d.totalHours.toFixed(1)}h</p>
                        </div>
                      );
                    }}
                  />
                  <Legend />
                  <Bar dataKey="placedHours" stackId="effort" fill="#6366f1" name={t('placed')} />
                  <Bar dataKey="overheadHours" stackId="effort" fill="#f97316" name={t('overhead')} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
