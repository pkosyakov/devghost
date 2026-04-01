# FTE Metrics Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an FTE display mode that calculates Ghost% as if developers worked full-time across the entire period from first to last commit, with a toggle on the order results page and a recalculation endpoint for legacy orders.

**Architecture:** New `computeFteDays()` function in shared package computes FTE working days from spread dates and commit dates. `ghost-metrics-service.ts` calculates FTE metrics alongside existing spread metrics during analysis (and via a new `recalculateFteForOrder()` method for legacy orders). The order page applies a data-level transform (`applyFteView`) to swap FTE values into standard GhostMetric fields, so all child components work unchanged.

**Tech Stack:** TypeScript, Prisma (schema migration), vitest, Next.js API routes, React (useState toggle)

**Spec:** `docs/superpowers/specs/2026-04-01-fte-metrics-mode-design.md`

---

### Task 1: Add `computeFteDays()` to shared package

**Files:**
- Modify: `packages/shared/src/utils.ts:54` (insert before spreading section)
- Test: `packages/shared/src/__tests__/utils.test.ts`

- [ ] **Step 1: Write failing tests for `computeFteDays()`**

Add to `packages/shared/src/__tests__/utils.test.ts`:

```ts
import { computeFteDays } from '../utils';

describe('computeFteDays', () => {
  it('counts weekdays in range plus weekend days in dayMap', () => {
    // Mon 2026-01-05 to Fri 2026-01-09 = 5 weekdays, no weekend days in map
    const dayMapKeys = ['2026-01-05', '2026-01-06', '2026-01-07'];
    const commitDates = [new Date('2026-01-09T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(5);
  });

  it('includes weekend days that appear in dayMap', () => {
    // Mon 2026-01-05 to Sun 2026-01-11 = 5 weekdays + Sat 2026-01-10 in map = 6
    const dayMapKeys = ['2026-01-05', '2026-01-10']; // Mon + Sat
    const commitDates = [new Date('2026-01-11T12:00:00Z')]; // Sun (not in dayMap)
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(6);
  });

  it('handles spread days before first commit', () => {
    // dayMap starts Thu 2026-01-01, commit on Mon 2026-01-05
    // Thu, Fri, Mon = 3 weekdays (Sat/Sun skipped, not in dayMap)
    const dayMapKeys = ['2026-01-01', '2026-01-02'];
    const commitDates = [new Date('2026-01-05T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(3);
  });

  it('returns 1 for single commit on a weekday', () => {
    const dayMapKeys = ['2026-01-05']; // Mon
    const commitDates = [new Date('2026-01-05T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(1);
  });

  it('returns 1 for single commit on a weekend day in dayMap', () => {
    const dayMapKeys = ['2026-01-10']; // Sat
    const commitDates = [new Date('2026-01-10T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(1);
  });

  it('returns 0 for empty inputs', () => {
    expect(computeFteDays([], [])).toBe(0);
  });

  it('uses periodEnd from commitDates even if after last dayMap key', () => {
    // dayMap: Mon 2026-01-05 only; commit on Wed 2026-01-07
    // Range Mon-Wed = 3 weekdays
    const dayMapKeys = ['2026-01-05'];
    const commitDates = [new Date('2026-01-07T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(3);
  });

  it('handles multi-week period correctly', () => {
    // 2026-01-05 (Mon) to 2026-01-16 (Fri) = 10 weekdays
    // Plus Sat 2026-01-10 in dayMap = 11
    const dayMapKeys = ['2026-01-05', '2026-01-10']; // Mon + Sat
    const commitDates = [new Date('2026-01-16T12:00:00Z')]; // Fri
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(11);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm test -- --run src/__tests__/utils.test.ts`
Expected: FAIL — `computeFteDays` is not exported / not defined

- [ ] **Step 3: Implement `computeFteDays()`**

Add to `packages/shared/src/utils.ts` after `calcAutoShare()` (line 54), before the spreading section:

