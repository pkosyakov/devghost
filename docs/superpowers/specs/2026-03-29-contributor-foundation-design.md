# Contributor Foundation — Design Spec

**Date:** 2026-03-29
**Slice:** 01-contributor-foundation (team-first-refactor)
**Strategy:** A-minimal complete — full domain foundation, vertical slice, no scope creep
**Status:** Approved

## Summary

Introduce canonical contributor identity as a first-class domain layer so new people-facing analytics stop depending on per-order extracted developer blobs and order-local dedup mappings.

This is the first architectural slice of the team-first refactor. It must be complete (readable AND actionable) but not expanded beyond its scope.

---

## Locked Decisions (from architecture)

| ID | Decision |
|---|---|
| D-003 | Internal uses `Contributor`; UI may say `Developer` |
| D-004 | `User` and `Contributor` are distinct |
| D-005 | Contributor identity resolution is Phase 1 foundation |
| D-012 | Point-in-time team membership (future slices) |
| D-015 | Raw events append-only; curation modeled separately |
| D-016 | Incremental recomputation, not full reprocessing |

## Design Decisions (from brainstorming)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Contributor scoping | Workspace 1:1 with User | Best bridge to future Organization. Safer than global. userId-only too temporary. |
| 2 | Population trigger | Backfill + idempotent projection on analysis complete | Lazy creation gives unstable cold path. |
| 3 | PR data in Contributor Detail | Commit-centric for slice 1 | No fake PR grouping. PR-first is target model for later slices. |
| 4 | Identity Queue | Inline section/filter on People List | Not a separate page in slice 1. |
| 5 | Sidebar | Add People minimally | P0 surface, should not be hidden behind direct URL. |
| 6 | i18n | Full en + ru from day one | User-facing screen, English-only would be unnecessary debt. |

---

## 1. Schema

Four new models + one relation added to User.

### Workspace

Temporary organization scope, 1:1 with User. No UI. When Organization lands later, Workspace becomes Organization.

```prisma
model Workspace {
  id           String              @id @default(cuid())
  name         String              @default("My Workspace")
  ownerId      String              @unique
  owner        User                @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  contributors Contributor[]
  aliases      ContributorAlias[]
  auditLogs    CurationAuditLog[]

  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt
}
```

### Contributor

Canonical tracked engineering identity.

```prisma
model Contributor {
  id             String                      @id @default(cuid())
  workspaceId    String
  workspace      Workspace                   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  displayName    String
  primaryEmail   String
  classification ContributorClassification   @default(INTERNAL)
  isExcluded     Boolean                     @default(false)
  excludedAt     DateTime?

  aliases        ContributorAlias[]
  auditLogs      CurationAuditLog[]

  createdAt      DateTime                    @default(now())
  updatedAt      DateTime                    @updatedAt

  @@unique([workspaceId, primaryEmail])
  @@index([workspaceId])
}
```

### ContributorAlias

Raw provider-specific identity signal. Belongs to Workspace directly (not only through Contributor) so unresolved aliases have scope.

```prisma
model ContributorAlias {
  id                 String                      @id @default(cuid())
  workspaceId        String
  workspace          Workspace                   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  contributorId      String?
  contributor        Contributor?                @relation(fields: [contributorId], references: [id], onDelete: SetNull)

  providerType       String                      @default("github")
  providerId         String?
  email              String
  username           String?

  resolveStatus      AliasResolveStatus          @default(UNRESOLVED)
  mergeReason        String?
  confidence         Float                       @default(0)
  classificationHint ContributorClassification?
  lastSeenAt         DateTime?
  createdAt          DateTime                    @default(now())
  updatedAt          DateTime                    @updatedAt

  @@unique([workspaceId, providerType, email])
  @@unique([workspaceId, providerType, providerId])
  @@index([contributorId])
  @@index([resolveStatus])
  @@index([workspaceId])
}
```

### CurationAuditLog

```prisma
model CurationAuditLog {
  id                String       @id @default(cuid())
  workspaceId       String
  workspace         Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  contributorId     String?
  contributor       Contributor? @relation(fields: [contributorId], references: [id], onDelete: SetNull)

  aliasId           String?
  action            CurationAction
  payload           Json         @default("{}")
  performedByUserId String
  performedByUser   User         @relation(fields: [performedByUserId], references: [id], onDelete: Cascade)
  createdAt         DateTime     @default(now())

  @@index([workspaceId])
  @@index([contributorId])
  @@index([aliasId])
}
```

### Enums

