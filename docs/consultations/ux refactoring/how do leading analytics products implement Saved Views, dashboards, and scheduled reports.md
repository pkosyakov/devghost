The cleanest model is: **Saved View = saved scope/configuration, Dashboard = reusable visual surface that renders one or more views, Report = a scheduled or exported delivery of a saved view/dashboard.** The best products increasingly collapse “report” into “scheduled delivery” rather than making it a separate analytics object. [grafana](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/)

## Category pattern

Across analytics products generally, a **view** is usually a saved query or saved filter state, not copied data; Microsoft Cost Management says a saved view stores filters, grouping, granularity, and chart settings, while the underlying data is not saved. Grafana’s model is similar in spirit: the dashboard is the primary object, and “Schedule a report” is an action from the dashboard rather than a separate reporting workspace. [learn.microsoft](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/save-share-views)

That pattern is showing up in engineering analytics too. LinearB documents saved filters as reusable scope definitions and separately documents dashboard links that preserve selected filters and date ranges, which strongly suggests “saved scope” and “shared dashboard state” are distinct but composable objects. [linearb.helpdocs](https://linearb.helpdocs.io/article/npdalbbe4e-resource-allocation-1)

## LinearB

LinearB explicitly supports two saved filter types in Resource Allocation, Forecasting, and Investment Strategy: **Project Filters** for bounded business scopes and **Filter Sets** for ongoing slices like product areas or customer segments. Those saved filters are reusable across modules, can be marked **Private** or **Public**, and only the creator or a platform admin can edit or delete them. [linearb.helpdocs](https://linearb.helpdocs.io/article/npdalbbe4e-resource-allocation-1)

For sharing, LinearB says **Copy Link to Dashboard** includes the selected filters and date range in the URL, which is the clearest documented example here of a shareable scoped URL. LinearB also distinguishes report permissions at the role level in its enterprise setup guide, where admins can create/delete public and private reports while lower roles have more limited report access. [linearb.helpdocs](https://linearb.helpdocs.io/article/6cnlaig17s-ent-setup-guide)

## Jellyfish

Jellyfish’s recent product messaging points toward **customizable dashboards as the main communication surface** rather than a separate report-builder workflow. The company says the new dashboard functionality eliminates the need to create different reports for different audiences and instead lets managers create targeted views for executives, teams, or onboarding use cases. [jellyfish](https://jellyfish.co/blog/how-jellyfish-dashboards-transformed-how-i-approach-my-job-as-an-engineering-manager/)

Jellyfish also exposes API endpoints that can be embedded into Grafana dashboards, which reinforces a model where dashboards are the delivery surface and the data scope is parameterized by timeframe and domain rather than locked into a separate report artifact. That is evidence for a platform trend: “report” is becoming a delivery mode, while “dashboard/view” is the durable product object. [jellyfish](https://jellyfish.co/blog/integrating-jellyfish-insights-with-grafana/)

## Swarmia

Swarmia publicly documents **shared views** in initiatives, where a set of filters can be saved as a reusable shared view. It also documents newer permission roles including **viewer** and **team admin**, which is relevant because saved/shared views only work well when permissions can be delegated below org-admin without granting full configuration rights. [swarmia](https://www.swarmia.com/changelog/2025-11-10-saved-views-for-initiatives)

The public docs surfaced here do not clearly document scheduled email reports the way LinearB and generic analytics tools do, so that remains less explicit from primary sources. Still, Swarmia’s direction supports the same structural pattern: shared filtered states are first-class, and permissions are being refined around who can view versus who can configure. [swarmia](https://www.swarmia.com/changelog/)

## Saved view vs dashboard

The clean distinction is:
- **Saved View:** persistent scope + filters + grouping + optional display mode.
- **Dashboard:** named canvas or page containing one or more cards/widgets, each bound to a view or to the current global scope.
- **Report:** delivery configuration that sends a snapshot or link on a schedule. [grafana](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/)

If you blur Saved View and Dashboard into one object too early, you create UX confusion: users cannot tell whether they are saving “this exact page layout” or “this analytical slice.” LinearB’s saved filters are useful exactly because they are lighter-weight than dashboards and can be reused across multiple modules. [linearb.helpdocs](https://linearb.helpdocs.io/article/npdalbbe4e-resource-allocation-1)

## Permissions

The cleanest permission model is **Private / Shared-to-specific-users-or-teams / Organization-public / Admin-owned canonical**. LinearB already documents a simpler version with **Private/Public** visibility plus admin override for editing/deletion. Swarmia’s role split between viewer, editor, and team admin suggests that product configuration rights should be decoupled from plain analytic visibility. [swarmia](https://www.swarmia.com/changelog/)

For your product, the practical recommendation is:
- **Private:** only creator.
- **Team-shared:** visible to members of specified team(s), editable by creator plus team admins.
- **Org-public:** visible to everyone with underlying data access, editable by creator plus analytics admins.
- **System/canonical:** admin-owned default views such as “Weekly Exec Summary” or “Platform Health.”  
This is cleaner than a generic ACL matrix and matches how B2B teams actually manage analytics artifacts. [swarmia](https://www.swarmia.com/changelog/)

## Shareable URLs

Shareable URLs should include the **resolved scope state**: date range, selected team(s), repo filters, contributor filters, grouping, and metric tab. LinearB explicitly says its dashboard links include selected filters and date ranges, which is the exact precedent you want. [linearb.helpdocs](https://linearb.helpdocs.io/article/12miefwqfm-how-can-i-share-my-linear-b-metrics)

The best implementation is dual-mode:
- **State URL:** encodes current unsaved state for ad hoc sharing.
- **Canonical URL:** points to a saved view/dashboard ID and loads its current stored configuration.  
This avoids the common failure mode where copied links either become too brittle or fail to preserve the analytical context. [learn.microsoft](https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-share-reports)

## Scheduled weekly delivery

The clearest cross-category pattern is that scheduling lives under **Share** on the dashboard/view rather than in a separate “Reports” product area. Grafana documents “Share → Schedule a report,” and similar tools schedule delivery from the saved report or dashboard itself. [support.assignar](https://support.assignar.com/hc/en-au/articles/5288778762383-Share-your-Report-or-Dashboard)

For your product, weekly delivery should almost certainly be a **Schedule attached to a Saved View or Dashboard**, not a standalone analytical object. The schedule should define recipients, cadence, timezone, format, and whether the email contains a static image/PDF, embedded KPI summary, or deep link back into the live product. [docs.openathens](https://docs.openathens.net/libraries/scheduling-reports)

## Persistent global filters

Persistent global filters work best when there is a stable **context bar** at the top of the app: organization, team, repo scope, date range, maybe environment/source filters. LinearB’s link-sharing behavior, and its note that saved filters do not store timeframe in some modules, show an important design choice: some filters are durable scope, while timeframe can remain session-global or module-global. [linearb.helpdocs](https://linearb.helpdocs.io/article/12miefwqfm-how-can-i-share-my-linear-b-metrics)

That suggests a good split:
- **Global persistent context:** org, time range, maybe team.
- **Saved View scope:** repo set, contributor segment, work type, metric grouping, exclusions.
- **Dashboard local controls:** widget-level display options only.  
This prevents every saved view from becoming stale just because a user wants to compare last week vs last quarter. [linearb.helpdocs](https://linearb.helpdocs.io/article/npdalbbe4e-resource-allocation-1)

## Is report separate?

The cleanest answer is **usually no**: a report should be a scheduled delivery or export configuration attached to a saved analytical object, not a separate first-class domain object. Grafana’s scheduling-from-dashboard model and Jellyfish’s “dashboards for audiences” messaging both support this direction. [jellyfish](https://jellyfish.co/blog/how-jellyfish-dashboards-transformed-how-i-approach-my-job-as-an-engineering-manager/)

A separate Report object only makes sense if it has meaningful independent structure, such as a curated narrative, multiple pages, commentary blocks, or compliance snapshots that must remain immutable over time. For an engineering analytics SaaS, most “weekly reports” are better modeled as `SavedView/Dashboard + Schedule`. [grafana](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/)

## Recommended model

Use this domain model:

| Object | Purpose | User-facing? |
|---|---|---|
| **SavedView** | Saved analytical scope and display config for one surface | Yes |
| **Dashboard** | Container of widgets/cards, each using current context or pinned SavedViews | Yes |
| **Schedule** | Delivery rule attached to SavedView or Dashboard | Yes |
| **ReportRun** | Generated weekly snapshot instance for audit/history | Mostly internal, optionally visible in history |
| **ShareGrant** | Permission binding for SavedView/Dashboard/Schedule | Internal/admin UI |
| **URLState** | Serialized ad hoc state for temporary sharing | Internal |

This keeps the UX clean while still supporting auditability and resend/history. A scheduled weekly report is therefore **not** a separate authored report object by default; it is a **Schedule** that produces **ReportRuns** from a SavedView or Dashboard. [docs.openathens](https://docs.openathens.net/libraries/scheduling-reports)

## Recommended UX

The cleanest product UX is:
- **Save View** in every analytics surface.
- **Add to Dashboard** from a saved view.
- **Share** menu with: copy link, invite people/teams, export, schedule weekly email.
- **Schedules** tab inside each saved view/dashboard, plus a centralized “All schedules” admin page.
- **Public/Private/Team** badge displayed next to the saved object name. [linearb.helpdocs](https://linearb.helpdocs.io/article/12miefwqfm-how-can-i-share-my-linear-b-metrics)

This gives users one mental model: *first define the slice, then decide how broadly to reuse it, then decide whether to deliver it on a schedule.* That is much cleaner than having separate, overlapping concepts for filters, dashboards, and reports. [grafana](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/)

If you want, I can do the next step as a **concrete object model + navigation spec + screen-level UX flows** for Saved Views / Dashboards / Weekly Reports in your product.