# Team / Repository / Contributor-Centric UX — Design Note

**Date:** 2026-03-29  
**Status:** Draft  
**Purpose:** целевая информационная архитектура и phased migration для DevGhost после пользовательского фидбека и deep research по рынку engineering analytics  
**Inputs:**  
- ambassador feedback и повторяющийся экспертный фидбек;  
- исследования в `docs/consultations/ux refactoring`;  
- текущая кодовая база, где продукт до сих пор центрирован вокруг `Order`.

## TL;DR

После изучения рынка и локального контекста итоговая картина такая:

- `Analysis Run` не должен быть главной UX-сущностью. Это инфраструктурный snapshot/job record.
- `Team` должен стать **основной scope-сущностью** для зрелого B2B UX.
- `Repository` остаётся **first-class domain entity**, но в зрелом UX это чаще drill-down/filter dimension, а не default landing.
- `Developer` в доменной модели лучше переименовать в `Contributor`, потому что tracked person не равен product user и не равен одному git email.
- `Contributor identity resolution` нужно делать в **первой фазе**, иначе team/repo dashboards будут недостоверны.
- `SavedView` должен быть **независимым scope object**, а weekly reports должны быть `Schedule` поверх `SavedView`, а не отдельной параллельной фичей.
- Для work attribution нужен гибридный слой: `WorkItem -> PullRequest -> Commit`.
- Для доверия нужен immutable raw layer + incremental curation, а не full re-analysis после каждого исключения.

## Что research поменял по сравнению с ранней гипотезой

Ранний вывод был "Repository и Developer должны стать сущностями 1-го уровня". Это остаётся верным, но research показал важную поправку:

- **не repository-first как основной scope;**
- **а team-first как основной управленческий scope**, с repository drill-down и contributor drill-down.

То есть для DevGhost:

- user-facing scope по умолчанию: `Team`;
- operational/catalog layer: `Repository`;
- person layer: `Contributor`;
- reusable reporting layer: `SavedView`;
- infrastructure layer: `AnalysisSnapshot`.

## Главные продуктовые принципы

### 1. Business entities over infrastructure

Пользователь должен думать:

- "моя команда";
- "мой репозиторий";
- "мой человек";
- "мой weekly view";

а не:

- "какой order/job/rerun породил эти цифры".

### 2. Persistent scope

Scope должен устанавливаться один раз и жить сквозь навигацию:

- organization;
- team or saved view;
- date range.

### 3. Trust before sophistication

Если identity merge, exclusions и team history неверны, любые красивые dashboards бесполезны.

### 4. One model for live and scheduled reporting

Weekly report не должен быть отдельной параллельной сущностью. Это schedule поверх saved scope.

### 5. People-first management, repo drill-down for leads

Managers управляют людьми и командами. Leads и repo owners часто заходят от конкретного репозитория. Продукт должен поддерживать оба режима, но primary scope для зрелого B2B UX должен быть командным.

## Рекомендуемая информационная архитектура

### Global context bar

Верхний persistent bar:

- `Organization`
- `Scope`
- `Date Range`

`Scope` может быть:

- `All Teams`
- конкретный `Team`
- конкретный `SavedView`

### Primary navigation

- `Home`
- `Teams`
- `People`
- `Reports`

### Secondary navigation

- `Repositories`
- `Settings`
- `Billing`
- `Profile`

### Admin / Diagnostics

Отдельно от main UX:

- `Data Health`
- `Users`
- `LLM Config`
- `Monitoring`
- `Audit Log`

Важно: `Analysis Runs / Jobs` не должны жить в primary nav. Если их надо показывать, то только в `Data Health` / `Diagnostics`.

## Scope hierarchy

```text
Organization
├── Teams
├── Saved Views
├── Repositories
├── Contributors
└── Analysis Snapshots (internal)
```

### Как должны сосуществовать Team, Repository и SavedView

