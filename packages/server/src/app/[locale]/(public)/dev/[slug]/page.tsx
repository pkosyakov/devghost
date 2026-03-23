import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import prisma from '@/lib/db';
import { DevProfileView } from '@/components/dev-profile-view';
import { CommentSection } from '@/components/comment-section';

interface PageProps {
  params: Promise<{ slug: string }>;
}

const getProfile = cache(async (slug: string) => {
  const profile = await prisma.developerProfile.findUnique({
    where: { slug },
    include: {
      user: { select: { email: true, name: true, githubUsername: true } },
    },
  });

  if (!profile || !profile.isActive) return null;
  return profile;
});

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const profile = await getProfile(slug);

  if (!profile) {
    return { title: 'Not Found | DevGhost' };
  }

  const description =
    profile.bio || `Developer productivity profile for ${profile.displayName}`;

  return {
    title: `${profile.displayName} - Developer Profile | DevGhost`,
    description,
    openGraph: {
      title: `${profile.displayName} - Developer Profile`,
      description,
      type: 'profile',
    },
  };
}

export default async function DevProfilePage({ params }: PageProps) {
  const { slug } = await params;
  const profile = await getProfile(slug);

  if (!profile) {
    notFound();
  }

  // Increment view count (fire-and-forget)
  prisma.developerProfile
    .update({
      where: { id: profile.id },
      data: { viewCount: { increment: 1 } },
    })
    .catch(() => {});

  // Fetch order metrics for this developer
  const includedIds = profile.includedOrderIds as string[] | null;
  const orderWhere = includedIds
    ? { id: { in: includedIds }, status: 'COMPLETED' as const }
    : { userId: profile.userId, status: 'COMPLETED' as const };

  const orders = await prisma.order.findMany({
    where: orderWhere,
    select: { id: true, name: true, selectedRepos: true },
  });

  const metrics = await prisma.orderMetric.findMany({
    where: {
      orderId: { in: orders.map((o: { id: string }) => o.id) },
      developerEmail: profile.user.email,
      periodType: 'ALL_TIME',
    },
    select: {
      orderId: true,
      commitCount: true,
      workDays: true,
      totalEffortHours: true,
      avgDailyEffort: true,
      ghostPercent: true,
      share: true,
    },
  });

  // Map order names and repos
  type Order = { id: string; name: string; selectedRepos: unknown };
  const orderMap = new Map<string, Order>(orders.map((o: Order) => [o.id, o]));
  type Metric = (typeof metrics)[number];
  const enrichedOrders = metrics.map((m: Metric) => ({
    orderId: m.orderId,
    orderName: orderMap.get(m.orderId)?.name || 'Unknown',
    repos:
      (orderMap.get(m.orderId)?.selectedRepos as Record<string, unknown>[])?.map(
        (r: Record<string, unknown>) =>
          (r.fullName as string) ||
          (r.full_name as string) ||
          `${(r.owner as Record<string, unknown>)?.login}/${r.name}`,
      ) || [],
    commitCount: m.commitCount,
    workDays: m.workDays,
    totalEffortHours: Number(m.totalEffortHours),
    avgDailyEffort: Number(m.avgDailyEffort),
    ghostPercent: m.ghostPercent ? Number(m.ghostPercent) : null,
    share: Number(m.share),
  }));

  // Compute summary
  const summary = {
    totalOrders: metrics.length,
    totalCommits: metrics.reduce((s: number, m: Metric) => s + m.commitCount, 0),
    totalWorkDays: metrics.reduce((s: number, m: Metric) => s + m.workDays, 0),
    totalEffortHours: metrics.reduce(
      (s: number, m: Metric) => s + Number(m.totalEffortHours || 0),
      0,
    ),
    avgGhostPercent:
      metrics.length > 0
        ? metrics.reduce((s: number, m: Metric) => s + Number(m.ghostPercent || 0), 0) /
          metrics.length
        : null,
  };

  const profileData = {
    slug: profile.slug,
    displayName: profile.displayName,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    githubUsername: profile.user.githubUsername,
    viewCount: profile.viewCount,
    createdAt: profile.createdAt.toISOString(),
  };

  return (
    <>
      <DevProfileView
        profile={profileData}
        summary={summary}
        orders={enrichedOrders}
      />
      <div className="mt-6">
        <CommentSection targetType="PROFILE" targetId={profile.id} />
      </div>
    </>
  );
}
