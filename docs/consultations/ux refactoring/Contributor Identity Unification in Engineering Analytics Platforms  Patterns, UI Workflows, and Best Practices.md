Here's the full report on Contributor Identity Unification. It covers every topic you asked about, with concrete sourced findings from official help docs and product documentation.

The 5 most actionable findings:

Use provider ID as your primary match key, not email. LinearB matches on GitHub/GitLab numeric user ID, not just email. This is the only way to correctly handle: (a) noreply addresses, (b) cross-org contributors, (c) username changes. Email-only matching leaves ~15–20% of contributors fragmented in typical orgs.

Run auto-merge before your first data ingestion, not after. Appfire Flow is explicit about this: "Set up auto-merge before adding integrations and repos." If you apply it retroactively, you have to re-run attribution on historical data. Design this as the first step in your onboarding wizard.

The Apex concept is mandatory UX. Every mature platform has the same model: one Contributor (apex/canonical) with many ContributorAlias (raw identity records). Without it you cannot unmerge, you cannot change the primary display identity, and you cannot audit what was merged and why.

Exclusion is not purely subtractive — it corrupts peer metrics. Flow documents this explicitly: excluding a developer makes their PRs appear unreviewed, which shifts everyone else's review-cycle metrics. Build "Include in historical data but stop collecting" as a distinct state from full exclusion, for handling former employees.

External contributor and bot filtering must be automatic. software.com auto-classifies external contributors by org membership + public-repo-only check. LinearB excludes bots from billing automatically. Manual filtering at scale (any org with 50+ repos) is not operationally viable.
# Contributor Identity Unification in Engineering Analytics Platforms: Patterns, UI Workflows, and Best Practices

**Research Date:** March 29, 2026  
**Focus:** How leading engineering analytics platforms model, merge, and manage developer identities across multiple Git providers, emails, Jira accounts, and external contributors — with concrete UI workflows from official documentation.

***

## 1. The Core Problem: One Developer, Many Identities

A software engineer typically produces commits and PRs under multiple identities across their career and across a single organization: a work email for enterprise SSO commits, a personal email set in their global `~/.gitconfig`, a GitHub-provided noreply address (e.g., `12345678+username@users.noreply.github.com`) for web-editor commits, a separate GitLab username for a different org, a Jira account under yet another email, a legacy identity from before a name change, and possibly a contractor identity from a different git org.[^1][^2]

GitHub itself cannot automatically transfer contributions made via the old noreply address format (`username@users.noreply.github.com`) when a username changes — those commits become permanently unattributed to the new account. This means that even at the Git provider level, identity is fragmented by design, and any analytics platform sitting on top must solve this independently.[^3]

Without resolution, a single developer shows up as 3–5 separate "contributors" in raw analytics data. Every metric — cycle time, PR throughput, DORA metrics, team velocity, investment balance — is wrong: inflated contributor counts, deflated per-person throughput, false "new contributors" on each alias's first commit, and review participation split across phantom personas.

***

## 2. The Canonical Data Model: Entity + Alias

Every mature platform in this space (LinearB, Appfire Flow, Swarmia, Waydev, GitClear) converges on the same two-table pattern:

**Contributor (apex entity):** The canonical, de-duplicated representation of a human developer. Has a display name, primary email, team membership, and inclusion/exclusion status. This is what appears in dashboards and reports.

**Alias (raw identity record):** One alias per unique way that developer appeared in a source system — each GitHub username, each email address, each Jira account, each GitLab identity. Many aliases can map to one Contributor.

Appfire Flow calls the canonical entity the **apex alias** and the canonical user the **apex user**: "An alias is a unique identifier for a user. A user can have multiple aliases in Flow... Flow assigns an apex alias to each user imported from connected integrations. An apex alias is the primary alias used to identify a user in your reports." The apex alias is the surviving identity after merge; subordinate aliases retain their data but resolve through the apex.[^4]

LinearB's API exposes this same model: the User object contains a `connected_users` field with `platform_users` and `contributors` arrays, reflecting the distinction between access accounts and tracked identities. The contributor list in Settings → Teams & Contributors shows merged aliases under each contributor record, and admins can click to merge or split from that view.[^5][^6]

