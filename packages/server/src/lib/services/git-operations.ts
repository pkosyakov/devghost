/**
 * Git operations: clone/update repos, extract commits, temp file management.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const execFileAsync = promisify(execFile);

function envPositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

const GIT_SHALLOW_BUFFER_DAYS = envPositiveInt('GIT_SHALLOW_BUFFER_DAYS', 14);
const GIT_FETCH_TIMEOUT_MS = envPositiveInt('GIT_FETCH_TIMEOUT_SEC', 600) * 1000;
const GIT_CLONE_TIMEOUT_MS = envPositiveInt('GIT_CLONE_TIMEOUT_SEC', 1800) * 1000;
const GIT_LOG_TIMEOUT_MS = envPositiveInt('GIT_LOG_TIMEOUT_SEC', 300) * 1000;
const GIT_PARTIAL_CLONE = envBool('GIT_PARTIAL_CLONE', true);

// ==================== Types ====================

export interface GitCommit {
  sha: string;
  message: string;
  authorEmail: string;
  authorName: string;
  authorDate: Date;
  additions: number;
  deletions: number;
  filesCount: number;
}

export interface CloneResult {
  repoPath: string;
  isNewClone: boolean;
  commitCount: number;
  sizeKb: number;       // git object database size (size-pack from count-objects)
}

export interface ExtractOptions {
  since?: string;         // ISO date string
  until?: string;         // ISO date string
  maxCount?: number;      // Limit number of commits (git --max-count)
  excludedEmails?: string[];
}

// ==================== Helpers ====================

function getCloneBasePath(): string {
  return process.env.CLONE_BASE_PATH || path.resolve(process.cwd(), 'clones');
}

async function execGit(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options?.timeout ?? 120_000;
  // Disable auto gc to prevent "Auto packing the repository in background"
  // messages from interfering with git operations (stderr noise + lock contention)
  return execFileAsync('git', ['-c', 'gc.auto=0', ...args], {
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
    timeout,
    maxBuffer: 50 * 1024 * 1024, // 50 MB for large git log
  });
}

function supportsFilterFallback(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const lower = text.toLowerCase();
  const markers = [
    'unknown option',
    'filter-spec',
    'filtering not recognized by server',
    'server does not support filter',
    'did not send all necessary objects',
    'partial clone',
  ];
  return lower.includes('filter') && markers.some(marker => lower.includes(marker));
}

async function execGitWithFilterFallback(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execGit(args, options);
  } catch (error) {
    if (!args.includes('--filter=blob:none') || !supportsFilterFallback(error)) {
      throw error;
    }
    const fallbackArgs = args.filter((arg) => arg !== '--filter=blob:none');
    return execGit(fallbackArgs, options);
  }
}

async function isValidGitRepo(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, '.git'));
    const { stdout } = await execGit(
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: dirPath },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

// ==================== Clone / Update ====================

/** Strip credentials from error messages to prevent token leakage in logs. */
function sanitizeError(error: unknown, token?: string): Error {
  const msg = error instanceof Error ? error.message : String(error);
  let safe = msg;
  if (token) safe = safe.replaceAll(token, '***');
  // Also strip any x-access-token:XXX@ patterns
  safe = safe.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
  const err = new Error(safe);
  err.name = error instanceof Error ? error.name : 'Error';
  return err;
}

/**
 * Clone or update a repo. When `shallowSince` is provided, only history from
 * that date is downloaded — dramatically faster for large repos with long history.
 * A 14-day buffer is applied internally so `git diff sha~1..sha` works for
 * boundary commits.
 */
export async function cloneOrUpdateRepo(
  cloneUrl: string,
  fullName: string,
  token?: string,
  defaultBranch?: string,
  shallowSince?: string,
): Promise<CloneResult> {
  const basePath = getCloneBasePath();
  const repoPath = path.join(basePath, ...fullName.split('/'));
  const branch = defaultBranch || 'main';

  // Build authenticated URL for private repos
  let authUrl = cloneUrl;
  if (token) {
    const url = new URL(cloneUrl);
    url.username = 'x-access-token';
    url.password = token;
    authUrl = url.toString();
  }

  const gitEnv: Record<string, string> = {
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
  };

  // Add 14-day buffer so parent commits exist for git diff sha~1..sha
  const shallowDate = shallowSince ? toShallowDate(shallowSince, GIT_SHALLOW_BUFFER_DAYS) : undefined;

  try {
    if (await isValidGitRepo(repoPath)) {
      // Update existing clone — ensure longpaths is set for Windows
      await execGit(['config', 'core.longpaths', 'true'], { cwd: repoPath }).catch(() => {});
      await execGit(['remote', 'set-url', 'origin', authUrl], { cwd: repoPath, env: gitEnv });
      // SECURITY: disable push to prevent any accidental writes to client repos
      await execGit(['remote', 'set-url', '--push', 'origin', 'DISABLED'], { cwd: repoPath, env: gitEnv });

      const fetchArgs = ['fetch', '--prune', '--no-tags', 'origin'];
      if (GIT_PARTIAL_CLONE) fetchArgs.splice(1, 0, '--filter=blob:none');
      if (shallowDate) fetchArgs.splice(1, 0, `--shallow-since=${shallowDate}`);
      await execGitWithFilterFallback(fetchArgs, { cwd: repoPath, env: gitEnv, timeout: GIT_FETCH_TIMEOUT_MS });

      await execGit(['reset', '--hard', `origin/${branch}`], { cwd: repoPath, env: gitEnv });

      const { stdout } = await execGit(['rev-list', '--count', 'HEAD'], { cwd: repoPath });
      const sizeKb = await getRepoSizeKb(repoPath);
      return { repoPath, isNewClone: false, commitCount: parseInt(stdout.trim(), 10) || 0, sizeKb };
    }

    // Fresh clone
    await fs.mkdir(path.dirname(repoPath), { recursive: true });

    const cloneArgs = ['-c', 'core.longpaths=true', '-c', 'protocol.version=2', 'clone', '--single-branch', '--branch', branch, '--no-tags'];
    if (GIT_PARTIAL_CLONE) cloneArgs.push('--filter=blob:none');
    if (shallowDate) cloneArgs.push(`--shallow-since=${shallowDate}`);
    cloneArgs.push(authUrl, repoPath);

    await execGitWithFilterFallback(cloneArgs, { env: gitEnv, timeout: GIT_CLONE_TIMEOUT_MS });
    // SECURITY: disable push to prevent any accidental writes to client repos
    await execGit(['remote', 'set-url', '--push', 'origin', 'DISABLED'], { cwd: repoPath, env: gitEnv });

    const { stdout } = await execGit(['rev-list', '--count', 'HEAD'], { cwd: repoPath });
    const sizeKb = await getRepoSizeKb(repoPath);
    return { repoPath, isNewClone: true, commitCount: parseInt(stdout.trim(), 10) || 0, sizeKb };
  } catch (error) {
    throw sanitizeError(error, token);
  }
}

