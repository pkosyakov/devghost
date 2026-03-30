# Slice 4 Review Brief

Review target: current Slice 4 implementation on the current feature branch in `C:\Projects\devghost`.

Purpose:
- perform an independent code review of Slice 4;
- evaluate reviewer quality, not implementation speed;
- return findings only, not fixes.

## Scope

Review the current working tree changes for Slice 4:
- `SavedView`
- global context bar
- scope-aware `Home`
- scope propagation into `Teams`, `People`, `Repositories`
- `Reports` list/detail
- saved-view and home API routes

Primary code areas:
- `C:\Projects\devghost\packages\server\prisma\schema.prisma`
- `C:\Projects\devghost\packages\server\prisma\migrations\20260330130000_add_saved_view`
- `C:\Projects\devghost\packages\server\src\app\[locale]\(dashboard)\dashboard`
- `C:\Projects\devghost\packages\server\src\app\[locale]\(dashboard)\reports`
- `C:\Projects\devghost\packages\server\src\app\[locale]\(dashboard)\people`
- `C:\Projects\devghost\packages\server\src\app\[locale]\(dashboard)\repositories`
- `C:\Projects\devghost\packages\server\src\app\[locale]\(dashboard)\teams`
- `C:\Projects\devghost\packages\server\src\app\api\v2\home`
- `C:\Projects\devghost\packages\server\src\app\api\v2\saved-views`
- `C:\Projects\devghost\packages\server\src\app\api\v2\contributors`
- `C:\Projects\devghost\packages\server\src\app\api\v2\repositories`
- `C:\Projects\devghost\packages\server\src\app\api\v2\teams`
- `C:\Projects\devghost\packages\server\src\components\layout\global-context-bar.tsx`
- `C:\Projects\devghost\packages\server\src\components\layout\save-view-dialog.tsx`
- `C:\Projects\devghost\packages\server\src\components\layout\sidebar.tsx`
- `C:\Projects\devghost\packages\server\src\lib\active-scope.ts`
- `C:\Projects\devghost\packages\server\src\lib\schemas\scope.ts`
- `C:\Projects\devghost\packages\server\src\lib\schemas\saved-view.ts`
- `C:\Projects\devghost\packages\server\src\lib\services\active-scope-service.ts`
- `C:\Projects\devghost\packages\server\src\lib\services\saved-view-service.ts`
- `C:\Projects\devghost\packages\server\src\lib\services\home-service.ts`
- `C:\Projects\devghost\packages\server\src\lib\__tests__\active-scope.test.ts`

## Read First

Read these source-of-truth docs before reviewing:
- `C:\Projects\devghost\docs\architecture\team-first-refactor\04-state-and-attribution-rules.md`
- `C:\Projects\devghost\docs\architecture\team-first-refactor\05-ux-ia.md`
- `C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\global-context-bar.md`
- `C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\home.md`
- `C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-list.md`
- `C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-detail.md`
- `C:\Projects\devghost\docs\architecture\team-first-refactor\08-data-and-api-contracts.md`
- `C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views.md`

## What To Look For

Prioritize:
1. behavioral bugs
2. regressions in existing `Teams`, `People`, `Repositories` flows
3. scope leaks or scope drift
4. saved-view round-trip/data-loss issues
5. API contract violations
6. architectural violations against Slice 4 packet/contracts
7. missing validation or edge-case handling
8. missing or insufficient tests where risk is real

Be especially alert for:
- URL-backed scope not matching resolved scope
- saved view activation producing different scope than saved payload
- local page filters fighting the global context bar
- list/detail inconsistencies under scoped data
- summary cards computed on wider data than the visible table
- team-route special cases incorrectly overriding saved-view scope
- hidden N+1 or obviously unsafe query patterns
- user-facing actions that look enabled but are incomplete

## What To Ignore

Do not spend time on:
- unrelated docs churn
- style-only issues
- minor copy/text polish
- speculative refactors outside Slice 4

## Required Output

Return findings only.

Format:
- severity: `P1`, `P2`, or `P3`
- one concise paragraph per finding
- include absolute file path and line references
- findings first, no long summary before them

If there are no findings, say exactly:
- `No findings.`

## Important Constraints

- Do not edit code.
- Do not fix anything.
- Do not assume the implementation is correct because tests pass.
- Review the current branch/worktree state, including new untracked Slice 4 files.
- Use a code review mindset: bugs, regressions, broken contracts, and trust issues matter most.

## Ready-To-Send Prompt

```text
Perform an independent code review of the current Slice 4 implementation in C:\Projects\devghost.

Read first:
- C:\Projects\devghost\docs\architecture\team-first-refactor\04-state-and-attribution-rules.md
- C:\Projects\devghost\docs\architecture\team-first-refactor\05-ux-ia.md
- C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\global-context-bar.md
- C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\home.md
- C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-list.md
- C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-detail.md
- C:\Projects\devghost\docs\architecture\team-first-refactor\08-data-and-api-contracts.md
- C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views.md

Review target:
- current working tree changes for Slice 4 on the current branch in C:\Projects\devghost
- include new untracked files and modified tracked files under packages/server

Focus on:
- behavioral bugs
- regressions in Teams/People/Repositories after introducing global scope
- scope leaks or scope drift
- saved-view round-trip issues
- API contract violations
- architectural violations against Slice 4 packet/contracts
- missing high-signal tests

Ignore:
- style-only issues
- unrelated docs churn
- speculative refactors

Output requirements:
- findings only
- severity P1/P2/P3
- concise explanation
- absolute file path with line references
- no fixes, no code changes
- if no findings, say exactly: No findings.
```