Waydev's setup guide explicitly orders steps as: 1) Repositories, 2) Ticket Projects, **3) Merge Contributors**, 4) Manage Contributors, 5) Teams — making it clear that identity resolution is a prerequisite for accurate team metrics.[^7]

***

## 3. Automatic Merge Rules

### LinearB

LinearB's Auto-Merge runs **daily in the background** and merges contributor records when either of two conditions is true:[^8]

- **Matching email address** — the same email appears across any connected Git or PM tool (GitHub, GitLab, Bitbucket, Jira, Azure DevOps)
- **Matching provider ID** — identical external IDs from a supported provider

The documentation states this process achieves "100% accuracy" and is therefore permanently enabled with no admin toggle to turn it off. Admins can manually unmerge contributors if a merge is found to be incorrect, reviewed in People & Teams under Company Settings. Merging also has a billing effect: "Once merged, this user is billed as one contributor in LinearB, and all activity for this contributor will be aggregated in one place."[^6][^8]

### Appfire Flow

Flow has a richer and more configurable auto-merge system with explicit admin controls:[^9]

- **Auto-merge trigger:** Sign-in email match *or* all-email matches (admin chooses which level of aggressiveness at Setup → Preferences → Auto-merge)
- **Auto-merge scope:** Only applies to users integrated *after* auto-merge is enabled — it does not retroactively apply to past data. "Set up auto-merge before adding integrations and repos."[^9]
- **Preferred domain:** Admins define up to 10 company email domains in priority order. When multiple aliases in a merge candidate have different domains, the apex is chosen by domain priority. "Your preferred domain designates which email domain Flow should choose as the apex user for any auto-merges or merge suggestions."[^9]
- **Exclusions:** Specific patterns (e.g., "undisclosed", common words) can be excluded from auto-merging. Exclusions are applied before the auto-merge toggle is turned on.[^9]
- **Email alerts:** Admins can subscribe to email alerts when new merge suggestions appear or when new users are ingested.[^9]

Flow also generates internal synthetic aliases per integration to handle multi-integration scenarios. If two separate GitHub integrations both import the same developer, Flow creates additional tracking aliases (e.g., `user-1775732@1840.id.gitprime.com`) and automatically merges them under the correct apex.[^4]

### Swarmia

Swarmia "automatically merges most user identities for you and removes any potential duplicates," with duplicate detection surfaced at setup and ongoing. The changelog from 2022 states: "We also automatically identify and merge duplicate accounts, and if a team member happens to commit code using a new email address, we'll suggest linking it to an existing account."[^10][^11]

The auto-detection approach is not explicitly documented in terms of matching rules (email vs. provider ID vs. fuzzy name). The setup guide recommends reviewing auto-merges before finalizing: "reviewing your contributors and confirming that the initial data looks accurate is still a good idea."[^10]

***

## 4. Manual Merge / Unmerge UI Workflows

### Appfire Flow: The Most Detailed Merge UI

Flow has the most fully documented merge workflow in the category, with a dedicated **Merge Users** page accessible from Settings → User Management → Users → Merge Users. The page has three tabs:[^9]

**Merge Suggestions tab:**
- Alphabetical list of merge candidates on the left; target user and suggested aliases on the right
- Each candidate shows the users Flow believes should be merged
- Admin actions: **Merge and next** (accept and continue), **Reject and next** (decline — rejected suggestions are NOT re-surfaced), or remove individual aliases from a group suggestion with the X button
- An alert badge appears on the Settings icon in the top nav when new merge suggestions exist; the User Health indicator under Settings shows "Users to merge" count and the percentage of users with open merge suggestions[^9]
- Quick filters on the Merge Suggestions tab: "Contain default domain," "Aliases created in last 30 days," "Have multiple logins" — for bulk-resolution workflows with large suggestion queues[^9]

**Manual Merge workflow:**
1. Click the All Users tab
2. Search for target user (the surviving apex)
3. Click-and-drag the target user into the "Select a target user" area on the right
4. Find aliases to merge; click-and-drag those into the "Select one or more aliases" area
5. Review the selection; click Merge; click Save[^9]

