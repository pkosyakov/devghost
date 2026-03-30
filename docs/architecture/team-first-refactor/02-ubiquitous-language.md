# Ubiquitous Language

This glossary is the terminology contract for architecture and implementation.

## Core terms

| Term | Definition | User-facing label | What it is not |
|---|---|---|---|
| `Organization` | Root business container that owns teams, contributors, repositories, saved views, and schedules | Organization | Not necessarily identical to one GitHub org |
| `User` | A person with login access to DevGhost | User, Member, Admin | Not automatically a tracked engineer |
| `Contributor` | Canonical tracked engineering identity used for analytics and attribution | Developer, Contributor | Not a product access account; not one email |
| `ContributorAlias` | A raw identity signal from a provider mapped to a contributor | Usually hidden | Not the canonical person record |
| `Team` | Stable analytics group of contributors | Team | Not necessarily an HR department; not necessarily a GitHub team |
| `Primary Team` | The default owning team for a contributor during a time period | Usually hidden or shown in profile | Not the only team membership |
| `TeamMembership` | Time-bounded membership of a contributor in a team | Usually hidden | Not a timeless many-to-many join |
| `ActiveScope` | The currently applied analytical context resolved from route/query state and optionally a saved view | Usually hidden; expressed through the global context bar | Not a persisted business object by itself; not the same as a saved view |
| `Repository` | Source code repository tracked by the system | Repository | Not the default management scope |
| `WorkItem` | Intent-level work unit from issue/project systems | Issue, Ticket, Epic | Not a code review object |
| `PullRequest` | Delivery/review container for code changes | Pull Request, PR | Not the strategic planning object |
| `Commit` | Fine-grained code change evidence unit | Commit | Not the main delivery UX object |
| `SavedView` | Saved analytical scope plus filter configuration | Saved View, Report View | Not only a team overlay; not just a URL bookmark |
| `Dashboard` | Widget layout rendered within a current scope or pinned saved view | Dashboard | Not the same as a saved scope |
| `Schedule` | Delivery rule that sends a saved view/dashboard on a cadence | Schedule | Not the generated report instance |
| `ReportRun` | Generated snapshot instance produced by a schedule | Report history entry | Not the authored report definition |
| `AnalysisSnapshot` | Internal record of ingestion/processing freshness and status | Usually hidden; maybe "Last updated" | Not a primary navigational entity |
| `Curation` | Reversible metadata that changes what is included in analytics | Usually "Exclude", "Merge", "Hide", "Classify" | Not mutation of raw source data |
| `ExclusionRecord` | Active/inactive rule or explicit exclusion of an entity from analytics | Usually hidden in admin surfaces | Not deletion of raw data |

## Preferred wording rules

### Use `Contributor` in architecture and data contracts

Reason:

- it avoids confusing tracked identity with login user;
- it avoids pretending one person always maps to one git email.

### Use `Developer` in UI where it improves clarity

Reason:

- user language may still be more natural with `Developer`;
- the internal model should remain stricter than the UI label.

### Do not use `Order` in new documents

Use:

- `AnalysisSnapshot` for internal run/sync state;
- `Analysis` only if you truly mean a user-facing action or concept.

### Do not use `Report` as a catch-all

Use:

- `SavedView` for saved scope/filter state;
- `Dashboard` for widget layout;
- `Schedule` for recurring delivery;
- `ReportRun` for generated historical output.

## Naming guardrails

If a new document or task uses a term not listed here, it must either:

- be added to this glossary first; or
- be explicitly scoped as temporary/local wording.
