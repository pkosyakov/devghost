import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'referral' });

export async function GET() {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  try {
    const [user, settings, [referralCount, totalEarned]] = await Promise.all([
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { referralCode: true },
      }),
      prisma.systemSettings.findFirst({
        select: { maxReferralsPerUser: true, defaultFreeCredits: true },
      }),
      Promise.all([
        prisma.referral.count({ where: { referrerId: session.user.id } }),
        prisma.referral.aggregate({
          where: { referrerId: session.user.id },
          _sum: { creditsAwarded: true },
        }),
      ]),
    ]);

    const referrals = await prisma.referral.findMany({
      where: { referrerId: session.user.id },
      include: { referred: { select: { email: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return apiResponse({
      referralCode: user?.referralCode,
      stats: {
        invited: referralCount,
        limit: settings?.maxReferralsPerUser ?? 20,
        creditsEarned: totalEarned._sum.creditsAwarded ?? 0,
        creditsPerReferral: settings?.defaultFreeCredits ?? 100,
      },
      referrals: referrals.map((r) => ({
        // Mask email: show first 1-2 chars + domain
        email: r.referred.email.replace(/^(.{1,2}).*?(@.*)$/, '$1***$2'),
        date: r.createdAt,
        creditsAwarded: r.creditsAwarded,
      })),
    });
  } catch (err) {
    log.error({ err, userId: session.user.id }, 'Failed to fetch referral data');
    return apiError('Failed to fetch referral data', 500);
  }
}
