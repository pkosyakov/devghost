import prisma from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'comment-utils' });

export async function deleteCommentsForTarget(
  targetType: 'PUBLICATION' | 'PROFILE',
  targetId: string,
) {
  const result = await prisma.comment.deleteMany({
    where: { targetType, targetId },
  });
  if (result.count > 0) {
    log.info({ targetType, targetId, deleted: result.count }, 'Orphan comments deleted');
  }
}
