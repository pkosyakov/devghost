# Analysis Results Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the completed analysis page as a customer-facing results landing with clear handoff into canonical workspace surfaces, and add a latest-results return path from Home.

**Architecture:** Decompose the 2006-line `orders/[id]/page.tsx` monolith into 4 product-level section components (Summary, Handoff, Overview, Technical). Add `latestCompletedAnalysis` to Home API. Add `AnalysisReturnBanner` for bidirectional handoff. Add `topCanonicalRepoId` to order detail API.

**Tech Stack:** Next.js 16 (App Router), React 19, TanStack Query, Prisma 6, shadcn/ui, next-intl, Tailwind CSS, vitest

**Spec:** `docs/superpowers/specs/2026-03-31-analysis-results-landing-design.md`

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `packages/server/src/components/analysis-results-summary.tsx` | Title, status, summary line, KPI cards, scope badge |
| `packages/server/src/components/analysis-handoff-card.tsx` | Next-step CTAs (People/Repos/Team), identity banner |
| `packages/server/src/components/analysis-results-overview.tsx` | Period/norm selectors, distribution panel, developer table, tabs |
| `packages/server/src/components/analysis-technical-panel.tsx` | Publish/share, scope, re-analyze, benchmark, logs (collapsible) |
| `packages/server/src/components/analysis-return-banner.tsx` | Thin return banner reading `fromAnalysis` query param |
| `packages/server/src/components/__tests__/analysis-handoff-card.test.tsx` | Handoff card variant rendering tests |
| `packages/server/src/components/__tests__/analysis-return-banner.test.tsx` | Return banner presence/absence tests |
| `packages/server/src/lib/services/__tests__/home-service-latest-analysis.test.ts` | latestCompletedAnalysis query tests |

### Modified files
| File | Change |
|---|---|
| `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx` | Slim down COMPLETED block to orchestrate 4 sections |
| `packages/server/src/app/api/orders/[id]/route.ts` | Add `topCanonicalRepoId` to GET response |
| `packages/server/src/lib/services/home-service.ts` | Add `latestCompletedAnalysis` to payload |
| `packages/server/src/app/api/v2/home/route.ts` | Pass through new field (likely automatic) |
| `packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx` | Render latest analysis card |
| `packages/server/src/app/[locale]/(dashboard)/people/page.tsx` | Insert `AnalysisReturnBanner` |
| `packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx` | Insert `AnalysisReturnBanner` |
| `packages/server/messages/en.json` | Add `analysisResults.*` namespace + `home.*.latestAnalysis.*` keys |
| `packages/server/messages/ru.json` | Add `analysisResults.*` namespace + `home.*.latestAnalysis.*` keys |

---

## Task 1: i18n Keys

**Files:**
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

All subsequent tasks depend on these keys existing.

- [ ] **Step 1: Add `analysisResults` namespace to `en.json`**

Open `packages/server/messages/en.json`. Add a new top-level `"analysisResults"` key (place it after the `"orders"` block). Content:

```json
"analysisResults": {
  "summary": {
    "title": "Analysis Results",
    "subtitle": "{repoCount} repositories, {contributorCount} contributors, {commitCount} commits analyzed",
    "completedAt": "Completed {date}"
  },
  "handoff": {
    "title": "Your analysis is complete. Here's what to do next.",
    "description": "Review the imported data, then create your first team.",
    "peopleCta": "Review contributors",
    "repositoriesCta": "Check repositories",
    "teamCta": "Create first team",
    "teamFallbackCta": "Find a repository to start your first team",
    "operationalPeople": "People",
    "operationalRepositories": "Repositories",
    "operationalLabel": "Review imported data:",
    "identityBanner": "{count} unresolved identities need review"
  },
  "technical": {
    "label": "Technical details"
  },
  "returnBanner": {
    "text": "You came here from analysis results.",
    "cta": "Back to analysis results"
  }
}
```

- [ ] **Step 2: Add `latestAnalysis` keys to `home` namespace in `en.json`**

Inside the existing `"home"` object, add to the `"firstData"` sub-object:

```json
"latestAnalysis": {
  "title": "Latest analysis ready",
  "subtitle": "{repoCount} repos, {contributorCount} contributors, {commitCount} commits",
  "cta": "View analysis results"
}
```

Inside the existing `"home.operational"` sub-object, add:

```json
"latestAnalysis": {
  "label": "Latest analysis"
}
```

- [ ] **Step 3: Add corresponding keys to `ru.json`**

Same structure, Russian translations:

```json
"analysisResults": {
  "summary": {
    "title": "Результаты анализа",
    "subtitle": "{repoCount} репозиториев, {contributorCount} контрибьюторов, {commitCount} коммитов проанализировано",
    "completedAt": "Завершён {date}"
  },
  "handoff": {
    "title": "Анализ завершён. Вот что делать дальше.",
    "description": "Просмотрите импортированные данные, затем создайте первую команду.",
    "peopleCta": "Просмотреть контрибьюторов",
    "repositoriesCta": "Проверить репозитории",
    "teamCta": "Создать первую команду",
    "teamFallbackCta": "Выберите репозиторий для первой команды",
    "operationalPeople": "Люди",
    "operationalRepositories": "Репозитории",
    "operationalLabel": "Просмотреть импортированные данные:",
    "identityBanner": "{count} неразрешённых идентичностей требуют проверки"
  },
  "technical": {
    "label": "Технические детали"
  },
  "returnBanner": {
    "text": "Вы перешли сюда из результатов анализа.",
    "cta": "Вернуться к результатам анализа"
  }
}
```

