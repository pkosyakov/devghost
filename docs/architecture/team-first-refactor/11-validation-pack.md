# Validation Pack

Status: starter

## Core scenarios

### Identity

- One contributor has 3 aliases and appears once in People and Team views.
- One alias is unresolved and appears in the admin queue.
- A bot-like alias is classified and excluded without deleting raw activity.

### Team history

- Contributor moves from Team A to Team B mid-quarter.
- Historical charts for Team A still include pre-move work.
- Current team views do not silently restate all prior work under Team B.

### Multi-repo work

- Contributor works in 3 repositories in the same period.
- Team page shows all 3 repositories in the team repo tab.
- Repository detail only shows repo-local context.

### Work attribution

- Squash-merged PR still appears as a PR-level delivery object.
- Direct push is visible in code-health/process surfaces.

### Saved scope

- One saved view contains multiple teams.
- The same saved view can be shared and scheduled.

### Curation

- Excluding a PR changes analytics without deleting raw data.
- Merging contributors changes rollups and is recorded in audit log.
