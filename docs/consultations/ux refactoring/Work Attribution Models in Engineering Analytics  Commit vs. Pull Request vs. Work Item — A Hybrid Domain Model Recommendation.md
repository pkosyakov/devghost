Here's the full report. The bottom line recommendation in a few sentences:

Use PR as your primary UX entity, Commit as your internal evidence layer, and Work Item as your intent/context layer. Each has a job it does uniquely well and none can replace the others.

The five most concrete findings:

Squash merge makes commit-primary architectures fragile. LinearB's solution — cache the earliest pushed commit timestamp before the squash occurs — is the right approach. But if the dev squashes locally before ever pushing, even that fails. The fallback is Jira issue state transitions. Design for both.

Appfire Flow is the most honest about squash complexity. Their docs document five distinct timing-dependent outcomes and end with "the most important thing is to understand your organization's baseline." This is pragmatic. No platform fully solves it.

GitHub squash merges preserve co-authors automatically since 2019 (GitLab does not). Parsing Co-authored-by: trailers from the squash commit on main is a reliable way to recover multi-author attribution even without the branch history.

Swarmia's April 2025 effort model change is a signal: unlinked PRs now get significantly lower weight than issue-linked PRs. This proves that a PR with no work item link is a lower-quality evidence signal — the platform is nudging teams toward ticket hygiene through its attribution weight, not through UI enforcement.

No platform has solved monorepo path-based attribution. CODEOWNERS is the correct mapping primitive but none of the main engineering analytics products surface it. This is an actual differentiation opportunity.

The phased model in section 8 gives you the sequencing: start with PR-only (simplest correct thing), add commit evidence in Phase 2, add work item linking in Phase 3.

# Work Attribution Models in Engineering Analytics: Commit vs. Pull Request vs. Work Item — A Hybrid Domain Model Recommendation

**Research Date:** March 29, 2026  
**Scope:** How leading engineering analytics products attribute developer work across commits, pull requests, and work items — including edge cases for squash merges, direct pushes, monorepos, cross-repo contributors, and cycle-time analytics — with a recommended hybrid domain model for an early-stage product.

***

## 1. Why No Single Entity Can Be the Sole Attribution Unit

The intuitive answer — "use PRs, they're the natural unit of work" — breaks in practice across the real-world workflows every product must handle. The correct model is a three-layer hierarchy where each entity has a specific job, none can be eliminated, and different analytics surfaces query at different layers.

The three layers are:

| Layer | Entity | What it captures | What it cannot capture |
|-------|--------|-----------------|------------------------|
| **Evidence** | Commit | Raw, timestamped authorship; coding days; rework; code churn | Work context; review process; logical work unit boundary |
| **Delivery unit** | Pull Request / MR | Review cycle; time-to-merge; reviewer participation; batch size | Effort before PR opened; work without PRs; intent/priority |
| **Intent unit** | Work Item / Issue | Business meaning; priority; estimation; ticket lifecycle | Actual code authored; who did the work at commit level |

Every leading platform ingests all three. The differences lie in which layer they privilege in the UX and how they link the three together.

***

## 2. How Leading Products Position Each Layer

### Swarmia: PR-Primary with Commit Evidence and Issue Linking

Swarmia's core analytics surfaces — Cycle Time, Batch Size, Code Review — are built around PRs. The developer effort model treats PRs as the primary attribution unit: "Activities are weighted differently, with pull requests and commits counted more heavily than reviews and comments... activities related to **unlinked** pull requests are also given much less weight than those tied to issues."[^1][^2]

The April 2025 effort model update made issue linkage an explicit quality signal: unlinked PRs receive significantly lower attribution weight than PRs linked to issues. This is a direct acknowledgment that a PR without an issue is a lower-confidence work unit — Swarmia rewards issue-linked work in the effort model, creating an incentive for teams to maintain ticket hygiene.[^1]

Commits remain an evidence layer: Swarmia counts commits toward the FTE effort model alongside PR events and comments, but commits alone (without a PR) are treated as lower-confidence attribution.[^3]

### LinearB: PR-Primary with Commit Fallback and Jira as an Optional Override

LinearB's primary cycle-time tracking is PR-based: coding time starts from the first branch commit, pickup time begins when the PR is opened, review time ends at merge. The PR is the delivery unit. Jira (or Linear, ADO) is an optional overlay that can replace commit-based coding time with issue-state-based coding time — when the Jira issue moves to "In Progress" becomes the start time instead of the first commit.[^4][^5]