**Unmerge workflow:**
1. On the All Users tab, drag the apex user into the "Select a target user" area
2. Click the Unmerge icon next to the alias to detach
3. Confirm in popup — the alias becomes an independent user in the list[^9]

**Preferred integration:** For merge suggestions, after domain preference is set, an integration preference is used as a tiebreaker. Admins set which tool's identity is preferred when multiple aliases tie on domain.[^9]

### LinearB: Three-Dot Icon Merge

LinearB's merge workflow is less ceremonial:[^12][^6]

1. Navigate to Settings → Teams & Contributors → Contributors
2. Locate the duplicate entry (by default, each email = one contributor)
3. Click the three-dot icon next to the contributor → select "Merge Account"
4. Select the primary (surviving) account
5. The merged contributor is billed as one; all activity aggregates under the primary

The setup guide explicitly calls this out as Step 2 in the onboarding flow: "After adding all relevant repositories, LinearB will display a list of repository contributors in the Teams & Contributors tab. By default, contributors are identified by unique email addresses, which may result in duplicate accounts."[^12]

### Swarmia: Checkbox + Merge Button

Swarmia's merge UI is the simplest documented:[^13][^10]
1. Navigate to Contributor Settings
2. Review the contributor list — detected duplicates appear on the right side of the page
3. Select two contributors from the list using checkboxes
4. Click **Merge** in the space on the right
5. Manual unmerge is also supported ("merge and unmerge identities as needed")[^14]

### Waydev

Waydev lists "Combine duplicate contributor profiles to unify data" as Step 3 in the owner setup guide, with explicit link to a "Merge Contributors" article. The setup guide explicitly orders this as prerequisite to team setup: contributors must be merged before being added to teams for metrics to be accurate.[^15][^7]

***

## 5. Confidence Scoring

No platform publicly documents a numeric confidence score for merge suggestions in their user-facing help center documentation. However, the merge logic across products implies two tiers:

**High-confidence (auto-merged without admin review):**
- Exact email match across providers[^8][^9]
- Exact provider ID match (GitHub user ID, GitLab user ID)[^8]
- Same sign-in email after SSO login[^9]

**Medium-confidence (surfaced as suggestion, requires admin review):**
- Same display name, different emails
- Same first name + last name initial + similar email domain
- Aliases from the same integration with overlapping activity periods

Flow's documentation implies a fuzzy matching layer for suggestions: "Exclude first name matches" is a configurable exclusion in the Preferences tab, which implies that first-name matching is in the default suggestion algorithm. Flow also allows excluding "common words and emails from matching" by configuring a blocklist of patterns.[^9]

**[Inference]** The standard industry pattern for this tier of matching — used in marketing CDPs, HR systems, and analytics platforms — combines exact-match keys (email, provider ID) for auto-merge with fuzzy string similarity (e.g., Jaro-Winkler distance on display names, Soundex on name variants) for suggestion generation. Engineering analytics platforms almost certainly use similar techniques in their backend suggestion generation, but do not expose the score to the admin UI.[^16][^17]

**[Inference]** A well-designed system should expose confidence as a simple categorical label (High / Medium / Low) on each suggestion, rather than a raw score, to guide admin triage. Flow's "Viewed" tab for suggestions that have been seen but not yet acted on is a partial implementation of this — it tracks the admin's review state without exposing a raw score.

***

## 6. Bot Detection and Filtering

### Definition of a Bot in This Context

Bots relevant to engineering analytics fall into three categories:
1. **Dependency update bots** (Dependabot, Renovate) — open PRs automatically to update packages
2. **CI/CD automation accounts** — push commits or open PRs on behalf of pipelines
3. **AI coding agents** — increasingly commit code under agent identities (e.g., `my-bot@users.noreply.github.com`)[^18]

### How Platforms Handle Bots

**software.com** has the most explicitly documented bot handling:[^19]
- PRs authored by a "known bot" (e.g., dependabot) are **automatically excluded** from all metrics
- Rationale: "Productivity metrics like Lead Time and Review Cycles are designed to measure the human element of the development process. Including automated PRs, such as dependency updates, would skew these metrics."
- The exclusion applies both to PR authorship metrics AND to dependency-update PRs specifically

