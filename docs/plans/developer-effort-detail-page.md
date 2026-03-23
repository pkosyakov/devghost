# Developer Effort Detail Page

## Context

Currently the developer table (`ghost-developer-table.tsx`) has an expandable inline row showing a compact effort timeline. The user wants a dedicated page with a **full graphical daily effort timeline** — detailed, interactive, and rich. The inline expand stays as a quick preview; the detail page provides the deep dive.

## Scope

**Focus: effort timeline visualization** + KPI summary + commit table.

## New Files

| # | File | Purpose |
|---|------|---------|
| 1 | `src/app/(dashboard)/orders/[id]/developers/[email]/page.tsx` | Detail page |
| 2 | `src/components/developer-effort-chart.tsx` | Main Recharts ComposedChart |
| 3 | `src/components/developer-kpi-cards.tsx` | 6-card KPI row |

## Modified Files

| # | File | Change |
|---|------|--------|
| 4 | `src/components/ghost-developer-table.tsx` | Add `BarChart2` icon linking to detail page |
| 5 | `src/components/commit-analysis-table.tsx` | Add optional `authorEmail` prop to filter commits |

## No New API Routes

All data available from existing endpoints:
- `GET /api/orders/[id]/metrics?period=ALL_TIME` — ghost %, effort, workdays (filter client-side by email)
- `GET /api/orders/[id]/daily-effort?email=X` — spread[] + sources[]
- `GET /api/orders/[id]/commits?authorEmail=X` — paginated commit list (already supported)

## Design Decisions

- **Email in URL**: `encodeURIComponent(email)` — simple, works with existing APIs
- **Date range**: Show only dates with data + fill gaps up to 3 working days between data points
- **Layout**: Single scrollable page (no tabs) — header, KPIs, chart, source table, commits
- **Chart type**: Recharts `ComposedChart` — stacked bars (placed+overhead) + line (commit count)

## Implementation Steps

### Step 1: `developer-kpi-cards.tsx`

6-column grid following `ghost-kpi-cards.tsx` pattern:

| Ghost % | Total Effort | Work Days | Avg Daily | Overhead | Commits |
|---------|-------------|-----------|-----------|----------|---------|
| ghostColor | Clock | Calendar | TrendingUp | AlertTriangle | GitCommit |

Props: `{ metric: GhostMetric | null; isLoading?: boolean }`
Grid: `grid gap-4 md:grid-cols-3 lg:grid-cols-6`

### Step 2: `developer-effort-chart.tsx`

**Recharts ComposedChart** — the primary visualization.

Props:
```typescript
interface DeveloperEffortChartProps {
  spread: SpreadEntry[];
  sources: SourceEntry[];
  onBarClick?: (date: string) => void;
}
```

Data transformation:
1. Build spreadMap (date -> effort, commits) and sourceMap (date -> estimated, placed, overhead)
2. Union all dates, sort chronologically
3. Fill gaps up to 3 working days with zero-height bars
4. Each point: `{ date, dateLabel, placed, overhead, commitCount, isWeekend }`

Chart config:
- **X-axis**: date labels ("Mon 02-16"), rotated -45deg
- **Y-axis left**: hours
- **Y-axis right**: commit count
- **Stacked Bar** (`stackId="effort"`):
  - `placed` — blue (#3b82f6) for weekdays, amber (#f59e0b) for weekends (via `<Cell>`)
  - `overhead` — red (#ef4444), opacity 0.6
- **Line**: `commitCount` on right axis, purple (#8b5cf6), dots
- **ReferenceLine** at MAX_DAILY_EFFORT=5 (red dashed, "Max Daily 5h")
- **ReferenceLine** at GHOST_NORM=3 (green dashed, "Ghost Norm 3h")
- **Custom Tooltip**: date (full), placed Xh, overhead +Xh, total, commit count, first 3 commit messages truncated
- **Bar onClick**: callback to scroll to commits section

### Step 3: Modify `commit-analysis-table.tsx`

Add optional `authorEmail` prop:
```typescript
interface CommitAnalysisTableProps {
  orderId: string;
  authorEmail?: string;  // NEW
}
```

In `fetchCommits` (line 165-178), add:
```typescript
if (authorEmail) params.set('authorEmail', authorEmail);
```

Add `authorEmail` to the `useCallback` dependency array (line 196).

No breaking changes — existing callers pass no `authorEmail`, behavior unchanged.

### Step 4: Modify `ghost-developer-table.tsx`

Add `BarChart2` icon (from lucide-react) next to developer name in each row.

In the Developer cell (lines 207-215), add link icon:
```tsx
<a
  href={`/orders/${orderId}/developers/${encodeURIComponent(m.developerEmail)}`}
  onClick={(e) => e.stopPropagation()}
  className="text-muted-foreground hover:text-foreground transition-colors"
  title="Detailed timeline"
>
  <BarChart2 className="h-4 w-4" />
</a>
```

`stopPropagation()` prevents row expand toggle.

### Step 5: `page.tsx` — Developer Detail Page

`'use client'` page with async params `{ id, email }`.

**Header**:
```
[< Back to Order]   Developer Name                Ghost 139%
                     developer@email.com
```

**Data loading** (3 parallel TanStack queries):
1. `['metrics', id]` -> filter to target email
2. `['daily-effort', id, email]` -> spread + sources
3. Commits delegated to CommitAnalysisTable component

**Page layout**:
```
<div className="space-y-6 p-6">
  Header (back button, name, email, ghost badge)
  DeveloperKpiCards
  Card > DeveloperEffortChart
  Card > Source-Spread Summary Table (inline HTML table from sources[])
  CommitAnalysisTable (with authorEmail prop)
</div>
```

**Source-Spread table** (inside a Card):
| Date | Day | Estimated | Placed | Overhead | Commits |
Rows from `sources[]`, sorted desc. Overhead column red when > 0.

**Scroll interaction**: clicking a chart bar scrolls to CommitAnalysisTable via `ref.scrollIntoView()`.

## Verification

1. `npx tsc --noEmit` — type-check clean
2. Navigate to order detail -> developer table -> click BarChart2 icon -> detail page loads
3. KPI cards show correct values matching the table row
4. Bar chart renders with correct placed/overhead stacking, weekend colors, reference lines
5. Tooltip shows date, hours, commit info on hover
6. Source-Spread table matches the inline expand data
7. Commit table filtered to the developer only
8. Back button returns to order page
9. Edge case: developer with 0 spread data -> "No data" message

## Status

**Implemented**: 2025-02-20, branch `feat/devghost`
