# Operator Prompt: Repository Read Model

Use this version if the builder-AI did not understand the full architectural packet.

This prompt is intentionally direct and concrete.

## What you are building

Implement `Slice 2: Repository Read Model` on top of the already completed `Contributor Foundation`.

You are **not** building:

- `Team`
- `SavedView`
- global context bar
- schedules/reports
- canonical PR/work-item model
- order flow replacement

You are building:

- canonical workspace-scoped `Repository`
- repository projector / backfill / sync
- repository list page
- repository detail page
- repository v2 APIs

## Preconditions

Do this work only on a branch/worktree that already contains:

- `Workspace`
- `Contributor`
- `ContributorAlias`
- `/api/v2/contributors/**`
- `/people` UI

If those do not exist in the current branch, stop and report that you need the `Contributor Foundation` base first.

## Core rule

`Repository` must become a real business object.

Do **not** build repository pages as thin wrappers over:

- `Order`
- `selectedRepos`
- order IDs

Legacy order data may be used as an ingestion source, but not as the business-facing contract.

## Current production boundary

Until `Organization`/`Team`/`SavedView` exist, everything in this slice is scoped to:

- `Workspace`

So for this slice:

- one workspace has many repositories
- one repository belongs to one workspace
- repeated analyses of the same repo in the same workspace must collapse into one canonical repository

## Exact deliverables

### 1. Schema

Add canonical repository storage in Prisma.

Minimum expectation:

- `Repository` model
- workspace-scoped uniqueness
- fields for provider/full name/default branch/basic freshness metadata

Also add the required migration file under:

- `packages/server/prisma/migrations/**`

Do not leave this as schema-only without migration SQL.

### 2. Repository projector

Create a service that can populate/update canonical repositories from legacy order data.

Required behavior:

- idempotent
- safe to rerun
- can backfill historical orders
- can run best-effort after analysis completion

Source of truth for ingestion may include:

- `order.selectedRepos`
- latest completed analysis/order state

But the output must be canonical repository records.

### 3. Backfill

Add a backfill path similar to contributor foundation.

Expected output:

- a script under `packages/server/scripts/**`
- it scans relevant historical orders
- it populates canonical repositories
- it is safe to rerun

### 4. Repository APIs

Add business-facing v2 routes under:

- `packages/server/src/app/api/v2/repositories/**`

Minimum endpoints:

- `GET /api/v2/repositories`
- `GET /api/v2/repositories/:id`

Optional supporting endpoint if needed:

- freshness/details helper endpoint

Rules:

- route identity is canonical `repositoryId`
- do not expose raw order IDs as primary identity
- do not return `selectedRepos` JSON as the frontend contract

### 5. Repository list UI

Add:

- `packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx`

and required components.

The page must show:

- one row per canonical repository
- repository full name
- provider
- last updated
- freshness status
- activity summary

It may be workspace-scoped for now.

### 6. Repository detail UI

Add:

- `packages/server/src/app/[locale]/(dashboard)/repositories/[id]/page.tsx`

and required components.

The page must be addressed by canonical repository ID, not order ID.

It must show:

- repository header
- freshness panel
- summary metrics
- canonical contributors active in this repository
- repository-local activity evidence

Important:

- if canonical PR data is not ready, do **not** fake PRs from commit groups
- it is acceptable for the PR section to be empty/unavailable in this slice
- commit/activity evidence is allowed as supporting information

### 7. Contributor reuse

Any people shown on repository pages must resolve through canonical `Contributor`.

Do **not**:

- build repository contributors from raw author emails only
- create a second parallel identity system for repository pages

If legacy commit data is used, map it through canonical contributor identity first.

### 8. Optional nav exposure

If low-risk, add a minimal `Repositories` item to sidebar.

Do not redesign the rest of navigation.

## Allowed write scope

- `packages/server/prisma/schema.prisma`
- `packages/server/prisma/migrations/**`
- `packages/server/scripts/**`
- `packages/server/src/app/api/v2/**`
- `packages/server/src/lib/**`
- `packages/server/src/app/[locale]/(dashboard)/repositories/**`
- `packages/server/messages/en.json`
- `packages/server/messages/ru.json`
- `packages/server/src/components/layout/sidebar.tsx`

## Read-only unless absolutely necessary

- `packages/server/src/app/[locale]/(dashboard)/orders/**`
- `packages/server/src/app/api/orders/**`
- publication/public profile flows

Do not refactor unrelated legacy surfaces in this slice.

## Acceptance criteria

The work is complete only if all of these are true:

1. `Repository` exists as a canonical workspace-scoped entity in schema and app code.
2. A repository that appears in multiple historical orders resolves to one canonical repository.
3. Repository population uses an explicit projector/backfill/sync pattern.
4. `/api/v2/repositories` exists.
5. `/repositories` page exists.
6. `/repositories/[id]` page exists.
7. Repository detail uses canonical repository ID, not order ID.
8. Freshness is visible in business terms without exposing job/run IDs as the main UX.
9. Repository-local contributors are canonical contributors.
10. Existing order creation/detail/publication flows still work.

## Explicitly acceptable compromises for this slice

These are allowed:

- repository detail has no canonical PR section yet
- PR section is empty or marked unavailable
- repository activity evidence is commit-backed
- repository scope is workspace-only

These are **not** allowed:

- fake PR list built from commit groups but presented as real PR data
- repository route based on order ID
- one row per order occurrence instead of one row per canonical repository
- repository people based only on raw email identity

## Recommended build order

1. Prisma model + migration
2. projector service
3. backfill script
4. repository list/detail read-model queries
5. v2 routes
6. list page
7. detail page
8. optional sidebar entry
9. validation

## Required final report from builder-AI

Return exactly:

1. Summary of implementation
2. Files changed
3. Acceptance criteria status, line by line
4. Tests run
5. Known gaps / follow-ups
6. Anything that blocked full completion