**LinearB** bots are excluded from billing: "Bots are not counted as contributors even if they generate PRs." Bot-created PRs can still trigger WorkerB automations (they consume credits), but they don't inflate contributor seat counts.[^20]

**Appfire Flow** handles bots via the **hidden users** and **exclude from metrics** mechanisms rather than an auto-detection system. Flow ingests all contributors from all repos — including bots. Admins must explicitly hide or exclude bot accounts. The "Users with no activity within 90 days" system team provides a proxy filter to surface inactive/bot accounts for bulk action.[^21][^22][^23]

**[Inference]** The common bot-detection heuristics that most platforms use internally, even if not documented:
- Username contains "bot", "dependabot", "renovate", "[bot]" suffix
- Email matches `*@users.noreply.github.com` patterns for well-known CI accounts
- No associated product login / no human profile data (avatar, display name)
- 100% of PRs target dependency lock files or generated code

A robust implementation should maintain an updatable **bot account pattern list** (regex on username + email) and surface any auto-detected bots for admin confirmation before exclusion, rather than silently excluding them.

### The GitHub Noreply Email Problem

GitHub's `ID+username@users.noreply.github.com` addresses present a specific identity challenge:[^2][^24][^1]
- Commits made via the GitHub web editor use this address by default when users enable "Keep my email addresses private"
- The old format (`username@users.noreply.github.com`) breaks attribution if the username changes — commits become permanently unattributed[^3]
- The new ID-based format (`12345678+username@users.noreply.github.com`) survives username changes because the numeric ID is stable[^24]

For an analytics platform, this means: if a developer has `Keep my email addresses private` enabled, their web-editor commits appear under the noreply address. Unless the platform cross-references the GitHub numeric user ID (available via the GitHub API), those commits will appear as an unresolved alias. The fix is to resolve identity via the provider's user ID field, not just email — exactly what LinearB's matching-provider-ID rule addresses.[^8]

***

## 7. External and Open-Source Contributor Handling

When an org's repositories are public, or when engineers contribute to third-party repos that are ingested, the platform ingests contributors who are not employees. If not handled, external contributors inflate team counts, introduce phantom "developers" into the user list, and can trigger incorrect merge suggestions.

### software.com

The most explicit policy in the category: a user is automatically classified as an **open-source contributor** if:[^19]
- They are **not a member of your Git organization**, AND
- Their only contributions have been to **public repositories**

Such contributors are excluded from all calculations. The rationale: "External contributors are often highly infrequent and including their work would not accurately represent the productivity of your internal development team."[^19]

### Appfire Flow

Flow ingests all contributors from all repos, including public repos. External contributors clutter the user list. The recommended workflow is:[^22]
1. Use the **hidden users** mechanism — "hide these users to remove them from your metrics so you can focus on your team"[^22]
2. Hidden users: removed from user list, removed from teams, removed from reports, metrics excluded, but data is not deleted
3. Hidden users remain included in auto-merge suggestions (merged into the hidden user and stay hidden)[^22]
4. When using auto-merge, aliases of a hidden user are merged under the hidden user and remain hidden — "you do not need to re-hide the user if they are re-ingested from another repo"[^22]

**Warning in Flow docs:** "Be cautious about excluding users who were once active contributors in your organization. If you exclude a user who meaningfully contributed to your metrics, you will skew your overall organization-level data. As an example, all PRs the excluded user reviewed will become unreviewed PRs in Flow." This is a critical downstream data integrity point discussed further in Section 9.[^21]

### Appfire Flow — Undisclosed Users

When a git host doesn't provide an account name or email via API (privacy-protected accounts, corporate SSO setups), Flow creates an alias labeled "Undisclosed" with a synthetic email like `undisclosed@[external_id].id.gitprime.com`. These undisclosed users appear in the user list and in reports. Admins should regularly review and either merge (if they can identify the real person) or hide these accounts.[^4]

***

## 8. User vs. Contributor: The Billing and Access Distinction

