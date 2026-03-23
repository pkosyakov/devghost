# i18n Code Review Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 8 issues from i18n code review — hardcoded strings, missing plurals, type safety, locale-aware dates.

**Architecture:** Targeted fixes across 7 files + 2 JSON translation files. No new dependencies. Stripe types fixed by accessing `SubscriptionItem.current_period_start/end` (moved from `Subscription` in Stripe v20). Date locale via `date-fns/locale/ru` + `useLocale()`.

**Tech Stack:** next-intl, date-fns v4 (with locale support), Stripe SDK v20, TypeScript strict mode.

---

## Task 1: Localize ACTION_CATEGORIES in admin audit page

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/admin/audit/page.tsx:17-24, 83-87`
- Modify: `packages/server/messages/en.json` (add keys under `admin.audit`)
- Modify: `packages/server/messages/ru.json` (add keys under `admin.audit`)

**Step 1: Add translation keys to JSON files**

In `en.json`, under `admin.audit`, add:

```json
"categoryAuth": "Auth events",
"categoryUser": "User management",
"categoryOrder": "Order management",
"categorySettings": "Settings changes",
"categoryCache": "Cache operations"
```

In `ru.json`, under `admin.audit`, add:

```json
"categoryAuth": "События авторизации",
"categoryUser": "Управление пользователями",
"categoryOrder": "Управление заказами",
"categorySettings": "Изменения настроек",
"categoryCache": "Операции кэша"
```

**Step 2: Move ACTION_CATEGORIES inside the component and use t()**

Replace the module-level `ACTION_CATEGORIES` array (lines 17-24) with a version inside the component body that uses `t()`:

```typescript
const ACTION_CATEGORIES = [
  { value: '', label: t('allActions') },
  { value: 'auth', label: t('categoryAuth') },
  { value: 'admin.user', label: t('categoryUser') },
  { value: 'admin.order', label: t('categoryOrder') },
  { value: 'admin.settings', label: t('categorySettings') },
  { value: 'admin.cache', label: t('categoryCache') },
];
```

The JSX usage (`{cat.label}`) stays the same — no changes needed there.

**Step 3: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('packages/server/messages/en.json'))"`
Run: `node -e "JSON.parse(require('fs').readFileSync('packages/server/messages/ru.json'))"`
Expected: No errors.

---

## Task 2: Fix hardcoded "across N days" in commit-analysis-table

**Files:**
- Modify: `packages/server/src/components/commit-analysis-table.tsx:575`
- Modify: `packages/server/messages/en.json` (add key under `orders.commitsTab`)
- Modify: `packages/server/messages/ru.json` (add key under `orders.commitsTab`)

**Step 1: Add translation keys**

In `en.json`, under `orders.commitsTab`:

```json
"effortSpreadSummary": "{effort} across {count, plural, one {# day} other {# days}}"
```

In `ru.json`, under `orders.commitsTab`:

```json
"effortSpreadSummary": "{effort} за {count, plural, one {# день} few {# дня} other {# дней}}"
```

**Step 2: Replace hardcoded string**

In `commit-analysis-table.tsx`, line 575, replace:

```typescript
({formatEffort(commit.effortHours)} across {entries.length} day{entries.length !== 1 ? 's' : ''})
```

with:

```typescript
({t('effortSpreadSummary', { effort: formatEffort(commit.effortHours), count: entries.length })})
```

**Step 3: Validate JSON** (same commands as Task 1)

---

## Task 3: Fix `explore.views` — add ICU plural forms

**Files:**
- Modify: `packages/server/messages/en.json` (line ~534, `explore.views`)
- Modify: `packages/server/messages/ru.json` (line ~534, `explore.views`)

**Step 1: Replace the simple parameter with ICU plural**

In `en.json`, change:
```json
"views": "{count} views"
```
to:
```json
"views": "{count, plural, one {# view} other {# views}}"
```

In `ru.json`, change:
```json
"views": "{count} просмотров"
```
to:
```json
"views": "{count, plural, one {# просмотр} few {# просмотра} other {# просмотров}}"
```

**Step 2: Validate JSON** (same commands as Task 1)

**Step 3: Verify caller passes `count` parameter**

Check the explore detail page passes the correct parameter name. In `packages/server/src/app/[locale]/(public)/explore/[owner]/[repo]/page.tsx`, confirm the `t('views', { count: ... })` call uses `count` as the param name.