```prisma
enum ContributorClassification {
  INTERNAL
  EXTERNAL
  BOT
  FORMER_EMPLOYEE
}

enum AliasResolveStatus {
  AUTO_MERGED
  MANUAL
  SUGGESTED
  UNRESOLVED
}

enum CurationAction {
  MERGE
  UNMERGE
  EXCLUDE
  INCLUDE
  CLASSIFY
}
```

### User model change

Add reverse relation:

```prisma
model User {
  // ... existing fields ...
  workspace  Workspace?
  curationAuditLogs CurationAuditLog[]
}
```

### Key schema invariants

- `ContributorAlias.contributorId` nullable — unresolved aliases exist without a contributor
- `@@unique([workspaceId, primaryEmail])` — one contributor per email per workspace
- `@@unique([workspaceId, providerType, email])` — alias uniqueness is workspace-scoped
- `@@unique([workspaceId, providerType, providerId])` — provider ID uniqueness is workspace-scoped
- `classificationHint` on alias allows bot/external marking before contributor attachment
- `isExcluded` + `excludedAt` — soft exclusion, not deletion

---

## 2. Projection Service

Service: `packages/server/src/lib/services/contributor-identity.ts`

### Architecture

```
Order(COMPLETED) ──► projectContributorsFromOrder(orderId)
                          │
                          ├─ ensureWorkspaceForUser(userId)
                          ├─ extractAliasesFromOrder()     // selectedDevelopers → seed identities
                          │                                 // developerMapping → alias hints only
                          ├─ upsertAliases()               // insert/update by workspace-scoped uniques
                          ├─ resolveIdentities()           // auto-merge rules
                          └─ refreshContributorStats()     // lastSeenAt, displayName if better signal

backfillAllOrders() ──► for each COMPLETED order → projectContributorsFromOrder()
```

### Bootstrap rule

When a new person appears for the first time:
- `selectedDevelopers` provide seed identity
- If no existing Contributor match in workspace → create new Contributor + attach primary alias
- Additional alias signals that cannot be confidently attached → `UNRESOLVED`

### Auto-merge rules (v1, priority order)

1. **Exact provider ID match** — alias with same `[workspaceId, providerType, providerId]` → merge into existing Contributor
2. **Exact email match** — alias with same email in workspace → merge if Contributor already exists for that email
3. **Unresolved bucket** — everything else → `resolveStatus: UNRESOLVED`, `contributorId: null`

No fuzzy matching in slice 1. Existing `deduplication.ts` stays for legacy order flow.

### Data source rules

- `selectedDevelopers` = source of seed contributors (name, email, provider info)
- `developerMapping` = source of additional alias hints/signals only
- Projector does NOT automatically replay legacy merge decisions into new graph

### Idempotency rules

- `projectContributorsFromOrder()` safe to call repeatedly — upsert by unique constraints
- `lastSeenAt` updated on each run
- New aliases added, existing aliases not deleted
- **Manual resolution is authoritative**: alias with `resolveStatus = MANUAL` is never reassigned by projector
- Manual merge/unmerge/classification always takes precedence over auto-resolution
- Projector updates signals (`lastSeenAt`, `username`) but never overwrites manual decisions

### Integration points

**Analysis Worker Hook** — best-effort, non-blocking:

```typescript
// In analysis-worker.ts, after order → COMPLETED
try {
  await projectContributorsFromOrder(orderId);
} catch (err) {
  analysisLogger.error({ err, orderId }, 'Contributor projection failed (non-blocking)');
}
```

If projection fails, analysis does NOT roll back to FAILED.

**Backfill Script** — `packages/server/scripts/backfill-contributors.ts`:

- Finds all Users with at least one COMPLETED Order
- For each: `ensureWorkspaceForUser()` → `projectContributorsFromOrder()` per order
- Idempotent, safe to re-run
- Progress output: `Processing user 1/N, order 1/M...`
- Run: `cd packages/server && npx tsx scripts/backfill-contributors.ts`

**Workspace Bootstrap** — `ensureWorkspaceForUser(userId)`:

- Called in projector, backfill, and optionally in registration
- If called in `/api/auth/register`, must be best-effort (failure must not break registration)
- Idempotent — returns existing workspace if present

### What projector does NOT do

- Does not touch legacy JSONB fields (selectedDevelopers, developerMapping, excludedDevelopers)
- Does not replay legacy manual merges into new graph
- Does not run fuzzy suggestions
- Does not recalculate Ghost% metrics

---

## 3. API Endpoints

All new endpoints under `/api/v2/contributors/`. Workspace resolved from authenticated user via `ensureWorkspaceForUser()`.

### Read endpoints