For squash merges, LinearB keeps the PR as the authoritative delivery container and walks backward to the earliest pushed commit for coding time start. The squashed commit on main is a side effect of the merge strategy, not the primary attribution object.[^5]

Draft PRs are explicitly tracked as a separate state: their time contributes to coding time but is excluded from cycle time, treating draft status as a "still building" signal before the formal review begins.[^4]

### Appfire Flow: Three-Layer with Explicit Metrics Segregation

Flow is the most explicit about separating its metrics by data layer. The metrics glossary separates **coding metrics** (source: commit), **pull request and collaboration metrics** (source: PR + commit), and **ticket metrics** (source: ticket). Effort distribution for investment balance uses a "probabilistic algorithm [that] combines user signals from tickets, PRs, and commits" — all three layers simultaneously.[^6]

Flow's cycle-time sub-metric, Lead Time, is: "Date of deployment - Date of commit. When displayed in aggregate, Flow uses the median calculation." — using commits as the start signal and deployment events (from git tags) as the end signal, bypassing the PR entirely for this metric. This is a case where the commit layer is the correct start point and the PR layer is irrelevant to the measurement.[^6]

### Jellyfish: Issue/Allocation as Primary, PR/Commit as Evidence

Jellyfish's patented Work Allocations model works at the issue/allocation level: engineering effort is classified by strategic category (new features, tech debt, maintenance, unplanned). Issues define the intent, PRs and commits are evidence of work within that intent. The platform ingests "signals from developer tool stacks to calculate a model of the day-to-day work of engineering" — treating individual events as input to an inferred model, not as first-class reportable objects.[^7][^8]

For cost capitalization and investment balance, Jellyfish's primary unit is the issue/project categorization, not the individual PR or commit. This is the correct primary unit for Jellyfish's core buyer persona (engineering finance, VP-level allocation decisions) because tickets map to capitalization categories in ways that raw commits cannot.

### GitClear: Commit-Primary with Line-Level Analysis

GitClear deliberately positions at the commit layer: its core metric is "Line Impact," which measures cognitive load at the commit level by analyzing diff content, file type, insertion context, and code churn. The Commit Activity Browser (CAB) is its primary UX surface — groups commits into semantically related sets (stitching related commits together across the day).[^9][^10]

GitClear's explicit argument: "Why pull requests alone are insufficient for highly collaborative teams" — because PRs aggregate too much work and lose the per-author signal within a multi-commit PR. This is the inverse of the dominant category position and is correct for GitClear's use case (high-frequency commit environments, open-source-style review workflows).[^10]

***

## 3. Edge Cases and Their Attribution Consequences

### 3.1 Squash Merges

**The problem:** A squash merge collapses N commits on a feature branch into one commit on main. If an analytics platform reads only the main branch, it sees one commit with the merge timestamp. Every commit-derived metric — coding days, commits per day, rework rate, HALOC — becomes wrong. Coding time appears as zero or minimal.

**How platforms handle it:**

- **LinearB:** Caches the earliest pushed commit timestamp before squashing occurs. Uses the cached timestamp as coding time start, regardless of what the post-squash history shows. If commits were not pushed before squashing, falls back to Jira issue state. Critical limitation: if the developer squashes locally before ever pushing, LinearB only sees the final squash commit and cannot recover the original timestamps.[^5]

- **Appfire Flow:** Acknowledges the problem explicitly and documents multiple timing-dependent edge cases: "If Flow ingests commits from a branch before they are squashed, then the commits are squashed but the branch is not deleted, Flow will initially display the pre-squashed commits, then remove them as deleted commits once the squashed commit is ingested." Flow's advice is to understand your org's squashing practices and calibrate baselines accordingly — it does not claim to fully solve the problem.[^11]

- **GitHub (upstream):** As of 2019, GitHub automatically adds all commit authors as co-authors on a squash-and-merge commit. This means the squash commit on main includes `Co-authored-by:` trailers for all original commit authors. A platform that reads co-author trailers from squash commits can recover multi-author attribution even without the original branch history.[^12]

- **GitLab:** Still has an open issue (as of March 2026) for including `Co-authored-by` lines from MR commits in squash commits — this means GitLab squash merges do NOT automatically preserve co-author attribution the way GitHub does.[^13]

**Best practice:** The PR is the correct squash-resilient attribution unit. All commits that were part of a PR are "inside" the PR container — the platform should record them when first pushed and keep them associated with the PR permanently, even after squashing. The squash commit on main is a delivery event, not the attribution event. Mark it as `merge_strategy: squash` and use the PR's original commit set for all effort and authorship metrics.

