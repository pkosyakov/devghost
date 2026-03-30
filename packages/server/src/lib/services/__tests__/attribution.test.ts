import { describe, it, expect } from 'vitest';

// Import directly — mapToCommitAnalysis is a pure mapper, no mocking needed.
// We mock only the modules that analysis-worker.ts imports at module level.
import { vi } from 'vitest';

vi.mock('@/lib/db', () => ({ default: {} }));
vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return {
    logger: mockLogger,
    analysisLogger: mockLogger,
    billingLogger: mockLogger,
    pipelineLogger: mockLogger,
    gitLogger: mockLogger,
  };
});
vi.mock('@/lib/services/pipeline-bridge', () => ({
  spawnPipeline: vi.fn(),
  checkOllamaHealth: vi.fn(),
  aggregateLlmUsage: vi.fn(),
  PipelineError: class extends Error {},
}));
vi.mock('@/lib/services/git-operations', () => ({}));
vi.mock('@/lib/services/pipeline-log-store', () => ({
  appendPipelineLog: vi.fn(),
  getPipelineLogs: vi.fn(),
  clearPipelineLogs: vi.fn(),
  updateJobMeta: vi.fn(),
  getJobMeta: vi.fn(),
}));
vi.mock('@/lib/services/job-registry', () => ({
  registerJob: vi.fn(),
  unregisterJob: vi.fn(),
  isCancelRequested: vi.fn(),
}));
vi.mock('@/lib/services/scope-filter', () => ({
  getInScopeShas: vi.fn(),
  countInScopeCommits: vi.fn(),
}));
vi.mock('@/lib/services/ghost-metrics-service', () => ({}));
vi.mock('@/lib/services/credit-service', () => ({}));

import { mapToCommitAnalysis } from '../analysis-worker';
import type { PipelineCommitResult } from '../pipeline-bridge';

function makeResult(overrides: Partial<PipelineCommitResult>): PipelineCommitResult {
  return {
    sha: 'abc123',
    estimated_hours: 2.0,
    method: 'cascading_none',
    ...overrides,
  };
}

const COMMIT = {
  sha: 'abc123',
  message: 'test commit',
  authorEmail: 'dev@test.com',
  authorName: 'Dev',
  authorDate: new Date('2026-01-01'),
  additions: 50,
  deletions: 10,
  filesCount: 3,
};

const SYSTEM_MODEL = 'qwen/qwen3-coder-next';
const LARGE_MODEL = 'qwen/qwen3-coder-plus';

describe('mapToCommitAnalysis — model attribution', () => {
  // --- FD routes that use the large model ---

  it('FD_v3_holistic stores large model from result.model', () => {
    const result = makeResult({ method: 'FD_v3_holistic', model: LARGE_MODEL });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBe(LARGE_MODEL);
  });

  it('FD_v2_cluster stores large model from result.model', () => {
    const result = makeResult({ method: 'FD_v2_cluster', model: LARGE_MODEL });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBe(LARGE_MODEL);
  });

  // --- FD routes that use the default model ---

  it('FD_hybrid_mechanical stores default model from result.model', () => {
    const result = makeResult({ method: 'FD_hybrid_mechanical_none', model: SYSTEM_MODEL });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBe(SYSTEM_MODEL);
  });

  // --- FD heuristic-only routes ---

  it('FD_cheap stores null', () => {
    const result = makeResult({ method: 'FD_cheap', model: null });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });

  it('FD_bulk_scaffold stores null', () => {
    const result = makeResult({ method: 'FD_bulk_scaffold', model: null });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });

  it('FD_v3_heuristic_only stores null', () => {
    const result = makeResult({ method: 'FD_v3_heuristic_only', model: null });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });

  it('FD_v3_fallback stores null', () => {
    const result = makeResult({ method: 'FD_v3_fallback', model: null });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });

  it('FD_fallback stores null', () => {
    const result = makeResult({ method: 'FD_fallback', model: null });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });

  // --- FD route with missing model field defaults to null, not system model ---

  it('FD route with absent result.model defaults to null', () => {
    const result = makeResult({ method: 'FD_v3_holistic' });
    // result.model is undefined (not set)
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });

  // --- Non-FD routes ---

  it('cascading_none uses system model', () => {
    const result = makeResult({ method: 'cascading_none' });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBe(SYSTEM_MODEL);
  });

  it('cascading_module uses system model', () => {
    const result = makeResult({ method: 'cascading_module' });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBe(SYSTEM_MODEL);
  });

  it('cascading_architectural uses system model', () => {
    const result = makeResult({ method: 'cascading_architectural' });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBe(SYSTEM_MODEL);
  });

  // --- Special methods ---

  it('root_commit_skip stores null', () => {
    const result = makeResult({ method: 'root_commit_skip' });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });

  it('error stores null', () => {
    const result = makeResult({ method: 'error' });
    const mapped = mapToCommitAnalysis(result, COMMIT, 'order-1', 'owner/repo', SYSTEM_MODEL);
    expect(mapped.llmModel).toBeNull();
  });
});
