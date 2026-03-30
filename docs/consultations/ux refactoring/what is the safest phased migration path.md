Here is the deep-research guide on safely migrating an engineering analytics product from an infrastructure-centric UX (e.g., Analysis Runs/Jobs) to a business-centric UX (e.g., Teams/Repositories/Contributors). 

The core principle here is to decouple the **data ingestion engine** from the **domain query layer** so you can reshape the UX without ripping out the reliable backend that actually fetches the git data.

### 1. The Core Migration Pattern: The "Strangler Fig" Facade
A "big bang" rewrite (pausing features to build a whole new v2) has a failure rate near 70% in SaaS. Instead, use the **Strangler Fig pattern**. [altexsoft](https://www.altexsoft.com/blog/strangler-fig-legacy-system-migration/)

In your specific context, this means:
1. **Leave the "Run" engine alone:** Keep your existing ingestion jobs, webhooks, and raw data tables exactly as they are. 
2. **Build an Anti-Corruption Layer (ACL):** Create a new Domain API layer that translates raw job data into the new entities. When the frontend asks for "Team Alpha's cycle time," the ACL queries the legacy tables, filters by the repositories mapped to Team Alpha, and returns the data. [salfati](https://salfati.group/topics/greenfield-vs-brownfield)
3. **Route Traffic Gradually:** Update the frontend to consume the new Domain API one page or widget at a time, leaving the rest of the app on the legacy API. 

### 2. Coexistence Strategy: Hiding Runs Behind Entities
You must bridge the gap between "A run just finished" and "A repository was updated."

*   **The Shadow Mapping Pattern:** Introduce the new `Repository` and `Contributor` tables now, but populate them asynchronously in the background. Every time a legacy "Run" completes, trigger an event that upserts the relevant Repositories and Contributors into the new tables.
*   **The "Last Updated" Illusion:** The UX should show a repository and a "Last Updated: 2 mins ago" badge. In the backend, this is simply querying the timestamp of the most recent legacy "Run" that included that repository's data. You are hiding the infrastructure concept (the job) behind the business concept (the repository).
*   **Decoupled Syncing:** If a user clicks "Refresh Data" on a Repository page, the backend translates this into a command to queue a legacy Analysis Run specifically for that repo's scope, abstracting the job queue away from the user.

### 3. Recommended Phased Rollout Order
You must sequence the rollout so that each entity builds the foundation for the next. Do not build the Team model before fixing Contributor identities.

#### Phase 1: Contributor Identity (The Foundation)
You cannot build Teams or accurate PR metrics if you have fragmented developers (e.g., `j.doe@gmail`, `John Doe`, and `jdoe_github`).
*   **Action:** Roll out the Contributor entity and the manual/auto merge UI first.
*   **Migration:** Map legacy author strings to the new Contributor entity. 
*   **UX Win:** Users immediately get a "People" page where they can clean up their data, establishing trust.

#### Phase 2: The Repository & Work-Item Model
Shift the UI from showing "Runs" to showing "Repositories."
*   **Action:** Introduce the Repository entity and PR/Work-Item entities. 
*   **Migration:** Build the ACL that pulls raw commit/PR data from the legacy tables and groups it by Repository.
*   **UX Win:** Users can now click on a Repository and see its PRs, rather than clicking on a Run and seeing raw logs.

#### Phase 3: The Team Model (The Pivot)
Once Contributors and Repositories are stable, introduce Teams. 
*   **Action:** Allow admins to group Contributors into Teams. Build dynamic mapping: if Contributor X is on Team Y, and Contributor X commits to Repo Z, then Repo Z is dynamically associated with Team Y's dashboard.
*   **UX Win:** This is the massive value unlock. Managers can finally filter by "My Team" instead of manually selecting 15 repositories.

#### Phase 4: Saved Views & Global Context
With Teams established, you can build persistent context.
*   **Action:** Implement the Global Context Bar (Org/Team + Date Range) and "Save View" functionality.
*   **Migration:** Any legacy "Saved Filters" must be translated into the new Saved View object.
*   **UX Win:** Users no longer have to re-configure their dashboard every time they log in.

#### Phase 5: Scheduled Reporting & Curation
Reporting and curation sit at the very top of the stack and depend on everything else working perfectly.
*   **Action:** Introduce scheduled email digests tied to Saved Views, and granular curation (excluding specific PRs or repos).
*   **Migration:** Deprecate the old "Run" views entirely. If an admin wants to exclude data, they do it via the new Curation UX (which writes to an exclusion table), rather than modifying job parameters.

### 4. How to Handle the Transition Period UI
During Phase 2 and 3, you will have users experiencing both systems. Use the **Dual-Track UI Pattern**:
*   Introduce the new Team/Repo views under a "New Dashboards (Beta)" toggle in the sidebar. [blog.scottlogic](https://blog.scottlogic.com/2021/07/16/UX-Migration-Strategy.html)
*   Keep the legacy "Analysis Runs / Jobs" view visible but move it to a "Developer/Admin Settings" or "Diagnostics" section. 
*   This explicitly communicates to the user: *"Jobs still exist, but they are infrastructure. Teams and Repositories are how you should be measuring your business."* Once 90% of traffic is hitting the new dashboards, you remove the legacy Run UI entirely. [altimi](https://altimi.com/insights/the-ai-powered-legacy-modernization-playbook)