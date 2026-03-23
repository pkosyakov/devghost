# UX Audit Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 10 verified UX issues across 4 phases: admin auth bug, full i18n, dashboard metrics, and UI polish.

**Architecture:** Layered approach — critical auth fix first, then i18n sweep across all pages, then dashboard data enrichment, then visual polish. Each phase is a separate commit.

**Tech Stack:** Next.js 16.1 (App Router), next-intl 4.8.3, NextAuth v5, Prisma, Tailwind CSS, shadcn/ui, Recharts

---

## Phase 1: Critical Bugs

### Task 1: Fix admin auth in proxy — JWT callbacks in auth.config.ts

**Files:**
- Modify: `packages/server/src/lib/auth.config.ts`

**Step 1: Add JWT and session callbacks to auth.config.ts**

Replace the entire file content:

```typescript
import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/login',
    newUser: '/register',
  },
  callbacks: {
    jwt({ token, user }) {
      // On login, copy role from user (DB) into JWT token
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role ?? 'USER';
      }
      return token;
    },
    session({ session, token }) {
      // Propagate id and role from JWT into session
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role;
      }
      return session;
    },
    authorized() {
      return true;
    },
  },
  providers: [], // Providers are added in auth.ts
} satisfies NextAuthConfig;
```

**Step 2: Verify auth.ts still overrides correctly**

`auth.ts` spreads `...authConfig.callbacks` and then defines its own `jwt` and `session`. Since spread comes first and own definitions come second, auth.ts callbacks override the base ones. No change needed in auth.ts.

**Step 3: Test admin route access**

Run dev server, navigate to `/ru/admin`. Should render admin page instead of redirecting to dashboard.

```bash
cd packages/server && pnpm dev
# In another terminal:
curl -s -o /dev/null -w "%{http_code}" --cookie "<session-cookie>" http://localhost:3000/ru/admin
# Expected: 200
```

### Task 2: Differentiate admin sidebar labels in i18n

**Files:**
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

**Step 1: Update admin sidebar keys in en.json**

Change `layout.sidebar.admin.billing` and `layout.sidebar.admin.settings`:

```json
"admin": {
  "overview": "Overview",
  "users": "Users",
  "allOrders": "All Orders",
  "publications": "Publications",
  "promoCodes": "Promo Codes",
  "billing": "Billing Stats",
  "monitoring": "Monitoring",
  "auditLog": "Audit Log",
  "settings": "LLM Settings"
}
```

**Step 2: Update admin sidebar keys in ru.json**

```json
"admin": {
  "overview": "Обзор",
  "users": "Пользователи",
  "allOrders": "Все заказы",
  "publications": "Публикации",
  "promoCodes": "Промокоды",
  "billing": "Статистика биллинга",
  "monitoring": "Мониторинг",
  "auditLog": "Журнал аудита",
  "settings": "Настройки LLM"
}
```

### Task 3: Commit Phase 1

```bash
cd /c/Projects/devghost
git add packages/server/src/lib/auth.config.ts packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "fix(auth): propagate role in edge JWT + differentiate admin sidebar labels"
```

---

## Phase 2: Full i18n

### Task 4: Add all new i18n keys to en.json

**Files:**
- Modify: `packages/server/messages/en.json`

**Step 1: Add all new namespace keys**

Append after the existing `"ghost"` block. New top-level keys to add:

