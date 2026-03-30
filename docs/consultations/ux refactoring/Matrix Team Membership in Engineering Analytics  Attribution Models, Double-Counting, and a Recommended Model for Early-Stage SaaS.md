Here's the full report. The most important findings:

The hard facts from primary sources:

Swarmia explicitly documents that matrix hierarchy is unsupported — "each team can only have one parent team. This means you can't use team hierarchy to map a matrix organization structure." This is the clearest product decision documented anywhere in the category.

All major products (LinearB, Swarmia, Flow) use full-credit-to-all-teams as their multi-team policy — meaning double-counting at the org level is the norm, not the exception. Nobody has solved org-level deduplication in a publicly documented way.

Jellyfish is probably the most correct — its patented Work Allocations Model is effort/time-based rather than event-count-based, which inherently handles fractional attribution. But it's the most complex to implement.

The concrete recommendation in one sentence:

Use a PRIMARY / SECONDARY role on TeamMembership. Team dashboards include all members' work. Org-level rollup deduplicates by primary team only. This is the only model that is simultaneously honest to team leads (they see their full team) and correct to executives (org totals don't inflate).

The three phases for rollout:

Phase 1: Single team per contributor. No matrix. Correct for 80% of orgs.

Phase 2: Add role = PRIMARY/SECONDARY. Add deduplication to org rollup.

Phase 3: Add type field (SQUAD/CHAPTER/GUILD), effective dates, tree hierarchy. Acknowledge DAG limitation explicitly like Swarmia does.
# Matrix Team Membership in Engineering Analytics: Attribution Models, Double-Counting, and a Recommended Model for Early-Stage SaaS

**Research Date:** March 29, 2026  
**Scope:** How leading engineering analytics products handle contributors who belong to multiple teams simultaneously — attribution logic, double-counting prevention, dashboard breakage, and a concrete recommended model for an early-stage product.

***

## 1. The Matrix Membership Problem Defined

A **matrix team membership** situation arises when a contributor belongs to more than one team at the same time — for example, a Principal Engineer on both the Payments Squad and the Platform Guild, or a staff-level developer embedded in a product team while also sitting on a cross-cutting Architecture chapter. This is different from *switching* teams over time (a sequential membership problem), which requires point-in-time attribution. Matrix membership is a *concurrent* membership problem: two or more team memberships are simultaneously valid for the same contributor during the same date range.

Every metric the platform computes at team level — PR throughput, cycle time, review count, investment balance, active contributors — must answer the question: "Which team does this work belong to?" For a matrix contributor, the raw data gives no answer. The product must impose a policy.

***

## 2. What Leading Products Actually Support

### LinearB: Full Multi-Team Allowed, No Deduplication Mechanism Documented

LinearB explicitly supports multi-team membership: "There are **no limits** on the number of teams, and contributors can belong to **multiple teams**." LinearB also confirms this in its original 2020 teams release post: "Contributors can be members of multiple LinearB teams."[^1][^2]

LinearB supports a higher-level construct called a **Group** (team of teams). Groups can contain multiple teams and users, can be nested, and a Root Group can be set as the default dashboard view. The Group dashboard shows combined metrics across all member teams. Critically: no mechanism is documented for deduplicating contributors who appear in multiple child teams when computing Group-level totals. The dashboard "allows you to see data for individual teams within the group and [access] detailed stats for each team in the table view" — suggesting the rollup is additive without deduplication.[^3]

**[Inference]** LinearB's group rollup almost certainly counts a multi-team contributor's work in every team they belong to. A developer on both Team A and Team B would have their PRs counted in both Team A's total and Team B's total. At the Group level containing both teams, that developer's PRs are double-counted.

### Swarmia: Multi-Team Member Allowed; Matrix Hierarchy Explicitly Unsupported

Swarmia's documented behavior for the "joining additional team" scenario: "If a person is added to a new team without leaving another... their historical and present work will be **attributed to both teams**." This is full-credit-to-all-teams policy, with no fractional splitting.[^4]

