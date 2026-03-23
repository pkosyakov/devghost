import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireAdmin, isErrorResponse, apiResponse, apiError, parseBody } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { adminUpdatePublicationSchema } from '@/lib/schemas';

const log = logger.child({ module: 'admin/publications/[id]' });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  try {
    const parsed = await parseBody(request, adminUpdatePublicationSchema);
    if (!parsed.success) return parsed.error;
    const body = parsed.data;

    const publication = await prisma.repoPublication.findUnique({ where: { id } });
    if (!publication) {
      return apiError('Publication not found', 404);
    }

    const allowedFields: Record<string, unknown> = {};
    if (body.isActive !== undefined) allowedFields.isActive = body.isActive;
    if (body.isFeatured !== undefined) allowedFields.isFeatured = body.isFeatured;
    if (body.title !== undefined) allowedFields.title = body.title;
    if (body.description !== undefined) allowedFields.description = body.description;
    if (body.sortOrder !== undefined) allowedFields.sortOrder = body.sortOrder;
    if (body.visibleDevelopers !== undefined) allowedFields.visibleDevelopers = body.visibleDevelopers;

    const updated = await prisma.repoPublication.update({
      where: { id },
      data: allowedFields,
    });

    log.info(
      { publicationId: id, fields: Object.keys(allowedFields) },
      'Admin publication updated',
    );

    return apiResponse(updated);
  } catch (err) {
    log.error({ err, publicationId: id }, 'Failed to update publication');
    return apiError('Failed to update publication', 500);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  try {
    const publication = await prisma.repoPublication.findUnique({ where: { id } });
    if (!publication) {
      return apiError('Publication not found', 404);
    }

    await prisma.repoPublication.delete({ where: { id } });

    log.info({ publicationId: id, slug: publication.slug }, 'Admin publication deleted');

    return apiResponse({ deleted: true });
  } catch (err) {
    log.error({ err, publicationId: id }, 'Failed to delete publication');
    return apiError('Failed to delete publication', 500);
  }
}
