Here's the full report. The most concrete and immediately actionable findings:

The single most important architectural decision:
Never delete raw events. Store exclusions as metadata in a separate ExclusionRecord table and filter at query time. This is what all mature platforms do — it's what makes re-inclusion, audit trails, and "what if I undo this?" possible without a pipeline rerun.

The best documented pattern in the category is Flow's regex PR exclusion — with three specifically good ideas worth copying directly:

Live regex preview against the last 100 PRs before saving — admins see what will be excluded before committing

Excluded PRs remain visible in reports with a strikethrough, never silently dropped

If a PR stops matching the rule (e.g. "WIP" removed from title), it auto-re-includes, using the original created_at for time metrics

The biggest gap across the entire category: no audit log. No platform publicly documents a curation history — who excluded what, when, and why. Every customer with >5 admins will eventually ask "why did these numbers change?" and have no way to answer it. The CurationAuditLog table in section 10 is a 1-day implementation that becomes a significant trust-builder.

Gitwiser's "Reset Existing Analyses" toggle is the right escape hatch for expensive retroactive exclusions. Make the recompute opt-in, not automatic — give admins control over when to trigger it.

software.com's two-tier contributor exclusion — "exclude all activity" vs. "exclude authored PRs only" — is the correct model. Excluding a manager who reviews PRs but rarely writes code should not make those reviewed PRs appear unreviewed to everyone else. This is a one-day feature that eliminates an entire class of data corruption.
# Manual Data Curation in Engineering Analytics: Incremental Architecture, UI Patterns, and Audit Trails

**Research Date:** March 29, 2026  
**Scope:** How leading engineering analytics platforms let admins curate data — excluding developers, repos, PRs, and commits; merging/splitting identities; detecting bots — without triggering full re-syncs, with concrete documented UI workflows and architecture patterns.

***

## 1. The Core Architecture Problem: Exclusion vs. Re-Analysis

The fundamental design question is whether a curation action modifies stored data (triggers a pipeline re-run) or modifies the *interpretation* of stored data at query time (a filter on top of immutable raw data).

**Re-analysis model:** Raw events are stored. When an exclusion rule changes, the platform re-processes raw data to produce new derived metrics. Every change to exclusions requires a partial or full recompute job.

**Filter-at-query-time model:** Raw events are stored untouched. Exclusion rules are stored as metadata. Every query joins against the exclusion ruleset and filters results before returning them. No recompute job is needed; the effect is immediate.

In practice, most platforms use a **hybrid**: raw events are immutable and stored permanently; derived metrics (cycle time aggregates, throughput counts, investment balance) are precomputed and cached in materialized views or time-series tables. A curation change invalidates and recomputes only the affected cached aggregates — not the full raw pipeline.

Appfire Flow explicitly documents this hybrid: changing PR exclusion rules prompts "You'll be prompted to reprocess your PRs based on the exclusion rules... Changing Pull Request Tracking can cause slight delays in processing pull requests." The raw PR data stays in place; only the classification layer (included/excluded) is re-evaluated, and only the affected downstream aggregates are updated.[^1]

***

## 2. Excluding Developers

### software.com (Software): Two-Tier User Exclusion

software.com has the most granular and explicitly documented developer exclusion model in the category:[^2]

**Tier 1 — Exclude all PR activity:** Removes all PRs the user created AND all reviews they performed. Full removal from all metrics.

**Tier 2 — Exclude PRs created by this user only:** Removes the user's PRs from throughput, developer counts, and batch size metrics. But keeps their code reviews counting toward reviewer metrics (Time to Review, review load). The rationale: "typically used for managers, designers, or other roles that may open pull requests but are not part of the core development team. Their created PRs will not factor into developer counts. However, their code reviews and approvals on other PRs will still be counted to preserve the accuracy of metrics like Time to Review."[^2]

This two-tier design solves a real problem that every platform faces but most don't document: excluding a PR author completely orphans all PRs they reviewed, making those PRs appear unreviewed and corrupting reviewer-side metrics for the entire team. Tier 2 is the correct model for role-based exclusions (engineering managers who occasionally write code, DevRel contributors, contractor leads).

**Placement:** Settings → User Exclusions. No re-sync required; documented as immediate.

### Appfire Flow: Hidden vs. Excluded

Flow distinguishes two distinct exclusion modes:[^3]

**Hidden:** User is removed from dashboards, reports, and team lists. Their data is not deleted. They remain in the system and auto-merge suggestions still apply to them. The user's PRs become "unreviewed" in reviewer-cycle metrics — the same downstream corruption risk documented in the previous report.