```ts
/**
 * Compute FTE (Full-Time Employee) working days for a developer.
 *
 * Period: min(dayMapKeys) to max(commitDates).
 * Counts all weekdays in that range + weekend days present in dayMapKeys.
 */
export function computeFteDays(dayMapKeys: string[], commitDates: Date[]): number {
  if (dayMapKeys.length === 0 || commitDates.length === 0) return 0;

  const dayMapSet = new Set(dayMapKeys);

  // periodStart = earliest dayMap key (includes backward spread)
  const sortedKeys = [...dayMapKeys].sort();
  const periodStart = sortedKeys[0];

  // periodEnd = latest commit date as YYYY-MM-DD UTC
  const maxCommitMs = Math.max(...commitDates.map(d => d.getTime()));
  const maxCommitDate = new Date(maxCommitMs);
  const periodEnd = maxCommitDate.toISOString().slice(0, 10);

  // Also consider dayMap keys that might be after last commit (unlikely but safe)
  const effectiveEnd = sortedKeys[sortedKeys.length - 1] > periodEnd
    ? sortedKeys[sortedKeys.length - 1]
    : periodEnd;

  let count = 0;
  const current = new Date(periodStart + 'T00:00:00Z');
  const endDate = new Date(effectiveEnd + 'T00:00:00Z');

  while (current <= endDate) {
    const dow = current.getUTCDay(); // 0=Sun, 6=Sat
    const dateStr = current.toISOString().slice(0, 10);

    if (dow !== 0 && dow !== 6) {
      // Weekday — always count
      count++;
    } else if (dayMapSet.has(dateStr)) {
      // Weekend — count only if in dayMap
      count++;
    }

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm test -- --run src/__tests__/utils.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils.ts packages/shared/src/__tests__/utils.test.ts
git commit -m "feat: add computeFteDays() to shared package"
```

---

### Task 2: Extend GhostMetric type with optional FTE fields

**Files:**
- Modify: `packages/shared/src/types.ts:26-43`

- [ ] **Step 1: Add FTE fields to GhostMetric interface**

In `packages/shared/src/types.ts`, add four optional fields after `overheadHours` (line 42):

```ts
export interface GhostMetric {
  developerId: string;
  developerName: string;
  developerEmail: string;
  periodType: PeriodType;
  periodStart?: string;
  periodEnd?: string;
  totalEffortHours: number;
  actualWorkDays: number;
  avgDailyEffort: number;
  ghostPercentRaw: number | null;
  ghostPercent: number | null;
  share: number;
  shareAutoCalculated: boolean;
  commitCount: number;
  hasEnoughData: boolean;
  overheadHours?: number;
  // FTE mode (optional — only populated on order results page)
  fteWorkDays?: number;
  fteAvgDailyEffort?: number;
  fteGhostPercentRaw?: number | null;
  fteGhostPercent?: number | null;
}
```

- [ ] **Step 2: Verify shared package builds**

Run: `cd packages/shared && pnpm test -- --run`
Expected: All existing tests still pass (fields are optional, no breakage)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add optional FTE fields to GhostMetric type"
```

---

### Task 3: Add FTE columns to OrderMetric schema

**Files:**
- Modify: `packages/server/prisma/schema.prisma:449-467`

- [ ] **Step 1: Add FTE fields to OrderMetric model**

In `packages/server/prisma/schema.prisma`, add after the `ghostPercent` field (after line 457):

```prisma
  // FTE metrics (full-time employee mode)
  fteWorkDays         Int      @default(0)
  fteAvgDailyEffort   Decimal? @db.Decimal(10, 4) @default(0)
  fteGhostPercentRaw  Decimal? @db.Decimal(10, 2)
  fteGhostPercent     Decimal? @db.Decimal(10, 2)
