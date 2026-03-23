import { NextRequest, NextResponse } from 'next/server';
import { auditLog } from '@/lib/audit';
import { requireUserSession, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import fs from 'fs/promises';
import path from 'path';

// Use same env var as Python pipeline; default resolves to scripts/.cache inside server package
const CACHE_DIR = process.env.PIPELINE_CACHE_DIR || path.resolve(process.cwd(), 'scripts', '.cache');
const CLONE_DIR = process.env.CLONE_BASE_PATH || path.resolve(process.cwd(), 'clones');

async function dirSize(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0, bytes = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile()) {
        count++;
        const stat = await fs.stat(path.join(e.parentPath || dir, e.name));
        bytes += stat.size;
      }
    }
  } catch { /* dir doesn't exist */ }
  return { count, bytes };
}

/** Count cloned repos (owner/repo subdirs) and total size. */
async function cloneStats(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0, bytes = 0;
  try {
    const owners = await fs.readdir(dir, { withFileTypes: true });
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      const repos = await fs.readdir(path.join(dir, owner.name), { withFileTypes: true });
      for (const repo of repos) {
        if (!repo.isDirectory()) continue;
        count++;
        const stats = await dirSize(path.join(dir, owner.name, repo.name));
        bytes += stats.bytes;
      }
    }
  } catch { /* dir doesn't exist */ }
  return { count, bytes };
}

export async function GET(req: NextRequest) {
  const result = await requireUserSession();
  if (isErrorResponse(result)) return result;

  const repos = await cloneStats(CLONE_DIR);
  const diffs = await dirSize(path.join(CACHE_DIR, 'diffs'));
  const llm = await dirSize(path.join(CACHE_DIR, 'llm'));

  return NextResponse.json({
    totalMb: Math.round((repos.bytes + diffs.bytes + llm.bytes) / 1024 / 1024 * 10) / 10,
    repos: repos.count,
    diffs: diffs.count,
    llm: llm.count,
  });
}

export async function DELETE(req: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const level = req.nextUrl.searchParams.get('level') || 'all';
  const cleared = { repos: 0, diffs: 0, llm: 0 };
  let freedBytes = 0;

  const clearDir = async (dir: string): Promise<number> => {
    try {
      const stat = await dirSize(dir);
      freedBytes += stat.bytes;
      await fs.rm(dir, { recursive: true, force: true });
      return stat.count;
    } catch { return 0; }
  };

  if (level === 'all' || level === 'repos') cleared.repos = await clearDir(CLONE_DIR);
  if (level === 'all' || level === 'diffs') cleared.diffs = await clearDir(path.join(CACHE_DIR, 'diffs'));
  if (level === 'all' || level === 'llm') cleared.llm = await clearDir(path.join(CACHE_DIR, 'llm'));

  await auditLog({
    userId: result.user.id,
    action: 'admin.cache.clear',
    targetType: 'SystemSettings',
    details: { level, freedMb: Math.round(freedBytes / 1024 / 1024 * 10) / 10 },
  });

  return NextResponse.json({ cleared, freedMb: Math.round(freedBytes / 1024 / 1024 * 10) / 10 });
}