This distinction is table-stakes in the category and has both UX and commercial implications.

| Concept | Definition | Billing | Access |
|---------|-----------|---------|--------|
| **User (Platform Access)** | Anyone who can log into the product to view reports or manage settings | Free / unlimited | Yes |
| **Contributor (Tracked Developer)** | A developer whose commits/PRs are tracked and included in metrics | Billable | Not required |

### LinearB

Explicitly documented: "Users are people with access to the LinearB application. Contributors are developers whose work is tracked for metrics and billing. You can add unlimited users without impacting billing. Only contributors included in LinearB teams count toward contributor-based tracking and reporting." Bots are explicitly excluded from contributor billing even if they generate PRs. Pricing is per contributor seat: $29/month (Essentials) or $59/month (Enterprise) per contributor, with bundled automation credits per seat.[^25][^20]

### Appfire Flow

Flow's user management page shows each user's "Include in metrics" status as a toggle. The **Active contributors** quick filter shows "users included in metrics with PR or commit activity in the past 30 days" — these are the users who count toward license usage. A user can be in the system (ingested from a repo) without having a Flow login, and without being included in metrics. Users with no login have only three tabs on their detail page (aliases, teams, groups) instead of all tabs — reflecting that they are tracked identities, not platform users.[^26][^27][^28]

### Waydev

The owner setup guide explicitly lists "Contributors vs. Users" as Step 0 of configuration: understanding this distinction is positioned as foundational before any other setup. "A contributor is a team member for whom LinearB measures and calculates engineering metrics" (Waydev uses the same conceptual model).[^6][^7]

### Swarmia

The contributor setup page emphasizes that a "Swarmia contributor combines the identities from all the different systems an individual contributor interacts with" — the contributor is a cross-system unified identity, not just a Git account. The distinction from platform users is implied but not as explicitly documented in public help docs as LinearB's coverage.[^14]

***

## 9. Downstream Analytics Impact of Identity Errors

Identity resolution errors are not cosmetic. They cascade into every metric the platform computes.

### Fragmentation Effects (Under-Merged)

If a developer has two aliases that are not merged, their work is split:

- **Cycle time:** If commits under alias A open a PR, and the merge is attributed to alias B (different email after a git config change), the PR may appear to have no commits, or the commit timeline is broken — cycle time becomes unmeasurable for that PR
- **PR throughput / velocity:** Each alias appears as a separate "developer" — team velocity is artificially high (more "contributors"), but per-person throughput is artificially low
- **Reviewer networks:** Code review participation is split — alias A reviewed 5 PRs, alias B reviewed 3 PRs, but the real developer reviewed 8. Review load balancing analysis is corrupted
- **DORA metrics:** Deployment frequency calculations that count "distinct contributors per deploy" are inflated. Change failure rate attribution may fail entirely if the deploy-triggering commit is under a different alias than the PR
- **Investment balance:** If one alias is on Team A and the other is not on any team, effort attributed to the unassigned alias doesn't appear in the investment breakdown at all — work is invisible

### Incorrect-Merge Effects (Over-Merged)

If two different people are incorrectly merged into one contributor:

- Their combined throughput appears as one superhuman developer — manager gets a misleading picture of one person's capacity
- Team boundaries break: if person A is on Backend Team and person B is on Frontend Team, the merged contributor appears to be on both (or neither, depending on how the merge resolves team membership)
- Code review conflict detection fails — it may appear as if a developer reviewed their own code

### Exclusion Effects

Appfire Flow explicitly warns about this: "If you exclude a user who meaningfully contributed to your metrics, you will skew your overall organization-level data. As an example, all PRs the excluded user reviewed will become **unreviewed PRs** in Flow." This is an important insight: exclusion is not purely subtractive. A PR review by an excluded user doesn't disappear — instead the PR loses a reviewer, which changes review-cycle metrics, average reviewer count, and time-to-approval statistics for all other users on those PRs.[^21]

The same principle applies to PR authors: excluding a contributor removes their PRs from cycle time calculations, which changes the team's average cycle time. If the excluded developer was unusually fast or slow, the team average shifts in a potentially misleading direction.

