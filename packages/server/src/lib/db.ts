import { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'comment-cascade' });

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createExtendedPrisma(): PrismaClient {
  const basePrisma = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

  // Cascade-delete comments when a RepoPublication or DeveloperProfile is deleted.
  // Comments use a polymorphic targetType+targetId pattern without FK constraints,
  // so we clean up orphans here to avoid dangling references.
  // Cast to PrismaClient: the extended client is a runtime superset of PrismaClient,
  // but $extends returns a wider type that breaks Prisma.TransactionClient assignability.
  return basePrisma.$extends({
    query: {
      repoPublication: {
        async delete({ args, query }) {
          const result = await query(args);
          try {
            const deleted = await basePrisma.comment.deleteMany({
              where: { targetType: 'PUBLICATION', targetId: result.id },
            });
            if (deleted.count > 0) {
              log.info(
                { targetType: 'PUBLICATION', targetId: result.id, deleted: deleted.count },
                'Orphan comments deleted',
              );
            }
          } catch (err) {
            log.error(
              { err, targetType: 'PUBLICATION', targetId: result.id },
              'Failed to cascade-delete comments',
            );
          }
          return result;
        },
      },
      developerProfile: {
        async delete({ args, query }) {
          const result = await query(args);
          try {
            const deleted = await basePrisma.comment.deleteMany({
              where: { targetType: 'PROFILE', targetId: result.id },
            });
            if (deleted.count > 0) {
              log.info(
                { targetType: 'PROFILE', targetId: result.id, deleted: deleted.count },
                'Orphan comments deleted',
              );
            }
          } catch (err) {
            log.error(
              { err, targetType: 'PROFILE', targetId: result.id },
              'Failed to cascade-delete comments',
            );
          }
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createExtendedPrisma();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