/** Get git object database size in KB using `git count-objects -v`. */
async function getRepoSizeKb(repoPath: string): Promise<number> {
  try {
    const { stdout } = await execGit(['count-objects', '-v'], { cwd: repoPath });
    // size-pack is the total size of pack files in KB
    const packMatch = stdout.match(/size-pack:\s*(\d+)/);
    const looseMatch = stdout.match(/^size:\s*(\d+)/m);
    return (packMatch ? parseInt(packMatch[1]!, 10) : 0) +
           (looseMatch ? parseInt(looseMatch[1]!, 10) : 0);
  } catch {
    return 0;
  }
}

/** Subtract `bufferDays` from an ISO date string, return YYYY-MM-DD for git --shallow-since. */
function toShallowDate(isoDate: string, bufferDays: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() - bufferDays);
  return d.toISOString().slice(0, 10);
}

// ==================== Extract Commits ====================

const LOG_FORMAT = '%H|%ae|%an|%aI|%s';

export async function extractCommits(
  repoPath: string,
  options?: ExtractOptions,
): Promise<GitCommit[]> {
  const args = ['log', `--format=${LOG_FORMAT}`, '--numstat', '--no-merges'];

  if (options?.maxCount) args.push(`--max-count=${options.maxCount}`);
  if (options?.since) args.push(`--since=${options.since}`);
  if (options?.until) args.push(`--until=${options.until}`);

  const { stdout } = await execGit(args, { cwd: repoPath, timeout: GIT_LOG_TIMEOUT_MS });
  if (!stdout.trim()) return [];

  return parseGitLog(stdout, options?.excludedEmails);
}

function parseGitLog(raw: string, excludedEmails?: string[]): GitCommit[] {
  const commits: GitCommit[] = [];
  const excludeSet = new Set(excludedEmails?.map(e => e.toLowerCase()) ?? []);
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) { i++; continue; }

    // Try to parse header line: SHA|email|name|date|message
    const parts = line.split('|');
    if (parts.length < 5 || !/^[0-9a-f]{40}$/.test(parts[0]!)) {
      i++;
      continue;
    }

    const sha = parts[0]!;
    const email = parts[1]!;
    const name = parts[2]!;
    const date = parts[3]!;
    const message = parts.slice(4).join('|'); // message may contain |
    i++;

    // Skip blank line after header
    if (i < lines.length && lines[i]!.trim() === '') i++;

    // Parse numstat lines
    let additions = 0;
    let deletions = 0;
    let filesCount = 0;

    while (i < lines.length) {
      const numLine = lines[i]!;
      if (numLine.trim() === '') { i++; break; }
      // numstat: "added\tdeleted\tfilepath" or "-\t-\tbinaryfile"
      const match = numLine.match(/^(\d+|-)\t(\d+|-)\t(.+)/);
      if (!match) {
        // Could be next commit header
        break;
      }
      const add = match[1] === '-' ? 0 : parseInt(match[1]!, 10);
      const del = match[2] === '-' ? 0 : parseInt(match[2]!, 10);
      additions += add;
      deletions += del;
      filesCount++;
      i++;
    }

    if (excludeSet.has(email.toLowerCase())) continue;

    commits.push({
      sha,
      message,
      authorEmail: email,
      authorName: name,
      authorDate: new Date(date),
      additions,
      deletions,
      filesCount,
    });
  }

  return commits;
}

// ==================== Temp File Management ====================

export async function writeCommitsFile(
  commits: GitCommit[],
  repoFullName: string,
): Promise<string> {
  const safeName = repoFullName.replace(/\//g, '-');
  const filePath = path.join(os.tmpdir(), `devghost-commits-${safeName}-${Date.now()}.json`);

  const data = {
    commits: commits.map(c => ({
      sha: c.sha,
      message: c.message,
      author_email: c.authorEmail,
      author_name: c.authorName,
    })),
  };

  await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
  return filePath;
}

export async function cleanupCommitsFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }
}