```

- [ ] **Step 2: Create migration**

Run: `cd packages/server && pnpm db:migrate -- --name add_fte_metrics_to_order_metric`
Expected: Migration created in `prisma/migrations/` directory

- [ ] **Step 3: Generate Prisma client**

Run: `cd packages/server && pnpm db:generate`
Expected: Prisma client generated successfully

- [ ] **Step 4: Commit**

```bash
git add packages/server/prisma/schema.prisma packages/server/prisma/migrations/
git commit -m "feat: add FTE columns to OrderMetric schema"
```

---

### Task 4: Calculate FTE metrics in `saveDeveloperMetric()`

**Files:**
- Modify: `packages/server/src/lib/services/ghost-metrics-service.ts:12-19` (imports), `117-160` (calculation), `198-227` (persistence)

- [ ] **Step 1: Add `computeFteDays` to imports**

In `ghost-metrics-service.ts`, update the `@devghost/shared` import (line 12-18):

```ts
import {
  calcGhostPercentRaw,
  calcGhostPercent,
  calcAutoShare,
  spreadEffort,
  computeFteDays,
  MIN_WORK_DAYS_FOR_GHOST,
} from '@devghost/shared';
```

- [ ] **Step 2: Add FTE calculation after spread result**

In `saveDeveloperMetric()`, after line 123 (`const overheadHours = spreadResult.totalOverhead;`), add:

```ts
    // FTE mode: count all weekdays in [earliest spread day, last commit] + weekend commit days
    const fteDays = computeFteDays(
      Array.from(spreadResult.dayMap.keys()),
      workset.commits.map(c => c.authorDate),
    );
    const fteAvgDaily = fteDays > 0 ? totalEffort / fteDays : 0;
    const fteGhostRaw = calcGhostPercentRaw(totalEffort, fteDays);
    const fteGhost = calcGhostPercent(totalEffort, fteDays, share);
```

Note: the `share` variable is computed at lines 131-139, which is AFTER line 123. Move the FTE Ghost% calculation to after the share block. Insert the `fteDays` and `fteAvgDaily` lines after line 123, and the `fteGhostRaw`/`fteGhost` lines after line 139 (after share is known):

```ts
    // After line 123:
    const fteDays = computeFteDays(
      Array.from(spreadResult.dayMap.keys()),
      workset.commits.map(c => c.authorDate),
    );
    const fteAvgDaily = fteDays > 0 ? totalEffort / fteDays : 0;

    // ... existing share calculation (lines 130-139) ...

    // After line 142 (after ghostRaw and ghost):
    const fteGhostRaw = calcGhostPercentRaw(totalEffort, fteDays);
    const fteGhost = calcGhostPercent(totalEffort, fteDays, share);
```

- [ ] **Step 3: Add FTE fields to the GhostMetric return object**

In the `metric` object construction (lines 145-160), add after `overheadHours`:

```ts
      fteWorkDays: fteDays,
      fteAvgDailyEffort: fteAvgDaily,
      fteGhostPercentRaw: fteGhostRaw,
      fteGhostPercent: fteGhost,
```

- [ ] **Step 4: Add FTE fields to the metricData for DB persistence**

In the `metricData` object (lines 198-208), add after `calculatedAt`:

```ts
      fteWorkDays: fteDays,
      fteAvgDailyEffort: fteAvgDaily,
      fteGhostPercentRaw: fteGhostRaw,
      fteGhostPercent: fteGhost,
