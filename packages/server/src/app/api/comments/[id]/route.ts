import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'comments-delete' });

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 1. Require authentication
    const session = await requireUserSession();
    if (isErrorResponse(session)) {
      return session;
    }

    // 2. Extract id from params
    const { id } = await params;

    // 3. Find comment by id
    const comment = await prisma.comment.findUnique({
      where: { id },
    });

    if (!comment) {
      return apiError('Comment not found', 404);
    }

    // 4. Check permissions
    const isAuthor = comment.authorId === session.user.id;
    const isAdmin = session.user.role === 'ADMIN';

    let isTargetOwner = false;

    if (!isAuthor && !isAdmin) {
      // Check if current user is the target owner
      if (comment.targetType === 'PUBLICATION') {
        const publication = await prisma.repoPublication.findUnique({
          where: { id: comment.targetId },
          select: { publishedById: true },
        });
        isTargetOwner = publication?.publishedById === session.user.id;
      } else if (comment.targetType === 'PROFILE') {
        const profile = await prisma.developerProfile.findUnique({
          where: { id: comment.targetId },
          select: { userId: true },
        });
        isTargetOwner = profile?.userId === session.user.id;
      }
    }

    // 5. Return 403 if no permission
    if (!isAuthor && !isAdmin && !isTargetOwner) {
      log.warn(
        { commentId: id, userId: session.user.id },
        'Forbidden: user cannot delete this comment',
      );
      return apiError('Forbidden', 403);
    }

    // 6. Delete comment (Prisma cascade handles replies)
    await prisma.comment.delete({
      where: { id },
    });

    log.info(
      { commentId: id, deletedBy: session.user.id, reason: isAuthor ? 'author' : isAdmin ? 'admin' : 'target-owner' },
      'Comment deleted',
    );

    return apiResponse({ deleted: true });
  } catch (err) {
    log.error({ err }, 'Failed to delete comment');
    return apiError('Internal server error', 500);
  }
}
