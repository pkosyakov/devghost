import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';
import { PublicDashboard } from '@/components/public-dashboard';
import { Badge } from '@/components/ui/badge';
import { CommentSection } from '@/components/comment-section';
import { Eye, Calendar } from 'lucide-react';
import { getTranslations, getLocale } from 'next-intl/server';

interface PageProps {
  params: Promise<{ owner: string; repo: string }>;
}

const getPublication = cache(async (owner: string, repo: string) => {
  const slug = `${owner}/${repo}`;
  const publication = await prisma.repoPublication.findUnique({
    where: { slug },
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
  const { owner, repo } = await params;
  const t = await getTranslations('explore');
  const publication = await getPublication(owner, repo);

  if (!publication) {
    return { title: t('notFoundTitle') };
  }

  const title = publication.title || `${owner}/${repo}`;
  const description =
    publication.description ||
    t('metaDescription', { owner, repo });

  return {
    title: t('metaTitle', { title }),
    description,
    openGraph: {
      title: t('ogTitle', { title }),
      description,
      type: 'article',
    },
  };
}

export default async function RepoDetailPage({ params }: PageProps) {
  const { owner, repo } = await params;
  const t = await getTranslations('explore');
  const locale = await getLocale();
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
  const publication = await getPublication(owner, repo);

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
    `${owner}/${repo}`,
    visibleDevs,
  );

  const title = publication.title || `${owner}/${repo}`;
  const formattedDate = new Date(publication.createdAt).toLocaleDateString(
    dateLocale,
    { year: 'numeric', month: 'long', day: 'numeric' },
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold">{title}</h1>
            <p className="text-muted-foreground mt-1">
              {owner}/{repo}
            </p>
          </div>
          {publication.isFeatured && (
            <Badge variant="secondary">{t('featured')}</Badge>
          )}
        </div>
        {publication.description && (
          <p className="text-muted-foreground mt-2">
            {publication.description}
          </p>
        )}
        <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <Eye className="h-4 w-4" />
            {t('views', { count: publication.viewCount })}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-4 w-4" />
            {t('published', { date: formattedDate })}
          </span>
          {publication.publishedBy?.name && (
            <span>{t('byAuthor', { author: publication.publishedBy.name })}</span>
          )}
        </div>
      </div>

      {/* Dashboard */}
      {metrics.length > 0 ? (
        <PublicDashboard metrics={metrics} />
      ) : (
        <div className="text-center py-20">
          <p className="text-muted-foreground">
            {t('noMetrics')}
          </p>
        </div>
      )}

      {/* Comments */}
      <CommentSection targetType="PUBLICATION" targetId={publication.id} />
    </div>
  );
}
