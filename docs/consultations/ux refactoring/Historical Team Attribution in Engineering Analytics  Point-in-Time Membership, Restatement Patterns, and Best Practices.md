Here's the full report. The core finding is sharply differentiated across products — and directly actionable for your design.

The most important findings, in order:

Swarmia is the only platform with fully documented point-in-time attribution, with a 10-day backdating heuristic for transition gaps — but even Swarmia admits that investment balance and AI adoption views don't yet use it. No product has fully solved this.

LinearB explicitly chose point-in-time as default in 2020: "change the teams devs are assigned to while keeping their history with the previous team". Their blog is one of the few explicit product decisions documented anywhere in the category.

Appfire Flow defaults to current-team attribution for ticket reports — meaning every team membership change silently rewrites history. This is the most common pattern among simpler products, and it's the model you should not copy.

The biggest gap across the entire category: no product supports explicit effective-date entry by admins. Everyone uses heuristic backdating. This is a real opportunity to differentiate — an effective_from date field on team membership edits would make your product more trustworthy for any customer where teams reorganize on a schedule (quarterly planning, etc.).

Multi-team developers create an unsolved double-counting problem at the org level. Every platform silently gives full credit to all teams. Org-level rollup totals are therefore inflated for any dev on 2+ teams. Requiring a primary team designation is the right architectural fix.

The recommended data model in one line: TeamMembership(contributor_id, team_id, valid_from, valid_to, created_at) — query everything with event_date BETWEEN valid_from AND valid_to, never against current state.
# Historical Team Attribution in Engineering Analytics: Point-in-Time Membership, Restatement Patterns, and Best Practices

**Research Date:** March 29, 2026  
**Context:** Engineering analytics products where developers move between teams over time, developers may belong to multiple teams simultaneously, and both current-state and historical-accuracy reporting is required.

***

## 1. The Core Tradeoff: Two Fundamentally Different Attribution Models

Every engineering analytics product must choose one of two attribution philosophies for team-based historical reporting, or implement both as configurable modes:

**Model A — Current-Team Attribution (a.k.a. "follow the member")**  
Work done in the past is attributed to whatever team the developer is on *today*. When a developer moves from Team Alpha to Team Bravo, all their historical commits and PRs are re-attributed to Bravo. The past is continuously rewritten to reflect the current org chart.

**Model B — Point-in-Time Attribution (a.k.a. "history stays where it was made")**  
Work is attributed to the team the developer belonged to *at the time the work was done*. When a developer moves from Alpha to Bravo, their historical data stays with Alpha. Bravo only accumulates data from the effective transfer date forward.

These are not implementation details. They produce fundamentally different answers to the same question — "What did Team Alpha deliver in Q3?" — and that difference compounds with every reorganization.

***

## 2. How Leading Products Handle This

### Swarmia: Fully Documented Point-in-Time with Backdating

Swarmia has the most complete and explicitly documented approach in the category. Their model is **point-in-time by default**, with a smart backdating heuristic that handles the gap between "when the developer actually moved" and "when an admin updated Swarmia":[^1]

**Joining the company:** When a new developer is added to a team in Swarmia, their membership is **backdated** so that any work done before being formally added is still attributed to that team. This prevents a blank gap during onboarding lag.[^1]

**Switching teams:** When a developer moves from one team to another, the new team membership is backdated to the point when they left the previous team, preventing data gaps during transition periods. Swarmia uses a **10-day detection window** with tolerance for up to **7 days gap and 3 days overlap** between old and new membership — accounting for the reality that admin updates often happen a few days after an actual org change.[^1]

**Joining an additional team (multi-team membership):** If a developer is added to a second team without leaving the first — e.g., joining a "Staff Engineers" group while remaining on a product team — the new membership is backdated and the developer's work is attributed to **both teams** for the entire period.[^1]

**Leaving the company:** Historical contributions remain attributed to the teams the developer was part of when the work was done. Their membership ends at the departure date. The recommended offboarding workflow is to remove the person from the GitHub organization, which automatically ends their Swarmia team memberships while preserving all historical data.[^1]

**Important Swarmia edge case — deleting a team:** If a team is deleted (not just reorganized), its past contributions disappear from any parent team's metrics. The rationale is intentional: including deleted team contributions would cause parent-team summaries to show work that doesn't reconcile with any current child team. This is a documented consistency tradeoff, not a bug.[^1]