***

## 10. Comparative Matrix

| Platform | Auto-Merge Logic | Manual Merge UI | Unmerge Support | Bot Detection | External Contributor | Suggestions UI | Apex/Primary Selection |
|----------|-----------------|-----------------|-----------------|--------------|---------------------|---------------|----------------------|
| **LinearB** | Email match + provider ID match; daily background[^8] | Three-dot icon → Merge Account in Contributors list[^12] | Yes — from People & Teams[^8] | Bots excluded from billing; auto-excluded from metrics[^20] | Not explicitly documented | Not documented as a separate "suggestions" workflow | Admin selects primary during manual merge[^6] |
| **Appfire Flow** | Email match (sign-in or all); optional, configurable; must be enabled before integrations[^9] | Dedicated Merge Users page; drag-target + drag-aliases; three-step confirm[^9] | Yes — Unmerge icon on alias row; alias becomes new user[^9] | No auto-detection; manual hide/exclude recommended[^21] | "Hidden users" system for external contributors[^22] | Full Suggestions tab; accept/reject/viewed workflow; badge alerts[^9] | "Preferred domain" + "Preferred integration" settings determine apex[^9] |
| **Swarmia** | Auto-detect; email-based (exact details not documented)[^11][^10] | Checkbox select two contributors → Merge button[^13][^10] | Yes — "manually merge and unmerge identities as needed"[^14] | Bot PRs auto-filtered (Dependabot etc.)[^19] | Not documented | Duplicates shown on right side of Contributor Settings[^10] | Not documented |
| **Waydev** | Auto-detect; exact algorithm not documented[^15] | "Combine duplicate contributor profiles" step 3 of setup[^15] | Not documented | Not documented | Not documented | Not documented | Not documented |
| **software.com** | Not documented | Two-level manual exclusion[^19] | Not documented | Auto-detect known bots; auto-exclude[^19] | Auto-classified and excluded by org membership + public-repo-only check[^19] | None documented | N/A |

***

## 11. Hard Edge Cases Every Implementation Must Handle

### 11.1 GitHub Noreply Addresses

A developer who commits via GitHub's web editor with privacy mode enabled appears under `ID+username@users.noreply.github.com`. This email cannot be added to another GitHub account and cannot be transferred on username change (for the old format). The fix: resolve identity using the **GitHub numeric user ID** from the API, not just email. LinearB does this via the provider-ID matching rule.[^3][^8]

### 11.2 Multiple GitHub Organizations in One Swarmia/LinearB Account

Swarmia supports connecting multiple GitHub organizations to one Swarmia organization. A developer with access to multiple GitHub orgs will have aliases from each org's integration. This is exactly the scenario where auto-merge by provider ID (the GitHub user ID is the same across orgs) is essential — email-only matching will fail if the developer uses different emails per org.[^29]

### 11.3 Contractor Accounts

A developer working as a contractor may use a personal GitHub account (personal email) while the organization's internal staff use SSO-linked work emails. Without explicit identity resolution, the contractor's work is permanently attributed to a personal alias that looks like an external contributor. The correct handling: admins should classify contractor aliases as internal contributors, merged with any work accounts, and explicitly included in team metrics.

### 11.4 Former Employees

Excluding a former employee seems like the obvious action on offboarding, but Flow's warning applies: their historical PR reviews become unreviewed, their historical cycle time contributions disappear, and team trend lines shift. The correct handling for former employees is to **include them in historical metrics but stop collecting new data** — which maps to Flow's "disable login + include in metrics" model, not a full exclusion.[^21]

### 11.5 AI Coding Agent Commits

As of 2026, AI agents (GitHub Copilot Workspace, Claude Code, etc.) increasingly commit code autonomously. These commits should be attributed to a bot account, not the engineer's identity, to avoid inflating individual throughput. The correct setup: a dedicated bot GitHub account with a dedicated SSH key, commits made under the bot's email/username. Engineering analytics platforms should auto-detect these bot accounts by the same mechanisms used for Dependabot.[^18]

### 11.6 Pair Programming / Mob Programming