---

## Task 4: Fix `admin.monitoring.jobsRunning` — add ICU plural forms

**Files:**
- Modify: `packages/server/messages/en.json` (line ~815, `admin.monitoring.jobsRunning`)
- Modify: `packages/server/messages/ru.json` (line ~815, `admin.monitoring.jobsRunning`)

**Step 1: Replace with ICU plural format**

In `en.json`, change:
```json
"jobsRunning": "{count} jobs running"
```
to:
```json
"jobsRunning": "{count, plural, one {# job running} other {# jobs running}}"
```

In `ru.json`, change:
```json
"jobsRunning": "{count} задач выполняется"
```
to:
```json
"jobsRunning": "{count, plural, one {# задача выполняется} few {# задачи выполняется} other {# задач выполняется}}"
```

**Step 2: Validate JSON** (same commands as Task 1)

---

## Task 5: Fix Stripe v20 types in webhook route (remove `as any`)

**Files:**
- Modify: `packages/server/src/app/api/billing/webhook/route.ts`

**Context:** Stripe SDK v20 removed `Invoice.subscription` and `Subscription.current_period_start/end`. The new API:
- Invoice subscription → `invoice.parent?.subscription_details?.subscription`
- Subscription period → `subscription.items.data[0].current_period_start/end` (moved to `SubscriptionItem`)

**Step 1: Fix invoice subscription access (lines 40-42)**

Replace:
```typescript
const subId = typeof (invoice as any).subscription === 'string'
  ? (invoice as any).subscription
  : (invoice as any).subscription?.id;
```

with:
```typescript
const parentSub = invoice.parent?.subscription_details?.subscription;
const subId = typeof parentSub === 'string' ? parentSub : parentSub?.id;
```

**Step 2: Fix subscription period access in `handleInvoicePaid` (lines 259-260)**

Since `prefetchedStripeSub` is retrieved via `stripe.subscriptions.retrieve(subId)`, the period is on the first item. Replace:

```typescript
const periodStart = new Date((stripeSub as any).current_period_start * 1000);
const periodEnd = new Date((stripeSub as any).current_period_end * 1000);
```

with:
```typescript
const firstItem = stripeSub.items.data[0];
const periodStart = firstItem ? new Date(firstItem.current_period_start * 1000) : new Date();
const periodEnd = firstItem ? new Date(firstItem.current_period_end * 1000) : new Date();
```

**Step 3: Fix `handleSubscriptionUpdated` period access (lines 408-409)**

Replace:
```typescript
currentPeriodStart: new Date((stripeSub as any).current_period_start * 1000),
currentPeriodEnd: new Date((stripeSub as any).current_period_end * 1000),
```

with:
```typescript
currentPeriodStart: new Date(stripeSub.items.data[0]?.current_period_start ? stripeSub.items.data[0].current_period_start * 1000 : Date.now()),
currentPeriodEnd: new Date(stripeSub.items.data[0]?.current_period_end ? stripeSub.items.data[0].current_period_end * 1000 : Date.now()),
```

**Step 4: Fix expiry date in upgrade block (line 422)**

Replace:
```typescript
subscriptionExpiresAt: new Date((stripeSub as any).current_period_end * 1000),
```

with:
```typescript
subscriptionExpiresAt: new Date(stripeSub.items.data[0]?.current_period_end ? stripeSub.items.data[0].current_period_end * 1000 : Date.now()),
```

**Step 5: Extract helper to reduce repetition**

Add a helper at the top of the handler functions section:

```typescript
function getSubscriptionPeriod(sub: Stripe.Subscription): { start: Date; end: Date } {
  const item = sub.items.data[0];
  return {
    start: item ? new Date(item.current_period_start * 1000) : new Date(),
    end: item ? new Date(item.current_period_end * 1000) : new Date(),
  };
}
```

Then simplify all period accesses to:
```typescript
const { start: periodStart, end: periodEnd } = getSubscriptionPeriod(stripeSub);
```

**Step 6: Build check**

Run: `cd packages/server && pnpm build 2>&1 | grep -E "(Compiled|Failed|error TS)"`
Expected: `Compiled successfully` (no type errors in this file)

---

## Task 6: Make date-fns format() locale-aware in analysis-period-selector

**Files:**
- Modify: `packages/server/src/components/analysis-period-selector.tsx`