**Excluded from metrics:** The user's commits and PRs stop contributing to metric calculations. However, PR reviews they performed on other people's PRs are handled differently depending on the calculation — the documentation explicitly warns: "all PRs the excluded user reviewed will become unreviewed PRs in Flow."[^4]

**Placement:** Settings → User Management → Users. The action is an admin toggle, applied immediately; no re-sync.

### LinearB: Exclude via Team Removal

LinearB's approach is less surgical: developers are excluded from metrics primarily by removing them from all teams. A contributor not on any team does not appear in team dashboards. Global "exclude from all reports" is documented as part of the people settings in Company Settings → Teams & Contributors.[^5]

**Placement:** Company Settings → Teams & Contributors → three-dot menu → remove from all teams or mark as inactive.

***

## 3. Excluding Repositories

### LinearB: Regex-Based Monitoring Rules with Per-Repo Override

LinearB's repo exclusion is architecture-level: repos that are not monitored are simply not ingested. But for already-monitored repos, exclusion works via:[^6]

**Global exclusion rules (Settings → Advanced → Exclude Branches):** Regular expressions applied globally across all repos. Excludes branches matching the pattern from all dashboard metrics.[^7]

**Per-repo Monitoring Rules (Settings → Git → three-dot → Monitoring Rules):** Repo-specific regex rules that override global rules. This is the right model for monorepos — you can exclude specific directories or file types at the repo level without affecting other repos.[^7]

**Auto-monitoring regex (Settings → Git → Monitoring Rules → global):** New repos matching a regex pattern are automatically included or excluded as they are discovered. This is the correct prevention mechanism for multi-org environments where new repos are constantly being created.[^6]

**Effect on existing data:** Not explicitly documented — implied to apply to new incoming data going forward, with historical data remaining as-is unless a manual reprocess is triggered.

### Appfire Flow: Repository Deactivation

Flow repos can be deactivated from Settings. A deactivated repo stops contributing new data and is hidden from dashboards. Historical data from that repo is preserved in the database but excluded from reports.

***

## 4. Excluding Pull Requests

### Appfire Flow: Regex Rules with Live PR Preview

Flow's PR exclusion is the most sophisticated in the category for rule-based exclusion:[^1]

**Rule creation flow:**
1. Settings → Report Settings → Configurations → General tab → "Pull request to exclude" → Create rule
2. Write a regular expression matching on: author username, PR title, or PR label
3. **Live preview:** Click "Test a Regular Expression" → modal shows most recent 100 PRs; PRs matching the regex are labeled "Matches" in real-time before saving[^1]
4. Save → confirm → reprocess triggered

**Reprocess behavior:** "Once the PR reprocessing finishes, PRs appear as excluded in your reports. Excluded PRs display differently in each report." Importantly: if a PR changes so the regex no longer matches (e.g., the "WIP" prefix is removed from the title), Flow automatically reprocesses and adds it back. And: "For time-based metrics like Time to first comment or Time to merge, the creation date of the PR is used to calculate the metric, not the time when Flow adds the PR back to reports and metrics." This is the correct behavior — cycle time anchors to the original PR creation date, not the date the exclusion rule was reversed.[^1]

**Excluded PR visibility:** Excluded PRs are not hidden — they appear in reports with visual markers. In the Work Log report, they show a slash through the cells. In the Review Workflow report, they appear with a strikethrough on the PR number. This surfaces excluded data visually rather than silently dropping it — admins can see what was excluded and why.[^1]

**PR comment exclusion:** Separate from PR exclusion — PR comments can be excluded by author or by text pattern using the same regex interface.[^1]

### LinearB: Branch-Level Outlier Manual Exclusion

LinearB operates at the branch level rather than the PR level for ad-hoc manual exclusions:[^8]

**Automatic outlier detection:** Branches with potential cycle time > 60 days AND in the 98th percentile of all active branches are automatically marked as outliers and excluded from cycle time calculations.[^8]

**Manual branch exclusion:** From the Activity tab → find any branch → three-dot menu → "Exclude Branch." Manually excluded branches show an **orange dot**; auto-excluded outliers show a **red dot**. The orange/red color distinction is a well-designed visual audit trail embedded directly in the data view.[^8]

**Reversibility:** "They can be returned to your cycle time metrics by clicking the three dots again, and selecting 'Cancel branch exclusion.'" All exclusions are reversible — the underlying data is never deleted.[^8]

### Gitwiser (Oobeya): Commit-Level Exclusion with Rebuild Toggle

Gitwiser documents the most granular commit-level exclusion in the category:[^9]