- `Team` = стабильная группа людей.
- `Repository` = технический/операционный объект и drill-down surface.
- `SavedView` = независимый именованный scope bundle.

`SavedView` не должен быть подчинён одной команде на уровне модели. Он может содержать:

- одну команду;
- несколько команд;
- subset репозиториев;
- subset contributors;
- особый date range;
- pinned filters.

## Целевая доменная модель

### 1. Organization

Корневая бизнес-сущность.

Хранит:

- members with roles;
- teams;
- repositories;
- contributors;
- saved views;
- schedules;
- norm profiles.

### 2. User vs Contributor

Это нужно разделить явно.

- `User` = тот, кто логинится в продукт.
- `Contributor` = тот, чья инженерная активность анализируется.

Один `Contributor`:

- может не иметь доступа в продукт;
- может иметь несколько alias-идентичностей;
- может состоять в нескольких командах;
- может быть помечен как bot / external / excluded.

В UI можно оставить слово `Developer`, но в модели лучше использовать `Contributor`.

### 3. Contributor + ContributorAlias

`Contributor`:

- canonical tracked person;
- primary display name;
- primary email;
- classification: internal / external / bot / former employee;
- primary team;
- exclusion flags.

`ContributorAlias`:

- provider type;
- provider id;
- email;
- username;
- confidence: auto / suggested / unresolved / manual.

### 4. Team

`Team` — first-class analytics entity.

Но это не обязательно HR-отдел и не обязательно GitHub team.

Содержит:

- name;
- parentTeamId;
- membership history;
- primary manager/owner;
- default norm profile;
- auto-discovered repositories;
- pinned repositories;
- excluded repositories;
- default report settings.

### 5. TeamMembership

Нужна отдельная сущность, а не просто many-to-many join.

Поля:

- contributorId;
- teamId;
- role;
- isPrimary;
- effectiveFrom;
- effectiveTo.

Default policy:

- historical attribution должна быть **point-in-time**, а не current-team-only;
- для org-level rollups нужен `primary team` или явная dedupe policy.

### 6. Repository

`Repository` остаётся first-class entity в модели и UX, но не обязан быть главным scope.

Хранит:

- provider;
- owner;
- name;
- default branch;
- connection state;
- include/exclude state;
- last updated timestamp;
- linked teams/contributors;
- repo-specific norms or overrides.

Repository page должна существовать, но быть скорее drill-down и ops surface, чем default homepage.

### 7. WorkItem, PullRequest, Commit

Research показал, что commit-only модель слишком слабая.

Нужен гибрид:

`WorkItem`
- intent container;
- issue/task/epic;
- нужен для roadmap/investment/allocation views.

`PullRequest`
- primary delivery container;
- основной UX-level объект для team dashboards;
- несёт lifecycle, review, cycle time, batch size, ownership.

`Commit`
- evidence layer;
- нужен для code-health, effort evidence, direct pushes, commit-level curation;
- должен сохраняться даже для pre-squash history.

### 8. AnalysisSnapshot

Это то, чем сейчас по факту является `Order` + job history.

Новая роль:

- internal infrastructure record;
- source of freshness/debug/audit;
- не primary UX entity.

Если пользователю показать это вообще, то только как:

- `Last updated`
- `Data freshness`
- `Sync health`
- `Reprocess / diagnostics`

### 9. SavedView, Dashboard, Schedule, ReportRun

`SavedView`
- saved scope + filter config;
- independent object;
- public/private/team visibility;
- shareable URL.

`Dashboard`
- widget layout using current scope or pinned saved views.

`Schedule`
- delivery rule attached to `SavedView` or `Dashboard`.

`ReportRun`
- generated snapshot instance for audit/history/resend.

Weekly report = `Schedule` + `ReportRun`, not separate authored domain object.

### 10. Curation layer

Нужны отдельные сущности:

- `ExclusionRecord`
- `CurationAuditLog`

И принцип:

