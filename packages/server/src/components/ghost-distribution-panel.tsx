'use client';

import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GhostBubbleChart } from './ghost-bubble-chart';
import { GhostStripChart } from './ghost-strip-chart';
import { GhostHeatmap } from './ghost-heatmap';
import type { GhostMetric } from '@devghost/shared';

interface GhostDistributionPanelProps {
  metrics: GhostMetric[];
  onDeveloperClick?: (email: string) => void;
}

export function GhostDistributionPanel({ metrics, onDeveloperClick }: GhostDistributionPanelProps) {
  const t = useTranslations('orders.detail');
  return (
    <Tabs defaultValue="bubble">
      <TabsList>
        <TabsTrigger value="bubble">{t('bubbleChart')}</TabsTrigger>
        <TabsTrigger value="strip">{t('stripChart')}</TabsTrigger>
        <TabsTrigger value="heatmap">{t('heatmap')}</TabsTrigger>
      </TabsList>
      <TabsContent value="bubble" className="min-h-[400px]">
        <GhostBubbleChart metrics={metrics} onBubbleClick={onDeveloperClick} />
      </TabsContent>
      <TabsContent value="strip" className="min-h-[400px]">
        <GhostStripChart metrics={metrics} onDeveloperClick={onDeveloperClick} />
      </TabsContent>
      <TabsContent value="heatmap" className="min-h-[400px]">
        <GhostHeatmap metrics={metrics} onDeveloperClick={onDeveloperClick} />
      </TabsContent>
    </Tabs>
  );
}