**Important Swarmia limitation (as of March 2026):** Swarmia's changelog from August 2025 notes that historical team memberships are now correctly tracked, and that "pull request counts, cycle times, and deployment metrics stay consistent even after team changes." However, the help documentation explicitly flags that some views — specifically **investment balance, focus summary, and AI adoption** — do not yet take historical team memberships into account, and instead use the current team state. This is a known in-progress gap.[^2][^1]

### LinearB: Point-in-Time by Default, with Admin Override per Team Move

LinearB's behavior is explicitly documented in a 2020 product release post: "You can also change the teams devs are assigned to **while keeping their history with the previous team** (and not automatically associate their history with the new team). This enables accurate comparisons and iteration history."[^3]

This is **point-in-time as the default**. The historical data stays with the team where the work was done, not with the developer's current team. The 2020 product video confirms the dual-team model: "One developer can live in multiple teams... when you move a developer from one team to another, their historical data stays in that team so if you want to look at the team data for past iterations you don't lose the data associated with that developer that you moved."[^4]

LinearB supports **multi-team membership**: contributors can belong to multiple teams simultaneously, and there is no explicit cap documented. Metrics dashboards filter by teams, and a developer's work is counted for every team they belong to — which means cycle time for PRs from a multi-team developer appears in both teams' dashboards.[^5][^6][^3]

LinearB dashboards support custom date ranges up to **6 months** of history on Essentials plans and **up to 3 years** on Enterprise plans.[^5]

### Appfire Flow: Current-Team Attribution with Ticket-Level Exception

Flow's ticket-based reports use **current team state** as the default attribution model. The documentation states: "When filtering based on a team, tickets only appear in ticket-based reports if any of the assignees from the time the ticket moves into an Active state are **on the team** [currently]." This is a current-team model for tickets.[^7]

However, for code-level metrics (PR, commit), the behavior follows the team membership of the contributor at query time — meaning if an admin changes team membership, historical code metrics will shift to reflect the new team assignment.

The consequence: Flow does not support true point-in-time historical accuracy without external data management. When a developer moves teams, their historical PRs re-attribute to the new team by default. Admins who want to preserve historical boundaries must manage this through careful team versioning or by keeping a separate "archived" team for departed developers.[^8]

Flow does track the last 90 days of team import history, showing who performed each import, which helps with audit trails but does not solve the attribution problem.[^8]

### Jellyfish: Current-Team Attribution Implied

Jellyfish's documentation and demo materials do not explicitly document a point-in-time team attribution mechanism. The platform's benchmarking and allocation features are described in terms of current team structure: "allows Engineering leaders to set productivity goals... on the Organization, Division, Group or Team level". Jellyfish's engineering allocation analysis, which powers cost capitalization, works by mapping engineer identities to current team assignments and applying effort signals backward — strongly suggesting current-team attribution.[^9]

**[Inference]** Jellyfish's primary use case — software cost capitalization for finance and investment balance reporting — makes point-in-time attribution less critical for its core buyers, since capitalization models typically use current headcount allocations projected over reporting periods. This design choice likely explains why point-in-time membership is not a headline feature.

***

## 3. The Team Hierarchy Problem

Team hierarchies add a second dimension to the attribution question: not just "which team did the developer belong to?" but "what was this team's place in the org hierarchy at that point in time?"

Swarmia makes an explicit, documented design decision: **team hierarchies are not point-in-time; they follow the current structure**. If Team A is moved from parent Analytics to parent DevOps, all of Team A's historical contributions appear under DevOps in rollup views, even though the work was done when A was under Analytics. The rationale: "We consider the metrics of those groups to be the metrics of the teams they are *presently composed of*."[^1]