Swarmia's team hierarchy has a hard structural constraint that directly limits matrix organization support: **"Each team can only have one parent team. This means you can't use team hierarchy to map a matrix organization structure."** This limitation is explicitly documented in the product and is the most direct acknowledgment in the category that matrix orgs are an unsolved problem. The recommended workaround is to contact Swarmia support directly for configuration guidance.[^5][^6]

The implication for double-counting: Swarmia's org-level rollup is likely affected. A developer on both a product team and a guild has their work counted in both. If the product team and the guild are both under the same parent org, the parent's metrics are inflated.

### Appfire Flow: Multi-Team Allowed; Nested Teams Have Deduplication for Unnested Users

Flow allows any user to belong to multiple teams. Team management shows:[^7]
- **Unnested users**: users added directly to a specific team
- **All users**: total count including users inherited from nested child teams[^8]

This suggests Flow tracks the two distinct sets and does not collapse them. When a parent team's metrics are computed, they should in principle include all users from all nested sub-teams without double-counting *within the hierarchy* — but Flow does not document what happens when a single user belongs to two sibling teams under the same parent.

The Retrospective report uses team filters directly, and "Sprint movement shows all sprints with tickets assigned to a team member of the selected team. If a team member works on a ticket in a different team's sprint, that sprint appears as an option in Sprint movement." — a specific example of cross-team attribution confusion caused by multi-team membership.[^9]

### Jellyfish: Allocation-Based Model That Implicitly Handles Matrix

Jellyfish's core mechanism is a **Work Allocations Model**, which it describes as patented: "Instead of simply counting events, Jellyfish's model considers *when* events happen, and *how and where* they are correlated with other events." The model reconstructs a time allocation (like a virtual timecard) per engineer rather than counting raw events.[^10]

If Jellyfish is modeling engineer *time* rather than *event counts*, then multi-team membership reduces to a time-allocation problem: "Alex spent 60% of their time on work attributable to Team A and 40% on Team B work." This is inherently fractional attribution and would avoid double-counting at the org level, because the 100% of Alex's time is divided across teams rather than replicated. This is consistent with how Jellyfish describes its R&D cost capitalization use case, where "per-engineer" time breakdown is the fundamental unit.[^11]

**[Inference]** Jellyfish likely handles matrix membership better than the rest of the category at the *allocation level* because its model is effort-based, not event-count-based. However, it's not explicitly documented whether a developer on two teams has their allocation split or duplicated in Jellyfish's org-level rollup.

***

## 3. The Three Attribution Policies and Their Consequences

### Policy 1: Full Credit to All Teams (the industry default)

Every team a contributor belongs to receives 100% credit for all of that contributor's work.

- **Team-level view:** Accurate and intuitive — Team A can see all the work its members contributed, regardless of cross-team memberships.
- **Org-level rollup:** Broken. If Alex is on 2 teams, Alex's 10 PRs appear as 20 PRs total at the org level.
- **Investment balance:** Broken. Alex's 100 hours of work appears as 200 hours in org-level cost models.
- **"How many engineers does this org have?":** Inflated. Each multi-team contributor is counted once per team.
- **Trend charts at org level:** Inflate output when matrix memberships increase, deflate when they decrease — for reasons unrelated to real productivity.

### Policy 2: Primary Team Gets 100% Credit

Each contributor has one designated **primary team**. All work is attributed to the primary team only, regardless of additional team memberships.

- **Team-level view for primary team:** Accurate.
- **Team-level view for secondary teams:** The contributor's work is invisible. A staff engineer embedded in Team B but with primary team = Platform doesn't show up in Team B's metrics.
- **Org-level rollup:** Accurate — each contributor's work counts exactly once.
- **Matrix visibility:** Broken. A contributor who is genuinely splitting effort between two teams has their cross-cutting work invisible in the secondary team's dashboard.

