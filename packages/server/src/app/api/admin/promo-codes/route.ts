import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'admin/promo-codes' });

const createSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[A-Z0-9_-]+$/i, 'Code must contain only letters, digits, underscores, or hyphens'),
  credits: z.number().int().positive(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime(),
  description: z.string().max(200).optional(),
});

export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const url = request.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20') || 20),
  );
  const search = url.searchParams.get('search') ?? '';
  const isActive = url.searchParams.get('isActive');

  const where: Record<string, unknown> = {};
  if (search) {
    where.code = { contains: search, mode: 'insensitive' };
  }
  if (isActive !== null && isActive !== '') {
    where.isActive = isActive === 'true';
  }

  try {
    const [promoCodes, total] = await Promise.all([
      prisma.promoCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          redemptions: {
            select: {
              id: true,
              redeemedAt: true,
              user: { select: { email: true, name: true } },
            },
            orderBy: { redeemedAt: 'desc' },
          },
        },
      }),
      prisma.promoCode.count({ where }),
    ]);

    return apiResponse({
      promoCodes,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    log.error({ err }, 'Failed to fetch promo codes');
    return apiError('Failed to fetch promo codes', 500);
  }
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors.map((e) => e.message).join(', '), 400);
  }

  const { code, credits, maxRedemptions, expiresAt, description } = parsed.data;
  const normalizedCode = code.toUpperCase();

  try {
    const promoCode = await prisma.promoCode.create({
      data: {
        code: normalizedCode,
        credits,
        maxRedemptions: maxRedemptions ?? null,
        expiresAt: new Date(expiresAt),
        description,
      },
    });

    await auditLog({
      userId: session.user.id,
      action: 'admin.promoCode.create',
      targetType: 'PromoCode',
      targetId: promoCode.id,
      details: { code: promoCode.code, credits, maxRedemptions },
    });

    log.info({ promoCodeId: promoCode.id, code: promoCode.code }, 'Promo code created');

    return apiResponse(promoCode, 201);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'P2002') {
      return apiError('Promo code already exists', 409);
    }
    log.error({ err, code }, 'Failed to create promo code');
    return apiError('Failed to create promo code', 500);
  }
}