**List contributors:**
```
GET /api/v2/contributors
  Query: ?page=1&pageSize=20&sort=lastActivityAt&sortOrder=desc
         &classification=INTERNAL,EXTERNAL
         &identityHealth=unresolved
         &search=john
  Response: apiResponse({
    contributors: ContributorSummaryRow[],
    pagination: { page, pageSize, total, totalPages },
    identityQueueSummary: { unresolvedCount, suggestedCount }
  })
```

**Contributor detail:**
```
GET /api/v2/contributors/:id
  Response: apiResponse({
    contributor: { id, displayName, primaryEmail, classification, isExcluded, excludedAt },
    aliases: ContributorAlias[],
    summaryMetrics: { totalCommits, activeRepositoryCount, lastActivityAt },
    repositoryBreakdown: { repoName, commitCount, lastActivityAt }[],
    identityHealth: { status, unresolvedAliasCount }
  })
```

Note: detail does NOT include commit evidence array. Commits are a separate endpoint.

**Commit evidence (paginated):**
```
GET /api/v2/contributors/:id/commits
  Query: ?page=1&pageSize=20
  Response: apiResponse({
    commits: { sha, message, repo, authoredAt, effortHours? }[],
    pagination: { page, pageSize, total, totalPages }
  })
```

**Identity queue:**
```
GET /api/v2/contributors/identity-queue
  Query: ?page=1&pageSize=20
  Response: apiResponse({
    aliases: { alias: ContributorAlias, suggestedContributor?: ContributorSummaryRow }[],
    pagination: { ... },
    summary: { unresolvedCount, suggestedCount }
  })
```

Primary consumer in slice 1: People List inline identity queue panel.

**Optional (not required for slice 1):**
```
GET /api/v2/contributors/:id/aliases
```

Detail endpoint already returns aliases. Separate endpoint can be added later if needed.

### Write endpoints

**Merge contributors:**
```
POST /api/v2/contributors/merge
  Body: { fromContributorId, toContributorId }
  Validation:
    - Both contributors must belong to current workspace
    - Cannot merge contributor into itself
  Effect: Move all aliases from → to. Delete fromContributor. Audit log.
  Execution: Single Prisma $transaction
  Response: apiResponse({ contributor: ContributorDetail })
```

**Unmerge contributor:**
```
POST /api/v2/contributors/unmerge
  Body: { contributorId, aliasIds: string[] }
  Validation:
    - Contributor and all aliases must belong to current workspace
    - Cannot extract all aliases (must leave at least one, unless explicit "split all")
  Effect: Create new Contributor from specified aliases. Audit log.
  Execution: Single Prisma $transaction
  Response: apiResponse({ original: ContributorDetail, newContributor: ContributorDetail })
```

**Exclude contributor:**
```
POST /api/v2/contributors/:id/exclude
  Body: { reason?: string }
  Effect: Set isExcluded=true, excludedAt=now(). Audit log.
  Response: apiResponse({ contributor: ContributorDetail })
```

**Include contributor:**
```
POST /api/v2/contributors/:id/include
  Body: {}
  Effect: Clear isExcluded, excludedAt. Audit log.
  Response: apiResponse({ contributor: ContributorDetail })
```

**Classify contributor:**
```
POST /api/v2/contributors/:id/classify
  Body: { classification: ContributorClassification }
  Effect: Update contributor classification. Audit log.
  Response: apiResponse({ contributor: ContributorDetail })
```

**Classify alias (classificationHint, not final contributor classification):**
```
POST /api/v2/contributors/aliases/:aliasId/classify
  Body: { classificationHint: ContributorClassification }
  Effect: Update alias classificationHint only. Audit log.
  Response: apiResponse({ alias: ContributorAlias })
```

**Resolve alias (attach to contributor):**
```
POST /api/v2/contributors/aliases/:aliasId/resolve
  Body: { contributorId: string }
  Effect: Attach unresolved alias to contributor. resolveStatus=MANUAL. Audit log.
  Response: apiResponse({ alias: ContributorAlias, contributor: ContributorDetail })
```

### Common patterns

- **Auth:** All endpoints require `requireUserSession()`. Workspace resolved via `user.id → workspace`.
- **Scope:** All queries filtered by `workspaceId` — user sees only their contributors.
- **Workspace ownership:** All write operations validate that referenced contributorId/aliasId belong to current workspace. 404 if not.
- **Audit:** All write actions create `CurationAuditLog` record.
- **Responses:** All via `apiResponse()` / `apiError()` from existing `api-utils.ts`.
- **Validation:** Zod schemas for all request bodies.
- **Transactional:** merge/unmerge run in single `prisma.$transaction`.
- **Invalidation:** After write actions, client invalidates: contributor detail, people list, identity queue summary (TanStack Query).