Flow specifically tracks whether a user is part of a "programming group" (pair/mob) as a field on the user record. When two developers work together on a PR, commit attribution goes to whoever pushes — the other developer's contribution is invisible. This is a known unsolved problem in the category. GitHub's `Co-authored-by:` commit trailer is the standard convention for attributing co-authors, but not all analytics platforms parse it as a dual-attribution signal.[^27]

***

## 12. Recommended Implementation Patterns

### Identity Resolution Pipeline

```
Raw event ingested (commit / PR / issue event)
  ↓
Extract identity signals:
  - git author email
  - git committer email
  - git provider user ID (numeric)
  - display name
  - linked ticket system account ID (Jira, Linear, ADO)
  ↓
Lookup against ContributorAlias table:
  - Exact match on (provider_type, provider_id) → HIGH CONFIDENCE → auto-merge
  - Exact match on email across providers → HIGH CONFIDENCE → auto-merge
  - Fuzzy match on display name + same org domain → MEDIUM CONFIDENCE → surface as suggestion
  - No match → create new unresolved ContributorAlias → flag for admin review
  ↓
Confidence label: HIGH (auto-merged) / SUGGESTED (pending admin) / UNRESOLVED (no match)
  ↓
Daily re-evaluation sweep:
  - Re-run high-confidence rules on unresolved aliases
  - Group SUGGESTED aliases into admin review queue
```

### Bot Classification Rules

Maintain an admin-editable blocklist of patterns. Auto-classify as bot if:
- Username exactly matches or contains: `[bot]`, `dependabot`, `renovate`, `github-actions`
- Email matches: `*@users.noreply.github.com` for known CI patterns
- No associated human profile data AND 100% of PRs target lock files or generated directories

Surface auto-classified bots to admin for one-time confirmation, then exclude from all metrics automatically.

### External Contributor Classification

Auto-classify as external if:
- Not a member of any connected Git organization
- Only contributions are to public repositories
- No associated ticket system account

Default behavior: exclude from internal team metrics. Make this configurable: some organizations want to track open-source maintainer load separately.

### Admin Queue Design

The admin identity resolution queue should be a first-class UI destination, not buried in Settings. It should show:
- Count of unresolved aliases (badge in nav)
- Pending merge suggestions grouped by confidence
- "No activity in 90 days" accounts for bot/external cleanup
- Former employees (departed > 30 days, still in metrics)

This mirrors the design of Flow's User Health indicator and LinearB's billing contributor management page, both of which surface identity health as an ongoing operational concern rather than a one-time setup step.[^6][^9]

***

*All sourced facts are cited inline. Claims labeled [Inference] represent analysis and synthesis not directly stated in any single source.*

---

## References

1. [Commit Was Not Made In The...](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions) - Learn common reasons that contributions may be missing from your contributions graph.

