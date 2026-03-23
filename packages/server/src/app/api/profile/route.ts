import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { Prisma } from '@prisma/client';
import { requireUserSession, isErrorResponse, apiResponse, apiError, parseBody } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { createProfileSchema, updateProfileSchema } from '@/lib/schemas';

const log = logger.child({ module: 'profile' });

export async function GET(request: NextRequest) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const profile = await prisma.developerProfile.findUnique({
      where: { userId: session.user.id },
    });

    return apiResponse(profile);
  } catch (error) {
    log.error({ err: error }, 'Failed to fetch profile');
    return apiError('Failed to fetch profile', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const parsed = await parseBody(request, createProfileSchema);
    if (!parsed.success) return parsed.error;
    const { slug, displayName, bio, avatarUrl, includedOrderIds } = parsed.data;

    // Check slug uniqueness (excluding own profile)
    const existing = await prisma.developerProfile.findUnique({ where: { slug } });
    if (existing && existing.userId !== session.user.id) {
      return apiError('This slug is already taken', 409);
    }

    const profile = await prisma.developerProfile.upsert({
      where: { userId: session.user.id },
      update: { slug, displayName, bio, avatarUrl, includedOrderIds },
      create: {
        userId: session.user.id,
        slug,
        displayName,
        bio,
        avatarUrl,
        includedOrderIds,
      },
    });

    log.info({ profileId: profile.id, slug }, 'Profile upserted');

    return apiResponse(profile);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError('This slug is already taken', 409);
    }
    log.error({ err: error }, 'Failed to upsert profile');
    return apiError('Failed to upsert profile', 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const profile = await prisma.developerProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!profile) {
      return apiError('Profile not found. Create one first.', 404);
    }

    const parsed = await parseBody(request, updateProfileSchema);
    if (!parsed.success) return parsed.error;
    const body = parsed.data;

    const allowedFields: Record<string, unknown> = {};

    if (body.displayName !== undefined) allowedFields.displayName = body.displayName;
    if (body.bio !== undefined) allowedFields.bio = body.bio;
    if (body.avatarUrl !== undefined) allowedFields.avatarUrl = body.avatarUrl;
    if (body.isActive !== undefined) allowedFields.isActive = body.isActive;
    if (body.includedOrderIds !== undefined) allowedFields.includedOrderIds = body.includedOrderIds;

    if (body.slug !== undefined) {
      const slugTaken = await prisma.developerProfile.findUnique({ where: { slug: body.slug } });
      if (slugTaken && slugTaken.userId !== session.user.id) {
        return apiError('Slug already taken', 409);
      }
      allowedFields.slug = body.slug;
    }

    const updated = await prisma.developerProfile.update({
      where: { userId: session.user.id },
      data: allowedFields,
    });

    log.info({ profileId: updated.id, fields: Object.keys(allowedFields) }, 'Profile updated');

    return apiResponse(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return apiError('Slug already taken', 409);
    }
    log.error({ err: error }, 'Failed to update profile');
    return apiError('Failed to update profile', 500);
  }
}