### 3.2 Long-Lived Feature Branches

**The problem:** A feature branch that lives for 3 weeks before opening a PR makes the PR's `created_at` a poor start marker for cycle time. The real coding start was 3 weeks ago. Using PR open date as cycle time start makes all time before the PR invisible.

**How platforms handle it:**

- **LinearB:** Uses `first commit on branch` as coding time start, not PR open date. The PR lifecycle begins at PR creation. Coding time is the period *before* PR open. Together: coding time + PR lifecycle = full development time.[^4]

- **Swarmia:** Defines cycle time as time from "PR opened (or commit pushed to branch)" to "PR merged" — acknowledging that some teams commit directly to branches without PRs as a first step.[^2]

- **Best practice:** Define cycle time as having two sub-phases: (1) **Coding phase**: first commit on branch → PR opened; (2) **Review phase**: PR opened → merged. Long-lived branches inflate the coding phase — which is the correct signal (a branch open for 3 weeks is genuinely a slow delivery). Don't artificially hide this by anchoring cycle time at PR creation.

### 3.3 Direct Pushes to Main

**The problem:** A developer pushes a commit directly to main without a PR. There is no delivery unit — just a raw commit. No review, no cycle time, no PR lifecycle. Direct pushes typically represent hotfixes, emergency patches, automated tooling, or policy violations.[^14]

**How platforms handle it:**

- **Appfire Flow:** "Flow is branch-agnostic. All commits available in the remote server for a repository will be imported to Flow, regardless of the branch they're on." Direct-to-main commits are ingested as commits. They do not generate PR metrics. They appear in commit-layer analytics (coding days, HALOC, code velocity) but not in PR-layer analytics (cycle time, review rate, pickup time).[^11]

- **LinearB:** Commits to excluded branches are not counted. The main branch is typically excluded from commit scanning to avoid counting squash-merged commits twice (once on the feature branch, once on main). Direct pushes to main on excluded branches would therefore be invisible — a known gap.[^4]

**Best practice:** Track direct pushes as a distinct event type: `DirectPush(commit_id, repo_id, author_id, timestamp, branch=main)`. Surface them in two ways: (1) as a code-hygiene signal in a "Direct commits to main" report (most teams want to see and reduce these); (2) as attribution evidence — the commit is still real work that should count in coding days and HALOC, even if it has no review signal.

### 3.4 Monorepos

**The problem:** In a monorepo, a single PR may touch files owned by multiple teams (e.g., a shared library update that changes 3 services). Attribution of that PR to "which team" is ambiguous. Commit counts, HALOC, and cycle time roll up to the repo level — but different services or directories within the repo are owned by different teams.

**How platforms handle it:**

- **Datadog Code Coverage / CODEOWNERS approach:** Splits coverage data by service or code owner teams based on the `CODEOWNERS` file. "Coverage is calculated for up to 200 services and code owners per coverage report." This is the most principled monorepo attribution model — use the `CODEOWNERS` file as the team-to-path mapping.[^15]

- **Appfire Flow:** No documented monorepo-specific path-based attribution. Team attribution in Flow is by contributor team membership, not by file path. A PR touching both Team A's service and Team B's service is attributed to the PR author's team.

- **LinearB:** Same as Flow — contributor-team attribution, not path-based. A PR in a monorepo is attributed to its author's team regardless of which directories it touches.

**[Inference]** No major engineering analytics platform has fully solved monorepo path-based attribution in a way that is surfaced in their user-facing help documentation. The correct model — attribute portions of a PR's work to multiple teams based on `CODEOWNERS` file path ownership — requires diff-level analysis, not just PR metadata.

**Best practice:** At minimum, expose a "path prefix → team" mapping (similar to CODEOWNERS) that allows per-PR work attribution to multiple teams. This is a Phase 3 feature for most products. For Phase 1/2, monorepo PRs should be attributed to the PR author's primary team, with a note in the UI indicating the PR touched multi-team paths.

### 3.5 Cross-Repository Work

**The problem:** A developer working across 5 repos may open one PR per repo per day. From the developer's individual view, this is unified effort. From each repo's view, they're a minor contributor. Team-level summaries that aggregate by team correctly capture this — but repo-level summaries will under-represent any individual developer's total contribution.

All platforms handle this correctly at the team/developer aggregation level, since contributor identity unification (see previous report) links all repos to one contributor. The edge case is cycle time for multi-repo features: if Feature X requires coordinated PRs in repo-A and repo-B that must both be merged for the feature to be live, neither PR's individual cycle time measures the true end-to-end delivery time. Only a work item that spans both PRs can measure this.

