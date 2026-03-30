import { describe, expect, it } from 'vitest';
import {
  buildHrefWithActiveScope,
  deriveSavedViewScopeKind,
  isScopeDirtyAgainstSavedView,
  parseDateOnlyToUtcStart,
  pickActiveScopeParams,
  resolvedScopeToSavedViewDefinitions,
  scopeQueryToSavedViewDefinitions,
  toDateOnlyString,
} from '@/lib/active-scope';

describe('active-scope helpers', () => {
  it('picks only active scope params from search params', () => {
    const params = new URLSearchParams({
      scopeKind: 'team',
      scopeId: 'team_1',
      from: '2026-03-01',
      to: '2026-03-30',
      search: 'ignored',
    });

    expect(pickActiveScopeParams(params).toString()).toBe(
      'scopeKind=team&scopeId=team_1&from=2026-03-01&to=2026-03-30',
    );
  });

  it('builds href with preserved active scope', () => {
    const params = new URLSearchParams({
      scopeKind: 'saved_view',
      scopeId: 'view_1',
      contributorIds: 'c1,c2',
    });

    expect(buildHrefWithActiveScope('/reports', params)).toBe(
      '/reports?scopeKind=saved_view&scopeId=view_1&contributorIds=c1%2Cc2',
    );
  });

  it('converts active scope query into saved view definitions', () => {
    const definitions = scopeQueryToSavedViewDefinitions({
      scopeKind: 'team',
      scopeId: 'team_42',
      from: '2026-03-01',
      to: '2026-03-31',
      repositoryIds: ['repo_1'],
      contributorIds: ['contrib_1'],
    });

    expect(definitions).toEqual({
      scopeDefinition: {
        teamIds: ['team_42'],
        dateRange: {
          start: '2026-03-01',
          end: '2026-03-31',
        },
      },
      filterDefinition: {
        repositoryIds: ['repo_1'],
        contributorIds: ['contrib_1'],
      },
    });
  });

  it('derives all_teams, team, and custom saved view kinds', () => {
    expect(
      deriveSavedViewScopeKind(
        { teamIds: [], dateRange: { start: null, end: null } },
        { repositoryIds: [], contributorIds: [] },
      ),
    ).toBe('all_teams');

    expect(
      deriveSavedViewScopeKind(
        { teamIds: ['team_1'], dateRange: { start: null, end: null } },
        { repositoryIds: [], contributorIds: [] },
      ),
    ).toBe('team');

    expect(
      deriveSavedViewScopeKind(
        { teamIds: ['team_1'], dateRange: { start: null, end: null } },
        { repositoryIds: ['repo_1'], contributorIds: [] },
      ),
    ).toBe('custom');
  });

  it('detects when URL-backed scope is dirty against saved view definitions', () => {
    const activeScope = {
      scopeKind: 'team' as const,
      scopeId: 'team_1',
      from: '2026-03-01',
      to: '2026-03-31',
      repositoryIds: ['repo_1'],
      contributorIds: [],
    };

    expect(
      isScopeDirtyAgainstSavedView(
        activeScope,
        { teamIds: ['team_1'], dateRange: { start: '2026-03-01', end: '2026-03-31' } },
        { repositoryIds: ['repo_1'], contributorIds: [] },
      ),
    ).toBe(false);

    expect(
      isScopeDirtyAgainstSavedView(
        activeScope,
        { teamIds: ['team_1'], dateRange: { start: '2026-03-01', end: '2026-03-31' } },
        { repositoryIds: [], contributorIds: [] },
      ),
    ).toBe(true);
  });

  it('treats an activated saved view as clean when resolved team ids match', () => {
    expect(
      isScopeDirtyAgainstSavedView(
        {
          scopeKind: 'saved_view',
          scopeId: 'view_1',
          from: '2026-03-01',
          to: '2026-03-31',
          repositoryIds: [],
          contributorIds: [],
        },
        { teamIds: ['team_1'], dateRange: { start: '2026-03-01', end: '2026-03-31' } },
        { repositoryIds: [], contributorIds: [] },
        ['team_1'],
      ),
    ).toBe(false);
  });

  it('formats dates into YYYY-MM-DD strings', () => {
    expect(toDateOnlyString(new Date('2026-03-30T15:45:00.000Z'))).toBe('2026-03-30');
    expect(toDateOnlyString('2026-04-01T00:00:00.000Z')).toBe('2026-04-01');
    expect(toDateOnlyString(null)).toBeNull();
  });

  it('converts resolved scope into saved view definitions preserving all fields', () => {
    const defs = resolvedScopeToSavedViewDefinitions({
      teamIds: ['team_a', 'team_b'],
      dateRange: { start: '2026-01-01', end: '2026-06-30' },
      secondaryFilters: {
        repositoryIds: ['repo_x'],
        contributorIds: ['contrib_y', 'contrib_z'],
      },
    });

    expect(defs).toEqual({
      scopeDefinition: {
        teamIds: ['team_a', 'team_b'],
        dateRange: { start: '2026-01-01', end: '2026-06-30' },
      },
      filterDefinition: {
        repositoryIds: ['repo_x'],
        contributorIds: ['contrib_y', 'contrib_z'],
      },
    });
  });

  it('converts resolved scope with null dates', () => {
    const defs = resolvedScopeToSavedViewDefinitions({
      teamIds: [],
      dateRange: { start: null, end: null },
      secondaryFilters: { repositoryIds: [], contributorIds: [] },
    });

    expect(defs.scopeDefinition.dateRange).toEqual({ start: null, end: null });
    expect(defs.filterDefinition).toEqual({ repositoryIds: [], contributorIds: [] });
  });

  it('parses date-only string to UTC midnight', () => {
    const d = parseDateOnlyToUtcStart('2026-03-15');
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('returns undefined for null/undefined date input', () => {
    expect(parseDateOnlyToUtcStart(null)).toBeUndefined();
    expect(parseDateOnlyToUtcStart(undefined)).toBeUndefined();
  });

  describe('isScopeDirtyAgainstSavedView — activation preserves scope', () => {
    const savedScope = {
      teamIds: ['team_1'],
      dateRange: { start: '2026-01-01', end: '2026-03-31' },
    };
    const savedFilter = {
      repositoryIds: ['repo_1', 'repo_2'],
      contributorIds: ['c_1'],
    };

    it('is clean when URL scope exactly matches saved definitions', () => {
      expect(
        isScopeDirtyAgainstSavedView(
          {
            scopeKind: 'team',
            scopeId: 'team_1',
            from: '2026-01-01',
            to: '2026-03-31',
            repositoryIds: ['repo_1', 'repo_2'],
            contributorIds: ['c_1'],
          },
          savedScope,
          savedFilter,
        ),
      ).toBe(false);
    });

    it('is dirty when date range changes', () => {
      expect(
        isScopeDirtyAgainstSavedView(
          {
            scopeKind: 'team',
            scopeId: 'team_1',
            from: '2026-02-01',
            to: '2026-03-31',
            repositoryIds: ['repo_1', 'repo_2'],
            contributorIds: ['c_1'],
          },
          savedScope,
          savedFilter,
        ),
      ).toBe(true);
    });

    it('is dirty when repositoryIds differ', () => {
      expect(
        isScopeDirtyAgainstSavedView(
          {
            scopeKind: 'team',
            scopeId: 'team_1',
            from: '2026-01-01',
            to: '2026-03-31',
            repositoryIds: ['repo_1'],
            contributorIds: ['c_1'],
          },
          savedScope,
          savedFilter,
        ),
      ).toBe(true);
    });

    it('is dirty when contributorIds differ', () => {
      expect(
        isScopeDirtyAgainstSavedView(
          {
            scopeKind: 'team',
            scopeId: 'team_1',
            from: '2026-01-01',
            to: '2026-03-31',
            repositoryIds: ['repo_1', 'repo_2'],
            contributorIds: [],
          },
          savedScope,
          savedFilter,
        ),
      ).toBe(true);
    });

    it('activated saved_view uses resolvedTeamIds for comparison, not scopeId', () => {
      // When scopeKind=saved_view, the URL has scopeId=view_id not team_id.
      // resolvedTeamIds override lets us compare resolved teams.
      expect(
        isScopeDirtyAgainstSavedView(
          {
            scopeKind: 'saved_view',
            scopeId: 'view_abc',
            from: '2026-01-01',
            to: '2026-03-31',
            repositoryIds: ['repo_1', 'repo_2'],
            contributorIds: ['c_1'],
          },
          savedScope,
          savedFilter,
          ['team_1'],
        ),
      ).toBe(false);
    });

    it('activated saved_view is dirty when resolvedTeamIds differ from saved', () => {
      expect(
        isScopeDirtyAgainstSavedView(
          {
            scopeKind: 'saved_view',
            scopeId: 'view_abc',
            from: '2026-01-01',
            to: '2026-03-31',
            repositoryIds: ['repo_1', 'repo_2'],
            contributorIds: ['c_1'],
          },
          savedScope,
          savedFilter,
          ['team_1', 'team_2'],
        ),
      ).toBe(true);
    });
  });

  describe('deriveSavedViewScopeKind — edge cases', () => {
    it('treats multiple teams as custom', () => {
      expect(
        deriveSavedViewScopeKind(
          { teamIds: ['a', 'b'], dateRange: { start: null, end: null } },
          { repositoryIds: [], contributorIds: [] },
        ),
      ).toBe('custom');
    });

    it('treats single team with contributors as custom', () => {
      expect(
        deriveSavedViewScopeKind(
          { teamIds: ['a'], dateRange: { start: null, end: null } },
          { repositoryIds: [], contributorIds: ['c1'] },
        ),
      ).toBe('custom');
    });

    it('treats no teams but with repositoryIds as custom', () => {
      expect(
        deriveSavedViewScopeKind(
          { teamIds: [], dateRange: { start: null, end: null } },
          { repositoryIds: ['r1'], contributorIds: [] },
        ),
      ).toBe('custom');
    });
  });

  it('scopeQueryToSavedViewDefinitions uses empty teamIds for all_teams', () => {
    const defs = scopeQueryToSavedViewDefinitions({
      scopeKind: 'all_teams',
      from: '2026-01-01',
      repositoryIds: [],
      contributorIds: [],
    });
    expect(defs.scopeDefinition.teamIds).toEqual([]);
  });

  it('pickActiveScopeParams preserves repositoryIds and contributorIds', () => {
    const params = new URLSearchParams({
      scopeKind: 'saved_view',
      scopeId: 'sv_1',
      repositoryIds: 'r1,r2',
      contributorIds: 'c1',
      irrelevant: 'dropped',
    });

    const picked = pickActiveScopeParams(params);
    expect(picked.get('repositoryIds')).toBe('r1,r2');
    expect(picked.get('contributorIds')).toBe('c1');
    expect(picked.has('irrelevant')).toBe(false);
  });
});

