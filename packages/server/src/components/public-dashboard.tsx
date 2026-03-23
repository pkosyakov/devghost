'use client';

import { useState } from 'react';
import type { GhostMetric } from '@devghost/shared';
import { GhostKpiCards } from '@/components/ghost-kpi-cards';
import { GhostDistributionPanel } from '@/components/ghost-distribution-panel';
import { GhostDeveloperTable } from '@/components/ghost-developer-table';

interface PublicDashboardProps {
  metrics: GhostMetric[];
}

export function PublicDashboard({ metrics }: PublicDashboardProps) {
  const [highlightedEmail, setHighlightedEmail] = useState<string | undefined>();

  // Compute KPI values from metrics
  const developerCount = metrics.length;
  const commitCount = metrics.reduce((sum, m) => sum + m.commitCount, 0);
  const totalWorkDays = metrics.reduce((sum, m) => sum + m.actualWorkDays, 0);

  const metricsWithData = metrics.filter((m) => m.hasEnoughData && m.ghostPercent !== null);
  const avgGhostPercent =
    metricsWithData.length > 0
      ? metricsWithData.reduce((sum, m) => sum + (m.ghostPercent ?? 0), 0) /
        metricsWithData.length
      : null;

  return (
    <div className="space-y-6">
      <GhostKpiCards
        avgGhostPercent={avgGhostPercent}
        developerCount={developerCount}
        commitCount={commitCount}
        totalWorkDays={totalWorkDays}
      />

      <GhostDistributionPanel
        metrics={metrics}
        onDeveloperClick={(email) => setHighlightedEmail(email)}
      />

      <GhostDeveloperTable
        metrics={metrics}
        orderId=""
        highlightedEmail={highlightedEmail}
        readOnly
      />
    </div>
  );
}