```json
"dashboard": {
  "title": "Dashboard",
  "description": "Overview of your code analysis",
  "newAnalysis": "New Analysis",
  "stats": {
    "totalOrders": "Total Orders",
    "totalOrdersSub": "{count} completed",
    "repositories": "Repositories",
    "repositoriesSub": "Analyzed across all orders",
    "developers": "Developers",
    "developersSub": "Unique contributors found",
    "avgGhost": "Avg Ghost %",
    "avgGhostSub": "Across all analyses"
  },
  "recentOrders": {
    "title": "Recent Orders",
    "description": "Your latest code analyses",
    "viewAll": "View All",
    "ghost": "Ghost {percent}%"
  },
  "getStarted": {
    "title": "Get Started",
    "description": "Create your first code analysis to get developer productivity metrics",
    "step1": "Select repositories from your GitHub account",
    "step2": "Run AI-powered effort analysis",
    "step3": "Review Ghost % productivity metrics",
    "cta": "Create First Analysis"
  }
},
"orders": {
  "title": "Orders",
  "description": "Manage your code analysis orders",
  "newAnalysis": "New Analysis",
  "noOrders": "No analyses yet",
  "noOrdersDescription": "Create your first code analysis to get developer productivity metrics",
  "createAnalysis": "Create Analysis",
  "repos": "{count} repos",
  "developers": "{count} developers",
  "commits": "{count} commits",
  "effort": "{hours}h effort",
  "analyzed": "{count} analyzed",
  "created": "Created {date}",
  "deleteConfirm": "Are you sure you want to delete this analysis?",
  "detail": {
    "back": "Back",
    "analysisCost": "Analysis cost: {cost} ({tokens} tokens, {calls} calls, {model})",
    "pipelineLog": "Pipeline Log ({count} entries)",
    "overview": "Overview",
    "commits": "Commits",
    "benchmark": "Benchmark",
    "effortTimeline": "Effort Timeline",
    "publish": "Publish",
    "editScope": "Edit Scope",
    "reAnalyze": "Re-analyze",
    "periodAllTime": "All Time",
    "ghostDistribution": "Ghost % Distribution",
    "bubbleChart": "Bubble",
    "stripChart": "Strip",
    "heatmap": "Heatmap"
  },
  "metrics": {
    "developer": "Developer",
    "commits": "Commits",
    "workDays": "Work Days",
    "effort": "Effort (h)",
    "avgDaily": "Avg/day (h)",
    "overhead": "Overhead (h)",
    "share": "Share",
    "ghost": "Ghost %"
  },
  "commitsTab": {
    "commits": "Commits",
    "totalEffort": "Total Effort",
    "avgEffort": "Avg Effort",
    "confidence": "Confidence",
    "additions": "Additions",
    "deletions": "Deletions",
    "filters": "Filters",
    "allCategories": "All Categories",
    "allComplexity": "All Complexity",
    "sort": "Sort",
    "date": "Date",
    "descending": "Descending",
    "ascending": "Ascending",
    "commit": "Commit",
    "author": "Author",
    "category": "Category",
    "complexity": "Complexity",
    "changes": "Changes",
    "effortCol": "Effort",
    "confidenceCol": "Confidence",
    "dateCol": "Date"
  },
  "new": {
    "title": "New Analysis",
    "description": "Select repositories to analyze",
    "analysisName": "Analysis Name",
    "analysisNameHint": "Auto-generated from repos if empty",
    "selectRepos": "Select Repositories",
    "selectReposDescription": "Choose the repositories you want to analyze",
    "myRepos": "My Repositories",
    "publicRepo": "Public Repository",
    "explore": "Explore",
    "searchRepos": "Search repositories..."
  }
},
"billing": {
  "title": "Billing",
  "description": "Manage your credits, subscriptions, and payment methods",
  "creditBalance": "Credit Balance",
  "creditBalanceDescription": "Your current credit balance breakdown",
  "permanent": "Permanent",
  "subscription": "Subscription",
  "reserved": "Reserved",
  "available": "Available",
  "subscriptionSection": "Subscription",
  "noSubscription": "No active subscription. Subscribe below to get monthly credits at a discount.",
  "creditPacks": "Credit Packs",
  "creditPacksDescription": "One-time purchases. Credits never expire.",
  "noPacks": "No credit packs available at the moment.",
  "subscriptionPlans": "Subscription Plans",
  "subscriptionPlansDescription": "Monthly subscriptions with bonus credits. Cancel anytime.",
  "noPlans": "No subscription plans available at the moment.",
  "promoCode": "Promo Code",
  "promoCodeDescription": "Have a promo code? Redeem it for free credits.",
  "freeMode": "Free Mode",
  "freeModeDescription": "All analyses are free — no credits required.",
  "comingSoon": "Credit packs coming soon."
},
"settings": {
  "title": "Settings",
  "description": "Manage your account settings",
  "profile": "Profile",
  "profileDescription": "Your account information",
  "email": "Email",
  "displayName": "Display Name",
  "github": "GitHub",
  "githubDescription": "Connect your GitHub account to access repositories",
  "connected": "Connected",
  "disconnect": "Disconnect",
  "pipelineCache": "Pipeline Cache",
  "pipelineCacheDescription": "Cached git diffs and LLM responses used to speed up benchmark re-runs",
  "totalSize": "Total size (MB)",
  "repoClones": "Repo clones",
  "diffCache": "Diff cache",
  "llmCache": "LLM cache",
  "saveSettings": "Save Settings"
},
"publications": {
  "title": "Publications",
  "description": "Manage your published analytics. Share links with clients and colleagues.",
  "repository": "Repository",
  "order": "Order",
  "views": "Views",
  "active": "Active",
  "created": "Created",
  "actions": "Actions",
  "noPublications": "No publications yet. Publish an analysis from the order page."
},
"explore": {
  "title": "Explore",
  "description": "Discover developer productivity analytics for open source repositories.",
  "search": "Search repositories...",
  "noResults": "No published analyses yet.",
  "publishCta": "Publish your analysis",
  "publishCtaDescription": "Share your repository analytics with the community."
},
"kpi": {
  "avgGhost": "Avg Ghost %",
  "developers": "Developers",
  "commits": "Commits",
  "workDays": "Work Days",
  "singleDevWarning": "Single developer — Ghost % reflects absolute effort vs {norm}h/day norm, not relative productivity."
},
"components": {
  "periodSelector": {
    "day": "Day",
    "week": "Week",
    "month": "Month",
    "quarter": "Quarter",
    "year": "Year",
    "allTime": "All Time",
    "allDevelopers": "All developers ({count})"
  },
  "effortTimeline": {
    "avgProductivity": "Average Productivity (hours/day)"
  }
}
```