**Commit-level exclusion:**
1. Navigate to Gitwiser → select repository → Git Analytics
2. Scroll to "Contributions During the Selected Period"
3. Click **Exclude** next to the commit(s) to exclude
4. Excluded commits appear in an "Excluded Commits" section at the bottom of the page[^9]

**Global file-pattern exclusions:** Glob patterns (e.g., `**/*.xml`) can exclude entire file types from analytics across all repos.[^9]

**Rebuild toggle:** Global admin exclusion settings include a **"Reset Existing Analyses"** toggle — when checked, the new exclusion patterns trigger a reanalysis of all existing data. When unchecked, the exclusion applies only to new data going forward. This is the best-documented opt-in full-rebuild pattern in the category — the platform makes the choice explicit to the admin.[^9]

***

## 5. Bot Filtering

### software.com: Automatic Known-Bot Detection

"We automatically identify and exclude any pull request where the author is a known bot (e.g., dependabot)." The exclusion is automatic — no admin action required for the known-bot list. Additional criteria for automatic exclusion:[^2]

- Backmerges (head branch = default branch)[^2]
- Release PRs with no unique commits[^2]
- Long-lived branches with more than 3 unique contributing authors (classified as release branches, not feature work)[^2]

### LinearB: Bot Exclusion from Billing + Activity

LinearB excludes bots from contributor billing automatically. PRs opened by bot accounts are tracked (they can trigger WorkerB automation rules and consume credits) but the bot contributor is not counted in seat billing. Branch-based automation (CI commits) is handled via the branch exclusion regex mechanism.[^7]

### Appfire Flow: Manual Hide/Exclude (No Auto-Detection Documented)

Flow ingests all contributors including bots. No auto-detection is documented. The recommended approach is to use the hidden users mechanism to remove bot accounts from reports. Admins must identify bots manually from the user list.[^3]

**[Inference]** This is a significant gap in Flow compared to software.com and LinearB. A bot-keyword-detection system (e.g., auto-classify any user whose username contains `[bot]`, `dependabot`, `renovate`) would eliminate routine admin overhead.

***

## 6. Merging and Splitting Contributor Identities

See the full Contributor Identity Unification report for detailed workflows. The key points on reversibility and incremental recomputation:

**Flow's unmerge:** Clicking Unmerge on an alias in the Merge Users interface immediately separates the alias into an independent user. The underlying events (commits, PRs) attributed to the merged user are re-attributed to the separated alias going forward. Flow does not document whether historical aggregates are retroactively recomputed or only updated for new data.[^10]

**LinearB's unmerge:** Available from Company Settings → People & Teams. The contributor records are separated; documentation does not detail whether a recompute job is triggered or whether the separation applies only going forward.[^11]

**The correct architecture for merge/unmerge:** All raw events should store the raw alias ID (e.g., `git_email: old@example.com`) independently of the resolved Contributor ID. The `Contributor → Alias` mapping is a separate join layer. Merging = adding an alias to a contributor's mapping. Unmerging = removing it. Re-querying after a merge/unmerge reads through the current mapping and produces updated results without rewriting any event records. This is the filter-at-query-time model applied to identity resolution.

***

## 7. Audit Trail of Curation Decisions

This is the most significant gap across the entire category. No platform publicly documents a dedicated curation audit log accessible to admins.

### What Exists (Implicit Trails)

**LinearB branch outlier dots:** The orange (manually excluded) vs. red (auto-excluded) dot on each branch in the Activity tab is a per-branch visual audit record of exclusion state. It doesn't record *who* excluded the branch or *when*, but it does show *that* it was manually excluded.[^8]

**Flow excluded PR display:** Excluded PRs remain visible in reports with visual strikethrough markers. The PR is not deleted — its excluded status is displayed inline. This is a read-only audit trail embedded in the data view.[^1]

**Flow excluded commits section:** Gitwiser shows excluded commits in a dedicated "Excluded Commits" section at the bottom of the repository analytics page. Excluded entries remain visible and can be re-included.[^9]

### What Is Missing Everywhere

No platform documents:
- A timestamped log of "User X excluded Repo Y on Date Z"
- A history of regex rule changes (who created the rule, when, what it replaced)
- A log of contributor merge/unmerge operations with timestamps and actor
- An undo history for curation actions

**[Inference]** The correct design is a `CurationEvent` table: `(id, actor_user_id, action_type, target_type, target_id, before_state, after_state, created_at)`. Actions include: `EXCLUDE_CONTRIBUTOR`, `INCLUDE_CONTRIBUTOR`, `EXCLUDE_REPO`, `EXCLUDE_PR`, `EXCLUDE_BRANCH`, `MERGE_CONTRIBUTOR`, `UNMERGE_CONTRIBUTOR`, `EXCLUDE_COMMIT`, `ADD_BOT_RULE`, `REMOVE_BOT_RULE`. This table is append-only (never updated or deleted) and is surfaced in a Settings → Curation History admin view. It answers the question "why are this team's numbers different from last week?" — which is frequently the first question after any curation action.

