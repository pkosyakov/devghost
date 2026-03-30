import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { Workspace } from '@prisma/client';

const log = logger.child({ service: 'workspace' });

/**
 * Ensures a Workspace exists for the given user. Idempotent.
 * Returns the existing or newly created Workspace.
 */
export async function ensureWorkspaceForUser(userId: string): Promise<Workspace> {
  const existing = await prisma.workspace.findUnique({
    where: { ownerId: userId },
  });

  if (existing) {
    return existing;
  }

  try {
    const workspace = await prisma.workspace.create({
      data: { ownerId: userId },
    });
    log.info({ workspaceId: workspace.id, userId }, 'Workspace created');
    return workspace;
  } catch (err: any) {
    // Race condition: another process created the workspace
    if (err?.code === 'P2002') {
      const raced = await prisma.workspace.findUnique({
        where: { ownerId: userId },
      });
      if (raced) return raced;
    }
    throw err;
  }
}
