'use client';

import { formatGhostPercent } from '@devghost/shared';
import type { GhostMetric } from '@devghost/shared';
import { heatColor } from './ghost-chart-utils';

/* ---------- Component ---------- */

interface GhostHeatmapProps {
  metrics: GhostMetric[];
  onDeveloperClick?: (email: string) => void;
}

export function GhostHeatmap({ metrics, onDeveloperClick }: GhostHeatmapProps) {
  // Sort: highest ghostPercent first, null (insufficient data) at bottom
  const sorted = [...metrics].sort((a, b) => {
    if (a.ghostPercent == null && b.ghostPercent == null) return 0;
    if (a.ghostPercent == null) return 1;
    if (b.ghostPercent == null) return -1;
    return b.ghostPercent - a.ghostPercent;
  });

  // Find separator indices
  // aboveNormEnd: last index where ghostPercent >= 100
  // nullStart: first index where ghostPercent is null
  let aboveNormEnd = -1;
  let nullStart = -1;

  for (let i = 0; i < sorted.length; i++) {
    const gp = sorted[i].ghostPercent;
    if (gp != null && gp >= 100) aboveNormEnd = i;
    if (gp == null && nullStart === -1) nullStart = i;
  }

  // Show separator between >=100 and <100 zones (only when both exist)
  const showNormSep = aboveNormEnd >= 0 && aboveNormEnd < sorted.length - 1
    && sorted[aboveNormEnd + 1]?.ghostPercent != null;
  // Show separator before null section (only when nulls exist and there are non-null rows)
  const showNullSep = nullStart > 0;

  return (
    <div className="max-h-[400px] overflow-y-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-background border-b">
          <tr className="h-8">
            <th className="text-left px-3 font-medium text-muted-foreground">Developer</th>
            <th className="text-right px-3 font-medium text-muted-foreground">Ghost %</th>
            <th className="text-right px-3 font-medium text-muted-foreground">Work Days</th>
            <th className="text-right px-3 font-medium text-muted-foreground">Effort (h)</th>
            <th className="text-right px-3 font-medium text-muted-foreground">Commits</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m, idx) => {
            const isNull = m.ghostPercent == null;

            // Separator before this row: norm boundary
            const needNormSep = showNormSep && idx === aboveNormEnd + 1;
            // Separator before this row: null section
            const needNullSep = showNullSep && idx === nullStart;

            return (
              <tr
                key={m.developerEmail}
                className={[
                  'cursor-pointer hover:bg-muted/50 transition-colors',
                  isNull ? 'bg-gray-100' : '',
                  needNormSep ? 'border-t-2 border-t-yellow-400' : '',
                  needNullSep ? 'border-t-2 border-t-gray-300' : '',
                ].join(' ')}
                style={{ height: 28 }}
                onClick={() => onDeveloperClick?.(m.developerEmail)}
              >
                <td className="px-3 truncate max-w-[200px]">
                  <span className={`font-medium ${isNull ? 'italic text-gray-400' : ''}`}>
                    {m.developerName}
                  </span>
                </td>
                <td
                  className="text-right px-3 font-mono tabular-nums"
                  style={!isNull ? { backgroundColor: heatColor(m.ghostPercent!) } : undefined}
                >
                  {isNull ? (
                    <span className="italic text-gray-400">N/A</span>
                  ) : (
                    formatGhostPercent(m.ghostPercent)
                  )}
                </td>
                <td className={`text-right px-3 tabular-nums ${isNull ? 'text-gray-400 italic' : ''}`}>
                  {m.actualWorkDays}
                </td>
                <td className={`text-right px-3 tabular-nums ${isNull ? 'text-gray-400 italic' : ''}`}>
                  {m.totalEffortHours.toFixed(1)}
                </td>
                <td className={`text-right px-3 tabular-nums ${isNull ? 'text-gray-400 italic' : ''}`}>
                  {m.commitCount}
                </td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={5} className="text-center py-6 text-muted-foreground">
                No developer metrics available
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
