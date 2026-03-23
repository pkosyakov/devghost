import prisma from '@/lib/db';
import { logger } from '@/lib/logger';
import { Prisma } from '@prisma/client';

export interface AuditLogParams {
  userId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/**
 * Write an audit log entry. Fire-and-forget — never throws.
 */
export async function auditLog(params: AuditLogParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        details: (params.details ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.error({ err, auditAction: params.action }, 'Failed to write audit log');
  }
}