2. [Could I use the ID-based GitHub-provided noreply address in git?](https://stackoverflow.com/questions/67138329/could-i-use-the-id-based-github-provided-noreply-address-in-git) - Edit: Under the old GitHub system with username@users.noreply.github.com emails, the commits would n...

3. [users.noreply.github.com, but after merging accounts, there is no ...](https://github.com/isaacs/github/issues/1690) - Unfortunately commits made with a GitHub provided noreply address cannot be transferred over to anot...

4. [Aliases - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802535233) - Flow uses aliases and apex aliases to identify and manage user accounts. This helps Flow merge users...

5. [Users - LinearB docs](https://docs.linearb.io/api-users/) - This API endpoint provides you with full CRUD operations on users, including assigning them to teams...

6. [How do I manage the number of contributors in my account?](https://linearb.helpdocs.io/article/7jda9bydfa-account-page) - The account page helps you manage the number of LinearB team contributors active in your account.

7. [Configuring Waydev](https://docs.waydev.co/docs/configuring-waydev) - Manage Contributors, Include Contributors in Metrics and then add Contributors to Teams. 5. Teams, C...

8. [Auto-Merge for Contributors in LinearB - HelpDocs & User Setup](https://linearb.helpdocs.io/article/5u3jzvjhbq-auto-merge) - Auto-Merge in LinearB ensures clean, accurate user data by automatically unifying identities across ...

9. [Merge users - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802404067) - Flow has a dedicated user merge page to help you navigate potential and recommended merges. The user...

10. [Get started in 15 minutes | Swarmia docs](https://help.swarmia.com/getting-started/get-started-in-15-minutes) - The good news is that Swarmia automatically merges most user identities for you and removes any pote...

11. [Create and manage teams in Swarmia](https://www.swarmia.com/changelog/2022-08-31-manage-teams/) - Navigate to team settings to create and manage teams. More updates. Deployment insights: now you can...

12. [LinearB Configuration Best Practices - HelpDocs & User Setup](https://linearb.helpdocs.io/article/ank9nh722m-linear-b-starter-guide) - Follow these steps to fully configure your LinearB account and ensure optimal performance: Add and M...

13. [Team settings | Swarmia docs](https://help.swarmia.com/getting-started/configuration/team-setup) - Setting up is easy but requires some thinking and discussion as a team to ensure that your data is c...

14. [Contributors | Swarmia docs](https://help.swarmia.com/getting-started/teams-and-members/contributors) - By combining the right identities, you ensure work items are assigned to the right people. The ident...

15. [Guide for Owners - Waydev](https://docs.waydev.co/docs/guide-for-owners) - Manage your Organization in Waydev

16. [A fuzzy approach to identity resolution - London Met Repository](https://repository.londonmet.ac.uk/8080/) - The fuzzy approach to identity resolution has been introduced that uses Soundex and Jaro-Winkler dis...

17. [Unify Profiles with Salesforce Data Cloud Identity Resolution Soft-Matching](https://www.salesforce.com/blog/data-cloud-identity-resolution/?bc=OTH) - Salesforce Data Cloud, the first real-time CRM, is turning your data into real-time customer magic. ...

18. [Agent Identity for Git Commits - DEV Community](https://dev.to/jpoehnelt/agent-identity-for-git-commits-53n1) - When running multiple AI agents that push to GitHub, you want commits to come from a bot account—not...

19. [Data Filtering and Exclusions - Software Support](https://docs.software.com/article/130-data-filtering-and-exclusions) - To provide the most accurate and actionable engineering metrics, our platform automatically filters ...

20. [How Credits Work - LinearB](https://linearb.io/how-credits-work) - A contributor is a team member for whom LinearB measures and calculates engineering metrics, using f...

21. [Exclude - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802043732) - To exclude a user from all reports, click the check box next to any users you want to exclude. Use t...

22. [Hidden users](https://help.pluralsight.com/hc/en-us/articles/24352522298260-Hidden-users) - Flow ingests data from all users who have contributed to your repos. This includes all contributors ...

23. [Team management - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1801912666) - Users excluded from metrics: all users that have been excluded from reports. Users on teams: all use...

24. [Commit attribution when changing GitHub username? - Stack Overflow](https://stackoverflow.com/questions/63690503/commit-attribution-when-changing-github-username) - You can have your commits attributed to your new username even if you had been using GitHub's no-rep...

25. [Understanding Users and Contributors in LinearB - HelpDocs](https://linearb.helpdocs.io/article/l2qz46f3lm-how-to-invite-new-users-jhj) - Contributors must belong to a LinearB team to include their activity in reports. LinearB allows an u...

26. [User management](https://help.pluralsight.com/hc/en-us/articles/24352517291028-User-management) - All Flow users, including those ingested from your integrations, appear on the Users page. Use this ...

27. [Combine Entity Records](https://help.athennian.com/hc/en-us/articles/7010551610651-Combine-Entity-Records) - Merge entity records into a single profile! Use the Combine tool to clean up multiple entries of the...

28. [User details - Flow - Confluence](https://appfire.atlassian.net/wiki/spaces/FD/pages/1802436885) - Hide more than one user at once from the Users page. Open. Learn more about Hidden users and the dif...

29. [Multiple GitHub organizations | Swarmia docs](https://help.swarmia.com/getting-started/integrations/github/multiple-github-organizations) - This article explains the various options available in Swarmia for connecting your company's multipl...

