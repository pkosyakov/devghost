/**
 * Services Module — DevGhost
 */

export {
  GhostMetricsService,
  getGhostMetricsService,
} from './ghost-metrics-service';

export { processAnalysisJob } from './analysis-worker';

export {
  cloneOrUpdateRepo,
  extractCommits,
  writeCommitsFile,
  cleanupCommitsFile,
  type GitCommit,
  type CloneResult,
  type ExtractOptions,
} from './git-operations';

export {
  spawnPipeline,
  checkOllamaHealth,
  PipelineError,
  PipelineTimeoutError,
  type PipelineResult,
  type PipelineCommitResult,
  type PipelineOptions,
} from './pipeline-bridge';
