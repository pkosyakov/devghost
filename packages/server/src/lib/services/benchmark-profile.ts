/**
 * Benchmark profile resolver.
 *
 * Defines the explicit rollout candidate pipeline so that order-page
 * benchmarks always test the full target architecture, not an ad-hoc
 * single-model experiment driven by whatever env flags happen to be live.
 */

export type BenchmarkProfileId = 'target_rollout';

export interface ResolvedBenchmarkProfile {
  id: BenchmarkProfileId;
  label: string;
  provider: 'openrouter';
  model: string;
  promptRepeat: false;
  fdV3Enabled: true;
  fdLargeProvider: 'openrouter';
  fdLargeModel: string;
}

const PROFILES: Record<BenchmarkProfileId, ResolvedBenchmarkProfile> = {
  target_rollout: {
    id: 'target_rollout',
    label: 'Full Rollout Candidate',
    provider: 'openrouter',
    model: 'qwen/qwen3-coder-next',
    promptRepeat: false,
    fdV3Enabled: true,
    fdLargeProvider: 'openrouter',
    fdLargeModel: 'qwen/qwen3-coder-plus',
  },
};

export function resolveBenchmarkProfile(id: BenchmarkProfileId): ResolvedBenchmarkProfile {
  return PROFILES[id];
}

export function isBenchmarkProfileId(value: string): value is BenchmarkProfileId {
  return value in PROFILES;
}
