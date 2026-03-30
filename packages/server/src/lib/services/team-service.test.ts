import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  team: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  teamMembership: {
    create: vi.fn(),
    createMany: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  contributor: {
    findFirst: vi.fn(),
  },
  contributorAlias: {
    findMany: vi.fn(),
  },
  workspace: {
    findUnique: vi.fn(),
  },
  commitAnalysis: {
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
  repository: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  $transaction: vi.fn((fn: any) => fn(mockPrisma)),
}));

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

import {
  listTeams,
  createTeam,
  createTeamFromRepository,
  getTeamDetail,
  updateTeam,
  deleteTeam,
  addMember,
  updateMembership,
  removeMembership,
  getTeamRepositories,
} from './team-service';

describe('team-service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
  });

  describe('listTeams', () => {
    it('returns enriched TeamSummaryRows matching contract shape', async () => {
      const now = new Date();
      const commitDate = new Date('2025-09-15');
      // First count call: search-filtered total; second: workspace-wide summary
      mockPrisma.team.count.mockResolvedValue(1);
      mockPrisma.team.findMany.mockResolvedValue([
        {
          id: 't1', name: 'Frontend', description: null,
          createdAt: now, updatedAt: now,
          memberships: [
            { contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'alice@co.com' }] } },
            { contributorId: 'c2', effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-01'), contributor: { aliases: [{ email: 'bob@co.com' }] } },
          ],
        },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        { authorEmail: 'alice@co.com', repository: 'org/frontend', authorDate: commitDate },
        { authorEmail: 'alice@co.com', repository: 'org/shared', authorDate: new Date('2025-08-01') },
      ]);
      // Summary queries: activeTeamIds, memberedContributors
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }])             // activeTeamIds
        .mockResolvedValueOnce([{ contributorId: 'c1' }, { contributorId: 'c2' }]); // memberedContributors

      const result = await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'name', sortOrder: 'asc' });

      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].teamId).toBe('t1');
      expect(result.teams[0].memberCount).toBe(2); // unique contributors (c1, c2)
      expect(result.teams[0].activeContributorCount).toBe(1); // c2 expired
      expect(result.teams[0].activeRepositoryCount).toBe(2);
      expect(result.teams[0].lastActivityAt).toEqual(commitDate);
      expect(result.teams[0].healthStatus).toBeNull(); // Slice 3 placeholder
      // Server-computed summary
      expect(result.summary.teamCount).toBe(1);
      expect(result.summary.activeTeamCount).toBe(1);
      expect(result.summary.memberedContributorCount).toBe(2);
    });

    it('excludes future-dated memberships from activeContributorCount', async () => {
      const now = new Date();
      const futureDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days ahead
      mockPrisma.team.count.mockResolvedValue(1);
      mockPrisma.team.findMany.mockResolvedValue([
        {
          id: 't1', name: 'Alpha', description: null, createdAt: now, updatedAt: now,
          memberships: [
            // Currently active member
            { contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'a@co.com' }] } },
            // Future-dated member — should NOT count as active
            { contributorId: 'c2', effectiveFrom: futureDate, effectiveTo: null, contributor: { aliases: [{ email: 'b@co.com' }] } },
          ],
        },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([]);
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }])
        .mockResolvedValueOnce([{ contributorId: 'c1' }, { contributorId: 'c2' }]);

      const result = await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'name', sortOrder: 'asc' });

      expect(result.teams[0].memberCount).toBe(2); // total unique members (includes future)
      expect(result.teams[0].activeContributorCount).toBe(1); // only c1, not c2
    });

    it('excludes repos with commits outside membership window from list counts', async () => {
      const now = new Date();
      mockPrisma.team.count.mockResolvedValue(1);
      mockPrisma.team.findMany.mockResolvedValue([
        {
          id: 't1', name: 'Alpha', description: null, createdAt: now, updatedAt: now,
          memberships: [
            // Membership from Jun to Dec 2025
            { contributorId: 'c1', effectiveFrom: new Date('2025-06-01'), effectiveTo: new Date('2025-12-31'), contributor: { aliases: [{ email: 'a@co.com' }] } },
          ],
        },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        // Commits only BEFORE membership started — should be excluded
        { authorEmail: 'a@co.com', repository: 'org/old', authorDate: new Date('2025-01-01') },
        { authorEmail: 'a@co.com', repository: 'org/old', authorDate: new Date('2025-03-01') },
        // Commits within membership window — should be included
        { authorEmail: 'a@co.com', repository: 'org/current', authorDate: new Date('2025-07-01') },
        { authorEmail: 'a@co.com', repository: 'org/current', authorDate: new Date('2025-09-01') },
        // Commits only AFTER membership ended — should be excluded
        { authorEmail: 'a@co.com', repository: 'org/future', authorDate: new Date('2026-02-01') },
      ]);
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }])
        .mockResolvedValueOnce([{ contributorId: 'c1' }]);

      const result = await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'name', sortOrder: 'asc' });

      // Only 'org/current' has activity within the membership window
      expect(result.teams[0].activeRepositoryCount).toBe(1);
      expect(result.teams[0].lastActivityAt).toEqual(new Date('2025-09-01'));
    });

    it('applies search filter', async () => {
      mockPrisma.team.count.mockResolvedValue(0);
      mockPrisma.team.findMany.mockResolvedValue([]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([])   // activeTeamIds
        .mockResolvedValueOnce([]);  // memberedContributors

      await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'name', sortOrder: 'asc', search: 'front' });

      const where = mockPrisma.team.count.mock.calls[0][0].where;
      expect(where.OR).toBeDefined();
      expect(where.OR[0].name.contains).toBe('front');
    });

    it('sorts by lastActivityAt globally, not per-page', async () => {
      const now = new Date();
      // Three teams — DB returns all of them when sort is a derived field (no skip/take)
      mockPrisma.team.count.mockResolvedValue(3);
      mockPrisma.team.findMany.mockResolvedValue([
        { id: 't1', name: 'Alpha', description: null, createdAt: now, updatedAt: now,
          memberships: [{ contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'a@co.com' }] } }] },
        { id: 't2', name: 'Beta', description: null, createdAt: now, updatedAt: now,
          memberships: [{ contributorId: 'c2', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'b@co.com' }] } }] },
        { id: 't3', name: 'Gamma', description: null, createdAt: now, updatedAt: now,
          memberships: [{ contributorId: 'c3', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'c@co.com' }] } }] },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        { authorEmail: 'a@co.com', repository: 'org/r1', authorDate: new Date('2025-03-01') },
        { authorEmail: 'b@co.com', repository: 'org/r2', authorDate: new Date('2025-09-01') }, // most recent
        { authorEmail: 'c@co.com', repository: 'org/r3', authorDate: new Date('2025-06-01') },
      ]);
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }, { teamId: 't2' }, { teamId: 't3' }])
        .mockResolvedValueOnce([{ contributorId: 'c1' }, { contributorId: 'c2' }, { contributorId: 'c3' }]);

      // Request page 1, pageSize 2, sorted by lastActivityAt desc
      const result = await listTeams('ws-1', { page: 1, pageSize: 2, sort: 'lastActivityAt', sortOrder: 'desc' });

      // Global sort: Beta (Sep) > Gamma (Jun) > Alpha (Mar). Page 1 size 2 = Beta, Gamma.
      expect(result.teams).toHaveLength(2);
      expect(result.teams[0].teamId).toBe('t2'); // Beta — most recent
      expect(result.teams[1].teamId).toBe('t3'); // Gamma
      // Pagination reflects total, not page size
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.totalPages).toBe(2);
    });

    it('sorts by memberCount using distinct contributors, not raw membership rows', async () => {
      const now = new Date();
      mockPrisma.team.count.mockResolvedValue(2);
      mockPrisma.team.findMany.mockResolvedValue([
        { id: 't1', name: 'Alpha', description: null, createdAt: now, updatedAt: now,
          memberships: [
            // Same contributor with re-entry: 2 rows, but 1 unique contributor
            { contributorId: 'c1', effectiveFrom: new Date('2024-01-01'), effectiveTo: new Date('2024-12-31'), contributor: { aliases: [{ email: 'a@co.com' }] } },
            { contributorId: 'c1', effectiveFrom: new Date('2025-06-01'), effectiveTo: null, contributor: { aliases: [{ email: 'a@co.com' }] } },
          ] },
        { id: 't2', name: 'Beta', description: null, createdAt: now, updatedAt: now,
          memberships: [
            // Two distinct contributors: 2 rows, 2 unique
            { contributorId: 'c2', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'b@co.com' }] } },
            { contributorId: 'c3', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'c@co.com' }] } },
          ] },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([]);
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }, { teamId: 't2' }])
        .mockResolvedValueOnce([{ contributorId: 'c1' }, { contributorId: 'c2' }, { contributorId: 'c3' }]);

      const result = await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'memberCount', sortOrder: 'desc' });

      // Beta has 2 unique contributors, Alpha has 1 (despite 2 membership rows)
      expect(result.teams[0].teamId).toBe('t2');
      expect(result.teams[0].memberCount).toBe(2);
      expect(result.teams[1].teamId).toBe('t1');
      expect(result.teams[1].memberCount).toBe(1); // NOT 2 (raw row count)
    });
  });

  describe('createTeam', () => {
    it('creates a team in the workspace', async () => {
      const created = { id: 't1', workspaceId: 'ws-1', name: 'Frontend', description: null };
      mockPrisma.team.create.mockResolvedValue(created);

      const result = await createTeam('ws-1', { name: 'Frontend' });

      expect(result).toEqual(created);
      expect(mockPrisma.team.create).toHaveBeenCalledWith({
        data: { workspaceId: 'ws-1', name: 'Frontend', description: undefined },
      });
    });
  });

  describe('createTeamFromRepository', () => {
    it('uses first known repository activity as membership effectiveFrom', async () => {
      const createdTeam = { id: 't-repo', workspaceId: 'ws-1', name: 'Core API', description: null };
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.repository.findFirst.mockResolvedValue({ id: 'r1', fullName: 'org/core-api' });
      mockPrisma.commitAnalysis.findMany
        .mockResolvedValueOnce([
          { authorEmail: 'alice@work.com' },
          { authorEmail: 'alice@home.com' },
        ])
        .mockResolvedValueOnce([
          { authorEmail: 'alice@work.com', authorDate: new Date('2025-01-15T10:00:00Z') },
          { authorEmail: 'alice@home.com', authorDate: new Date('2025-03-01T10:00:00Z') },
        ]);
      mockPrisma.contributorAlias.findMany.mockResolvedValue([
        { contributorId: 'c1', email: 'alice@work.com' },
        { contributorId: 'c1', email: 'alice@home.com' },
      ]);
      mockPrisma.team.create.mockResolvedValue(createdTeam);
      mockPrisma.teamMembership.createMany.mockResolvedValue({ count: 1 });

      const result = await createTeamFromRepository('ws-1', 'r1', {
        name: 'Core API',
        contributorIds: ['c1'],
      });

      expect(result).toEqual({ team: createdTeam });
      expect(mockPrisma.teamMembership.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            teamId: 't-repo',
            contributorId: 'c1',
            effectiveFrom: new Date('2025-01-15T10:00:00Z'),
          }),
        ],
      });
    });
  });

  describe('getTeamDetail', () => {
    it('returns null for non-existent team', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await getTeamDetail('t-999', 'ws-1');
      expect(result).toBeNull();
    });

    it('returns team with contributors, scopeInfo, and summaryMetrics', async () => {
      // getTeamDetail calls getTeamRepositories internally — mock both findFirst calls
      const teamData = {
        id: 't1',
        name: 'Frontend',
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        memberships: [
          {
            id: 'm1',
            contributorId: 'c1',
            effectiveFrom: new Date('2025-01-01'),
            effectiveTo: null,
            isPrimary: true,
            role: 'Lead',
            contributor: {
              id: 'c1',
              displayName: 'Alice',
              primaryEmail: 'alice@co.com',
              classification: 'INTERNAL',
              isExcluded: false,
              aliases: [{ email: 'alice@co.com' }],
            },
          },
        ],
      };
      // getTeamDetail calls findFirst once; computeTeamRepositories uses pre-loaded data
      mockPrisma.team.findFirst.mockResolvedValueOnce(teamData);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([]);
      mockPrisma.repository.findMany.mockResolvedValue([]);

      const result = await getTeamDetail('t1', 'ws-1');

      expect(result!.contributors).toHaveLength(1);
      expect(result!.contributors[0].displayName).toBe('Alice');
      expect(result!.contributors[0].isPrimary).toBe(true);
      expect(result!.scopeInfo).toBeDefined();
      expect(result!.scopeInfo.source).toBe('local');
      expect(result!.summaryMetrics).toBeDefined();
      expect(result!.summaryMetrics.memberCount).toBe(1);
      expect(result!.summaryMetrics.activeContributorCount).toBe(1);
      expect(result!.repositories).toBeDefined();
    });
  });

  describe('addMember', () => {
    it('returns error if team not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await addMember('t-999', 'ws-1', { contributorId: 'c1' });
      expect(result).toEqual({ error: 'Team not found' });
    });

    it('returns error if contributor not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue(null);

      const result = await addMember('t1', 'ws-1', { contributorId: 'c-999' });
      expect(result).toEqual({ error: 'Contributor not found' });
    });

    it('rejects overlapping membership in the same team', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue({ id: 'c1' });
      // Existing membership: 2025-01-01 to 2025-12-31
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm-existing', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-12-31') },
      ]);

      const result = await addMember('t1', 'ws-1', {
        contributorId: 'c1',
        effectiveFrom: new Date('2025-06-01'), // overlaps with existing
      });

      expect(result).toEqual({ error: 'Membership overlaps with an existing membership in this team' });
      expect(mockPrisma.teamMembership.create).not.toHaveBeenCalled();
    });

    it('allows non-overlapping membership in the same team (re-entry)', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue({ id: 'c1' });
      // Existing membership ended 2025-06-30
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm-old', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-30') },
      ]);
      mockPrisma.teamMembership.create.mockResolvedValue({
        id: 'm-new', teamId: 't1', contributorId: 'c1', isPrimary: false,
        contributor: { id: 'c1', displayName: 'Alice', primaryEmail: 'alice@co.com' },
      });

      const result = await addMember('t1', 'ws-1', {
        contributorId: 'c1',
        effectiveFrom: new Date('2026-01-01'), // no overlap
      });

      expect(result).toHaveProperty('membership');
    });

    it('only unsets overlapping primary memberships when adding as primary', async () => {
      const from2025 = new Date('2025-01-01');
      const from2026 = new Date('2026-01-01');

      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue({ id: 'c1' });
      // First findMany call: same-team overlap check — no overlap in THIS team
      // Second findMany call: isPrimary check across ALL teams
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([]) // no same-team overlapping memberships
        .mockResolvedValueOnce([   // primary memberships across all teams
          { id: 'm-old', contributorId: 'c1', effectiveFrom: new Date('2024-01-01'), effectiveTo: new Date('2024-12-31'), isPrimary: true },
          { id: 'm-current', contributorId: 'c1', effectiveFrom: from2025, effectiveTo: null, isPrimary: true },
        ]);
      mockPrisma.teamMembership.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.teamMembership.create.mockResolvedValue({
        id: 'm-new', teamId: 't1', contributorId: 'c1', isPrimary: true,
        contributor: { id: 'c1', displayName: 'Alice', primaryEmail: 'alice@co.com' },
      });

      await addMember('t1', 'ws-1', {
        contributorId: 'c1',
        isPrimary: true,
        effectiveFrom: from2026,
      });

      // Should only unset m-current (overlaps with 2026+), not m-old (ended 2024-12-31)
      expect(mockPrisma.teamMembership.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['m-current'] } },
        data: { isPrimary: false },
      });
    });
  });

  describe('updateMembership', () => {
    it('rejects date change that would overlap with sibling membership', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      // Existing membership being updated: 2025-01-01 to 2025-06-30
      mockPrisma.teamMembership.findFirst.mockResolvedValue({
        id: 'm1', teamId: 't1', contributorId: 'c1',
        effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-30'),
      });
      // Sibling membership: 2025-07-01 to 2025-12-31
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm2', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2025-07-01'), effectiveTo: new Date('2025-12-31') },
      ]);

      const result = await updateMembership('m1', 't1', 'ws-1', {
        effectiveTo: new Date('2025-09-01'), // extends into m2's range
      });

      expect(result).toEqual({ error: 'Updated dates would overlap with another membership in this team' });
      expect(mockPrisma.teamMembership.update).not.toHaveBeenCalled();
    });

    it('accepts date change when ranges do not overlap (re-entry gap preserved)', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.teamMembership.findFirst.mockResolvedValue({
        id: 'm1', teamId: 't1', contributorId: 'c1',
        effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-30'),
      });
      // Sibling membership: 2026-01-01 onwards — no overlap with m1's dates
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm2', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
      ]);
      mockPrisma.teamMembership.update.mockResolvedValue({ id: 'm1' });

      const result = await updateMembership('m1', 't1', 'ws-1', {
        effectiveTo: new Date('2025-12-31'), // still before m2
      });

      expect(result).toHaveProperty('membership');
      expect(mockPrisma.teamMembership.update).toHaveBeenCalled();
    });

    it('unsets overlapping isPrimary when promoting to primary', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.teamMembership.findFirst.mockResolvedValue({
        id: 'm1', teamId: 't1', contributorId: 'c1',
        effectiveFrom: new Date('2025-01-01'), effectiveTo: null, isPrimary: false,
      });
      // No siblings in same team (no date overlap check needed when dates unchanged)
      // But there is an existing primary in another team that overlaps
      mockPrisma.teamMembership.findMany.mockResolvedValueOnce([
        { id: 'm-other', contributorId: 'c1', effectiveFrom: new Date('2024-06-01'), effectiveTo: null, isPrimary: true },
      ]);
      mockPrisma.teamMembership.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.teamMembership.update.mockResolvedValue({ id: 'm1', isPrimary: true });

      await updateMembership('m1', 't1', 'ws-1', { isPrimary: true });

      expect(mockPrisma.teamMembership.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['m-other'] } },
        data: { isPrimary: false },
      });
    });
  });

  describe('updateTeam', () => {
    it('updates team fields scoped to workspace', async () => {
      mockPrisma.team.updateMany.mockResolvedValue({ count: 1 });

      const result = await updateTeam('t1', 'ws-1', { name: 'Renamed', description: 'New desc' });

      expect(result.count).toBe(1);
      expect(mockPrisma.team.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', workspaceId: 'ws-1' },
        data: { name: 'Renamed', description: 'New desc' },
      });
    });

    it('returns count 0 when team not in workspace', async () => {
      mockPrisma.team.updateMany.mockResolvedValue({ count: 0 });

      const result = await updateTeam('t-missing', 'ws-1', { name: 'X' });

      expect(result.count).toBe(0);
    });
  });

  describe('deleteTeam', () => {
    it('deletes team scoped to workspace', async () => {
      mockPrisma.team.deleteMany.mockResolvedValue({ count: 1 });

      const result = await deleteTeam('t1', 'ws-1');

      expect(result.count).toBe(1);
      expect(mockPrisma.team.deleteMany).toHaveBeenCalledWith({
        where: { id: 't1', workspaceId: 'ws-1' },
      });
    });

    it('returns count 0 when team not in workspace', async () => {
      mockPrisma.team.deleteMany.mockResolvedValue({ count: 0 });

      const result = await deleteTeam('t-missing', 'ws-1');

      expect(result.count).toBe(0);
    });
  });

  describe('removeMembership', () => {
    it('returns error if team not in workspace', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await removeMembership('m1', 't1', 'ws-1');
      expect(result).toEqual({ error: 'Team not found' });
    });

    it('returns error if membership not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.teamMembership.deleteMany.mockResolvedValue({ count: 0 });

      const result = await removeMembership('m-999', 't1', 'ws-1');
      expect(result).toEqual({ error: 'Membership not found' });
    });
  });

  describe('getTeamRepositories', () => {
    it('returns empty array when team has no members', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1', memberships: [] });

      const result = await getTeamRepositories('t1', 'ws-1');
      expect(result!.repositories).toEqual([]);
    });

    it('returns null when team not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await getTeamRepositories('t-999', 'ws-1');
      expect(result).toBeNull();
    });

    it('excludes commits outside membership effective dates (point-in-time)', async () => {
      const memberFrom = new Date('2025-06-01');
      const memberTo = new Date('2025-12-31');

      mockPrisma.team.findFirst.mockResolvedValue({
        id: 't1',
        memberships: [{
          contributorId: 'c1',
          effectiveFrom: memberFrom,
          effectiveTo: memberTo,
          contributor: { aliases: [{ email: 'alice@co.com' }] },
        }],
      });
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });

      // Three commits: before membership, during, and after
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-03-01'), commitHash: 'aaa' },
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-07-15'), commitHash: 'bbb' },
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2026-02-01'), commitHash: 'ccc' },
      ]);
      mockPrisma.repository.findMany.mockResolvedValue([]);

      const result = await getTeamRepositories('t1', 'ws-1');

      // Only the mid-membership commit should qualify
      expect(result!.repositories).toHaveLength(1);
      expect(result!.repositories[0].activeCommitCount).toBe(1);
    });

    it('treats effectiveTo as exclusive (commit ON end date is excluded)', async () => {
      const endDate = new Date('2025-12-31');

      mockPrisma.team.findFirst.mockResolvedValue({
        id: 't1',
        memberships: [{
          contributorId: 'c1',
          effectiveFrom: new Date('2025-01-01'),
          effectiveTo: endDate,
          contributor: { aliases: [{ email: 'alice@co.com' }] },
        }],
      });
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        // Commit exactly ON the end date — should be excluded (exclusive effectiveTo)
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: endDate, commitHash: 'boundary' },
        // Commit one day before — should be included
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-12-30'), commitHash: 'before' },
      ]);
      mockPrisma.repository.findMany.mockResolvedValue([]);

      const result = await getTeamRepositories('t1', 'ws-1');

      expect(result!.repositories).toHaveLength(1);
      expect(result!.repositories[0].activeCommitCount).toBe(1); // only 'before', not 'boundary'
    });

    it('same-day date range includes commits from that entire day', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({
        id: 't1',
        memberships: [{
          contributorId: 'c1',
          effectiveFrom: new Date('2025-01-01'),
          effectiveTo: null,
          contributor: { aliases: [{ email: 'alice@co.com' }] },
        }],
      });
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        // Commit at noon on July 1 — should be included in from=to=2025-07-01
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-07-01T12:00:00Z'), commitHash: 'noon' },
        // Commit at 11pm — should also be included
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-07-01T23:30:00Z'), commitHash: 'late' },
        // Commit on next day — should be excluded
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-07-02T01:00:00Z'), commitHash: 'next' },
      ]);
      mockPrisma.repository.findMany.mockResolvedValue([]);

      // Same-day range: from=to="2025-07-01" (parses to midnight UTC)
      const sameDay = new Date('2025-07-01');
      const result = await getTeamRepositories('t1', 'ws-1', { from: sameDay, to: sameDay });

      expect(result!.repositories).toHaveLength(1);
      expect(result!.repositories[0].activeCommitCount).toBe(2); // noon + late, not next
    });
  });
});