### Task 5: Add all new i18n keys to ru.json

**Files:**
- Modify: `packages/server/messages/ru.json`

**Step 1: Add matching Russian keys**

Same structure, translated values:

```json
"dashboard": {
  "title": "Дашборд",
  "description": "Обзор анализов кода",
  "newAnalysis": "Новый анализ",
  "stats": {
    "totalOrders": "Всего заказов",
    "totalOrdersSub": "{count} завершено",
    "repositories": "Репозитории",
    "repositoriesSub": "Проанализировано во всех заказах",
    "developers": "Разработчики",
    "developersSub": "Уникальных контрибьюторов",
    "avgGhost": "Средний Ghost %",
    "avgGhostSub": "По всем анализам"
  },
  "recentOrders": {
    "title": "Последние заказы",
    "description": "Ваши последние анализы кода",
    "viewAll": "Все заказы",
    "ghost": "Ghost {percent}%"
  },
  "getStarted": {
    "title": "Начало работы",
    "description": "Создайте первый анализ кода для получения метрик продуктивности",
    "step1": "Выберите репозитории из GitHub",
    "step2": "Запустите AI-анализ трудозатрат",
    "step3": "Изучите метрики Ghost %",
    "cta": "Создать первый анализ"
  }
},
"orders": {
  "title": "Заказы",
  "description": "Управление заказами на анализ кода",
  "newAnalysis": "Новый анализ",
  "noOrders": "Анализов пока нет",
  "noOrdersDescription": "Создайте первый анализ кода для получения метрик продуктивности",
  "createAnalysis": "Создать анализ",
  "repos": "{count} репоз.",
  "developers": "{count} разраб.",
  "commits": "{count} коммитов",
  "effort": "{hours}ч трудозатрат",
  "analyzed": "{count} проанализ.",
  "created": "Создан {date}",
  "deleteConfirm": "Вы уверены, что хотите удалить этот анализ?",
  "detail": {
    "back": "Назад",
    "analysisCost": "Стоимость анализа: {cost} ({tokens} токенов, {calls} вызовов, {model})",
    "pipelineLog": "Лог пайплайна ({count} записей)",
    "overview": "Обзор",
    "commits": "Коммиты",
    "benchmark": "Бенчмарк",
    "effortTimeline": "Таймлайн трудозатрат",
    "publish": "Опубликовать",
    "editScope": "Изменить скоуп",
    "reAnalyze": "Перезапустить",
    "periodAllTime": "За всё время",
    "ghostDistribution": "Распределение Ghost %",
    "bubbleChart": "Пузырьковый",
    "stripChart": "Полосовой",
    "heatmap": "Тепловая карта"
  },
  "metrics": {
    "developer": "Разработчик",
    "commits": "Коммиты",
    "workDays": "Раб. дни",
    "effort": "Трудозатр. (ч)",
    "avgDaily": "Средн./день (ч)",
    "overhead": "Оверхед (ч)",
    "share": "Доля",
    "ghost": "Ghost %"
  },
  "commitsTab": {
    "commits": "Коммиты",
    "totalEffort": "Всего трудозатрат",
    "avgEffort": "Средн. трудозатраты",
    "confidence": "Уверенность",
    "additions": "Добавлено",
    "deletions": "Удалено",
    "filters": "Фильтры",
    "allCategories": "Все категории",
    "allComplexity": "Любая сложность",
    "sort": "Сорт.",
    "date": "Дата",
    "descending": "По убыванию",
    "ascending": "По возрастанию",
    "commit": "Коммит",
    "author": "Автор",
    "category": "Категория",
    "complexity": "Сложность",
    "changes": "Изменения",
    "effortCol": "Трудозатраты",
    "confidenceCol": "Уверенность",
    "dateCol": "Дата"
  },
  "new": {
    "title": "Новый анализ",
    "description": "Выберите репозитории для анализа",
    "analysisName": "Название анализа",
    "analysisNameHint": "Генерируется автоматически из репозиториев",
    "selectRepos": "Выберите репозитории",
    "selectReposDescription": "Выберите репозитории для анализа",
    "myRepos": "Мои репозитории",
    "publicRepo": "Публичный репозиторий",
    "explore": "Обзор",
    "searchRepos": "Поиск репозиториев..."
  }
},
"billing": {
  "title": "Биллинг",
  "description": "Управление кредитами, подписками и способами оплаты",
  "creditBalance": "Баланс кредитов",
  "creditBalanceDescription": "Текущий баланс кредитов",
  "permanent": "Постоянные",
  "subscription": "Подписка",
  "reserved": "Зарезервировано",
  "available": "Доступно",
  "subscriptionSection": "Подписка",
  "noSubscription": "Нет активной подписки. Оформите подписку для ежемесячных кредитов со скидкой.",
  "creditPacks": "Пакеты кредитов",
  "creditPacksDescription": "Разовые покупки. Кредиты не истекают.",
  "noPacks": "Нет доступных пакетов кредитов.",
  "subscriptionPlans": "Планы подписки",
  "subscriptionPlansDescription": "Ежемесячные подписки с бонусными кредитами. Отмена в любое время.",
  "noPlans": "Нет доступных планов подписки.",
  "promoCode": "Промокод",
  "promoCodeDescription": "Есть промокод? Активируйте его для получения бесплатных кредитов.",
  "freeMode": "Бесплатный режим",
  "freeModeDescription": "Все анализы бесплатны — кредиты не требуются.",
  "comingSoon": "Пакеты кредитов скоро появятся."
},
"settings": {
  "title": "Настройки",
  "description": "Управление настройками аккаунта",
  "profile": "Профиль",
  "profileDescription": "Информация о вашем аккаунте",
  "email": "Email",
  "displayName": "Отображаемое имя",
  "github": "GitHub",
  "githubDescription": "Подключите GitHub для доступа к репозиториям",
  "connected": "Подключён",
  "disconnect": "Отключить",
  "pipelineCache": "Кэш пайплайна",
  "pipelineCacheDescription": "Кэшированные диффы и ответы LLM для ускорения бенчмарков",
  "totalSize": "Размер (МБ)",
  "repoClones": "Клоны репозиториев",
  "diffCache": "Кэш диффов",
  "llmCache": "Кэш LLM",
  "saveSettings": "Сохранить настройки"
},
"publications": {
  "title": "Публикации",
  "description": "Управление публикациями. Делитесь ссылками с клиентами и коллегами.",
  "repository": "Репозиторий",
  "order": "Заказ",
  "views": "Просмотры",
  "active": "Активна",
  "created": "Создана",
  "actions": "Действия",
  "noPublications": "Нет публикаций. Опубликуйте анализ со страницы заказа."
},
"explore": {
  "title": "Обзор",
  "description": "Аналитика продуктивности разработчиков в open source проектах.",
  "search": "Поиск репозиториев...",
  "noResults": "Опубликованных анализов пока нет.",
  "publishCta": "Опубликуйте свой анализ",
  "publishCtaDescription": "Поделитесь аналитикой репозитория с сообществом."
},
"kpi": {
  "avgGhost": "Средний Ghost %",
  "developers": "Разработчики",
  "commits": "Коммиты",
  "workDays": "Рабочие дни",
  "singleDevWarning": "Единственный разработчик — Ghost % отражает абсолютные трудозатраты к норме {norm}ч/день, а не относительную продуктивность."
},
"components": {
  "periodSelector": {
    "day": "День",
    "week": "Неделя",
    "month": "Месяц",
    "quarter": "Квартал",
    "year": "Год",
    "allTime": "За всё время",
    "allDevelopers": "Все разработчики ({count})"
  },
  "effortTimeline": {
    "avgProductivity": "Средняя продуктивность (часов/день)"
  }
}
```