```

- [ ] **Step 5: Update log line to include FTE days**

Update the log at line 125-128 to include `fteDays`:

```ts
    log.info(
      { orderId, email, totalEffort, workDays, fteDays, overheadHours, commitCount: workset.commitCount },
      'Spread effort computed',
    );
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/lib/services/ghost-metrics-service.ts
git commit -m "feat: calculate FTE metrics in saveDeveloperMetric()"
```

---

### Task 5: Add `recalculateFteForOrder()` method

**Files:**
- Modify: `packages/server/src/lib/services/ghost-metrics-service.ts` (add method before `calculateAndSave`)

- [ ] **Step 1: Add recalculation method**

Add to `GhostMetricsService` class, before `calculateAndSave()` (line 233):

```ts
  /**
   * Recalculate FTE metrics for an existing order without re-running analysis.
   * Uses stored DailyEffort dates as dayMap proxy and in-scope commit dates.
   */
  async recalculateFteForOrder(orderId: string, userId: string): Promise<number> {
    const scopeConfig = await this.loadOrderScope(orderId, userId);
    const commitAnalyses = await getInScopeCommits(orderId, scopeConfig, {
      select: {
        commitHash: true,
        authorEmail: true,
        authorName: true,
        authorDate: true,
        effortHours: true,
      },
    }) as InScopeCommitRow[];

    // Load all DailyEffort rows with dates
    const dailyEfforts = await prisma.dailyEffort.findMany({
      where: { orderId },
      select: { developerEmail: true, date: true },
    });

    // Load all OrderMetric records
    const orderMetrics = await prisma.orderMetric.findMany({
      where: { orderId },
    });

    let updated = 0;

    for (const m of orderMetrics) {
      const email = m.developerEmail;

      // Filter commits and daily effort dates for this metric's period bucket
      const bucketCommitDates: Date[] = [];
      for (const ca of commitAnalyses) {
        if (ca.authorEmail !== email) continue;
        const d = new Date(ca.authorDate);
        if (this.dateMatchesBucket(d, m.periodType, m.year, m.month)) {
          bucketCommitDates.push(d);
        }
      }

      const bucketDayMapKeys: Set<string> = new Set();
      for (const de of dailyEfforts) {
        if (de.developerEmail !== email) continue;
        const d = new Date(de.date);
        if (this.dateMatchesBucket(d, m.periodType, m.year, m.month)) {
          bucketDayMapKeys.add(d.toISOString().slice(0, 10));
        }
      }

      const dayMapKeys = Array.from(bucketDayMapKeys);
      if (dayMapKeys.length === 0 || bucketCommitDates.length === 0) continue;

      const fteDays = computeFteDays(dayMapKeys, bucketCommitDates);
      const totalEffort = Number(m.totalEffortHours ?? 0);
      const share = Number(m.share ?? 1);
      const fteAvgDaily = fteDays > 0 ? totalEffort / fteDays : 0;
      const fteGhostRaw = calcGhostPercentRaw(totalEffort, fteDays);
      const fteGhost = calcGhostPercent(totalEffort, fteDays, share);

      await prisma.orderMetric.update({
        where: { id: m.id },
        data: {
          fteWorkDays: fteDays,
          fteAvgDailyEffort: fteAvgDaily,
          fteGhostPercentRaw: fteGhostRaw,
          fteGhostPercent: fteGhost,
        },
      });
      updated++;
    }

    log.info({ orderId, updated }, 'FTE metrics recalculated');
    return updated;
  }

  /** Check if a date falls within the given period bucket. */
  private dateMatchesBucket(
    date: Date,
    periodType: string,
    year: number | null,
    month: number | null,
  ): boolean {
    if (periodType === 'ALL_TIME') return true;
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    if (periodType === 'YEAR') return y === year;
    if (periodType === 'MONTH') return y === year && m === month;
    if (periodType === 'QUARTER') {
      const q = Math.ceil(m / 3);
      const bucketQ = month != null ? Math.ceil(month / 3) : null;
      return y === year && q === bucketQ;
    }
    return true;
  }
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/lib/services/ghost-metrics-service.ts
git commit -m "feat: add recalculateFteForOrder() for legacy orders"
```

---

### Task 6: Return FTE fields from metrics API

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/metrics/route.ts:77-92`
- Test: `packages/server/src/app/api/orders/[id]/metrics/__tests__/route.test.ts`

- [ ] **Step 1: Write failing test for FTE fields in response**

Add to `packages/server/src/app/api/orders/[id]/metrics/__tests__/route.test.ts`:

```ts
  it('includes FTE fields in metric response', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
    } as never);

    mockOrderMetricFindMany.mockResolvedValue([
      {
        developerEmail: 'dev@test.com',
        developerName: 'Dev',
        periodType: 'ALL_TIME',
        year: null,
        month: null,
        commitCount: 10,
        workDays: 5,
        totalEffortHours: 15,
        avgDailyEffort: 3.0,
        ghostPercentRaw: 100,
        ghostPercent: 100,
        share: 1.0,
        shareAutoCalculated: true,
        fteWorkDays: 20,
        fteAvgDailyEffort: 0.75,
        fteGhostPercentRaw: 25,
        fteGhostPercent: 25,
      },
    ]);
    mockDailyEffortFindMany.mockResolvedValue([]);

    const res = await GET(makeRequest('period=ALL_TIME'), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(json.data[0].fteWorkDays).toBe(20);
    expect(json.data[0].fteAvgDailyEffort).toBe(0.75);
    expect(json.data[0].fteGhostPercentRaw).toBe(25);
    expect(json.data[0].fteGhostPercent).toBe(25);
  });

  it('defaults FTE fields to 0/null for legacy metrics', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
    } as never);

    mockOrderMetricFindMany.mockResolvedValue([
      {
        developerEmail: 'dev@test.com',
        developerName: 'Dev',
        periodType: 'ALL_TIME',
        year: null,
        month: null,
        commitCount: 5,
        workDays: 3,
        totalEffortHours: 9,
        avgDailyEffort: 3.0,
        ghostPercentRaw: 100,
        ghostPercent: 100,
        share: 1.0,
        shareAutoCalculated: true,
        // No FTE fields — legacy row
      },
    ]);
    mockDailyEffortFindMany.mockResolvedValue([]);

    const res = await GET(makeRequest('period=ALL_TIME'), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(json.data[0].fteWorkDays).toBe(0);
    expect(json.data[0].fteAvgDailyEffort).toBe(0);
    expect(json.data[0].fteGhostPercentRaw).toBeNull();
    expect(json.data[0].fteGhostPercent).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- --run src/app/api/orders/\\[id\\]/metrics/__tests__/route.test.ts`