**Context:** `format()` from date-fns v4 accepts a `{ locale }` option. The `ru` locale is at `date-fns/locale/ru`. Use `useLocale()` from `next-intl` to determine current locale.

**Step 1: Add imports**

Add to the existing imports:
```typescript
import { useLocale } from 'next-intl';
import { ru, enUS } from 'date-fns/locale';
```

**Step 2: Create a locale map and add `useLocale()` in each component**

Add a module-level map:
```typescript
const DATE_LOCALES: Record<string, Locale> = { ru, en: enUS };
```

In each of the 3 exported components (`AnalysisPeriodSelector`, `AnalysisPeriodInline`, `AnalysisPeriodDisplay`), add:
```typescript
const locale = useLocale();
const dateLocale = DATE_LOCALES[locale];
```

**Step 3: Pass locale to all `format()` calls**

There are 6 `format()` calls across the 3 components. Update each:

```typescript
// Before:
format(date, 'MMM d, yyyy')
// After:
format(date, 'MMM d, yyyy', { locale: dateLocale })

// Before:
format(date, 'MMM yyyy')
// After:
format(date, 'MMM yyyy', { locale: dateLocale })
```

**Step 4: Build check** (same as Task 5, step 6)

---

## Task 7: Fix `as any` cast in i18n/request.ts

**Files:**
- Modify: `packages/server/src/i18n/request.ts:6`

**Step 1: Replace `as any` with proper readonly cast**

Replace:
```typescript
const locale = routing.locales.includes(requested as any) ? requested : routing.defaultLocale;
```

with:
```typescript
const locale = (routing.locales as readonly string[]).includes(requested)
  ? requested
  : routing.defaultLocale;
```

This preserves type safety — `routing.locales` is `readonly ['en', 'ru']`, and `includes()` on a readonly array correctly accepts `string`.

---

## Task 8: Fix `EventSource.lastEventId` casts in explore-tab.tsx

**Files:**
- Modify: `packages/server/src/components/explore-tab.tsx:197, 221`

**Context:** tsconfig has `"lib": ["dom", "dom.iterable", "esnext"]` which includes `EventSource` with `lastEventId`. The issue is likely that `es` is typed as `EventSource` from the DOM lib but TypeScript's DOM types may not include `lastEventId` in the version bundled with the project's TS.

**Step 1: Check TypeScript version and EventSource type**

Run: `cd packages/server && npx tsc --version`
Run: `grep "lastEventId" node_modules/typescript/lib/lib.dom.d.ts`

If `lastEventId` IS in the DOM types: the `as any` should not be needed and there's likely a variable typing issue. If it's NOT in the DOM types: extend the type.

**Step 2a: If `lastEventId` exists in DOM types**

The variable `es` might be typed too narrowly. Check the `new EventSource(...)` assignment and ensure it's typed as `EventSource`.

**Step 2b: If `lastEventId` is missing from DOM types**

Add a minimal type augmentation. Replace both `(es as any).lastEventId` with `es.lastEventId` and add at the top of the file or in a `.d.ts`:

```typescript
// EventSource.lastEventId is standard but may be missing from older TS DOM types
declare global {
  interface EventSource {
    readonly lastEventId: string;
  }
}
```

Alternatively, a simpler approach: just read it as a property without cast:

```typescript
extra: { query, lastEventId: 'lastEventId' in es ? (es as { lastEventId: string }).lastEventId : undefined },
```

**Step 3: Build check** (same as Task 5, step 6)

---

## Final: Commit all fixes

**Step 1: Validate JSON files**

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/server/messages/en.json'))"
node -e "JSON.parse(require('fs').readFileSync('packages/server/messages/ru.json'))"
```

**Step 2: Build check**

```bash
cd packages/server && pnpm build 2>&1 | grep -E "(Compiled|Failed|error TS)"
```

Expected: `Compiled successfully`

**Step 3: Commit**

```bash
git add packages/server/messages/en.json packages/server/messages/ru.json \
  packages/server/src/app/[locale]/(dashboard)/admin/audit/page.tsx \
  packages/server/src/components/commit-analysis-table.tsx \
  packages/server/src/app/api/billing/webhook/route.ts \
  packages/server/src/components/analysis-period-selector.tsx \
  packages/server/src/i18n/request.ts \
  packages/server/src/components/explore-tab.tsx

git commit -m "fix(i18n): code review fixes — plurals, types, locale-aware dates"
```
