import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';
import { PublicDashboard } from '@/components/public-dashboard';
import { Eye, Calendar } from 'lucide-react';

interface PageProps {
  params: Promise<{ token: string }>;
}

const getPublicationByToken = cache(async (token: string) => {
  const publication = await prisma.repoPublication.findUnique({
    where: { shareToken: token },
    include: {
      publishedBy: { select: { name: true } },
    },
  });

  if (!publication || !publication.isActive) return null;
  return publication;
});

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { token } = await params;
  const publication = await getPublicationByToken(token);

  if (!publication) {
    return {
      title: 'Not Found | DevGhost',
      robots: { index: false, follow: false },
    };
  }

  const title = publication.title || `${publication.owner}/${publication.repo}`;

  return {
    title: `${title} - Shared Analytics | DevGhost`,
    description: `Shared developer productivity analytics for ${publication.owner}/${publication.repo}`,
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({ params }: PageProps) {
  const { token } = await params;
  const publication = await getPublicationByToken(token);

  if (!publication) {
    notFound();
  }

  // Increment view count (fire-and-forget)
  prisma.repoPublication
    .update({
      where: { id: publication.id },
      data: { viewCount: { increment: 1 } },
    })
    .catch(() => {});

  // Compute metrics
  const visibleDevs = publication.visibleDevelopers as string[] | null;
  const metrics = await computeRepoMetrics(
    publication.orderId,
    `${publication.owner}/${publication.repo}`,
    visibleDevs,
  );

  const locale = await getLocale();
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';

  const title =
    publication.title || `${publication.owner}/${publication.repo}`;
  const formattedDate = new Date(publication.createdAt).toLocaleDateString(
    dateLocale,
    { year: 'numeric', month: 'long', day: 'numeric' },
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="text-muted-foreground mt-1">
          {publication.owner}/{publication.repo}
        </p>
        {publication.description && (
          <p className="text-muted-foreground mt-2">
            {publication.description}
          </p>
        )}
        <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <Eye className="h-4 w-4" />
            {publication.viewCount} views
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-4 w-4" />
            Shared {formattedDate}
          </span>
          {publication.publishedBy?.name && (
            <span>by {publication.publishedBy.name}</span>
          )}
        </div>
      </div>

      {/* Dashboard */}
      {metrics.length > 0 ? (
        <PublicDashboard metrics={metrics} />
      ) : (
        <div className="text-center py-20">
          <p className="text-muted-foreground">
            No metrics data available for this repository.
          </p>
        </div>
      )}
    </div>
  );
}