Expected: FAIL — `fteWorkDays` is undefined in response

- [ ] **Step 3: Add FTE fields to the metrics response**

In `packages/server/src/app/api/orders/[id]/metrics/route.ts`, update the return object inside `orderMetrics.map()` (after line 91, before the closing `};`):

```ts
      fteWorkDays: m.fteWorkDays ?? 0,
      fteAvgDailyEffort: Number(m.fteAvgDailyEffort ?? 0),
      fteGhostPercentRaw: m.fteGhostPercentRaw != null ? Number(m.fteGhostPercentRaw) : null,
      fteGhostPercent: m.fteGhostPercent != null ? Number(m.fteGhostPercent) : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && pnpm test -- --run src/app/api/orders/\\[id\\]/metrics/__tests__/route.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/metrics/route.ts packages/server/src/app/api/orders/[id]/metrics/__tests__/route.test.ts
git commit -m "feat: return FTE fields from metrics API"
```

---

### Task 7: Add recalculate-fte API endpoint

**Files:**
- Create: `packages/server/src/app/api/orders/[id]/recalculate-fte/route.ts`

- [ ] **Step 1: Create the endpoint**

Create `packages/server/src/app/api/orders/[id]/recalculate-fte/route.ts`:

```ts
import { apiResponse, apiError, getOrderWithAuth } from '@/lib/api-utils';
import { getGhostMetricsService } from '@/lib/services/ghost-metrics-service';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await getOrderWithAuth(id, {
    select: { id: true, userId: true, status: true },
  });

  if (!result.success) {
    return apiError(result.error, result.status);
  }

  const order = result.order as { id: string; userId: string; status: string };
  if (order.status !== 'COMPLETED') {
    return apiError('Order must be completed to recalculate FTE metrics', 400);
  }

  const service = getGhostMetricsService();
  const updated = await service.recalculateFteForOrder(id, order.userId);

  return apiResponse({ updated });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/recalculate-fte/route.ts
git commit -m "feat: add POST /api/orders/[id]/recalculate-fte endpoint"
```

---

### Task 8: Add FTE toggle and `applyFteView` to order page

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`
- Modify: `packages/server/messages/ru.json`
- Modify: `packages/server/messages/en.json`

- [ ] **Step 1: Add i18n keys**

In `packages/server/messages/ru.json`, find the `orders.detail` section and add:

```json
"fteToggleSpread": "Spread",
"fteToggleFte": "FTE",
"fteCalculateButton": "Рассчитать FTE",
"fteCalculating": "Расчёт...",
"fteRecalculated": "FTE метрики рассчитаны",
"fteRecalcFailed": "Ошибка расчёта FTE",
"fteNotAvailableTooltip": "FTE метрики не рассчитаны для этого заказа"
```

Add equivalent keys in `packages/server/messages/en.json`:

```json
"fteToggleSpread": "Spread",
"fteToggleFte": "FTE",
"fteCalculateButton": "Calculate FTE",
"fteCalculating": "Calculating...",
"fteRecalculated": "FTE metrics calculated",
"fteRecalcFailed": "FTE calculation failed",
"fteNotAvailableTooltip": "FTE metrics not calculated for this order"
```

- [ ] **Step 2: Add `applyFteView` helper and toggle state**

In `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`, add the import for `MIN_WORK_DAYS_FOR_GHOST` to the existing `@devghost/shared` import (line 25):

```ts
import { GHOST_NORM, MIN_WORK_DAYS_FOR_GHOST, type GhostMetric, type GhostEligiblePeriod } from '@devghost/shared';
```

Add the `applyFteView` function before the page component (after imports):

```ts
function applyFteView(metrics: GhostMetric[]): GhostMetric[] {
  return metrics.map(m => ({
    ...m,
    actualWorkDays: m.fteWorkDays ?? m.actualWorkDays,
    avgDailyEffort: m.fteAvgDailyEffort ?? m.avgDailyEffort,
    ghostPercentRaw: m.fteGhostPercentRaw !== undefined ? m.fteGhostPercentRaw : m.ghostPercentRaw,
    ghostPercent: m.fteGhostPercent !== undefined ? m.fteGhostPercent : m.ghostPercent,
    hasEnoughData: (m.fteWorkDays ?? 0) >= MIN_WORK_DAYS_FOR_GHOST,
  }));
}
```

- [ ] **Step 3: Add FTE state and readiness logic inside the page component**

Inside the page component, near the existing `period` state, add:

```ts
const [fteMode, setFteMode] = useState(false);
```

Add FTE readiness check and the recalculation mutation. Place these near other mutations (around line 790):

```ts
  const fteReady = metrics.length > 0 && metrics.every((m: GhostMetric) => (m.fteWorkDays ?? 0) > 0);

  const fteRecalcMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/orders/${id}/recalculate-fte`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) throw new Error(json?.error ?? 'Recalculation failed');
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['metrics', id] });
      toast.success(t('detail.fteRecalculated'));
    },
    onError: (error: Error) => {
      toast.error(t('detail.fteRecalcFailed'), error.message);
    },
  });
```