### Not in this slice

- Scope resolution by Team/SavedView
- Batch operations
- Export/download
- Webhook notifications

---

## 4. UI — People List

Route: `/[locale]/(dashboard)/people/page.tsx`

### Layout structure

```
┌─────────────────────────────────────────────────────┐
│  Header: title + search                             │
├─────────────────────────────────────────────────────┤
│  Summary Strip                                      │
│  [N contributors] [N unresolved] [N excluded]       │
├─────────────────────────────────────────────────────┤
│  Filters: [Classification ▾] [Identity Health ▾]    │
├─────────────────────────────────────────────────────┤
│  Identity Queue Panel (collapsible)                 │
│  Shows unresolved alias count + top items + CTAs    │
│  Primary consumer of GET /identity-queue            │
├─────────────────────────────────────────────────────┤
│  Contributors Table                                 │
│  One row = one canonical contributor (NEVER aliases)│
│  Columns: Name, Email, Classification, Identity,    │
│           Repos, Last Activity, Actions             │
│  Identity = separate column with badge + tooltip    │
├─────────────────────────────────────────────────────┤
│  Pagination                                         │
└─────────────────────────────────────────────────────┘
```

### Key rules

- **One row = one canonical contributor.** Unresolved aliases without contributor live in Identity Queue panel, not in the table.
- Click on "N unresolved" in summary strip → scrolls to Identity Queue panel + optionally applies `identityHealth=attention` filter to table.
- Identity health is a **separate column** (or badge with tooltip/aria-label), not just an icon. Classification and identity health are different axes.

### Components

```
people/
  page.tsx                    — client page with useQuery (no SSR in slice 1)
  components/
    people-summary-strip.tsx  — 3 KPI cards
    people-filters.tsx        — classification + identity health dropdowns
    people-identity-queue.tsx — collapsible panel, top unresolved aliases, resolve CTAs
    people-table.tsx          — main table with sorting, pagination
    people-table-row.tsx      — single contributor row with quick actions
    identity-health-badge.tsx — badge with tooltip/aria-label
```

### Data flow

- Client-first: `page.tsx` as client page with `useQuery`
- `GET /api/v2/contributors` for table + summary
- `GET /api/v2/contributors/identity-queue` for inline queue panel
- Filters update URL search params (shareable/bookmarkable state)
- `sortOrder` param (not `order`) to avoid collision with legacy Order term

### Per-row quick actions

- View detail → navigate to `/people/[id]`
- Exclude / Include → `POST /:id/exclude` or `/include`
- Classify → submenu → `POST /:id/classify`

### States

- **Loading** — skeleton table
- **Empty** — "No contributors yet. Run an analysis to populate."
- **Error** — error banner with retry
- **Filtered empty** — "No contributors match filters" with reset button

---

## 5. UI — Contributor Detail

Route: `/[locale]/(dashboard)/people/[id]/page.tsx`

### Layout structure

```
┌─────────────────────────────────────────────────────┐
│  ← Back to People (preserves list searchParams)     │
├─────────────────────────────────────────────────────┤
│  Contributor Header                                 │
│  Name, email, classification, identity status       │
│  [Actions ▾]: Exclude/Include, Classify, Merge      │
├─────────────────────────────────────────────────────┤
│  KPI Summary                                        │
│  [N commits] [N repos] [last activity]              │
├─────────────────────────────────────────────────────┤
│  Identity & Aliases                                 │
│  Section 1: Attached Aliases                        │
│    - resolved aliases with status badge             │
│    - classify hint action per alias                 │
│  Section 2: Potential Matches (if any)              │
│    - unresolved aliases with same email domain      │
│      or from same orders as this contributor        │
│    - "Attach to this contributor" action            │
├─────────────────────────────────────────────────────┤
│  Repository Breakdown                               │
│  Table: repo, commits, last activity                │
├─────────────────────────────────────────────────────┤
│  Commit Evidence (paginated)                        │
│  Table: sha, message, repo, date, effortHours       │
│  Separate endpoint: GET /:id/commits               │
│  [pagination]                                       │
└─────────────────────────────────────────────────────┘
```

### Key rules

- **Attached aliases vs. potential matches** — two separate sections, never mixed.
- **Resolve action = "Attach to this contributor"** — not a general "pick any contributor" flow. Creating new contributor from unresolved alias belongs in identity queue / unmerge flow.
- **Back to People preserves list state** — search params (page, search, classification, identityHealth, sort, sortOrder) carried via URL.
- **Header + Identity sections remain visible** even when activity is empty.
- **Not-found = in-page state** (client-first page), not Next.js 404 in slice 1.
- **Merge modal** reuses `GET /api/v2/contributors?search=...` excluding current contributor.

