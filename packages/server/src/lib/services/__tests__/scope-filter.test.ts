import { describe, it, expect } from 'vitest';
import { buildScopeWhereClause } from '../scope-filter';

describe('buildScopeWhereClause', () => {
  it('ALL_TIME returns base filter only', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'ALL_TIME',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
    });
  });

  it('DATE_RANGE adds authorDate filter', () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-12-31');
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'DATE_RANGE',
      analysisYears: [],
      analysisStartDate: start,
      analysisEndDate: end,
      analysisCommitLimit: null,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
      authorDate: { gte: start, lte: end },
    });
  });

  it('LAST_N_COMMITS returns base filter (limit applied separately)', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'LAST_N_COMMITS',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: 100,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
    });
  });

  it('SELECTED_YEARS with empty array returns impossible filter', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'SELECTED_YEARS',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where.orderId).toBe('__impossible__');
  });

  it('SELECTED_YEARS builds OR of per-year date ranges', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'SELECTED_YEARS',
      analysisYears: [2022, 2024],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
      OR: [
        { authorDate: { gte: new Date('2022-01-01T00:00:00Z'), lt: new Date('2023-01-01T00:00:00Z') } },
        { authorDate: { gte: new Date('2024-01-01T00:00:00Z'), lt: new Date('2025-01-01T00:00:00Z') } },
      ],
    });
  });

  it('DATE_RANGE with null dates falls back to base filter', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'DATE_RANGE',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
    });
  });

  it('SELECTED_YEARS with contiguous years still uses per-year OR', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'SELECTED_YEARS',
      analysisYears: [2024, 2025],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where.OR).toHaveLength(2);
  });
});