**Best practice:** For cross-repo feature measurement, the work item is the correct primary unit. The work item's `created_at` → `done_at` span captures the true delivery time regardless of how many repos and PRs were involved. This is why Jellyfish's allocation model — issue/project as the primary unit — is correct for org-level investment tracking even if it seems abstract for engineering managers.

***

## 4. What Each Entity Is Best Suited to Measure

| Metric | Best source entity | Why |
|--------|--------------------|-----|
| Coding days | Commit | One data point per unique calendar day with a commit on any branch |
| HALOC / code churn / rework | Commit | Requires diff-level analysis at individual commit granularity |
| Cycle time (coding phase) | Commit (first on branch) → PR open | Captures effort before PR is created |
| Cycle time (review phase) | PR (open → merge) | Review events exist only on the PR object |
| Pickup time (time to first review) | PR | Property of the PR review lifecycle |
| PR throughput | PR (merged count) | The natural "unit of delivery" for most teams |
| Review load / reviewer participation | PR + PR review events | No equivalent at commit level |
| Work-in-progress (WIP) | PR (open, non-draft) | Measures open PRs at any point in time |
| Investment balance | Work item | Tickets carry strategic category / label |
| Feature delivery time | Work item | Spans multiple PRs, multiple repos |
| Story point velocity | Work item | Points live on tickets, not PRs |
| Sprint burndown | Work item | Sprint boundaries are ticket constructs |
| Direct push hygiene | Commit (no PR parent) | Only visible at commit layer |
| Squash attribution | Commit (pre-merge) + PR | Requires both to survive squashing |
| Pair programming attribution | Commit (`Co-authored-by`) | Co-author trailer is a commit property |

***

## 5. The Recommended Hybrid Domain Model

### Entity Hierarchy

```
WorkItem (Issue / Ticket / Epic)
  ├── links to: PullRequest[]       ← N PRs can implement one work item
  │                                 ← One PR can be linked to N work items
  └── PullRequest
        ├── authored_by: Contributor
        ├── reviewed_by: Contributor[]
        ├── merged_into: Repository / Branch
        ├── linked_work_items: WorkItem[]
        ├── merge_strategy: ENUM(MERGE_COMMIT, SQUASH, REBASE)
        └── Commit[]                 ← Collected at push time, retained post-squash
              ├── authored_by: Contributor
              ├── committed_by: Contributor   ← May differ (squash/rebase)
              ├── co_authors: Contributor[]   ← From Co-authored-by trailers
              ├── repository: Repository
              ├── branch: string
              └── diff_stats: {files, additions, deletions, churn}
```

The key design decisions embedded in this model:

1. **Commits are ingested at push time and permanently linked to their originating PR.** When a squash merge occurs, the squash commit on main is a new Commit record with `merge_strategy: SQUASH` and a reference to the PR it came from. The original commits remain in the store, attached to the PR. Analytics that need pre-squash data use the PR's `commits[]` collection; analytics that need the main-branch history use the squash commit.

2. **The PR is the primary delivery container.** Cycle time, review metrics, batch size, pickup time all live at the PR level. When there is no PR (direct push), the Commit is promoted to a pseudo-PR with `type: DIRECT_PUSH` so that code-hygiene reporting can surface it without special-casing every query.

3. **The WorkItem is the intent container.** Investment balance, sprint velocity, and feature delivery time are computed at the WorkItem level. A WorkItem has many PRs; a PR can belong to many WorkItems. This many-to-many link is normalized — not denormalized into the PR or the commit.

4. **Contributor attribution is resolved at the Commit level via `authored_by` + `co_authors`** and propagated upward to the PR. If Alice wrote 60% of the commits in a PR and Bob wrote 40%, the PR's effort attribution can reflect this at a per-contributor level rather than assigning 100% to the PR author.

### Which Entity is Primary in the UX

**UX primary: Pull Request.** The PR is the correct primary UX entity for team-level dashboards because:
- It has a natural lifecycle (opened → review → merged/closed) that maps to process stages
- It has a clean timestamp pair (opened\_at, merged\_at) for cycle time
- It is the unit most engineering managers discuss in retrospectives
- It survives the squash merge problem (commits are evidence *inside* the PR container)
- It has reviewer relationships, which commits do not

PR-centric dashboards: Cycle Time, WIP, Review Load, Batch Size, PR Throughput.

