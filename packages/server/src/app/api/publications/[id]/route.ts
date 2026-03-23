import { NextRequest } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError, parseBody } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { updatePublicationSchema } from '@/lib/schemas';

const log = logger.child({ module: 'publications' });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const { id } = await params;

    const parsed = await parseBody(request, updatePublicationSchema);
    if (!parsed.success) return parsed.error;
    const body = parsed.data;

    const publication = await prisma.repoPublication.findFirst({
      where: { id, publishedById: session.user.id },
    });

    if (!publication) {
      return apiError('Publication not found', 404);
    }

    const allowedFields: Record<string, unknown> = {};
    if (body.isActive !== undefined) allowedFields.isActive = body.isActive;
    if (body.visibleDevelopers !== undefined) allowedFields.visibleDevelopers = body.visibleDevelopers;
    if (body.regenerateToken) allowedFields.shareToken = createId();

    if (Object.keys(allowedFields).length === 0) {
      return apiError('No valid fields to update', 400);
    }

    const updated = await prisma.repoPublication.update({
      where: { id },
      data: allowedFields,
    });

    log.info({ publicationId: id, fields: Object.keys(allowedFields) }, 'Publication updated');

    return apiResponse(updated);
  } catch (error) {
    log.error({ err: error }, 'Failed to update publication');
    return apiError('Failed to update publication', 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const { id } = await params;

    const publication = await prisma.repoPublication.findFirst({
      where: { id, publishedById: session.user.id },
    });

    if (!publication) {
      return apiError('Publication not found', 404);
    }

    await prisma.repoPublication.delete({ where: { id } });

    log.info({ publicationId: id, slug: publication.slug }, 'Publication deleted');

    return apiResponse({ deleted: true });
  } catch (error) {
    log.error({ err: error }, 'Failed to delete publication');
    return apiError('Failed to delete publication', 500);
  }
}
