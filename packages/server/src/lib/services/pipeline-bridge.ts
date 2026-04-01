/**
 * Pipeline Bridge — manages Python subprocess for commit analysis.
 */
import { spawn, execFile } from 'child_process';
import path from 'path';
import { getLlmConfig } from '@/lib/llm-config';
import { pipelineLogger } from '@/lib/logger';

// ==================== Types ====================

export interface PipelineCommitResult {
  sha: string;
  estimated_hours: number;
  raw_estimate?: number;
  method: string;
  routed_to?: string;
  analysis?: {
    change_type?: string;
    cognitive_complexity?: string;
    architectural_scope?: string;
    new_logic_percent?: number;
    moved_or_copied_percent?: number;
    boilerplate_percent?: number;
    summary?: string;
  } | null;
  rule_applied?: string | null;
  complexity_score?: number;
  complexity_guard?: string | null;
  fd_details?: Record<string, unknown> | null;
  model?: string | null;
  llm_calls?: Array<{
    prompt_tokens?: number;
    completion_tokens?: number;
    total_duration_ms?: number;
    step?: string;
    [key: string]: unknown;
  }>;
}

export interface PipelineResult {
  status: string;
  commits: PipelineCommitResult[];
  errors: string[];
}

export interface PipelineResultLog {
  sha: string;
  status: 'ok' | 'error' | 'skip';
  hours?: number;
  method?: string;
  type?: string;
  durationMs?: number;
  error?: string;
}

export interface PipelineOptions {
  onProgress?: (current: number, total: number) => void;
  onResult?: (entry: PipelineResultLog) => void;
  onSpawn?: (pid: number | undefined) => void;
  timeoutMs?: number; // default: 30 min
  llmConfigOverride?: import('@/lib/llm-config').LlmConfig; // override system LLM config (e.g. benchmark forcing Ollama)
  noLlmCache?: boolean; // skip LLM cache (re-run same model)
  contextLength?: number;  // model context window size for FD threshold
  failFast?: boolean;  // stop on first LLM error (benchmark mode)
  promptRepeat?: boolean;  // duplicate system prompt in user message (arXiv:2512.14982)
}

export class PipelineError extends Error {
  constructor(message: string, public readonly exitCode?: number | null) {
    super(message);
    this.name = 'PipelineError';
  }
}

export class PipelineTimeoutError extends PipelineError {
  constructor(timeoutMs: number) {
    super(`Pipeline timed out after ${Math.round(timeoutMs / 60000)} minutes`);
    this.name = 'PipelineTimeoutError';
  }
}

// ==================== LLM Usage Aggregation ====================

export interface LlmUsageStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalLlmCalls: number;
  totalDurationMs: number;
}

/** Aggregate LLM usage from pipeline commit results. */
export function aggregateLlmUsage(commits: PipelineCommitResult[]): LlmUsageStats {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalLlmCalls = 0;
  let totalDurationMs = 0;

  for (const commit of commits) {
    for (const call of commit.llm_calls ?? []) {
      totalPromptTokens += call.prompt_tokens ?? 0;
      totalCompletionTokens += call.completion_tokens ?? 0;
      totalDurationMs += call.total_duration_ms ?? 0;
      totalLlmCalls++;
    }
  }

  return { totalPromptTokens, totalCompletionTokens, totalLlmCalls, totalDurationMs };
}

// ==================== Ollama Health ====================

export async function checkOllamaHealth(ollamaUrl?: string): Promise<boolean> {
  const baseUrl = (ollamaUrl || process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

// ==================== Pipeline Spawn ====================

// process.cwd() = packages/server/ when running Next.js
const PIPELINE_SCRIPT = path.resolve(
  process.cwd(), 'scripts/pipeline/run_devghost_pipeline.py'
);

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Kill process and its children. SIGTERM/SIGKILL don't kill child trees on Windows. */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => {});
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }, 5000);
  }
}