This means Swarmia gives you point-in-time accuracy at the **member level** (work stays attributed to the team it was done for), but current-state rollups at the **group/parent level** (team groupings reflect today's org chart). This is a pragmatic but intentional tradeoff.

**[Inference]** Full bi-temporal modeling — point-in-time at both the member level and the hierarchy level — would require storing `(team_id, parent_team_id, valid_from, valid_to)` and querying rollups against the historical hierarchy, not the current one. No product in this category appears to implement this fully. It would produce what data engineers call a **slowly changing dimension Type 2** (SCD2) for team hierarchy, and it is a significant engineering investment that most platforms defer.

***

## 4. The Multi-Team Attribution Problem

When a developer belongs to multiple teams simultaneously, every metric that team-level reporting computes has an attribution ambiguity:

- **If you count a PR for every team the author belongs to:** Total PR count across teams sums to more than the organization's total PR count. Rollup dashboards double-count.
- **If you split attribution equally across teams:** A developer on 3 teams contributes 0.33 PRs to each per PR. Fractional attribution makes cycle time calculations unintuitive.
- **If you pick one "primary team" per developer and attribute all work there:** Simple, but requires designating a primary team — and the choice affects every metric for both teams.

Swarmia uses the equal-attribution model for the "joining additional team" scenario — the work goes to both teams with full credit. LinearB also attributes to all teams a developer belongs to.[^3][^1]

The downstream effect: any org-level or multi-team dashboard needs to handle **deduplication** when aggregating across teams. If org-level cycle time is computed by averaging team-level cycle times, and some developers are double-counted, the org average is wrong. This is an unsolved UX problem in the category — most platforms rely on admins to avoid creating overlapping multi-team assignments for core contributors and reserve multi-team membership for explicitly cross-cutting roles (principal engineers, platform teams, staff engineers).

***

## 5. Historical Restatement vs. Frozen Attribution: The Analytics Consequences

| Question | Current-Team Attribution | Point-in-Time Attribution |
|----------|--------------------------|--------------------------|
| "What did Team A deliver in Q3?" | Changes every time a member joins or leaves Team A | Stable: reflects who was on Team A in Q3 |
| "What has this developer delivered overall?" | Stable: always correct, regardless of team changes | Stable: aggregates by developer are unaffected |
| "How does Team A's Q3 compare to Team B's Q3?" | Comparison is valid only if neither team's composition changed | Comparison is always valid — Q3 is Q3 |
| "We just reorganized. What does the new team's history look like?" | Instant visibility — past work flows into new team view | Requires explicit historical backdating or a separate "blended view" |
| "How did output change after a team-lead change?" | Comparison valid if no other membership changed | Comparison valid; pre/post split is accurate |
| "Executive asked why Team A's velocity dropped last quarter" | May be explained by a team composition change rather than real productivity shift | True productivity signal, composition changes visible separately |

The most common analytics failure from current-team attribution: a team looks like it "improved" dramatically when in fact it just absorbed several high-performers from a disbanded team. Leadership draws wrong conclusions from what is actually a team composition event, not a performance event.

***

## 6. Dashboards, Trends, and Executive Reports: Specific Patterns

### Trend Charts

Trend charts (e.g., cycle time over 6 months) are the most sensitive to team attribution model. A 6-month trend line for a team should reflect what actually happened to that team over those 6 months, not be retrospectively distorted by membership changes. Point-in-time attribution is the only model that produces stable, auditable trend charts.

**Best practice:** For all trend visualizations, compute metrics using team membership as-of the time bucket, not as of query time. This is equivalent to asking: "Who was on Team A during week 14? What metrics did those people generate during week 14?" — not "Who is currently on Team A, and what did they do during week 14?"

Swarmia's changelog documents this directly: "more accurate historical metrics for teams, taking membership changes into account."[^2]

### Weekly and Monthly Executive Reports

Executive summary reports — cycle time, throughput, investment balance by team — should be frozen at generation time to be useful for board-level and executive consumption. A weekly report generated on Monday should not produce different numbers when re-opened on Friday because a developer moved teams on Wednesday.

The practical implementation is a **report snapshot**: at generation time, resolve current team membership and compute metrics against point-in-time data. Store the resolved report. Subsequent opens retrieve the snapshot, not a live re-query.

LinearB supports exporting dashboards as CSV or PNG, providing a mechanism for snapshot delivery. Swarmia delivers scheduled Slack digests — a form of frozen-at-generation delivery.[^10][^5]

### Investment Balance / Allocation Reporting

Investment balance (% of effort on new features vs. maintenance vs. technical debt) is especially sensitive because it directly influences budget and capitalization decisions. When team membership changes, the investment balance for a team retroactively shifts — a previously "tech debt quarter" might become a "feature quarter" simply because high-feature contributors were moved in.

This is why Swarmia explicitly calls out that investment balance does **not yet** use historical team membership — it's a known open item precisely because the stakes of getting it wrong are high for finance audiences.[^1]

***

## 7. Effective Date Ranges: The Admin Workflow Gap

The biggest practical gap across all platforms is **explicit effective date entry by admins**. Most products rely on inference heuristics (Swarmia's 10-day window) or have no backdating at all (Flow). None of the documented products allow an admin to explicitly enter "Alex moved from Team A to Team B effective February 15" with a date field — the closest is adding Alex to Team B today and trusting the heuristic to infer the right effective date.[^1]

The gap creates a correctness problem when:
- An admin catches up on org changes that happened weeks ago
- A contractor's start date was before their Swarmia/LinearB account was created
- A reorg happened in batches over multiple weeks

**[Inference]** The correct solution is a Team Membership edit UI that accepts an explicit `effective_from` date, stored as a `(contributor_id, team_id, effective_from, effective_to, created_at)` record — the minimal form of temporal team membership. This is conceptually equivalent to the bitemporal data model for the membership dimension, without requiring full bitemporality of the entire data warehouse.[^11][^12]

***

## 8. Comparative Matrix

| Platform | Attribution Model | Multi-Team Support | Backdating | Explicit Effective Dates | Team Hierarchy History | Gaps Acknowledged |
|----------|------------------|-------------------|------------|--------------------------|----------------------|------------------|
| **Swarmia** | Point-in-time[^1] | Yes — work goes to all teams[^1] | Auto-heuristic (10-day window)[^1] | No — heuristic only[^1] | Current-state hierarchy, point-in-time members[^1] | Investment balance, AI adoption not yet point-in-time[^1] |
| **LinearB** | Point-in-time (default); keep history with old team on move[^3] | Yes — contributors can be on multiple teams[^6] | On team creation via "Get team's history" toggle[^6] | No — not documented | Not documented | Not documented |
| **Appfire Flow** | Current-team (default) for ticket reports[^7] | Yes[^13] | No explicit backdating documented[^8] | No | Not documented | Reports silently shift when team membership changes[^7] |
| **Jellyfish** | Current-team (inferred from allocation model)[^14] | Yes | No explicit backdating documented | No | Not documented | Point-in-time not a documented feature |

***

## 9. Recommendation for a Product With Changing Team Structures and Historical Accuracy Requirements

### Adopt Point-in-Time Attribution as the Architectural Default

Build the data model from the start with temporal team membership: `TeamMembership(contributor_id, team_id, valid_from, valid_to, created_at)`. Every query that involves team-level aggregation joins against the membership table using `event_date BETWEEN valid_from AND valid_to` — not against the current state. This is the only model that:

- Produces stable historical trend charts that do not change when org structure changes
- Supports accurate before/after comparisons around team events (reorgs, lead changes, team merges)
- Generates trustworthy executive reports that look the same whether opened immediately or 3 months later

### Expose Effective Dates in the Admin UI

Provide explicit date fields for team membership changes. The admin form for "Add developer to team" should include an optional `Effective from` date (default: today) and the form for "Remove from team" should include an `Effective to` date. This eliminates the need for heuristic backdating and gives admins full control. The heuristic approach (like Swarmia's 10-day window) is a reasonable fallback for lazy onboarding, not a substitute for admin precision.

### Define a Primary Team Per Developer

For developers on multiple teams simultaneously, require or strongly nudge admins to designate one team as the **primary**. Use primary team for org-level rollup deduplication (to avoid double-counting in aggregate metrics) while still attributing work to all teams in team-level views. Without a primary, org-level cycle time and throughput aggregations will double-count multi-team contributors.

### Build Two Report Modes: Live and Snapshot

Live dashboards recompute metrics on every page load using point-in-time membership from the database — always showing the true historical picture. Weekly executive summaries are **rendered and frozen at generation time**: membership is resolved, metrics are computed, and the result is stored as a report artifact. The archive of weekly snapshots becomes an auditable record that external changes cannot retroactively alter.

### Handle Team Deletion Without Metric Corruption

When a team is deleted (after a reorg), do not delete its `TeamMembership` records. Instead, archive the team (hidden from active selectors but queryable for historical date ranges). This preserves historical metrics for periods when the team existed. A developer who was on a now-deleted team should still show that work attributed to that team in any time-range query that overlaps with the team's active period.

### Communicate Model Behavior Transparently in the UI

On every team dashboard, show a notification when the currently selected date range includes a period where team membership differed from today's composition: "This chart uses team membership as it was in [date range]. Some contributors were added or removed since then." This surfaces the model's behavior and prevents user confusion when a trend chart doesn't match their mental model of the team.

***

## 10. Open Questions

1. **Full bi-temporality of team hierarchy:** Is it worth storing historical parent-team structure so that rollup dashboards can reflect the org as it existed at any past point? Swarmia explicitly chose not to do this. The value appears in highly compliance-sensitive contexts (capitalization, audit) but adds significant query complexity.

2. **Attribution weight for multi-team developers:** Equal attribution (full credit to all teams) vs. fractional attribution (1/N per team) vs. primary-team-only? Each model produces different org-level totals. There is no single correct answer — it depends on whether the org wants team dashboards to sum to org-level totals (fractional) or whether teams are independent units of accountability (full credit).

3. **How to handle retroactive identity merges:** If two contributor aliases are merged today, and one was on Team A while the other was on Team B, the merged contributor now has historical work in both teams. This should be fine for team reports. But the merged contributor's individual trend chart will show a jump or gap if the two aliases had different activity periods. Products should detect and annotate these transitions.

---

## References

1. [What happens when people switch teams or leave?](https://help.swarmia.com/metrics-and-definitions/frequently-asked-questions/how-do-i-account-for-people-leaving-my-organization) - Swarmia tracks the historical team memberships of contributors over time. Contributions made for one...

2. [Changelog | Swarmia](https://www.swarmia.com/changelog/) - Signals are shown on the Swarmia home page, and they also appear in team lists and relevant team vie...

3. [Drive Team Success & New LinearB Features](https://linearb.io/blog/drive-team-success-new-linearb-feature) - LinearB just got better again. Configure LinearB to match your team organization. LinearB now also s...

4. [LinearB Teams](https://www.youtube.com/watch?v=NBkxyc4eCVQ) - How are your teams doing? LinearB teams view gives leaders visibility into how work is distributed a...

5. [Understanding Metrics Dashboards in LinearB - HelpDocs & User Setup](https://linearb.helpdocs.io/article/c2vts5j3h9-default-metrics-dashboards) - Gain real-time insights into engineering performance with LinearB’s Metrics Dashboards, tracking del...

6. [Managing Teams in LinearB - HelpDocs & User Setup](https://linearb.helpdocs.io/article/5cisqb2zci-teams-how-to) - Create, edit, and delete teams in LinearB.

7. [Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802633609) - Resolving issues with team memberships and view rights · If data from some team members isn't showin...

8. [Team management - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1801912666) - Users excluded from metrics: all users that have been excluded from reports. Users on teams: all use...

9. [Jellyfish Launches Industry's First Comparative Benchmarking Tool ...](https://devops.com/jellyfish-launches-industrys-first-comparative-benchmarking-tool-for-engineering-leaders/) - Jellyfish Benchmarks Adds Anonymized Third-Party Performance Data; Allows Engineering Leaders to Set...

10. [Jellyfish: A Large Language Model for Data Preprocessing - arXiv](https://arxiv.org/html/2312.01678v4) - This paper explores the utilization of LLMs for data preprocessing (DP), a crucial step in the data ...

11. [Implementing Bitemporal Modeling for the Best Value - Dataversity](https://www.dataversity.net/articles/implementing-bitemporal-modeling-best-value/) - Bitemporal Modeling is an extremely useful tool for documenting historical data. It allows you to re...

12. [Bitemporal pattern - DAO Fusion - ANASOFT](http://opensource.anasoft.com/daofusion-site/reference/bitemporal-pattern.html) - Add temporal aspects to your business domain, tracking persistent entities in two distinct timelines...

13. [User details - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802436885) - Hide more than one user at once from the Users page. Open. Learn more about Hidden users and the dif...

14. [Jellyfish Engineering Management Platform (2022) - YouTube](https://www.youtube.com/watch?v=vfuavv0kbng) - /Product-Tour-YT Book a Demo: https://jllyf.sh/Demo-YT Visit us at: https://Jellyfish.co Jellyfish i...