And the `home` additions:

```json
"firstData.latestAnalysis": {
  "title": "Последний анализ готов",
  "subtitle": "{repoCount} репо, {contributorCount} контрибьюторов, {commitCount} коммитов",
  "cta": "Посмотреть результаты анализа"
}
```

```json
"operational.latestAnalysis": {
  "label": "Последний анализ"
}
```

- [ ] **Step 4: Verify JSON validity**

Run: `cd packages/server && node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8')); console.log('en.json OK')" && node -e "JSON.parse(require('fs').readFileSync('messages/ru.json','utf8')); console.log('ru.json OK')"`

Expected: both print OK.

- [ ] **Step 5: Commit**

```bash
git add packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat(i18n): add analysisResults namespace and home.latestAnalysis keys"
```

---

## Task 2: AnalysisReturnBanner Component

**Files:**
- Create: `packages/server/src/components/analysis-return-banner.tsx`
- Create: `packages/server/src/components/__tests__/analysis-return-banner.test.tsx`

This is standalone with no dependencies on other new components.

- [ ] **Step 1: Write the test**

Create `packages/server/src/components/__tests__/analysis-return-banner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalysisReturnBanner } from '../analysis-return-banner';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      'returnBanner.text': 'You came here from analysis results.',
      'returnBanner.cta': 'Back to analysis results',
    };
    return map[key] ?? key;
  },
}));

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

// Mock i18n Link
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('AnalysisReturnBanner', () => {
  it('renders nothing when fromAnalysis param is absent', () => {
    mockSearchParams.delete('fromAnalysis');
    const { container } = render(<AnalysisReturnBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('renders banner with return link when fromAnalysis param is present', () => {
    mockSearchParams.set('fromAnalysis', 'order-123');
    render(<AnalysisReturnBanner />);
    expect(screen.getByText('You came here from analysis results.')).toBeTruthy();
    const link = screen.getByText('Back to analysis results').closest('a');
    expect(link?.getAttribute('href')).toBe('/orders/order-123');
  });

  it('renders nothing when fromAnalysis param is empty string', () => {
    mockSearchParams.set('fromAnalysis', '');
    const { container } = render(<AnalysisReturnBanner />);
    expect(container.innerHTML).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/components/__tests__/analysis-return-banner.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `packages/server/src/components/analysis-return-banner.tsx`:

```tsx
'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ArrowLeft } from 'lucide-react';