export async function spawnPipeline(
  repoPath: string,
  language: string,
  commitsFile: string,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const llmConfig = options?.llmConfigOverride ?? await getLlmConfig();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python',
      [PIPELINE_SCRIPT, repoPath, language, commitsFile],
      {
        cwd: path.dirname(PIPELINE_SCRIPT), // script dir for Python imports
        env: {
          ...process.env,
          LLM_PROVIDER: llmConfig.provider,
          OLLAMA_URL: llmConfig.ollama.url,
          OLLAMA_MODEL: llmConfig.ollama.model,
          OPENROUTER_API_KEY: llmConfig.openrouter.apiKey,
          OPENROUTER_MODEL: llmConfig.openrouter.model,
          OPENROUTER_PROVIDER_ORDER: llmConfig.openrouter.providerOrder.join(','),
          OPENROUTER_PROVIDER_IGNORE: llmConfig.openrouter.providerIgnore.join(','),
          OPENROUTER_ALLOW_FALLBACKS: String(llmConfig.openrouter.allowFallbacks),
          OPENROUTER_REQUIRE_PARAMETERS: String(llmConfig.openrouter.requireParameters),
          NO_LLM_CACHE: options?.noLlmCache ? '1' : '',
          FAIL_FAST: options?.failFast ? '1' : '',
          PROMPT_REPEAT: options?.promptRepeat ? '1' : '',
          MODEL_CONTEXT_LENGTH: String(
            Math.max(4096, Math.min(262144, options?.contextLength || 32768)),
          ),
          LLM_CONCURRENCY: llmConfig.concurrency?.llm != null ? String(llmConfig.concurrency.llm) : '',
          FD_LLM_CONCURRENCY: llmConfig.concurrency?.fd != null ? String(llmConfig.concurrency.fd) : '',
          FD_LLM_CONCURRENCY_CAP: llmConfig.concurrency?.fdCap != null ? String(llmConfig.concurrency.fdCap) : '',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    options?.onSpawn?.(proc.pid);

    let stdout = '';
    let stderr = '';
    let stderrLineBuffer = '';

    proc.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8');
      stderr += chunk;

      // Buffer incomplete lines to handle chunk splitting
      stderrLineBuffer += chunk;
      const lines = stderrLineBuffer.split('\n');
      stderrLineBuffer = lines.pop()!; // keep incomplete last line

      for (const line of lines) {
        // PROGRESS:N/M
        if (options?.onProgress) {
          const progressMatch = line.match(/PROGRESS:(\d+)\/(\d+)/);
          if (progressMatch) {
            options.onProgress(parseInt(progressMatch[1]!, 10), parseInt(progressMatch[2]!, 10));
          }
        }

        // RESULT:{json} — per-commit result for live log
        if (options?.onResult && line.startsWith('RESULT:')) {
          try {
            const entry = JSON.parse(line.slice(7)) as PipelineResultLog;
            options.onResult(entry);
          } catch { /* ignore malformed */ }
        }
      }
    });

    const timer = setTimeout(() => {
      killProcessTree(proc.pid);
      reject(new PipelineTimeoutError(timeoutMs));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Log non-progress stderr lines (ERROR, FATAL, diagnostics from Python)
      const stderrLines = stderr.split('\n')
        .filter(l => l.trim() && !l.startsWith('PROGRESS:') && !l.startsWith('RESULT:'));
      if (stderrLines.length > 0) {
        // Diagnostic lines from our pipeline (context, thresholds)
        const diag = stderrLines.filter(l => l.startsWith('[pipeline]'));
        if (diag.length > 0) {
          pipelineLogger.info({ lines: diag }, 'Pipeline diagnostics');
        }
        // Error/warning lines
        const important = stderrLines.filter(l =>
          l.includes('ERROR') || l.includes('FATAL') || l.includes('OpenRouter'));
        if (important.length > 0) {
          pipelineLogger.warn({ lines: important.slice(0, 10) }, 'Pipeline stderr');
        }
      }

      if (code !== 0) {
        const stderrTail = stderrLines.slice(-5).join('\n');
        reject(new PipelineError(
          `Pipeline exited with code ${code}: ${stderrTail}`,
          code,
        ));
        return;
      }

      try {
        const result = JSON.parse(stdout) as PipelineResult;
        if (result.status === 'error') {
          const errMsg = (result as any).error
            || (result.errors?.length ? result.errors.join('; ') : 'unknown');
          reject(new PipelineError(`Pipeline returned error: ${errMsg}`));
          return;
        }
        resolve(result);
      } catch (e) {
        reject(new PipelineError(
          `Failed to parse pipeline JSON output: ${e}. stdout length=${stdout.length}`,
        ));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new PipelineError(`Failed to spawn Python process: ${err.message}`));
    });
  });
}