- raw events append-only;
- exclusion/merge/split/classification живут отдельно;
- derived metrics пересчитываются инкрементально.

## Рекомендуемая UX-картина

### Home

Landing page должна зависеть от активного scope и persona:

- CTO / VP Eng: org or multi-team overview;
- Engineering Manager: team dashboard;
- Tech Lead / Repo Owner: team overview + repo hot spots.

Но сама entry page остаётся одной: `Home`, scoped by context bar.

### Teams

`Teams` — главный список для управленческого use case.

Team detail tabs:

- `Overview`
- `Pull Requests`
- `People`
- `Repositories`
- `Health & Trends`
- `Reports`
- `Settings`

Важно:

- repo set команды собирается автоматически из активности участников;
- пользователь может его уточнить через include/exclude/pin;
- этот refined scope можно сохранить как `SavedView`.

### People

Список contributors по organization/scope.

Contributor detail:

- cross-repo activity;
- team memberships;
- alias health;
- PR history;
- commit evidence;
- compare mode.

### Repositories

Repository list нужен, но как catalog/drill-down, а не как главный landing.

Repository detail:

- freshness and sync state;
- local contributors;
- PR activity;
- direct pushes / anomalies;
- repo-specific rules and exclusions.

### Reports

`Reports` по сути становятся библиотекой reusable scopes:

- `Saved Views`
- `Dashboards`
- `Schedules`

Пользовательский mental model:

1. define the slice;
2. save it;
3. share it;
4. schedule it.

## Как должен выглядеть large-org multi-repo scenario

Пример:

- 120 repositories;
- 14 teams;
- contributors работают в 2-5 репозиториях;
- CTO хочет weekly executive summary;
- Engineering Manager хочет delivery view по своей команде;
- Tech Lead хочет зайти в конкретный repo.

Поведение UX:

- `Home` открывается в последнем активном scope, например `Platform Team + last 30 days`.
- На `Team page` видны все репозитории, где участники команды были активны в периоде.
- В `Repositories` tab команды repo появляется как строка, а не как отдельный global scope reset.
- Один contributor показывается **один раз** в `People`, а не дублируется по каждому repo.
- На contributor detail есть breakdown по репозиториям и командам.
- На repository detail этот contributor показывается только локально для этого repo.
- Менеджер может выключить репозитории-шум и сохранить refined slice как `SavedView`.

## Identity resolution как фаза 1

Research здесь однозначен: это не поздний cleanup, а фундамент.

Нужен pipeline:

1. ingest raw identity signals;
2. exact match by provider id;
3. exact match by email;
4. fuzzy suggestion by display name + org domain;
5. unresolved queue for admin.

Дополнительно нужны:

- bot classification rules;
- external contributor rules;
- former employee cleanup;
- admin queue как first-class destination, а не buried settings page.

## Work attribution policy

Для DevGhost оптимален research-backed hybrid:

- `PR` — primary UX and team delivery unit;
- `Commit` — evidence layer and code-health layer;
- `WorkItem` — strategic allocation layer.

Special handling:

- squash merges;
- rebase merges;
- direct pushes to main;
- monorepo CODEOWNERS attribution;
- ghost PR cases where intermediate branch history is missing.

Решение:

- ingest commits at push time where possible;
- persist commit-to-PR linkage;
- promote direct push to pseudo-PR where needed;
- keep PR as the delivery object shown on team surfaces.

## Manual curation and trust architecture

### Raw layer

Никогда не мутировать и не удалять raw events:

- commits;
- PRs;
- reviews;
- issue events.

### Curation layer

Separate metadata:

- exclude contributor;
- exclude repo;
- exclude PR;
- exclude commit;
- merge contributor;
- unmerge contributor;
- classify bot/external.

### Query layer

Все метрики должны строиться через join against active exclusions.

### Cache layer

Precomputed metrics cache with smart invalidation:

- invalidate only affected time buckets;
- no full recompute by default;
- explicit `Reprocess history` escape hatch for regex/global rule changes.