export function AnalysisReturnBanner() {
  const searchParams = useSearchParams();
  const fromAnalysis = searchParams.get('fromAnalysis');
  const t = useTranslations('analysisResults');

  if (!fromAnalysis) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-muted bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
      <ArrowLeft className="h-4 w-4 shrink-0" />
      <span>{t('returnBanner.text')}</span>
      <Link
        href={`/orders/${fromAnalysis}`}
        className="ml-1 font-medium text-primary hover:underline"
      >
        {t('returnBanner.cta')}
      </Link>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx vitest run src/components/__tests__/analysis-return-banner.test.tsx`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/components/analysis-return-banner.tsx packages/server/src/components/__tests__/analysis-return-banner.test.tsx
git commit -m "feat: add AnalysisReturnBanner component with fromAnalysis query param"
```

---

## Task 3: AnalysisResultsSummary Component

**Files:**
- Create: `packages/server/src/components/analysis-results-summary.tsx`

No separate test file — this is a pure presentational component reusing existing `GhostKpiCards`. Verified via typecheck and integration.

- [ ] **Step 1: Create the component**

Create `packages/server/src/components/analysis-results-summary.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { GhostKpiCards } from '@/components/ghost-kpi-cards';
import { CalendarRange } from 'lucide-react';

interface AnalysisResultsSummaryProps {
  orderName: string;
  /** Completed-result counts (not raw extraction-era) */
  repoCount: number;
  contributorCount: number;
  commitCount: number;
  completedAt: string | null;
  /** KPI data */
  avgGhostPercent: number | null;
  totalWorkDays: number;
  ghostNormHours: number;
  /** Scope display */
  dateRangeLabel: string | null;
  scopeLabel: string | null;
  isPartialScope: boolean;
}

export function AnalysisResultsSummary({
  orderName,
  repoCount,
  contributorCount,
  commitCount,
  completedAt,
  avgGhostPercent,
  totalWorkDays,
  ghostNormHours,
  dateRangeLabel,
  scopeLabel,
  isPartialScope,
}: AnalysisResultsSummaryProps) {
  const t = useTranslations('analysisResults');

  return (
    <div className="space-y-4">
      {/* Headline */}
      <div>
        <h1 className="text-2xl font-bold">{orderName}</h1>
        <p className="text-sm text-muted-foreground">
          {t('summary.subtitle', { repoCount, contributorCount, commitCount })}
          {completedAt && (
            <span className="ml-2">
              &middot; {t('summary.completedAt', { date: new Date(completedAt).toLocaleDateString() })}
            </span>
          )}
        </p>
      </div>

      {/* KPI Cards */}
      <GhostKpiCards
        avgGhostPercent={avgGhostPercent}
        developerCount={contributorCount}
        commitCount={commitCount}
        totalWorkDays={totalWorkDays}
        ghostNormHours={ghostNormHours}
      />

      {/* Scope / date range */}
      {dateRangeLabel && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
          <CalendarRange className="h-4 w-4 flex-shrink-0" />
          <span>{dateRangeLabel}</span>
          {scopeLabel && (
            <>
              <span className="text-muted-foreground/40">&middot;</span>
              {isPartialScope ? (
                <Badge variant="outline" className="border-amber-300 text-amber-700 bg-amber-50 text-xs font-normal">
                  {scopeLabel}
                </Badge>
              ) : (
                <span>{scopeLabel}</span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors related to analysis-results-summary.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/components/analysis-results-summary.tsx
git commit -m "feat: add AnalysisResultsSummary component"
```

---

## Task 4: AnalysisHandoffCard Component

**Files:**
- Create: `packages/server/src/components/analysis-handoff-card.tsx`
- Create: `packages/server/src/components/__tests__/analysis-handoff-card.test.tsx`

- [ ] **Step 1: Write the test**

Create `packages/server/src/components/__tests__/analysis-handoff-card.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalysisHandoffCard } from '../analysis-handoff-card';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      'handoff.title': 'Your analysis is complete.',
      'handoff.description': 'Review the imported data.',
      'handoff.peopleCta': 'Review contributors',
      'handoff.repositoriesCta': 'Check repositories',
      'handoff.teamCta': 'Create first team',
      'handoff.teamFallbackCta': 'Find a repository to start your first team',
      'handoff.operationalLabel': 'Review imported data:',
      'handoff.operationalPeople': 'People',
      'handoff.operationalRepositories': 'Repositories',
    };
    return map[key] ?? key;
  },
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('AnalysisHandoffCard', () => {
  it('renders prominent variant for first_data stage', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId="repo-abc"
        unresolvedIdentityCount={0}
      />
    );
    expect(screen.getByText('Your analysis is complete.')).toBeTruthy();
    expect(screen.getByText('Review contributors')).toBeTruthy();
    expect(screen.getByText('Check repositories')).toBeTruthy();
    expect(screen.getByText('Create first team')).toBeTruthy();
  });

  it('links team CTA to specific repo when topCanonicalRepoId is provided', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId="repo-abc"
        unresolvedIdentityCount={0}
      />
    );
    const teamLink = screen.getByText('Create first team').closest('a');
    expect(teamLink?.getAttribute('href')).toBe('/repositories/repo-abc?fromAnalysis=order-1');
  });

  it('uses fallback CTA when topCanonicalRepoId is null', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId={null}
        unresolvedIdentityCount={0}
      />
    );
    expect(screen.getByText('Find a repository to start your first team')).toBeTruthy();
    const fallbackLink = screen.getByText('Find a repository to start your first team').closest('a');
    expect(fallbackLink?.getAttribute('href')).toBe('/repositories?fromAnalysis=order-1');
  });

  it('renders compact variant for operational stage', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="operational"
        topCanonicalRepoId={null}
        unresolvedIdentityCount={0}
      />
    );
    expect(screen.getByText('Review imported data:')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
    expect(screen.getByText('Repositories')).toBeTruthy();
    // No team CTA in operational
    expect(screen.queryByText('Create first team')).toBeNull();
  });

  it('shows identity banner when unresolvedIdentityCount > 0', () => {
    render(
      <AnalysisHandoffCard
        analysisId="order-1"
        workspaceStage="first_data"
        topCanonicalRepoId={null}
        unresolvedIdentityCount={5}
      />
    );
    // Identity banner links carry fromAnalysis
    const links = screen.getAllByRole('link');
    const identityLink = links.find(
      (l) => l.getAttribute('href')?.includes('identityHealth=unresolved')
    );
    expect(identityLink?.getAttribute('href')).toContain('fromAnalysis=order-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/components/__tests__/analysis-handoff-card.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `packages/server/src/components/analysis-handoff-card.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, FolderGit2, UsersRound, AlertCircle } from 'lucide-react';
import type { WorkspaceStage } from '@/hooks/use-workspace-stage';

interface AnalysisHandoffCardProps {
  analysisId: string;
  workspaceStage: WorkspaceStage;
  topCanonicalRepoId: string | null;
  unresolvedIdentityCount: number;
}

