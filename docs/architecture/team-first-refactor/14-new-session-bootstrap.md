# New Session Bootstrap

## Purpose

Use this file to start a fresh Codex session on the DevGhost team-first refactor without relying on prior chat context.

## What the new session should do first

The new session should not start coding immediately.

It should first:

1. read the architecture package entrypoint: [README.md](C:\Projects\devghost\docs\architecture\team-first-refactor\README.md)
2. read the current handoff: [13-session-handoff.md](C:\Projects\devghost\docs\architecture\team-first-refactor\13-session-handoff.md)
3. check current worktrees with `git worktree list --porcelain`
4. inspect the relevant worktree status
5. summarize:
   - current slice status
   - relevant source-of-truth docs
   - open review findings or blockers
   - recommended next action
   - whether Slice 2 is already merged
   - whether Slice 3 code is still active on `feature/team-pivot`
   - whether Slice 4 packet is ready to hand off

Only after that should it proceed with implementation, review, or planning.

## Default prompt for a new Codex session

Paste this as the first message in a new session:

```text
We are continuing the DevGhost team-first refactor.

Before doing any coding, reviewing, or planning:

1. Read:
   - C:\Projects\devghost\docs\architecture\team-first-refactor\README.md
   - C:\Projects\devghost\docs\architecture\team-first-refactor\13-session-handoff.md
2. Run `git worktree list --porcelain`.
3. Determine which worktree contains the active slice work.
4. Inspect the relevant worktree status/diff.
5. Summarize:
   - where the implementation actually lives,
   - which slice is active,
   - which docs are source of truth,
   - whether there are open review findings,
   - what the next best action is,
   - whether Slice 2 is already merged,
   - whether Slice 3 code is still active on `feature/team-pivot`,
   - whether Slice 4 packet is ready to hand off.

Important constraints:
- Treat the architecture package under `docs/architecture/team-first-refactor` as source of truth unless a newer spec/plan explicitly supersedes it.
- Do not assume the active implementation is in `master`; confirm the worktree first.
- Do not invent behavior outside the packet/contracts.
- If reviewing code, review the real active worktree rather than the main workspace.
- If implementation and docs diverge, call out the delta explicitly before proceeding.
```

## If the task is specifically code review

Use this variant:

```text
We are continuing the DevGhost team-first refactor. This task is a code review.

First:
1. Read C:\Projects\devghost\docs\architecture\team-first-refactor\README.md
2. Read C:\Projects\devghost\docs\architecture\team-first-refactor\13-session-handoff.md
3. Run `git worktree list --porcelain`
4. Identify the worktree that contains the active implementation
5. Review that code, not `master`
6. State whether the reviewed slice is merge-ready, already merged, or still blocked

Use the architecture packet/specs as the review baseline. Findings first, ordered by severity, with exact file/line references.
```

## If the task is specifically implementation

Use this variant:

```text
We are continuing the DevGhost team-first refactor. This task is implementation.

First:
1. Read C:\Projects\devghost\docs\architecture\team-first-refactor\README.md
2. Read C:\Projects\devghost\docs\architecture\team-first-refactor\13-session-handoff.md
3. Run `git worktree list --porcelain`
4. Confirm the active worktree and branch
5. Read the relevant implementation packet for the active slice
6. Summarize assumptions before editing
7. If the active slice is Slice 3, confirm that the Team Pivot plan has no unresolved review findings before editing code
8. If Slice 4 planning exists, confirm whether the packet already reflects the real Slice 3 implementation baseline

Do not expand scope beyond the packet. If packet/contracts are insufficient, stop and report the gap instead of inventing behavior.
```

## Minimal manual checklist for the operator

When starting a new session yourself, do this:

1. Open the repo.
2. Paste the default prompt above.
3. If the task is about the repository slice, mention:
   - Slice 2 may already be merged to `master`
   - Codex must verify the actual worktree list first
4. Ask Codex to restate:
   - active slice
   - active worktree
   - source-of-truth docs
   - next action
   - whether Slice 2 is already merged
   - whether Slice 3 code is still the active branch baseline
   - whether Slice 4 packet is execution-ready

If Codex cannot clearly state those items, do not start implementation yet.