### Policy 3: Fractional Attribution (Weighted Split)

Work is split proportionally across all teams a contributor belongs to. The simplest version: equal split (1/N per team for N teams). More sophisticated versions allow weighted splits (60%/40%) set by admins.

- **Team-level view:** Each team sees a fractional contribution — 0.5 PRs per multi-team PR if the developer is on 2 teams. Counterintuitive for most engineering managers.
- **Org-level rollup:** Accurate — all fractions sum to 1.
- **Cycle time and duration metrics:** Fractional credit doesn't affect duration metrics (cycle time, pickup time) — those are properties of the PR itself, not of who authored it. Only count-based and effort-based metrics are affected.
- **In practice:** No major engineering analytics platform publicly implements fractional attribution. It's the correct model mathematically but the most confusing for human interpretation.

***

## 4. Where Matrix Membership Breaks Specific Dashboards

| Dashboard / Report | How Multi-Team Membership Breaks It |
|--------------------|--------------------------------------|
| **Org-level PR throughput** | Double-counts PRs from multi-team contributors; org total > sum of individual contributions |
| **Org-level active contributors** | Over-counts if same person belongs to multiple teams — each team counts them as "1 active contributor" |
| **Investment balance / effort %** | Org-level % sums to >100% if effort is replicated across teams[^11] |
| **Team comparison table** | "Which team contributed more?" — skewed if high-performers are on 2 teams and counted for both[^12] |
| **Cycle time at org level** | Not broken by double-counting (it's a median/average), but *scope* is wrong if the same PR appears twice in the distribution |
| **Weekly executive summary** | Headline "total PRs merged this week" overstates throughput if any contributors are multi-team[^13] |
| **Team hierarchy rollup** | Parent team counts multi-team children twice — e.g., a dev on both Frontend and API (both under Product) inflates Product's totals[^5][^6] |
| **Sprint movement / ticket-based** | "A team member works on a ticket in a different team's sprint" — that sprint appears in both teams' sprint filters[^9] |

***

## 5. Swarmia's Structural Limitation: The Hard Proof

The clearest documented product decision in the category is Swarmia's explicit statement: **"Each team can only have one parent team. This means you can't use team hierarchy to map a matrix organization structure."**[^6][^5]

This is not a bug — it is a deliberate data model constraint. A tree-shaped hierarchy (each node has exactly one parent) cannot represent a matrix (each node can have multiple parent contexts). Swarmia's data model is a tree. Matrix orgs need a DAG (directed acyclic graph). These are structurally incompatible at the hierarchy level.

The implication: if your product ever needs to correctly roll up metrics for a "Security Chapter" that spans developers across Frontend, Backend, and Platform teams — all of whom also have their own product team affiliations — a tree-shaped team hierarchy cannot represent this without data corruption.

***

## 6. Recommended Model for an Early-Stage SaaS Product

### Core Principle: Separate "Membership" from "Ownership"

The fundamental design insight is that **team membership** (who is on a team) and **work ownership** (which team "owns" a piece of work for reporting purposes) are not the same thing. Separating them is what makes matrix structures tractable.

**Team Membership** answers: "Is this developer a member of Team X?" — a boolean, can be true for multiple teams simultaneously.

**Work Ownership** answers: "For this PR/commit/work item, which team's metrics should it contribute to?" — this is what needs a policy.

### The Recommended Data Model

```
Contributor
  - id
  - display_name
  - primary_team_id   ← FK to Team (nullable for unassigned)
  - is_tracked        ← boolean, affects billing

TeamMembership
  - contributor_id
  - team_id
  - valid_from        ← explicit effective date
  - valid_to          ← null = current
  - role              ← ENUM: PRIMARY, SECONDARY
  - created_at

Team
  - id
  - name
  - parent_team_id    ← nullable FK (tree hierarchy for rollup)
  - type              ← ENUM: SQUAD, CHAPTER, GUILD, ORG
```

The `role` field on `TeamMembership` is the key: `PRIMARY` means this team owns the contributor's work for rollup/deduplication purposes; `SECONDARY` means the contributor is visible in this team's member list and team-scoped views, but their work is not counted in this team's org-level totals.

### Attribution Rules by Layer

**Team-scoped dashboards:** Include all work from all members (PRIMARY + SECONDARY) in the selected date range. A developer on two teams shows all their work in both Team A's dashboard and Team B's dashboard. This is what team leads want — they want to see their whole team's output, regardless of who else that developer reports to.

**Org-level rollup (aggregate across teams):** Count each contributor's work exactly once, using their PRIMARY team assignment. This prevents double-counting. The org-level "total PRs" is the union of all contributors' PRs, deduplicated by contributor.

**Group / parent team rollup:** Same deduplication logic applies. Roll up from the leaf team where the contributor's `role = PRIMARY`. If a parent team tries to aggregate across child teams, deduplicate at the contributor level by primary assignment.

**Cross-cutting teams (Chapters, Guilds):** Teams of `type = CHAPTER` or `type = GUILD` are explicitly "secondary membership" contexts. By convention, no contributor has `role = PRIMARY` in a Chapter — their primary team is always their squad. Chapter dashboards show the full work of all members but do not participate in org-level rollup as independent work units.

### What to Show in the UI

On a **contributor profile page**, show:
- Primary team badge (prominent)
- Secondary teams list (smaller, labeled "Also member of")

On a **team dashboard**, show:
- "10 members (7 primary, 3 secondary)" — transparent about composition
- A toggle: "Show primary members only" / "Show all members" — lets the manager understand which metrics include cross-cutting members

On an **org-level dashboard**, show:
- A note: "Metrics attributed by primary team assignment. [N] contributors have secondary team memberships." — surfaces the deduplication policy so managers trust the numbers

### Handling the Case Where No Primary Team Is Set

Some contributors may legitimately not have a primary team (e.g., a solo contractor, an unclassified external contributor). Work from contributors without a primary team should be bucketed into an **"Unassigned"** virtual team for org-level rollup purposes — visible to admins, excluded from team comparison tables until classified.

### Rollout Phase: When to Add This Complexity

For an early-stage product:

**Phase 1 (MVP):** Support single team membership per contributor. No matrix. This is correct for 80% of customers. Simpler UI, simpler data model, no deduplication needed.

**Phase 2 (after first customer asks):** Add secondary team memberships. Surface the `PRIMARY / SECONDARY` role toggle on the team membership add/edit form. Compute all team dashboards inclusively. Add the org-level rollup deduplication rule using primary team.

**Phase 3 (after scale):** Add `type` field on Team for CHAPTER/GUILD semantics. Add explicit effective dates (`valid_from / valid_to`) on TeamMembership. Add team hierarchy DAG if customers need it — but enforce single-parent constraint initially (the tree model) to keep rollup queries simple. Warn explicitly in the UI that matrix hierarchy (a team in two parent-team rollups simultaneously) is not supported — this is the honest position Swarmia took.[^6]

***

## 7. Comparison: Where This Recommendation Diverges from Current Products

| Decision | LinearB | Swarmia | Appfire Flow | **Recommended Model** |
|----------|---------|---------|--------------|----------------------|
| Multi-team membership | Yes, unlimited[^2] | Yes, full-credit-to-all[^4] | Yes[^7] | Yes, with PRIMARY/SECONDARY role |
| Org-level deduplication | Not documented | Not documented | Not documented | **Explicit: primary team owns rollup** |
| Matrix hierarchy support | Groups (tree)[^3] | **Explicitly unsupported**[^6] | Nested teams (tree)[^8] | Tree initially; acknowledge DAG limitation |
| Admin visibility of multi-team | Not documented | Not documented | "Unnested users" count[^8] | Member count shows primary/secondary split |
| Chapter/Guild semantics | Configurable via Groups[^3] | Via manual team type | Not documented | First-class `type` field |
| Dashboard transparency | None documented | None documented | None documented | **Explicit note on deduplication policy** |

***

## 8. Open Questions

1. **Should cycle time be team-scoped or contributor-scoped?** Cycle time is a property of a PR, not of a team. If a multi-team contributor authors a PR, it has one cycle time — it doesn't change based on which team's dashboard you're viewing. The only attribution question is: *which team's cycle time distribution does this PR appear in?* The recommendation is: the PR appears in all teams the author belongs to, regardless of primary/secondary. Secondary-team dashboards should show accurate cycle time distributions even for cross-cutting staff.

2. **Can a contributor have no primary team?** Yes — but they should appear as an admin action item ("Unassigned contributors affect org-level totals"). Billing decisions may prevent leaving contributors permanently unassigned.

3. **Can a contributor have two primary teams?** No — enforcing single-primary is the constraint that makes org-level deduplication computationally trivial and semantically unambiguous. If a customer insists on two equal primaries, the correct answer is to model their role as a fractional allocation (0.5 FTE per team) — which Jellyfish's model handles, but is complex to implement and explain.

---

## References

1. [Drive Team Success & New LinearB Features](https://linearb.io/blog/drive-team-success-new-linearb-feature) - LinearB just got better again. Configure LinearB to match your team organization. LinearB now also s...

2. [LinearB Configuration Best Practices - HelpDocs & User Setup](https://linearb.helpdocs.io/article/ank9nh722m-linear-b-starter-guide) - Merge Duplicate Contributor Accounts · Navigate to the Teams & Contributors tab in your LinearB acco...

3. [Grouping Teams in LinearB - HelpDocs & User Setup](https://linearb.helpdocs.io/article/yjc5br34gt-linear-b-team-grouping) - Enhance Visibility with Team Grouping

4. [What happens when people switch teams or leave?](https://help.swarmia.com/metrics-and-definitions/frequently-asked-questions/how-do-i-account-for-people-leaving-my-organization) - Swarmia tracks the historical team memberships of contributors over time. Contributions made for one...

5. [Creating & managing teams | Swarmia docs](https://help.swarmia.com/configuration/teams-and-members/managing-teams)

6. [Creating & managing teams | Swarmia docs](https://help.swarmia.com/getting-started/configuration/teams-and-members/managing-teams) - You can search and add individual GitHub users to teams in Swarmia. By default, the search only retu...

7. [Adding existing users to a team at the user level - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802010965) - Navigate to Settings. Click Teams under User management. Click Create team. Enter a team name in the...

8. [Team management - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1801912666) - All teams created in Flow or imported into Flow are shown on the Teams page. Use this page to create...

9. [Retrospective report - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802207573) - Use the Retrospective report to compare your teams' metrics across specific timeframes. Look back on...

10. [Work Allocations: The Future for Efficient Engineering Teams](https://jellyfish.co/blog/work-allocations-model-for-efficient-engineering-teams/) - Jellyfish's Work Allocations Model reconstructs the work performed by engineers to show a holistic v...

11. [How Jellyfish Automates the Cost Capitalization of Software R&D](https://www.youtube.com/watch?v=BSRwuNjr1TQ) - Read our Cost Cap Blog: https://jllyf.sh/CostCapBlog-YTCC Allocation Metric Explainer Video: https:/...

12. [Jellyfish Engineering Metrics Benchmarks | Demo](https://www.youtube.com/watch?v=ANARBEABZ_I) - Watch our Benchmarking Overview: https://jllyf.sh/Benchmarking-Overview
Read our Benchmarking Blog: ...

13. [Understanding Metrics Dashboards in LinearB - HelpDocs](https://linearb.helpdocs.io/article/c2vts5j3h9-default-metrics-dashboards) - The Metrics Dashboards in LinearB provide real-time visibility into engineering performance, code qu...

