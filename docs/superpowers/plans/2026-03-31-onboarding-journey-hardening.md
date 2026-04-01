# Onboarding Journey Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four UX gaps so a new customer experiences a coherent guided journey from first analysis through first saved view.

**Architecture:** A lightweight `/api/v2/workspace-stage` endpoint (4 DB counts, no scope resolution) provides maturity + onboarding data to a thin client hook. Four independent UI changes consume that hook to gate chrome, add handoff CTAs, and surface save-view triggers. No new schema.

**Tech Stack:** Next.js App Router, React 19, TanStack Query, next-intl, shadcn/ui, Tailwind CSS

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/app/api/v2/workspace-stage/route.ts` | Lightweight API — 4 counts (team, repo, contributor, savedView), no scope resolution |
| Create | `src/hooks/use-workspace-stage.ts` | Client hook wrapping the new endpoint |
| Create | `src/__tests__/api/v2/workspace-stage.test.ts` | Unit test for workspace-stage API |
| Modify | `src/app/[locale]/(dashboard)/orders/[id]/page.tsx` | Add onboarding handoff card after completed analysis for first-run users |
| Modify | `src/components/layout/global-context-bar.tsx` | Hide on `empty`/`first_data` stages |
| Modify | `src/components/layout/sidebar.tsx` | De-emphasize Teams for early stages; de-emphasize Reports until first saved view |
| Modify | `src/app/[locale]/(dashboard)/repositories/page.tsx` | Add "Create team from repository" banner for first-team bootstrap |
| Modify | `src/app/[locale]/(dashboard)/dashboard/page.tsx` | Upgrade first-saved-view card visually + copy |
| Modify | `src/app/[locale]/(dashboard)/teams/[id]/page.tsx` | Add save-view prompt after first-team onboarding banner |
| Modify | `src/app/[locale]/(dashboard)/repositories/[id]/components/create-team-from-repository-dialog.tsx` | Invalidate `workspace-stage` on team creation |
| Modify | `src/app/[locale]/(dashboard)/teams/components/create-team-dialog.tsx` | Invalidate `workspace-stage` on team creation |
| Modify | `src/components/layout/save-view-dialog.tsx` | Invalidate `workspace-stage` on saved view creation |
| Modify | `messages/en.json` | English i18n keys for new UI copy |
| Modify | `messages/ru.json` | Russian i18n keys for new UI copy |

---

### Task 1: Create `/api/v2/workspace-stage` endpoint + `useWorkspaceStage` hook

The sidebar, context bar, and several pages need workspace maturity. The existing `/api/v2/home` is too heavy (scope resolution, commit aggregation, top-lists). Create a dedicated lightweight endpoint that runs 4 `COUNT(*)` queries in parallel.

**Files:**
- Create: `packages/server/src/app/api/v2/workspace-stage/route.ts`
- Create: `packages/server/src/hooks/use-workspace-stage.ts`

- [ ] **Step 1: Create the API route**

```typescript
// packages/server/src/app/api/v2/workspace-stage/route.ts
import { apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { buildSavedViewReadableWhere } from '@/lib/saved-view-access';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';

export async function GET() {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);
  const workspaceId = workspace.id;

  const [teamCount, repoCount, contributorCount, savedViewCount] = await Promise.all([
    prisma.team.count({ where: { workspaceId } }),
    prisma.repository.count({ where: { workspaceId } }),
    prisma.contributor.count({ where: { workspaceId } }),
    prisma.savedView.count({
      where: {
        ...buildSavedViewReadableWhere(workspaceId, session.user.id),
        isArchived: false,
      },
    }),
  ]);

  const workspaceStage: 'empty' | 'first_data' | 'operational' =
    teamCount > 0 ? 'operational' :
    (repoCount > 0 && contributorCount > 0) ? 'first_data' :
    'empty';

  return apiResponse({
    workspaceStage,
    onboarding: {
      needsFirstSavedView: teamCount > 0 && savedViewCount === 0,
      savedViewCount,
    },
  });
}
```

- [ ] **Step 2: Create the client hook**

```typescript
// packages/server/src/hooks/use-workspace-stage.ts
import { useQuery } from '@tanstack/react-query';