export function AnalysisHandoffCard({
  analysisId,
  workspaceStage,
  topCanonicalRepoId,
  unresolvedIdentityCount,
}: AnalysisHandoffCardProps) {
  const t = useTranslations('analysisResults');
  const fromParam = `fromAnalysis=${analysisId}`;

  const identityBanner = unresolvedIdentityCount > 0 && (
    <div className="flex items-center justify-between rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-2 dark:border-yellow-800 dark:bg-yellow-950">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-yellow-600" />
        <span className="text-sm">
          {t('handoff.identityBanner', { count: unresolvedIdentityCount })}
        </span>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link href={`/people?identityHealth=unresolved&${fromParam}`}>
          {t('handoff.peopleCta')}
        </Link>
      </Button>
    </div>
  );

  if (workspaceStage === 'first_data') {
    const teamHref = topCanonicalRepoId
      ? `/repositories/${topCanonicalRepoId}?${fromParam}`
      : `/repositories?${fromParam}`;
    const teamLabel = topCanonicalRepoId
      ? t('handoff.teamCta')
      : t('handoff.teamFallbackCta');

    return (
      <div className="space-y-3">
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div>
                <p className="font-medium">{t('handoff.title')}</p>
                <p className="text-sm text-muted-foreground">{t('handoff.description')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/people?${fromParam}`}>
                  <Button variant="default" size="sm">
                    <Users className="h-4 w-4 mr-2" />
                    {t('handoff.peopleCta')}
                  </Button>
                </Link>
                <Link href={`/repositories?${fromParam}`}>
                  <Button variant="outline" size="sm">
                    <FolderGit2 className="h-4 w-4 mr-2" />
                    {t('handoff.repositoriesCta')}
                  </Button>
                </Link>
                <Link href={teamHref}>
                  <Button variant="outline" size="sm">
                    <UsersRound className="h-4 w-4 mr-2" />
                    {teamLabel}
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
        {identityBanner}
      </div>
    );
  }

  // operational: compact variant
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm">
        <span className="text-muted-foreground">{t('handoff.operationalLabel')}</span>
        <Link
          href={`/people?${fromParam}`}
          className="font-medium text-primary hover:underline"
        >
          {t('handoff.operationalPeople')}
        </Link>
        <Link
          href={`/repositories?${fromParam}`}
          className="font-medium text-primary hover:underline"
        >
          {t('handoff.operationalRepositories')}
        </Link>
      </div>
      {identityBanner}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx vitest run src/components/__tests__/analysis-handoff-card.test.tsx`

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/components/analysis-handoff-card.tsx packages/server/src/components/__tests__/analysis-handoff-card.test.tsx
git commit -m "feat: add AnalysisHandoffCard with stage-dependent variants"
```

---

## Task 5: AnalysisResultsOverview Component

**Files:**
- Create: `packages/server/src/components/analysis-results-overview.tsx`

Extracts the existing Overview/Commits/Calendar tabs, period selector, ghost norm selector, distribution panel, and developer table from `orders/[id]/page.tsx` (lines 1919-2000). Reuses existing sub-components directly.

- [ ] **Step 1: Create the component**

Create `packages/server/src/components/analysis-results-overview.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { GhostDistributionPanel } from '@/components/ghost-distribution-panel';
import { GhostDeveloperTable } from '@/components/ghost-developer-table';
import { GhostPeriodSelector } from '@/components/ghost-period-selector';
import { CommitAnalysisTable } from '@/components/commit-analysis-table';
import { EffortTimeline } from '@/components/effort-timeline';
import { GHOST_NORM, type GhostMetric, type GhostEligiblePeriod } from '@devghost/shared';

type GhostNormMode = 'fixed' | 'median';

interface AnalysisResultsOverviewProps {
  orderId: string;
  metrics: GhostMetric[];
  period: GhostEligiblePeriod;
  onPeriodChange: (period: GhostEligiblePeriod) => void;
  onShareChange: (email: string, share: number, auto: boolean) => void;
  highlightedEmail: string | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function AnalysisResultsOverview({
  orderId,
  metrics,
  period,
  onPeriodChange,
  onShareChange,
  highlightedEmail,
}: AnalysisResultsOverviewProps) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('overview');
  const [ghostNormMode, setGhostNormMode] = useState<GhostNormMode>('fixed');

  // Ghost norm calculation
  const normCandidates = metrics
    .filter((m) => m.hasEnoughData && Number.isFinite(m.avgDailyEffort) && m.avgDailyEffort > 0)
    .map((m) => m.avgDailyEffort);
  const medianGhostNorm = median(normCandidates);
  const effectiveGhostNorm =
    ghostNormMode === 'median' && medianGhostNorm != null ? medianGhostNorm : GHOST_NORM;
  const effectiveGhostNormMode: GhostNormMode =
    ghostNormMode === 'median' && medianGhostNorm != null ? 'median' : 'fixed';

  const normFmt = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
  const effectiveGhostNormLabel = normFmt.format(effectiveGhostNorm);
  const medianGhostNormLabel = medianGhostNorm != null ? normFmt.format(medianGhostNorm) : null;

  // Apply ghost norm to metrics
  const displayMetrics: GhostMetric[] = metrics.map((metric) => {
    if (!metric.hasEnoughData || metric.actualWorkDays <= 0) return metric;
    const avgDailyEffort = metric.avgDailyEffort;
    const raw = (avgDailyEffort / effectiveGhostNorm) * 100;
    const adjusted =
      metric.share > 0 ? (avgDailyEffort / (effectiveGhostNorm * metric.share)) * 100 : null;
    return {
      ...metric,
      ghostPercentRaw: Number.isFinite(raw) ? raw : null,
      ghostPercent: adjusted != null && Number.isFinite(adjusted) ? adjusted : null,
    };
  });

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <TabsList>
        <TabsTrigger value="overview">{t('detail.overview')}</TabsTrigger>
        <TabsTrigger value="commits">{t('detail.commits')}</TabsTrigger>
        <TabsTrigger value="calendar">{t('detail.effortTimeline')}</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="space-y-6">
        <div className="flex justify-end items-center gap-2 flex-wrap">
          <GhostPeriodSelector value={period} onChange={onPeriodChange} />
          <Select
            value={ghostNormMode}
            onValueChange={(v) => setGhostNormMode(v as GhostNormMode)}
          >
            <SelectTrigger className="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">
                {t('detail.ghostNormModeFixed', { hours: GHOST_NORM.toFixed(1) })}
              </SelectItem>
              <SelectItem value="median">{t('detail.ghostNormModeMedian')}</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline" className="text-xs">
            {t('detail.ghostNormCurrent', { hours: effectiveGhostNormLabel })}
          </Badge>
        </div>

        {ghostNormMode === 'median' && effectiveGhostNormMode === 'fixed' && (
          <p className="text-xs text-muted-foreground text-right">
            {t('detail.ghostNormMedianFallback', { hours: GHOST_NORM.toFixed(1) })}
          </p>
        )}
        {ghostNormMode === 'median' && medianGhostNormLabel && (
          <p className="text-xs text-muted-foreground text-right">
            {t('detail.ghostNormMedianValue', { hours: medianGhostNormLabel })}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t('detail.ghostDistribution')}</CardTitle>
          </CardHeader>
          <CardContent>
            <GhostDistributionPanel
              metrics={displayMetrics}
              onDeveloperClick={(email) =>
                router.push(`/orders/${orderId}/developers/${encodeURIComponent(email)}`)
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('detail.developersTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <GhostDeveloperTable
              metrics={displayMetrics}
              orderId={orderId}
              highlightedEmail={highlightedEmail}
              onShareChange={onShareChange}
            />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="commits">
        <CommitAnalysisTable orderId={orderId} />
      </TabsContent>

      <TabsContent value="calendar">
        <EffortTimeline orderId={orderId} />
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors related to analysis-results-overview.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/components/analysis-results-overview.tsx
git commit -m "feat: add AnalysisResultsOverview component (tabs, distribution, developer table)"
```

---

## Task 6: AnalysisTechnicalPanel Component

**Files:**
- Create: `packages/server/src/components/analysis-technical-panel.tsx`

Extracts publish/share, edit scope, re-analyze, benchmark (launcher + matrix + progress), pipeline log, and analysis cost. Wrapped in a collapsible accordion.

- [ ] **Step 1: Create the component**

Create `packages/server/src/components/analysis-technical-panel.tsx`.

This component receives all the props and state needed for the technical controls. Read the current `orders/[id]/page.tsx` lines 1529-1880 and 1919-1996 (benchmark tab content) for the exact JSX to extract. The component structure:

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  ChevronDown,
  ChevronUp,
  Settings2,
  RefreshCw,
  Share2,
  Terminal,
  Loader2,
} from 'lucide-react';
import { BenchmarkLauncher } from '@/components/benchmark-launcher';
import { BenchmarkMatrix } from '@/components/benchmark-matrix';
import { PipelineLog } from '@/components/pipeline-log';
import { AnalysisEventLog } from '@/components/analysis-event-log';
import { CommitProcessingTimeline } from '@/components/commit-processing-timeline';
import { EditScopePanel, type AnalysisPeriodSettings } from '@/components/edit-scope-panel';
import { PublishModal } from '@/components/publish-modal';
import { ShareLinkCard } from '@/components/share-link-card';
import type { PipelineLogEntry } from '@/components/pipeline-log';
import type { AnalysisEventEntry } from '@/components/analysis-event-log';
import type { GhostMetric } from '@devghost/shared';
import type { WorkspaceStage } from '@/hooks/use-workspace-stage';

interface AnalysisTechnicalPanelProps {
  orderId: string;
  order: any; // Order type from API
  workspaceStage: WorkspaceStage;
  isAdmin: boolean;
  // Progress & diagnostics
  progress: any;
  jobEvents: AnalysisEventEntry[];
  pipelineLog: PipelineLogEntry[];
  // Benchmark
  benchmarkJobId: string | null;
  benchmarkProgress: any;
  benchmarkEvents: AnalysisEventEntry[];
  benchmarkLog: PipelineLogEntry[];
  benchmarkNow: number;
  onBenchmarkLaunched: (jobId: string) => void;
  // Mutations
  onAnalyze: () => void;
  analyzeIsPending: boolean;
  onCancelJob: (jobId: string) => void;
  cancelIsPending: boolean;
  // Scope
  onScopeSubmit: (settings: AnalysisPeriodSettings) => void;
  scopeIsPending: boolean;
  // Publish
  metrics: GhostMetric[];
  // Share token
  shareToken: string | null;
  onShareTokenChange: (token: string | null) => void;
}

export function AnalysisTechnicalPanel(props: AnalysisTechnicalPanelProps) {
  const t = useTranslations('orders');
  const tResults = useTranslations('analysisResults');
  const defaultOpen = props.workspaceStage !== 'first_data';
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [publishRepo, setPublishRepo] = useState<string | null>(null);
  const [showEditScope, setShowEditScope] = useState(false);
  const [showCompletedLog, setShowCompletedLog] = useState(false);

  // The full JSX extracted from orders/[id]/page.tsx lines 1529-1880 + benchmark tab.
  // Implementation note: copy the exact JSX blocks from the current page,
  // replacing direct state access with props.* references.
  // This is a large but mechanical extraction — the code already exists,
  // it just moves into this wrapper.

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="flex items-center gap-2 text-muted-foreground">
          {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {tResults('technical.label')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-2">
        {/* Analysis cost line */}
        {/* ... extracted from lines 1530-1547 ... */}

        {/* Publish/Share controls */}
        {/* ... extracted from lines 1548-1611 ... */}

        {/* Edit Scope */}
        {/* ... extracted from lines 1612-1626 ... */}

        {/* Re-analyze button */}
        {/* ... extracted from lines 1563-1584 ... */}

        {/* Benchmark section (admin only) */}
        {/* ... extracted from lines 1629-1835 (launcher + progress + live diagnostics) ... */}
        {/* ... plus BenchmarkMatrix from the benchmark tab (line 1994) ... */}

        {/* Completed pipeline log */}
        {/* ... extracted from lines 1838-1880 ... */}
      </CollapsibleContent>
    </Collapsible>
  );
}
```

**Implementation guidance:** The step above shows the skeleton. The implementer must:
1. Read `orders/[id]/page.tsx` lines 1529-1880 and 1992-1996.
2. Copy each JSX block into the `CollapsibleContent`.
3. Replace direct state variables (`publishRepo`, `showEditScope`, `showCompletedLog`) with local state (they're already declared above).
4. Replace `analyzeMutation.mutate()` with `props.onAnalyze()`, `cancelJobMutation.mutate(id)` with `props.onCancelJob(id)`, etc.
5. Keep `t('detail.*')` translations — these are existing legacy keys that remain.

- [ ] **Step 2: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors related to analysis-technical-panel.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/components/analysis-technical-panel.tsx
git commit -m "feat: add AnalysisTechnicalPanel with collapsible accordion wrapper"
```

---

## Task 7: Order API — Add `topCanonicalRepoId`

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/route.ts:40-52`

- [ ] **Step 1: Add the lookup to the GET handler**

Open `packages/server/src/app/api/orders/[id]/route.ts`. After line 40 (`const { order } = result;`), add the canonical repo lookup:

```ts
    // Resolve first canonical repository for handoff CTA (workspace-scoped)
    let topCanonicalRepoId: string | null = null;
    if (order.status === 'COMPLETED') {
      const repoFullNames = Array.isArray(order.selectedRepos)
        ? (order.selectedRepos as Array<{ full_name?: string; fullName?: string }>)
            .map((r) => r.full_name ?? r.fullName)
            .filter((n): n is string => !!n)
        : [];
      if (repoFullNames.length > 0) {
        // Scope to the order owner's workspace to avoid cross-workspace matches
        const workspace = await prisma.workspace.findUnique({
          where: { ownerId: order.userId },
          select: { id: true },
        });
        if (workspace) {
          const match = await prisma.repository.findFirst({
            where: {
              workspaceId: workspace.id,
              fullName: { in: repoFullNames },
            },
            select: { id: true },
          });
          topCanonicalRepoId = match?.id ?? null;
        }
      }
    }
```

Then modify the return at line 42 to include it:

```ts
    return apiResponse({
      ...order,
      topCanonicalRepoId,
      metrics: order.metrics.map((m) => ({
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/route.ts
git commit -m "feat: add topCanonicalRepoId to order detail API response"
```

---

## Task 8: Home Service — Add `latestCompletedAnalysis`

**Files:**
- Modify: `packages/server/src/lib/services/home-service.ts`
- Create: `packages/server/src/lib/services/__tests__/home-service-latest-analysis.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/server/src/lib/services/__tests__/home-service-latest-analysis.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOrderFindFirst = vi.fn();
const mockOrderMetricFindMany = vi.fn();
const mockCommitAnalysisCount = vi.fn();
const mockCommitAnalysisFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    order: { findFirst: (...args: unknown[]) => mockOrderFindFirst(...args) },
    orderMetric: { findMany: (...args: unknown[]) => mockOrderMetricFindMany(...args) },
    commitAnalysis: {
      count: (...args: unknown[]) => mockCommitAnalysisCount(...args),
      findMany: (...args: unknown[]) => mockCommitAnalysisFindMany(...args),
    },
  },
}));

// Focused unit test for the helper function.
import { getLatestCompletedAnalysis } from '../home-service';

describe('getLatestCompletedAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no completed order exists', async () => {
    mockOrderFindFirst.mockResolvedValue(null);
    const result = await getLatestCompletedAnalysis('user-1');
    expect(result).toBeNull();
    expect(mockOrderFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
      })
    );
  });

  it('returns completed-result counts (not raw extraction-era counts)', async () => {
    mockOrderFindFirst.mockResolvedValue({
      id: 'order-1',
      name: 'My Analysis',
      completedAt: new Date('2026-03-15T10:00:00Z'),
    });
    // Metrics: 2 distinct contributors (a@test.com appears twice)
    mockOrderMetricFindMany.mockResolvedValue([
      { developerEmail: 'a@test.com' },
      { developerEmail: 'b@test.com' },
      { developerEmail: 'a@test.com' },
    ]);
    // CommitAnalysis base rows (jobId: null): 95 actual analyzed commits
    mockCommitAnalysisCount.mockResolvedValue(95);
    // CommitAnalysis base rows distinct repos: 2 repos actually analyzed
    mockCommitAnalysisFindMany.mockResolvedValue([
      { repository: 'org/repo1' },
      { repository: 'org/repo2' },
    ]);
    // Verify queries scope to base analysis (jobId: null), excluding benchmarks

    const result = await getLatestCompletedAnalysis('user-1');

    expect(result).toEqual({
      id: 'order-1',
      name: 'My Analysis',
      completedAt: new Date('2026-03-15T10:00:00Z').toISOString(),
      repoCount: 2,
      contributorCount: 2,
      commitCount: 95,
    });

    // Verify commit/repo queries exclude benchmark rows (jobId: null)
    expect(mockCommitAnalysisCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'order-1', jobId: null } })
    );
    expect(mockCommitAnalysisFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'order-1', jobId: null } })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/lib/services/__tests__/home-service-latest-analysis.test.ts`

Expected: FAIL — function not found.

- [ ] **Step 3: Implement the helper and integrate into home-service**

Add to `packages/server/src/lib/services/home-service.ts` — a new exported function near the top (before `getHomeDetail`):

```ts
export async function getLatestCompletedAnalysis(userId: string) {
  const order = await prisma.order.findFirst({
    where: { userId, status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    select: {
      id: true,
      name: true,
      completedAt: true,
    },
  });

  if (!order || !order.completedAt) return null;

  // All counts derived from completed-result evidence, not raw order config:

  // contributorCount: distinct emails from completed ALL_TIME metrics
  // (not raw selectedDevelopers which includes excluded candidates)
  const metricRows = await prisma.orderMetric.findMany({
    where: { orderId: order.id, periodType: 'ALL_TIME' },
    select: { developerEmail: true },
  });
  const distinctContributors = new Set(metricRows.map((r) => r.developerEmail));

  // commitCount: actual analyzed commits from base analysis rows only
  // (jobId: null excludes benchmark runs which create additional CommitAnalysis rows)
  const baseWhere = { orderId: order.id, jobId: null };

  const commitCount = await prisma.commitAnalysis.count({
    where: baseWhere,
  });

  // repoCount: distinct repositories from base analysis rows only
  const repoRows = await prisma.commitAnalysis.findMany({
    where: baseWhere,
    select: { repository: true },
    distinct: ['repository'],
  });
  const repoCount = repoRows.length;

  return {
    id: order.id,
    name: order.name,
    completedAt: order.completedAt.toISOString(),
    repoCount,
    contributorCount: distinctContributors.size,
    commitCount,
  };
}
```

Then in `getHomeDetail`, after the existing parallel queries, add:

```ts
  const latestCompletedAnalysis = await getLatestCompletedAnalysis(workspace.ownerId);
```

And include it in the return object:

```ts
  return {
    workspaceStage,
    // ... existing fields ...
    latestCompletedAnalysis,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx vitest run src/lib/services/__tests__/home-service-latest-analysis.test.ts`

Expected: 2 tests PASS.

- [ ] **Step 5: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/lib/services/home-service.ts packages/server/src/lib/services/__tests__/home-service-latest-analysis.test.ts
git commit -m "feat: add latestCompletedAnalysis to home-service payload"
```

---

## Task 9: Dashboard — Latest Analysis Card

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Add latest analysis card to `FirstDataStage`**

In `dashboard/page.tsx`, in the `FirstDataStage` component (around line 97), add a card between the KPI grid (line 117) and the CTA buttons (line 119):

```tsx
      {data.latestCompletedAnalysis && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-center justify-between gap-4 pt-6">
            <div className="space-y-1">
              <p className="font-medium">{t('firstData.latestAnalysis.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('firstData.latestAnalysis.subtitle', {
                  repoCount: data.latestCompletedAnalysis.repoCount,
                  contributorCount: data.latestCompletedAnalysis.contributorCount,
                  commitCount: data.latestCompletedAnalysis.commitCount,
                })}
              </p>
            </div>
            <Link href={`/orders/${data.latestCompletedAnalysis.id}`}>
              <Button>{t('firstData.latestAnalysis.cta')}</Button>
            </Link>
          </CardContent>
        </Card>
      )}
```

- [ ] **Step 2: Add compact latest analysis to `OperationalStage`**

In the `OperationalStage` component, inside the highlights Card (around line 208), add after the freshness card block (around line 267):

```tsx
      {data.latestCompletedAnalysis && (
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {t('operational.latestAnalysis.label')}
          </span>
          <Link
            href={`/orders/${data.latestCompletedAnalysis.id}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            {data.latestCompletedAnalysis.name}
          </Link>
        </div>
      )}
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx
git commit -m "feat: add latest analysis return path to Home (first_data + operational)"
```

---

## Task 10: Insert AnalysisReturnBanner into People and Repositories Pages

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/people/page.tsx`
- Modify: `packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx`

- [ ] **Step 1: Add banner to People page**

In `people/page.tsx`, add import at the top:

```tsx
import { AnalysisReturnBanner } from '@/components/analysis-return-banner';
```

Then insert `<AnalysisReturnBanner />` as the first element inside the main render container (before `PeopleSummaryStrip` or equivalent). Wrap in Suspense since it uses `useSearchParams`:

```tsx
import { Suspense } from 'react';

// Inside the component's return, at the very top of the content area:
<Suspense fallback={null}>
  <AnalysisReturnBanner />
</Suspense>
```

- [ ] **Step 2: Add banner to Repositories page**

Same pattern in `repositories/page.tsx`:

```tsx
import { AnalysisReturnBanner } from '@/components/analysis-return-banner';
import { Suspense } from 'react';

// Inside the component's return, at the very top of the content area:
<Suspense fallback={null}>
  <AnalysisReturnBanner />
</Suspense>
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/people/page.tsx packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx
git commit -m "feat: insert AnalysisReturnBanner into People and Repositories pages"
```

---

## Task 11: Orchestrator Refactor — Rewire `orders/[id]/page.tsx`

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`

This is the largest task. It replaces the COMPLETED rendering block (lines 1478-2006) with the 4 new section components while keeping all other status blocks (DRAFT, DEVELOPERS_LOADED, READY_FOR_ANALYSIS, PROCESSING, FAILED) intact.

- [ ] **Step 1: Add imports for new components**

At the top of `orders/[id]/page.tsx`, add:

```tsx
import { AnalysisResultsSummary } from '@/components/analysis-results-summary';
import { AnalysisHandoffCard } from '@/components/analysis-handoff-card';
import { AnalysisResultsOverview } from '@/components/analysis-results-overview';
import { AnalysisTechnicalPanel } from '@/components/analysis-technical-panel';
```

Remove imports that are now only used inside the extracted components (but verify each — some may still be needed for non-COMPLETED statuses):

Candidates to remove if only used in COMPLETED block:
- `BenchmarkLauncher` (only in COMPLETED)
- `BenchmarkMatrix` (only in COMPLETED)
- `PublishModal` (only in COMPLETED)
- `ShareLinkCard` (only in COMPLETED)
- `EditScopePanel` (only in COMPLETED)
- `EffortTimeline` (only in COMPLETED)
- `CommitAnalysisTable` (only in COMPLETED)

Keep: `PipelineLog`, `AnalysisEventLog`, `CommitProcessingTimeline` — used in PROCESSING block too.

- [ ] **Step 2: Compute completed-result counts for AnalysisResultsSummary**

Inside the component, after the existing metrics computation (around line 865-906), add summary count derivation:

```tsx
  // Completed-result counts (not raw extraction-era)
  const completedContributorCount = displayMetrics.length;
  const completedCommitCount = displayMetrics.reduce(
    (sum: number, m: GhostMetric) => sum + m.commitCount, 0
  );
  const completedRepoCount = Array.isArray(order.selectedRepos) ? order.selectedRepos.length : 0;
```

- [ ] **Step 3: Replace COMPLETED block**

Replace the entire COMPLETED rendering block (lines 1478-2006) with:

```tsx
      {order.status === 'COMPLETED' && !analysisStarted && (
        <div className="space-y-6">
          <AnalysisResultsSummary
            orderName={order.name}
            repoCount={completedRepoCount}
            contributorCount={completedContributorCount}
            commitCount={completedCommitCount}
            completedAt={order.completedAt}
            avgGhostPercent={avgGhost}
            totalWorkDays={totalWorkDays}
            ghostNormHours={effectiveGhostNorm}
            dateRangeLabel={(() => {
              const start = fmtDate(order.availableStartDate, dateLocale);
              const end = fmtDate(order.availableEndDate, dateLocale);
              return start && end ? t('detail.repoDateRange', { start, end }) : null;
            })()}
            scopeLabel={formatScopeDescription(order, t, dateLocale)}
            isPartialScope={order.analysisPeriodMode !== 'ALL_TIME'}
          />

          <AnalysisHandoffCard
            analysisId={id}
            workspaceStage={stageData?.workspaceStage ?? 'first_data'}
            topCanonicalRepoId={order.topCanonicalRepoId ?? null}
            unresolvedIdentityCount={identityHealth?.unresolvedCount ?? 0}
          />

          <AnalysisResultsOverview
            orderId={id}
            metrics={metrics}
            period={period}
            onPeriodChange={setPeriod}
            onShareChange={(email, share, auto) => shareMutation.mutate({ email, share, auto })}
            highlightedEmail={highlightedEmail}
          />

          <AnalysisTechnicalPanel
            orderId={id}
            order={order}
            workspaceStage={stageData?.workspaceStage ?? 'first_data'}
            isAdmin={isAdmin}
            progress={progress}
            jobEvents={jobEvents}
            pipelineLog={pipelineLog}
            benchmarkJobId={benchmarkJobId}
            benchmarkProgress={benchmarkProgress}
            benchmarkEvents={benchmarkEvents}
            benchmarkLog={benchmarkLog}
            benchmarkNow={benchmarkNow}
            onBenchmarkLaunched={(jobId) => {
              setBenchmarkJobId(jobId);
              setBenchmarkLog([]);
              benchmarkLogSinceRef.current = 0;
              setBenchmarkEvents([]);
              benchmarkEventCursorRef.current = null;
            }}
            onAnalyze={() => analyzeMutation.mutate()}
            analyzeIsPending={analyzeMutation.isPending}
            onCancelJob={(jobId) => cancelJobMutation.mutate(jobId)}
            cancelIsPending={cancelJobMutation.isPending}
            onScopeSubmit={handleScopeSubmit}
            scopeIsPending={scopeMutation.isPending}
            metrics={displayMetrics}
            shareToken={shareToken}
            onShareTokenChange={setShareToken}
          />
        </div>
      )}
```

- [ ] **Step 4: Remove dead code**

Remove state variables, local helper functions, and imports that are now only used inside extracted components. Check each removal carefully — some state like `benchmarkJobId`, `benchmarkLog`, `benchmarkEvents` may still be managed in the orchestrator and passed as props.

State that **stays in orchestrator** (passed as props): `benchmarkJobId`, `benchmarkLog`, `benchmarkEvents`, `benchmarkProgress`, `benchmarkNow`, `shareToken`, `pipelineLog`, `jobEvents`.

State that **moves into components**: `publishRepo` (→ `AnalysisTechnicalPanel`), `showEditScope` (→ `AnalysisTechnicalPanel`), `showCompletedLog` (→ `AnalysisTechnicalPanel`), `activeTab` (→ `AnalysisResultsOverview`), `ghostNormMode` (→ `AnalysisResultsOverview`).

- [ ] **Step 5: Typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: no errors.

- [ ] **Step 6: Visual verification**

Run: `cd packages/server && timeout 15 npx next dev 2>&1 | tail -5`

Navigate to a completed analysis at `http://localhost:3000/orders/{id}` and verify:
1. Summary section appears first (title, KPI cards, scope badge).
2. Handoff card appears next.
3. Overview tabs (distribution, developer table) are visible.
4. Technical details collapsed at bottom (for first_data stage).
5. Non-COMPLETED statuses (DRAFT, PROCESSING, FAILED) are unaffected.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx
git commit -m "refactor: rewire orders/[id] COMPLETED block to use section components"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`

Expected: 0 errors.

- [ ] **Step 2: Run all tests**

Run: `cd packages/server && npx vitest run`

Expected: all pass, including new tests.

- [ ] **Step 3: Run linter**

Run: `cd packages/server && npx eslint src/components/analysis-results-summary.tsx src/components/analysis-handoff-card.tsx src/components/analysis-results-overview.tsx src/components/analysis-technical-panel.tsx src/components/analysis-return-banner.tsx --no-error-on-unmatched-pattern`

Expected: no errors or only pre-existing warnings.

- [ ] **Step 4: Commit any fixes**

If typecheck/tests/lint revealed issues, fix and commit.

```bash
git add -A
git commit -m "fix: address typecheck/lint issues from analysis results landing"
```