- [ ] **Step 4: Apply FTE transform to metrics before passing to components**

In the COMPLETED section, right before the `displayMetrics` computation (line 840), wrap the source metrics:

```ts
  const sourceMetrics = fteMode ? applyFteView(metrics) : metrics;
```

Then change line 840 to use `sourceMetrics` instead of `metrics`:

```ts
  const displayMetrics: GhostMetric[] = sourceMetrics.map((metric: GhostMetric) => {
```

Also change the `AnalysisResultsOverview` props (line 1494) to pass `sourceMetrics` instead of `metrics`:

```ts
            metrics={fteMode ? applyFteView(metrics) : metrics}
```

This ensures both the summary KPIs (computed from `displayMetrics` in page.tsx) and the overview component (which applies its own ghostNorm mode) both receive FTE-transformed data when FTE is active.

- [ ] **Step 5: Add FTE toggle UI to the COMPLETED section**

In the COMPLETED section (after `<AnalysisResultsSummary>` closing tag, around line 1483), add the toggle:

```tsx
          {/* FTE Mode Toggle */}
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-md border p-0.5 text-sm">
              <button
                className={cn(
                  'px-3 py-1 rounded-sm transition-colors',
                  !fteMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setFteMode(false)}
              >
                {t('detail.fteToggleSpread')}
              </button>
              <button
                className={cn(
                  'px-3 py-1 rounded-sm transition-colors',
                  fteMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  !fteReady && 'opacity-50 cursor-not-allowed',
                )}
                onClick={() => fteReady && setFteMode(true)}
                disabled={!fteReady}
                title={!fteReady ? t('detail.fteNotAvailableTooltip') : undefined}
              >
                {t('detail.fteToggleFte')}
              </button>
            </div>
            {!fteReady && order.status === 'COMPLETED' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => fteRecalcMutation.mutate()}
                disabled={fteRecalcMutation.isPending}
              >
                {fteRecalcMutation.isPending
                  ? t('detail.fteCalculating')
                  : t('detail.fteCalculateButton')}
              </Button>
            )}
          </div>
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx packages/server/messages/ru.json packages/server/messages/en.json
git commit -m "feat: add FTE toggle and applyFteView to order results page"
```

---

### Task 9: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run shared package tests**

Run: `cd packages/shared && pnpm test -- --run`
Expected: All tests PASS

- [ ] **Step 2: Run server tests**

Run: `cd packages/server && pnpm test -- --run`
Expected: All tests PASS

- [ ] **Step 3: Run lint**

Run: `cd packages/server && pnpm lint`
Expected: No new errors

- [ ] **Step 4: Build check**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds

- [ ] **Step 5: Commit any lint/type fixes if needed**

```bash
git add -A && git commit -m "fix: address lint/type issues from FTE implementation"
```
