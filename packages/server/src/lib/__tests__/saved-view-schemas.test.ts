import { describe, expect, it } from 'vitest';
import {
  createSavedViewBodySchema,
  createSavedViewFromScopeBodySchema,
  savedViewListQuerySchema,
  updateSavedViewBodySchema,
} from '@/lib/schemas/saved-view';
import {
  activeScopeQuerySchema,
  savedViewFilterDefinitionSchema,
  savedViewScopeDefinitionSchema,
} from '@/lib/schemas/scope';

describe('savedViewListQuerySchema', () => {
  it('applies defaults for missing fields', () => {
    const result = savedViewListQuerySchema.parse({});
    expect(result).toEqual({
      page: 1,
      pageSize: 20,
      sort: 'updatedAt',
      sortOrder: 'desc',
      includeArchived: false,
    });
  });

  it('coerces string numbers', () => {
    const result = savedViewListQuerySchema.parse({ page: '3', pageSize: '10' });
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
  });

  it('rejects page size above 100', () => {
    const result = savedViewListQuerySchema.safeParse({ pageSize: '200' });
    expect(result.success).toBe(false);
  });

  it('accepts search and includeArchived', () => {
    const result = savedViewListQuerySchema.parse({
      search: 'backend',
      includeArchived: 'true',
    });
    expect(result.search).toBe('backend');
    expect(result.includeArchived).toBe(true);
  });
});

describe('createSavedViewBodySchema', () => {
  it('validates a minimal body with defaults', () => {
    const result = createSavedViewBodySchema.parse({
      name: 'My View',
      scopeDefinition: {},
    });
    expect(result.name).toBe('My View');
    expect(result.visibility).toBe('PRIVATE');
    expect(result.filterDefinition).toEqual({
      repositoryIds: [],
      contributorIds: [],
    });
  });

  it('trims and rejects empty name', () => {
    expect(createSavedViewBodySchema.safeParse({
      name: '   ',
      scopeDefinition: {},
    }).success).toBe(false);
  });

  it('rejects name longer than 120 characters', () => {
    expect(createSavedViewBodySchema.safeParse({
      name: 'a'.repeat(121),
      scopeDefinition: {},
    }).success).toBe(false);
  });

  it('accepts full body with all fields', () => {
    const result = createSavedViewBodySchema.parse({
      name: 'Full View',
      visibility: 'WORKSPACE',
      scopeDefinition: {
        teamIds: ['t1'],
        dateRange: { start: '2026-01-01', end: '2026-03-31' },
      },
      filterDefinition: {
        repositoryIds: ['r1'],
        contributorIds: ['c1'],
      },
    });
    expect(result.visibility).toBe('WORKSPACE');
    expect(result.scopeDefinition.teamIds).toEqual(['t1']);
  });
});

describe('updateSavedViewBodySchema', () => {
  it('allows partial update with only name', () => {
    const result = updateSavedViewBodySchema.parse({ name: 'Renamed' });
    expect(result).toEqual({ name: 'Renamed' });
  });

  it('allows partial update with only visibility', () => {
    const result = updateSavedViewBodySchema.parse({ visibility: 'WORKSPACE' });
    expect(result).toEqual({ visibility: 'WORKSPACE' });
  });

  it('allows empty object (no updates)', () => {
    const result = updateSavedViewBodySchema.parse({});
    expect(result).toEqual({});
  });
});

describe('createSavedViewFromScopeBodySchema', () => {
  it('validates body with activeScope', () => {
    const result = createSavedViewFromScopeBodySchema.parse({
      name: 'Scope View',
      activeScope: {
        scopeKind: 'team',
        scopeId: 'team_1',
        from: '2026-01-01',
      },
    });
    expect(result.name).toBe('Scope View');
    expect(result.visibility).toBe('PRIVATE');
    expect(result.activeScope.scopeKind).toBe('team');
  });

  it('rejects missing name', () => {
    expect(createSavedViewFromScopeBodySchema.safeParse({
      activeScope: { scopeKind: 'all_teams' },
    }).success).toBe(false);
  });
});

describe('activeScopeQuerySchema', () => {
  it('requires scopeId for non-all_teams scope', () => {
    const result = activeScopeQuerySchema.safeParse({ scopeKind: 'team' });
    expect(result.success).toBe(false);
  });

  it('does not require scopeId for all_teams', () => {
    const result = activeScopeQuerySchema.parse({ scopeKind: 'all_teams' });
    expect(result.scopeKind).toBe('all_teams');
  });

  it('rejects from > to', () => {
    const result = activeScopeQuerySchema.safeParse({
      scopeKind: 'all_teams',
      from: '2026-04-01',
      to: '2026-03-01',
    });
    expect(result.success).toBe(false);
  });

  it('accepts from = to (single day)', () => {
    const result = activeScopeQuerySchema.parse({
      scopeKind: 'all_teams',
      from: '2026-03-15',
      to: '2026-03-15',
    });
    expect(result.from).toBe('2026-03-15');
    expect(result.to).toBe('2026-03-15');
  });

  it('parses CSV repositoryIds', () => {
    const result = activeScopeQuerySchema.parse({
      scopeKind: 'all_teams',
      repositoryIds: 'r1,r2,r3',
    });
    expect(result.repositoryIds).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('savedViewScopeDefinitionSchema', () => {
  it('applies defaults for empty object', () => {
    const result = savedViewScopeDefinitionSchema.parse({});
    expect(result).toEqual({
      teamIds: [],
      dateRange: { start: null, end: null },
    });
  });

  it('rejects malformed date strings', () => {
    const result = savedViewScopeDefinitionSchema.safeParse({
      dateRange: { start: 'not-a-date' },
    });
    expect(result.success).toBe(false);
  });
});

describe('savedViewFilterDefinitionSchema', () => {
  it('applies defaults', () => {
    const result = savedViewFilterDefinitionSchema.parse({});
    expect(result).toEqual({
      repositoryIds: [],
      contributorIds: [],
    });
  });
});