export type WorkspaceStage = 'empty' | 'first_data' | 'operational';

interface WorkspaceStageData {
  workspaceStage: WorkspaceStage;
  onboarding: {
    needsFirstSavedView: boolean;
    savedViewCount: number;
  };
}

export function useWorkspaceStage() {
  return useQuery<WorkspaceStageData>({
    queryKey: ['workspace-stage'],
    queryFn: async () => {
      const res = await fetch('/api/v2/workspace-stage');
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/api/v2/workspace-stage/route.ts packages/server/src/hooks/use-workspace-stage.ts
git commit -m "feat(onboarding): add lightweight /api/v2/workspace-stage endpoint and useWorkspaceStage hook"
```

---

### Task 2: Analysis results — onboarding handoff card

After a first-run customer completes their first analysis, the results screen should provide explicit next steps: Review Contributors, Check Repositories, Create First Team. This card is only shown when `workspaceStage === 'first_data'` (repos + contributors exist but no team yet).

**Important:** `order.selectedRepos` stores a legacy GitHub snapshot with `full_name` but NO canonical `repositoryId`. The "Create first team" CTA must link to `/repositories` (which will have its own bootstrap banner in Task 5), NOT to a specific repository detail page.

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

- [ ] **Step 1: Add i18n keys for the onboarding handoff card**

In `messages/en.json`, inside the `orders` object, add:

```json
"onboardingHandoff": {
  "title": "What's next?",
  "description": "Your analysis is complete. Here's what to do with the results:",
  "peopleCta": "Review contributors",
  "repositoriesCta": "Check repositories",
  "teamCta": "Create first team from repository"
}
```

In `messages/ru.json`, inside the `orders` object, add:

```json
"onboardingHandoff": {
  "title": "Что дальше?",
  "description": "Анализ завершён. Вот что делать с результатами:",
  "peopleCta": "Проверить контрибьюторов",
  "repositoriesCta": "Посмотреть репозитории",
  "teamCta": "Создать первую команду из репозитория"
}
```

- [ ] **Step 2: Import hook and add the handoff card to the COMPLETED section**

In `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`:

Add import at the top (alongside existing imports):

```typescript
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
```

Add `FolderGit2` and `UsersRound` to the existing lucide-react import block (they are NOT currently imported in this file):

```typescript
// Add to the existing lucide-react import destructuring:
  FolderGit2,
  UsersRound,
```

Inside the `OrderPage` component, after `const t = useTranslations('orders');` (line ~314), add:

```typescript
const { data: stageData } = useWorkspaceStage();
const isFirstRun = stageData?.workspaceStage === 'first_data';
```

Then, inside the `{order.status === 'COMPLETED' && !analysisStarted && ( ... )}` block (line ~1687), immediately after the opening `<>` fragment and before the existing `<div className="flex items-center justify-between">`, add:

```tsx
{isFirstRun && (
  <Card className="border-primary/20 bg-primary/5">
    <CardContent className="pt-6">
      <div className="space-y-3">
        <div>
          <p className="font-medium">{t('onboardingHandoff.title')}</p>
          <p className="text-sm text-muted-foreground">{t('onboardingHandoff.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/people">
            <Button variant="default" size="sm">
              <Users className="h-4 w-4 mr-2" />
              {t('onboardingHandoff.peopleCta')}
            </Button>
          </Link>
          <Link href="/repositories">
            <Button variant="outline" size="sm">
              <FolderGit2 className="h-4 w-4 mr-2" />
              {t('onboardingHandoff.repositoriesCta')}
            </Button>
          </Link>
          <Link href="/repositories">
            <Button variant="outline" size="sm">
              <UsersRound className="h-4 w-4 mr-2" />
              {t('onboardingHandoff.teamCta')}
            </Button>
          </Link>
        </div>
      </div>
    </CardContent>
  </Card>
)}
```

Note: all three CTAs use existing imports (`Users` already imported, `FolderGit2` and `UsersRound` added above). The "team" CTA links to `/repositories` where the bootstrap banner (Task 5) will guide the user to pick a repo.

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat(onboarding): add next-step handoff card on completed analysis for first-run users"
```

---

### Task 3: Early-stage chrome simplification — hide GlobalContextBar

The GlobalContextBar (scope selector, date range, save view) is confusing for users in `empty` and `first_data` stages. Hide it entirely for those stages.

**Loading-safe default:** `stageData` is `undefined` during the initial fetch. We treat undefined as "show chrome" (i.e. `isEarlyStage = false` when data hasn't loaded). This avoids regressing mature users who would see a brief flash of missing chrome on every page load. New users may see a sub-second flash of the context bar on their very first visit before the query resolves; this is acceptable for this slice. After the first fetch, `staleTime: 5min` ensures the cached value is used for subsequent navigations.

**Files:**
- Modify: `packages/server/src/components/layout/global-context-bar.tsx`

- [ ] **Step 1: Add stage-aware early return**

In `global-context-bar.tsx`, add the import:

```typescript
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
```

Inside the `GlobalContextBar` component, after the existing `const isAnalyticalPath = ...` line, add:

```typescript
// undefined = data not yet loaded → default to showing chrome (avoids regressing mature users)
const { data: stageData } = useWorkspaceStage();
const isEarlyStage = stageData?.workspaceStage === 'empty' || stageData?.workspaceStage === 'first_data';
```

Then modify the existing early return. The current code is:

```typescript
if (!isAnalyticalPath) {
  return null;
}
```

Change it to:

```typescript
if (!isAnalyticalPath || isEarlyStage) {
  return null;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/components/layout/global-context-bar.tsx
git commit -m "feat(onboarding): hide GlobalContextBar for empty and first_data stages"
```

---

### Task 4: Early-stage chrome simplification — de-emphasize sidebar items

Two separate dimming rules per the spec:
- **Teams**: dimmed on `empty` and `first_data` (no teams exist yet, concept is premature)
- **Reports**: dimmed when `savedViewCount === 0` regardless of stage (Reports is not meaningful until the user has at least one saved view — this covers the gap where stage is already `operational` after first team but zero saved views exist)

Both remain clickable but don't compete for attention.

**Files:**
- Modify: `packages/server/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Add stage-aware dimming logic**

In `sidebar.tsx`, add the import:

```typescript
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
```

Inside the `Sidebar` component, after the existing `const isAdmin = ...` line, add:

```typescript
// undefined stageData = not yet loaded → default to no dimming (avoids regressing mature users)
const { data: stageData } = useWorkspaceStage();
const isEarlyStage = stageData?.workspaceStage === 'empty' || stageData?.workspaceStage === 'first_data';
const noSavedViews = stageData ? stageData.onboarding.savedViewCount === 0 : false;
const deemphasizedKeys = new Set<string>();
if (isEarlyStage) deemphasizedKeys.add('teams');
if (isEarlyStage || noSavedViews) deemphasizedKeys.add('reports');
```

Then in the `primaryNavigation` JSX, inside the `navigation.map(...)` callback, after the existing `const isActive = ...` and `const itemHref = ...` lines, add:

```typescript
const isDimmed = deemphasizedKeys.has(item.nameKey);
```

And modify the Link's className to include dimming. The current code:

```tsx
<Link
  href={itemHref}
  className={cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  )}
>
```

Change to:

```tsx
<Link
  href={itemHref}
  className={cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
    isDimmed && !isActive && 'opacity-40',
  )}
>
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/components/layout/sidebar.tsx
git commit -m "feat(onboarding): de-emphasize Teams and Reports in sidebar based on maturity invariants"
```

---

### Task 5: Repository list — first-team bootstrap discoverability

On the repositories list page, when the workspace is in `first_data` stage (no teams yet), add a prominent contextual banner encouraging the user to pick any repository below to create their first team. The banner does NOT link to a specific repo — instead it highlights the concept and the user clicks any repository row to reach the detail page which already has "Create Team from Repository" dialog. This avoids the problem of selecting an arbitrary or wrong repo from the current paginated/filtered slice.

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx`
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

- [ ] **Step 1: Add i18n keys**

In `messages/en.json`, inside the `repositories` object, add:

```json
"firstTeamBanner": {
  "title": "Ready to create your first team?",
  "description": "Open a repository you know well and use \"Create Team from Repository\" to bootstrap your first team from its contributors."
}
```

In `messages/ru.json`, inside the `repositories` object, add:

```json
"firstTeamBanner": {
  "title": "Готовы создать первую команду?",
  "description": "Откройте знакомый репозиторий и нажмите «Создать команду из репозитория», чтобы собрать первую команду из его контрибьюторов."
}
```

- [ ] **Step 2: Add the banner to the repository list page**

In `packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx`:

Add imports:

```typescript
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
import { Card, CardContent } from '@/components/ui/card';
import { UsersRound } from 'lucide-react';
```

Note: `Button` is already imported. No `Link` needed since the banner does not link to a specific target.

Inside the `RepositoriesPage` component, after the existing query hooks, add:

```typescript
const { data: stageData } = useWorkspaceStage();
const showFirstTeamBanner = stageData?.workspaceStage === 'first_data';
```

In the JSX, after the `<RepositorySummaryStrip ... />` and before `<RepositoryFilters ... />`, add:

```tsx
{showFirstTeamBanner && (
  <Card className="border-primary/20 bg-primary/5">
    <CardContent className="flex items-center gap-4 pt-6">
      <UsersRound className="h-6 w-6 shrink-0 text-primary" />
      <div className="space-y-1">
        <p className="font-medium">{t('firstTeamBanner.title')}</p>
        <p className="text-sm text-muted-foreground">{t('firstTeamBanner.description')}</p>
      </div>
    </CardContent>
  </Card>
)}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat(onboarding): add first-team bootstrap banner on repository list"
```

---

### Task 6: Invalidate `workspace-stage` cache after stage-changing mutations

The `useWorkspaceStage` hook caches for 5 minutes. Three existing mutations change the workspace stage or onboarding invariants and must invalidate `['workspace-stage']` so the UI updates immediately:

1. **First team via repo bootstrap** — `create-team-from-repository-dialog.tsx` `onSuccess`
2. **Manual team creation** — `create-team-dialog.tsx` `onSuccess`
3. **First saved view creation** — `save-view-dialog.tsx` `onSuccess`

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/repositories/[id]/components/create-team-from-repository-dialog.tsx`
- Modify: `packages/server/src/app/[locale]/(dashboard)/teams/components/create-team-dialog.tsx`
- Modify: `packages/server/src/components/layout/save-view-dialog.tsx`

- [ ] **Step 1: Add invalidation to create-team-from-repository-dialog.tsx**

In the file's mutation `onSuccess` handler, add:

```typescript
queryClient.invalidateQueries({ queryKey: ['workspace-stage'] });
```

alongside the existing invalidations. If `queryClient` is not already obtained via `useQueryClient()`, add it.

- [ ] **Step 2: Add invalidation to create-team-dialog.tsx**

Same pattern — in the mutation `onSuccess`, add:

```typescript
queryClient.invalidateQueries({ queryKey: ['workspace-stage'] });
```

- [ ] **Step 3: Add invalidation to save-view-dialog.tsx**

In the mutation `onSuccess` (which already invalidates `['saved-views']` and `['scope-saved-views']`), add:

```typescript
queryClient.invalidateQueries({ queryKey: ['workspace-stage'] });
```

- [ ] **Step 4: Verify typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/repositories/[id]/components/create-team-from-repository-dialog.tsx packages/server/src/app/[locale]/(dashboard)/teams/components/create-team-dialog.tsx packages/server/src/components/layout/save-view-dialog.tsx
git commit -m "feat(onboarding): invalidate workspace-stage cache after team and saved-view mutations"
```

---

### Task 7: Stronger first-saved-view handoff

Two changes:
1. On the **team detail page**, when `onboarding=first-team` is present and no saved views exist, add an explicit "Save View" prompt with a direct SaveViewDialog trigger. The team detail page is the correct place for direct save because the scope is already team-scoped.
2. On the **operational Home page**, upgrade the passive card visually and update copy, but keep the action as "Open team" (navigating to team detail). Home's default scope is `all_teams`, so opening SaveViewDialog here would save a generic scope instead of the intended first meaningful team scope.

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/page.tsx`
- Modify: `packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx`
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

- [ ] **Step 1: Add i18n keys**

In `messages/en.json`, inside the `teamDetail.onboarding` object, add these keys:

```json
"saveViewTitle": "Save this as your first report",
"saveViewDescription": "Choose a useful date range in the scope bar above, then save this view so you can return to it anytime.",
"saveViewCta": "Save View"
```

In `messages/ru.json`, inside the `teamDetail.onboarding` object, add:

```json
"saveViewTitle": "Сохраните это как первый отчёт",
"saveViewDescription": "Выберите полезный диапазон дат в панели scope, затем сохраните — чтобы возвращаться к этому виду.",
"saveViewCta": "Сохранить отчёт"
```

Update the `home.operational.firstSavedView` keys in `en.json`:

```json
"title": "Save your first reusable view",
"description": "Open your team, choose a useful date range, and save it as a report you can reopen anytime.",
"openTeam": "Open team and save view"
```

And in `ru.json`:

```json
"title": "Сохраните первый отчёт",
"description": "Откройте команду, выберите диапазон дат и сохраните scope как отчёт, к которому можно вернуться.",
"openTeam": "Открыть команду и сохранить"
```

- [ ] **Step 2: Add save-view prompt to team detail page**

In `packages/server/src/app/[locale]/(dashboard)/teams/[id]/page.tsx`:

Add imports:

```typescript
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
import { SaveViewDialog } from '@/components/layout/save-view-dialog';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { Save } from 'lucide-react';
```

Inside the component, after the existing `const isFirstTeamOnboarding = ...` line, add:

```typescript
const { data: stageData } = useWorkspaceStage();
const showSaveViewPrompt = isFirstTeamOnboarding && stageData?.onboarding?.needsFirstSavedView;
const [saveDialogOpen, setSaveDialogOpen] = useState(false);

const activeScopePayload = useMemo(() => {
  const raw = activeScopeQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  const scope = raw.success ? raw.data : {
    scopeKind: 'team' as const,
    scopeId: id,
    from: undefined,
    to: undefined,
    repositoryIds: [] as string[],
    contributorIds: [] as string[],
  };
  return {
    scopeKind: scope.scopeKind || ('team' as const),
    scopeId: scope.scopeId || id,
    from: scope.from,
    to: scope.to,
    repositoryIds: scope.repositoryIds,
    contributorIds: scope.contributorIds,
  };
}, [searchParams, id]);
```

Then in the JSX, right after the existing onboarding banner `{isFirstTeamOnboarding && ( <Card>...</Card> )}`, add:

```tsx
{showSaveViewPrompt && (
  <>
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="flex flex-col gap-3 pt-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <p className="font-medium">{t('onboarding.saveViewTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('onboarding.saveViewDescription')}</p>
        </div>
        <Button onClick={() => setSaveDialogOpen(true)}>
          <Save className="h-4 w-4 mr-2" />
          {t('onboarding.saveViewCta')}
        </Button>
      </CardContent>
    </Card>
    <SaveViewDialog
      open={saveDialogOpen}
      onOpenChange={setSaveDialogOpen}
      activeScope={activeScopePayload}
    />
  </>
)}
```

- [ ] **Step 3: Upgrade Home operational first-saved-view card (visual only)**

In `packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx`, in the `OperationalStage` function, upgrade the existing `needsFirstSavedView` card with visual prominence. No SaveViewDialog here — the action stays as "Open team" which navigates to team detail where the direct save trigger lives.

Find the existing card:

```tsx
{data.onboarding?.needsFirstSavedView && (
  <Card>
    <CardContent className="flex flex-col gap-4 pt-6 lg:flex-row lg:items-center lg:justify-between">
```

Replace `<Card>` with `<Card className="border-primary/20 bg-primary/5">`:

```tsx
{data.onboarding?.needsFirstSavedView && (
  <Card className="border-primary/20 bg-primary/5">
    <CardContent className="flex flex-col gap-4 pt-6 lg:flex-row lg:items-center lg:justify-between">
```

The i18n key updates from Step 1 will update the copy automatically. No other code changes needed on Home.

- [ ] **Step 4: Verify typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/[locale]/(dashboard)/teams/[id]/page.tsx packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat(onboarding): add direct SaveViewDialog on team detail, upgrade Home card visually"
```

---

### Task 8: Tests for workspace-stage API

The spec requires test coverage for new stage logic. Add a unit test for the `/api/v2/workspace-stage` endpoint covering all three stage transitions and the `needsFirstSavedView` flag.

**Files:**
- Create: `packages/server/src/__tests__/api/v2/workspace-stage.test.ts`

- [ ] **Step 1: Check existing test patterns**

Read existing v2 API tests to understand the project's test setup (mocking Prisma, auth, etc.):

Use the Glob tool with pattern `packages/server/src/__tests__/**/*.test.ts` to find existing tests. Read one of them to understand the mocking/assertion patterns used in the project.

- [ ] **Step 2: Write the test**

Create `packages/server/src/__tests__/api/v2/workspace-stage.test.ts` following the project's existing test patterns. The test should:

1. Mock `requireUserSession` to return a valid session
2. Mock `ensureWorkspaceForUser` to return a workspace with a known ID
3. Mock `prisma.team.count`, `prisma.repository.count`, `prisma.contributor.count`, `prisma.savedView.count`
4. Test three scenarios:
   - **empty**: all counts 0 → `workspaceStage: 'empty'`, `needsFirstSavedView: false`
   - **first_data**: repoCount=1, contributorCount=1, teamCount=0 → `workspaceStage: 'first_data'`, `needsFirstSavedView: false`
   - **operational with no saved views**: teamCount=1, repoCount=1, contributorCount=1, savedViewCount=0 → `workspaceStage: 'operational'`, `needsFirstSavedView: true`
   - **operational with saved views**: teamCount=1, savedViewCount=1 → `workspaceStage: 'operational'`, `needsFirstSavedView: false`

Adapt to the project's test infrastructure (vitest, mocking patterns) as discovered in Step 1.

- [ ] **Step 3: Run the test**

Run: `cd packages/server && pnpm test -- --run src/__tests__/api/v2/workspace-stage.test.ts`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/__tests__/api/v2/workspace-stage.test.ts
git commit -m "test(onboarding): add unit tests for /api/v2/workspace-stage endpoint"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `cd packages/server && npx tsc --noEmit --pretty`
Expected: no errors

- [ ] **Step 2: Run lint**

Run: `cd packages/server && pnpm lint`
Expected: no errors (or only pre-existing warnings)

- [ ] **Step 3: Run tests**

Run: `cd packages/server && pnpm test -- --run`
Expected: all tests pass

- [ ] **Step 4: Verify build**

Run: `cd packages/server && pnpm build`
Expected: build succeeds (may take a few minutes)

- [ ] **Step 5: Final commit if any lint fixes needed**

```bash
git add -A
git commit -m "chore: lint fixes for onboarding hardening"
```