### UI placement

Лучший паттерн:

- contextual action inline;
- central curation management hub;
- audit log visible to admins.

## Saved views, dashboards and weekly reports

### Recommended object model

- `SavedView` = scope + filter config
- `Dashboard` = widget layout
- `Schedule` = delivery rule
- `ReportRun` = historical generated instance

### UX rules

- `Save View` action on every analytics surface;
- `Add to Dashboard` from saved view;
- `Share` menu: link / permissions / export / schedule;
- `Schedules` tab inside saved object;
- centralized `All schedules` admin page.

### Important product decision

Do not build a separate authored feature called "Weekly Reports".

Better model:

- user saves a view;
- optionally pins it into a dashboard;
- schedules weekly delivery.

## Migration strategy

### Core pattern

Use a `Strangler Fig` migration, not a big-bang rewrite.

Keep:

- existing run engine;
- ingestion jobs;
- raw historical tables.

Add:

- anti-corruption layer / domain API;
- shadow mapping into new entities;
- gradual frontend routing to new entity pages.

### Shadow mapping pattern

Каждый раз, когда legacy run завершился:

- upsert repositories;
- upsert contributors and aliases;
- upsert PR/work-item links;
- update freshness timestamps.

UX при этом показывает:

- repository freshness;
- team freshness;
- last updated.

А не сам job.

## Recommended phased rollout

### Phase 1 — Contributor identity foundation

- introduce `Contributor` and `ContributorAlias`;
- build auto-merge + review queue;
- create `People` page;
- separate `User` vs `Contributor`.

### Phase 2 — Repository and work-item model

- introduce `Repository`;
- introduce `PullRequest` and minimal `WorkItem`;
- group legacy data through ACL into repo/pr surfaces;
- ship repo detail pages and freshness states.

### Phase 3 — Team model

- introduce `Team` and `TeamMembership`;
- point-in-time attribution;
- auto-discovered repos from team activity;
- team detail pages;
- move default manager workflow to team scope.

### Phase 4 — Saved views and global context

- global context bar;
- `SavedView`;
- `Dashboard`;
- reusable shared scopes;
- cross-team manager workflows.

### Phase 5 — Schedules, curation and diagnostics polish

- `Schedule` and `ReportRun`;
- central curation hub;
- smart invalidation;
- data health / diagnostics;
- move legacy run UI fully out of main experience.

## Explicit decisions to lock

### 1. Primary default scope

`Team` wins as the default management scope.

### 2. Repository position

`Repository` remains first-class in model and drill-down UX, but should not dominate the default landing in the mature product.

### 3. SavedView model

`SavedView` is an independent first-class object, not merely a team overlay.

### 4. Weekly reports

Weekly reports are scheduled deliveries of saved scopes.

### 5. Identity architecture

Identity resolution is Phase 1, not an afterthought.

### 6. Team history

Point-in-time attribution should be the default model.

### 7. Matrix membership

Allow multi-team membership at the data level, but define:

- one `primary team`;
- org rollup dedupe rules;
- clear team-local vs org-global attribution behavior.

### 8. Infrastructure exposure

`AnalysisSnapshot` stays internal/admin-facing unless surfaced as data health.

## Short conclusion

Целевой DevGhost после refactor должен выглядеть так:

- менеджер входит в `Home` или `Teams`;
- scope выбирается один раз через global context bar;
- contributor identities уже очищены и управляемы;
- repos доступны как catalog и drill-down;
- PR является delivery unit, commit — evidence unit;
- weekly report — это saved scope on a schedule;
- raw analysis runs живут в diagnostics, а не в primary UX.

Это наиболее цельная картина, которая одновременно:

- соответствует user feedback;
- соответствует best practices зрелых engineering analytics tools;
- не требует big-bang rewrite;
- сохраняет возможность repository-centric drill-down для DevGhost-specific use cases.