### Task 6: Localize dashboard page

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx`

**Step 1: Add useTranslations hook**

Add `import { useTranslations } from 'next-intl';` to imports. Inside component: `const t = useTranslations('dashboard');`

**Step 2: Replace all hardcoded strings**

- `"Dashboard"` → `t('title')`
- `"Overview of your code analysis"` → `t('description')`
- `"New Analysis"` → `t('newAnalysis')`
- `"Total Orders"` → `t('stats.totalOrders')`
- `"{n} completed"` → `t('stats.totalOrdersSub', { count: stats.completedOrders })`
- `"Repositories"` → `t('stats.repositories')`
- `"Analyzed across all orders"` → `t('stats.repositoriesSub')`
- `"Developers"` → `t('stats.developers')`
- `"Unique contributors found"` → `t('stats.developersSub')`
- `"Completion Rate"` → `t('stats.avgGhost')` (card replacement in Phase 3)
- `"Recent Orders"` → `t('recentOrders.title')`
- `"Your latest code analyses"` → `t('recentOrders.description')`
- `"View All"` → `t('recentOrders.viewAll')`
- All "Get Started" strings → `t('getStarted.*')`

### Task 7: Localize orders list page

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/page.tsx`

**Step 1: Add useTranslations**

`const t = useTranslations('orders');` + `const tStatus = useTranslations('status');`