***

## 8. Incremental Recomputation vs. Full Rebuild

### The Three Patterns Used in Practice

**Pattern 1 — Immediate filter (no recompute):** Exclusion rules are applied at query time. Dashboards immediately reflect the exclusion without any background job. The correct pattern for simple boolean exclusions (contributor on/off, repo on/off) where the excluded entity's contribution can be subtracted from pre-aggregated totals.

**Pattern 2 — Partial reprocess (affected entities only):** When a PR exclusion regex rule changes, only PRs matching the new or removed rule are re-evaluated. Their classification is updated, and only the downstream aggregates that included those PRs are invalidated and recomputed. Flow documents this: "slight delays in processing pull requests" — not a full pipeline rebuild.[^1]

**Pattern 3 — Opt-in full rebuild:** Gitwiser explicitly documents a "Reset Existing Analyses" toggle for global exclusion rule changes. The admin chooses whether the new rule applies retroactively to all historical data or only to future data. This is the correct UI for rules that would be expensive to apply retroactively (e.g., a new file-type exclusion that affects millions of commits).[^9]

### What Determines Which Pattern Is Correct

| Curation Action | Correct Pattern | Reason |
|----------------|----------------|--------|
| Exclude a contributor | Immediate filter | All their PRs/commits are identified by contributor_id join; subtract from aggregates |
| Exclude a repository | Immediate filter | All events from repo_id; subtract from aggregates |
| Exclude a PR manually | Immediate filter | Single entity; remove from cycle-time distributions, recompute median |
| Add PR title regex rule | Partial reprocess | Must scan all PRs for matches; update classification + invalidate affected time buckets |
| Exclude file types from code metrics | Opt-in full rebuild | Must re-diff all affected commits to recalculate HALOC, churn |
| Merge two contributor aliases | Immediate filter | Update alias→contributor mapping; queries automatically pick up new mapping |
| Unmerge contributor aliases | Immediate filter | Remove mapping entry; historical events re-attribute automatically |
| Change bot detection pattern | Partial reprocess | Re-evaluate authorship classification for all historical PRs from matching accounts |

***

## 9. UI Placement of Curation Controls

### The Two Anti-Patterns

**Anti-pattern 1: All curation buried in Settings.** The admin must navigate to Settings → Advanced → Configurations every time they want to exclude something they see in a dashboard. There is no path from "this PR looks wrong" to "exclude this PR" without leaving the current context.

**Anti-pattern 2: Curation only via bulk regex rules.** No way to exclude a single specific PR or a single branch — every exclusion must be expressed as a regex pattern that might accidentally match other items.

### The Better Pattern: Contextual Exclusion + Central Management

**Contextual (inline) curation:** Three-dot menu or right-click context menu on any PR, commit, branch, or contributor in any list or drill-down view, with options:
- Exclude this PR from metrics
- Exclude all PRs from this author
- Mark this branch as an outlier
- Mark this contributor as a bot
- Merge this contributor with…

LinearB documents this pattern for branches: the three-dot menu on any branch in the Activity tab exposes manual exclusion without leaving the view.[^8]

**Central management view (Settings → Data Curation):** A single page that shows:
- All active exclusion rules (regex patterns, with the count of currently-matched entities)
- All manually excluded entities (contributors, repos, PRs, branches) with exclusion date
- All merged contributor pairs with merge date
- All bot-classified accounts
- The curation history log (who did what, when)

This two-level model — inline quick actions for individual entities, Settings for policy-level rules — matches the admin workflows in both large and small orgs.

***

## 10. Recommended Architecture for an Early-Stage Product

### Immutable Raw Events Layer

Store all ingested events (commits, PRs, reviews, issue events) in an append-only events table. **Never delete or modify raw event records.** Exclusion is always metadata — a separate table of `ExclusionRule` and `ExclusionRecord` — never a deletion from the events table.

