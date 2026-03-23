import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'comments' });

/**
 * Verify that the target (publication or profile) exists and is active.
 * Returns the ownerId or null if not found / inactive.
 */
export async function verifyTarget(
  targetType: 'PUBLICATION' | 'PROFILE',
  targetId: string,
): Promise<{ ownerId: string } | null> {
  if (targetType === 'PUBLICATION') {
    const pub = await prisma.repoPublication.findUnique({
      where: { id: targetId },
      select: { isActive: true, publishedById: true },
    });
    if (!pub || !pub.isActive) return null;
    return { ownerId: pub.publishedById };
  } else {
    const profile = await prisma.developerProfile.findUnique({
      where: { id: targetId },
      select: { isActive: true, userId: true },
    });
    if (!profile || !profile.isActive) return null;
    return { ownerId: profile.userId };
  }
}

const VALID_TARGET_TYPES = new Set(['PUBLICATION', 'PROFILE']);
const MAX_CONTENT_LENGTH = 1000;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const targetType = searchParams.get('targetType');
    const targetId = searchParams.get('targetId');
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));

    // Validate required params
    if (!targetType || !VALID_TARGET_TYPES.has(targetType)) {
      return apiError('targetType is required and must be PUBLICATION or PROFILE', 400);
    }

    if (!targetId) {
      return apiError('targetId is required', 400);
    }

    // Verify target exists and is active
    const target = await verifyTarget(targetType as 'PUBLICATION' | 'PROFILE', targetId);
    if (!target) {
      return apiError('Target not found', 404);
    }

    // Optionally get current user session (GET is public, so missing auth is fine)
    let currentUserId: string | null = null;
    let currentUserRole: string | null = null;
    try {
      const session = await requireUserSession();
      if (!isErrorResponse(session)) {
        currentUserId = session.user.id;
        currentUserRole = session.user.role;
      }
    } catch {
      // Not authenticated — fine for GET
    }

    const skip = (page - 1) * limit;

    // Fetch root comments with nested replies
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: {
          targetType: targetType as 'PUBLICATION' | 'PROFILE',
          targetId,
          parentId: null,
        },
        include: {
          author: { select: { id: true, name: true, role: true } },
          replies: {
            include: {
              author: { select: { id: true, name: true, role: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.comment.count({
        where: {
          targetType: targetType as 'PUBLICATION' | 'PROFILE',
          targetId,
          parentId: null,
        },
      }),
    ]);

    // Compute canDelete for each comment and reply
    const isAdmin = currentUserRole === 'ADMIN';
    const isOwner = (authorId: string) => currentUserId === authorId;
    const isTargetOwner = currentUserId === target.ownerId;

    const commentsWithPermissions = comments.map((comment: any) => ({
      ...comment,
      canDelete: isAdmin || isTargetOwner || isOwner(comment.authorId),
      replies: (comment.replies || []).map((reply: any) => ({
        ...reply,
        canDelete: isAdmin || isTargetOwner || isOwner(reply.authorId),
      })),
    }));

    log.debug(
      { targetType, targetId, page, limit, total, count: comments.length },
      'Comments fetched',
    );

    return apiResponse({ comments: commentsWithPermissions, total, page, limit });
  } catch (err) {
    log.error({ err }, 'Failed to fetch comments');
    return apiError('Internal server error', 500);
  }
}

export async function POST(request: Request) {
  try {
    // 1. Require authentication
    const session = await requireUserSession();
    if (isErrorResponse(session)) {
      return session;
    }

    // 2. Parse body
    const body = await request.json();
    const { targetType, targetId, content, parentId } = body;

    // 3. Validate targetType
    if (!targetType || !VALID_TARGET_TYPES.has(targetType)) {
      return apiError('targetType is required and must be PUBLICATION or PROFILE', 400);
    }

    // 4. Validate targetId
    if (!targetId) {
      return apiError('targetId is required', 400);
    }

    // 5. Validate content
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return apiError('Content is required and must be a non-empty string', 400);
    }
    if (content.trim().length > MAX_CONTENT_LENGTH) {
      return apiError(`Content must not exceed ${MAX_CONTENT_LENGTH} characters`, 400);
    }

    // 6. Verify target exists and is active
    const target = await verifyTarget(targetType as 'PUBLICATION' | 'PROFILE', targetId);
    if (!target) {
      return apiError('Target not found', 404);
    }

    // 7. If parentId provided, verify parent comment
    if (parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: parentId },
      });

      if (!parent) {
        return apiError('Parent comment not found', 404);
      }

      // Only allow replies to root comments (single level nesting)
      if (parent.parentId !== null) {
        return apiError('Cannot reply to a reply. Only single-level nesting is allowed', 400);
      }

      // Parent must belong to same target
      if (parent.targetType !== targetType || parent.targetId !== targetId) {
        return apiError('Parent comment belongs to a different target', 400);
      }
    }

    // 8. Create comment
    const comment = await prisma.comment.create({
      data: {
        content: content.trim(),
        targetType: targetType as 'PUBLICATION' | 'PROFILE',
        targetId,
        authorId: session.user.id,
        parentId: parentId || undefined,
      },
      include: {
        author: { select: { id: true, name: true, role: true } },
      },
    });

    log.info(
      { commentId: comment.id, targetType, targetId, authorId: session.user.id, parentId },
      'Comment created',
    );

    return apiResponse(comment, 201);
  } catch (err) {
    log.error({ err }, 'Failed to create comment');
    return apiError('Internal server error', 500);
  }
}