**Step 2: Replace hardcoded strings**

- Title/description → `t('title')`, `t('description')`
- Button labels → `t('newAnalysis')`, `t('createAnalysis')`
- Empty state → `t('noOrders')`, `t('noOrdersDescription')`
- Status labels in `statusConfig` → use `tStatus('COMPLETED')` etc.
- Metric labels → `t('repos', { count })`, `t('developers', { count })`, `t('commits', { count })`
- Delete confirm → `t('deleteConfirm')`

### Task 8: Localize orders detail, billing, settings, publications, explore pages

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx` — `useTranslations('orders.detail')` + `useTranslations('orders.metrics')` + `useTranslations('orders.commitsTab')`
- Modify: `packages/server/src/app/[locale]/(dashboard)/billing/page.tsx` — `useTranslations('billing')`
- Modify: `packages/server/src/app/[locale]/(dashboard)/settings/page.tsx` — `useTranslations('settings')`
- Modify: `packages/server/src/app/[locale]/(dashboard)/publications/page.tsx` — `useTranslations('publications')`
- Modify: `packages/server/src/app/[locale]/(public)/explore/page.tsx` — `getTranslations('explore')` (server component)

For each page: import translations hook, replace hardcoded English strings with `t('key')` calls. Follow the same pattern as Task 6-7.

### Task 9: Localize shared components

**Files:**
- Modify: `packages/server/src/components/ghost-developer-table.tsx` — `useTranslations('orders.metrics')` for column headers
- Modify: `packages/server/src/components/ghost-kpi-cards.tsx` — `useTranslations('kpi')`

### Task 10: Commit Phase 2

```bash
cd /c/Projects/devghost
git add packages/server/messages/ packages/server/src/app/ packages/server/src/components/
git commit -m "feat(i18n): complete localization of all app pages (EN/RU)"
```

---

## Phase 3: Dashboard Metrics

### Task 11: Replace Completion Rate with Avg Ghost% on dashboard

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx`

**Step 1: Update DashboardStats interface**

Add `avgGhostPercent: number | null;` to `DashboardStats`.

**Step 2: Calculate avgGhostPercent in fetchStats**

After fetching orders from `/api/orders`, compute:

```typescript
const completedWithMetrics = data.data.filter(
  (o: any) => o.status === 'COMPLETED' && o.metrics?.avgGhostPercent != null
);
const avgGhostPercent = completedWithMetrics.length > 0
  ? completedWithMetrics.reduce((sum: number, o: any) => sum + o.metrics.avgGhostPercent, 0) / completedWithMetrics.length
  : null;
```

**Step 3: Replace 4th stat card**

Replace Completion Rate card with Avg Ghost% card using color from `ghostColor()` imported from `@devghost/shared`. Show `Math.round(avgGhostPercent)%` or "—" if null.

### Task 12: Add Ghost% to Recent Orders section

**Step 1: Update recentOrders in DashboardStats**

Add `metrics: { avgGhostPercent: number; totalEffortHours: number; totalCommitsAnalyzed: number } | null` to the recentOrders items interface.

**Step 2: Show Ghost% badge next to status**

In the Recent Orders list, after the status badge, add:

```tsx
{order.metrics && (
  <span className={`text-sm font-medium ${getGhostColor(order.metrics.avgGhostPercent)}`}>
    Ghost {Math.round(order.metrics.avgGhostPercent * 10) / 10}%
  </span>
)}
```

Import `getGhostColor` (inline helper or from shared).

### Task 13: Commit Phase 3

```bash
cd /c/Projects/devghost
git add packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx
git commit -m "feat(dashboard): add avg Ghost% stat card + metrics in recent orders"
```

---

## Phase 4: UX Polish

### Task 14: Sticky developer table header

**Files:**
- Modify: `packages/server/src/components/ghost-developer-table.tsx`

**Step 1: Add sticky classes to TableHeader**

Change:
```tsx
<TableHeader>
```
to:
```tsx
<TableHeader className="sticky top-0 z-10 bg-background">
```

### Task 15: Single-developer warning in KPI cards

**Files:**
- Modify: `packages/server/src/components/ghost-kpi-cards.tsx`

**Step 1: Add developerCount check**

The component already receives `developerCount` prop. Add info icon + tooltip when `developerCount === 1`:

```tsx
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslations } from 'next-intl';
import { GHOST_NORM } from '@devghost/shared';
```

In the Ghost% card, after the percentage display, conditionally show:

```tsx
{developerCount === 1 && (
  <Tooltip>
    <TooltipTrigger>
      <Info className="h-4 w-4 text-muted-foreground" />
    </TooltipTrigger>
    <TooltipContent className="max-w-xs">
      <p>{t('singleDevWarning', { norm: GHOST_NORM })}</p>
    </TooltipContent>
  </Tooltip>
)}
```

### Task 16: Explore — empty state CTA + auth-aware header

**Files:**
- Modify: `packages/server/src/app/[locale]/(public)/explore/page.tsx`
- Modify: `packages/server/src/app/[locale]/(public)/layout.tsx`

**Step 1: Add publish CTA to explore page**

After `<ExploreGrid>`, add:

```tsx
<div className="text-center py-8 border-t mt-8">
  <h3 className="font-semibold mb-1">{t('publishCta')}</h3>
  <p className="text-muted-foreground text-sm mb-4">{t('publishCtaDescription')}</p>
  <Link href="/publications">
    <Button variant="outline">{t('publishCta')}</Button>
  </Link>
</div>
```

Add `getTranslations('explore')` and import `Button` + `Link`.

**Step 2: Auth-aware public header**

In `layout.tsx`, import `auth` from `@/lib/auth` and check session:

```tsx
const session = await auth();
```

Then conditionally render:

```tsx
{session?.user ? (
  <Link href="/dashboard" className="text-sm font-medium">{t('dashboard')}</Link>
) : (
  <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">{t('signIn')}</Link>
)}
```

Add `"dashboard": "Dashboard"` / `"Дашборд"` key to `layout.public` in both message files.

### Task 17: Billing — meaningful empty state

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/billing/page.tsx`

**Step 1: Check billing enabled**

Add fetch to `/api/billing/balance` — if it returns or if packs are empty AND plans are empty, show context-aware message.

Simplest approach: use env var check. Add API endpoint or pass via layout. Alternative: just check if `packs.length === 0 && plans.length === 0`:

```tsx
{packs.length === 0 && plans.length === 0 ? (
  <Card>
    <CardHeader>
      <CardTitle>{t('freeMode')}</CardTitle>
      <CardDescription>{t('freeModeDescription')}</CardDescription>
    </CardHeader>
  </Card>
) : (
  // existing packs/plans rendering
)}
```

### Task 18: Commit Phase 4

```bash
cd /c/Projects/devghost
git add packages/server/src/components/ packages/server/src/app/ packages/server/messages/
git commit -m "feat(ux): sticky table header, single-dev warning, explore CTA, billing empty state"
```

---

## Verification

### Task 19: Full smoke test

**Step 1: Run dev server**
```bash
cd packages/server && pnpm dev
```

**Step 2: Check each page in both locales**

Navigate through all pages in EN and RU:
- `/` and `/ru` — landing
- `/dashboard` and `/ru/dashboard` — stat cards, recent orders with Ghost%
- `/orders` and `/ru/orders` — list with metrics
- `/orders/{id}` — detail page, all tabs, sticky header on scroll
- `/billing` and `/ru/billing` — free mode message
- `/settings` and `/ru/settings`
- `/publications` and `/ru/publications`
- `/explore` and `/ru/explore` — CTA, auth-aware header
- `/admin` — should work for admin user

**Step 3: Run existing tests**
```bash
cd packages/server && pnpm test
```