**UX secondary (drill-down): Commit.** Commits surface in two specific contexts:
- **Code quality drill-down:** HALOC, churn, rework, coding days — metrics that require commit-level granularity
- **Process hygiene:** Direct pushes to main, commit frequency, coding day distribution

Commit-centric dashboards: Code Health, Contribution Activity, Direct Push Monitor.

**UX secondary (context): Work Item.** Work items appear as context on PR cards ("linked to PROJ-123") and as the primary unit on Investment Balance and Delivery dashboards.

Work item-centric dashboards: Investment Balance, Sprint Velocity, Feature Delivery Time, Allocation by Category.

### What Stays Internal (Not Exposed in UX)

- Raw commit SHAs and branch names — visible only in drill-down / evidence panel, never in summary metrics
- Diff content — stored for churn/rework calculation but not surfaced to users
- Pre-squash commit set vs. squash commit — handled internally; UX always shows the PR as the delivery unit
- Merge strategy (SQUASH / REBASE / MERGE\_COMMIT) — available as a filter but not a primary dimension

***

## 6. The Special Cases That Require Explicit Handling

### 6.1 PRs with No Commits Visible Post-Squash (Locally-Squashed Before Push)

If a developer squashes commits locally and pushes only the final squash commit, the platform never sees the intermediate commits. The PR contains one commit; coding time start = that commit's timestamp. This is correct behavior — there is no recoverable information. The only remedy is Jira-based coding time (use the issue's "In Progress" state transition as the start time). Recommend this as the default for any team using consistent squash strategies.[^5]

### 6.2 Rebase-Merged PRs

Rebase merge creates new commit SHAs for each original commit. The SHAs on main differ from the SHAs on the feature branch. Any platform that matches commits by SHA across branches will fail to deduplicate these — the same logical change appears as two distinct commits. The fix: match commits by content hash (tree hash of the diff), not by commit SHA. Flow handles this via its deduplication logic for branch-merged-then-deleted scenarios.[^11]

### 6.3 PRs That Span Multiple Repositories (Cross-Repo PRs)

Some monorepo-adjacent workflows involve a "meta-PR" or a stack of PRs across repos that must all land together. No platform in the category models this natively. The correct workaround: the shared Work Item that links all these PRs is the measurement unit. The work item's cycle time (created → done) is the true delivery time.

### 6.4 The "Ghost PR" Pattern (Squash-then-Delete Branch Before Platform Ingestion)

If a developer: creates a branch → commits → squashes locally → pushes the single commit → opens a PR → the PR is merged and branch deleted → before the platform's first ingestion — the platform only ever sees one commit with no history. This is the worst-case scenario for all platforms. Only a Jira-state-based coding time fallback can recover the timing. Commit-only analytics for this pattern will always show near-zero coding time.

### 6.5 Monorepo with CODEOWNERS

For attribution to be team-aware in a monorepo, the platform needs: (1) the diff file list from each PR; (2) a CODEOWNERS-style path→team mapping table. This allows the platform to answer "what percentage of this PR touched files owned by Team A vs. Team B?" This is the correct model for cross-team PRs in a monorepo. Phase 1 implementation: parse `CODEOWNERS` file from the repo, store path→team mapping, annotate each PR with impacted teams based on diff. Phase 2: use impacted teams to attribute effort fractions to multiple teams (the fractional attribution model described in the matrix team report).

***

## 7. Daily / Weekly Effort Reporting and the Right Source Entity

For **daily effort reporting** (e.g., "what did each developer do this week?"), the correct source entity depends on granularity:

| Report | Primary entity | Secondary entity | Reason |
|--------|---------------|-----------------|--------|
| "PRs opened / merged this week" | PR | — | Direct PR event count |
| "Coding days this week" | Commit | — | Per-day commit activity |
| "Reviews performed this week" | PR review event | — | Review events live on PRs |
| "Tickets completed this week" | Work item | PR | Sprint/issue completion |
| "Effort distribution (investment balance)" | Work item | PR, Commit | All three layers combined[^1] |
| "Code churn / rework this week" | Commit | — | Requires diff analysis |
| "Cycle time for PRs merged this week" | PR | Commit (start time) | PR duration + commit start |

The Swarmia effort model (April 2025 update) explicitly weights these sources: PRs and commits are weighted more heavily than comments and reviews. Issue completions were removed from the FTE model because an issue being "done" is not the same as the developer being active — tickets can sit in "done" for days after the work was actually finished. This is the correct hierarchy: code events > collaboration events > state transitions.[^1]