```sql
ExclusionRecord (
  id,
  target_type   -- ENUM: CONTRIBUTOR, REPO, PR, BRANCH, COMMIT, BOT_PATTERN
  target_id     -- FK to the excluded entity (or pattern string for BOT_PATTERN)
  scope         -- ENUM: ALL_ACTIVITY, AUTHORED_ONLY  (for CONTRIBUTOR)
  excluded_by   -- FK to User (admin who made the change)
  excluded_at   -- timestamp
  reason        -- optional free-text
  is_active     -- boolean (supports re-inclusion without deleting the record)
)

CurationAuditLog (
  id,
  actor_user_id,
  action_type   -- ENUM: EXCLUDE, INCLUDE, MERGE, UNMERGE, CLASSIFY_BOT, RECLASSIFY
  target_type,
  target_id,
  before_state  -- JSON snapshot of before
  after_state   -- JSON snapshot of after
  created_at
)
```

### Query Layer Joins Against Exclusions

All metric queries join against `ExclusionRecord WHERE is_active = true` and filter out excluded entities. This is Pattern 1 (immediate filter) — no recompute job needed for contributor/repo/PR exclusions. The exclusion takes effect on the next page load.

### Precomputed Metric Cache with Smart Invalidation

Maintain a materialized metrics cache (cycle time aggregates by team × time bucket, throughput counts, etc.). When an `ExclusionRecord` is inserted or deactivated, enqueue an invalidation job for only the time buckets that are affected by the excluded entity. For a PR excluded from 2025-Q3, invalidate only the Q3 2025 buckets for the PR author's team — not the entire historical dataset.

### The "Reprocess" Escape Hatch

For regex-based rules (PR title exclusion, file-type exclusion, bot-pattern rules), provide an explicit "Apply to historical data" toggle at rule save time. Default to "Apply from today forward" for performance. Let admins explicitly opt into a full reprocess when needed — as Gitwiser does.[^9]

### Phase 1 Curation (Minimum Viable)

- Contributor on/off toggle (include/exclude from metrics) — immediate filter
- Repository on/off toggle — immediate filter
- Bot account flag — immediate filter, manual designation
- Three-dot "Exclude this PR" inline action — single PR exclusion, immediate filter

### Phase 2 Curation

- PR exclusion regex rules with live preview (Flow's regex test modal pattern)[^1]
- Branch exclusion regex rules (LinearB's Monitoring Rules pattern)[^7]
- Contributor merge/unmerge UI
- Curation audit log (read-only admin view)

### Phase 3 Curation

- Opt-in full reprocess with progress indicator for rule changes
- File-type / directory exclusion for code metrics
- Automated bot detection (keyword pattern matching on username + email)
- Two-tier contributor exclusion (all activity vs. authored PRs only, as per software.com)[^2]
- Excluded entity visualization in reports (strikethrough/slash markers as in Flow)[^1]

---

## References

1. [Excluding pull requests - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802141893) - Once the PR reprocessing finishes, PRs appear as excluded in your reports. Excluded PRs display diff...

2. [Data Filtering and Exclusions - Software Support](https://docs.software.com/article/130-data-filtering-and-exclusions) - To provide the most accurate and actionable engineering metrics, our platform automatically filters ...

3. [Hidden users](https://help.pluralsight.com/hc/en-us/articles/24352522298260-Hidden-users) - Flow ingests data from all users who have contributed to your repos. This includes all contributors ...

4. [Exclude - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802043732) - To exclude a user from all reports, click the check box next to any users you want to exclude. Use t...

5. [How do I manage the number of contributors in my account?](https://linearb.helpdocs.io/article/7jda9bydfa-account-page) - The account page helps you manage the number of LinearB team contributors active in your account.

6. [Configuring Auto-Monitoring for Git Repositories - LinearB - HelpDocs](https://linearb.helpdocs.io/article/pizvzinzy4-auto-detecting-git-hub-repos) - Automatically include new repositories as they are created or discovered. · Use regex-based rules to...

7. [Excluding Branches and Files from Git Metrics Dashboards - LinearB](https://linearb.helpdocs.io/article/04kg2oyhhr-how-do-i-exclude-branches-from-my-dashboards) - Learn how to exclude specific branches and file types from LinearB dashboards to keep your metrics c...

8. [How Does LinearB Classify Branches As Outliers - HelpDocs](https://linearb.helpdocs.io/article/ry5nht6c9j-how-does-linear-b-classify-branches-as-outliers) - Branches will be marked as outliers if they have a potential cycle time of greater than 60 days, and...

9. [Git Analytics Exclusions](https://docs.oobeya.io/gitwiser-repo-analytics/settings-for-git-analytics/git-analytics-exclusions)

10. [Merge users - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802404067) - Flow has a dedicated user merge page to help you navigate potential and recommended merges. The user...

11. [Auto-Merge for Contributors in LinearB - HelpDocs & User Setup](https://linearb.helpdocs.io/article/5u3jzvjhbq-auto-merge) - Automatically unify contributor identities across Git and PM tools to keep attribution accurate and ...