### Components

```
people/[id]/
  page.tsx                           — client page, useQuery
  components/
    contributor-header.tsx           — name, email, classification, actions dropdown
    contributor-kpi-summary.tsx      — metric cards
    contributor-aliases-panel.tsx    — attached aliases + potential matches (two sections)
    contributor-repo-breakdown.tsx   — repo table
    contributor-commit-evidence.tsx  — paginated commit table (separate endpoint)
    contributor-merge-modal.tsx      — search + select target contributor
```

### Data flow

- `GET /api/v2/contributors/:id` — main detail (lightweight, no commits array)
- `GET /api/v2/contributors/:id/commits?page=1&pageSize=20` — paginated commit evidence
- After write actions (exclude/include/classify/merge/resolve) → invalidate: contributor detail, people list, identity queue summary

### States

- **Loading** — skeleton cards + tables
- **Not found** — in-page "Contributor not found" (not Next.js 404)
- **Empty activity** — header + aliases visible, repo/commits sections show "No activity found"
- **Error** — error banner with retry

---

## 6. Sidebar, i18n, Integration

### Sidebar

Add one item in `packages/server/src/components/layout/sidebar.tsx`:

```
Dashboard
Orders
People        ← new, between Orders and Publications
Publications
```

- Icon: `Users` from lucide-react
- Route: `/people`
- i18n key: `layout.sidebar.people`
- No other navigation changes

### i18n

New keys in `packages/server/messages/en.json` and `packages/server/messages/ru.json`.

Separate language values per file (en: "People", ru: "Разработчики" — not combined).

Key structure:

```
layout.sidebar.people
people.title
people.search.placeholder
people.summary.total / .unresolved / .excluded
people.filters.classification / .identityHealth
people.table.name / .email / .classification / .identity / .repos / .lastActivity
people.actions.exclude / .include / .classify / ...
people.identityQueue.title / .resolve / .empty / ...
people.empty.title / .description
people.error.*
contributorDetail.backToList
contributorDetail.header.*
contributorDetail.identity.attached / .potentialMatches / ...
contributorDetail.kpi.*
contributorDetail.repos.*
contributorDetail.commits.*
contributorDetail.actions.*
contributorDetail.merge.*
contributorDetail.empty.*
contributorDetail.error.*
```

Exact string values determined at implementation time.

### Middleware

Add `'/people'` to `PROTECTED_PREFIXES` in `packages/server/middleware.ts`.

### Workspace bootstrap in registration

Optional best-effort call to `ensureWorkspaceForUser()` in `packages/server/src/app/api/auth/register/route.ts`. Must not break registration on failure.

### Backfill script location

`packages/server/scripts/backfill-contributors.ts`

Run: `cd packages/server && npx tsx scripts/backfill-contributors.ts`

### What we do NOT touch

- Existing order pages — no changes
- `deduplication.ts` — stays for legacy order flow
- `ghost-metrics-service.ts` — no recalculation
- Publication/profile features — no changes
- Admin panel — no changes
- `prisma/seed.ts` — no changes (workspace created via projector/backfill)

---

## Acceptance Criteria

1. Canonical `Contributor` concept exists in schema and app code
2. One person with multiple git identities resolves to one contributor
3. New people-facing routes/screens use contributor read models, not raw order-local developer blobs
4. People List renders one row per canonical contributor
5. Contributor Detail shows aliases, summary, and cross-repo activity context
6. Unresolved aliases visible through identity queue inline panel on People List
7. Excluding or classifying a contributor works through domain-facing actions without deleting raw activity
8. Existing order-based pages continue to function
9. All write actions are transactional and audited
10. Manual resolution takes precedence over automatic projection

## Out of Scope

- Team model / team dashboards
- Repository read model
- SavedView
- Global context bar
- Schedules / report runs
- Full curation hub
- PR reconstruction / PR-first delivery view
- Fuzzy matching / suggestions
- Complete nav rewrite
- Batch operations
- SSR for new pages

## Risks

- Overcoupling new contributor model to legacy Order JSON blobs
- Premature team/org assumptions in schema
- Sidebar churn leaking into foundational slice

## Escalation Rules

Stop and report if:
- A locked decision in `01-decisions.md` would need to change
- Implementation requires full Team rollout first
- New API contract cannot avoid direct dependence on legacy order-local semantics
- Broader nav redesign seems necessary