***

## 8. Summary Recommendation for an Early-Stage Product

**Phase 1 — PR-only model (simplest correct thing):**
- Ingest PRs and their metadata (opened\_at, merged\_at, author, reviewers, linked issue IDs)
- Ingest commits on PR branches (pushed commits, retained even after merge)
- Cycle time = PR open → PR merge (coding phase is out of scope)
- Effort = PR count per contributor per week
- No work item linking required yet

**Phase 2 — Add commit evidence layer:**
- Record `first_commit_on_branch` timestamp for coding phase cycle time
- Track direct-to-main commits as `DIRECT_PUSH` events
- Add HALOC / code churn metrics (requires diff ingestion)
- Squash merge handling: retain pre-squash commits; mark squash commit with `merge_strategy: SQUASH`

**Phase 3 — Add work item layer:**
- Parse PR-to-issue links from branch names, PR bodies, commit messages
- Compute investment balance by issue label / category
- Add Jira/Linear/ADO work item ingestion for issue-state coding time
- CODEOWNERS-based monorepo path attribution

**Never expose:**
- Raw commit SHAs in primary dashboards
- Merge strategy in primary metrics (it's a filter/context item only)
- Branch names as primary navigation (they change, get deleted, are not stable identifiers)
- Pre-squash commit count as a headline metric (teams will optimize by making more micro-commits)

---

## References

1. [See a more accurate distribution of work with the updated effort model](https://www.swarmia.com/changelog/2025-04-25-updated-effort-model/) - We’ve refined our developer effort model based on your feedback and extensive testing. In this chang...

2. [Improve pull request flow with Swarmia](https://www.youtube.com/watch?v=TR4Y7Uej1_0) - Better pull request flow means three things: faster software delivery to end-users, less risky deplo...

3. [Developer effort (FTEs) | Swarmia docs](https://help.swarmia.com/metrics-and-definitions/developer-effort-ftes) - Activities are weighted differently, with pull requests and commits counted more heavily than review...

4. [How and When LinearB Counts Commits - HelpDocs & User Setup](https://linearb.helpdocs.io/article/afettcgj1q-how-and-when-linear-b-counts-commits) - LinearB counts commits by tracking repository activity, branch configurations, and optional integrat...

5. [Handling Squash Merges in LinearB - HelpDocs & User Setup](https://linearb.helpdocs.io/article/7ukyx6lrpu-how-does-linear-b-handle-squash-merges) - Learn how LinearB ensures accurate coding time metrics when squash merges are used, and how enabling...

6. [Metrics overview - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802633465) - Use Metrics overview to get the most out of Flow by: choosing the metrics that are most important fo...

7. [5 min Product Overview | Jellyfish Engineering Management Platform (2022)](https://www.youtube.com/watch?v=vfuavv0kbng) - Tour the Product: https://jllyf.sh/Product-Tour-YT
Book a Demo: https://jllyf.sh/Demo-YT
Visit us at...

8. [7 Top-Rated Alternatives to Cortex for 2026](https://jellyfish.co/blog/cortex-alternatives/) - Jellyfish's patented allocation model automatically connects engineering work to strategic categorie...

9. [GitClear: Data-driven insight for developer impact and code review | Product Hunt](https://www.producthunt.com/products/gitclear?launch=gitclear) - GitClear (previously Static Object) provides unprecedented data-driven insight into the world of you...

10. [Commit Activity Browser Demo: Developer Edition](https://www.youtube.com/watch?v=W4yAfu4-wIs) - Developers that incorporate the Commit Activity Browser into their daily routine discover several be...

11. [Branches - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802633585)

12. [Improved attribution when squashing commits - GitHub Changelog](https://github.blog/changelog/2019-12-19-improved-attribution-when-squashing-commits/) - In 2016, GitHub introduced commit squashing when merging a pull request. Then in 2018, we added supp...

13. [Include Co-authored-by lines from MR commits in squash ...](https://gitlab.com/gitlab-org/gitlab/-/work_items/593408) - (Disclosure: I used GitHub Duo Chat to help me articulate the following. 🙂) Problem

14. [Direct Commits to Main Are a Silent Quality Risk](https://www.minware.com/blog/direct-commits-to-main) - Direct commits to main branches often go unnoticed but pose a serious risk to delivery quality. Here...

15. [Monorepo Support in Code Coverage - Datadog Docs](https://docs.datadoghq.com/code_coverage/monorepo_support/) - Identify which files belong to each service or are owned by specific teams; Compare coverage across ...

