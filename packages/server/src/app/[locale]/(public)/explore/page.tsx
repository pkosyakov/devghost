import type { Metadata } from 'next';
import prisma from '@/lib/db';
import { ExploreGrid } from '@/components/explore-grid';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

export const metadata: Metadata = {
  title: 'Explore Developer Analytics | DevGhost',
  description:
    'Explore developer productivity analytics for open source repositories.',
  openGraph: {
    title: 'Explore Developer Analytics | DevGhost',
    description:
      'Explore developer productivity analytics for open source repositories.',
    type: 'website',
  },
};

export default async function ExplorePage() {
  const t = await getTranslations('explore');
  const pageSize = 20;

  const [items, total] = await Promise.all([
    prisma.repoPublication.findMany({
      where: { isActive: true },
      orderBy: [
        { isFeatured: 'desc' },
        { sortOrder: 'asc' },
        { viewCount: 'desc' },
      ],
      take: pageSize,
      select: {
        id: true,
        owner: true,
        repo: true,
        slug: true,
        publishType: true,
        isFeatured: true,
        title: true,
        description: true,
        viewCount: true,
        createdAt: true,
      },
    }),
    prisma.repoPublication.count({ where: { isActive: true } }),
  ]);

  const initialData = {
    items: items.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
    total,
    page: 1,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">
          {t('description')}
        </p>
      </div>
      <ExploreGrid initialData={initialData} />
      <div className="text-center py-8 border-t mt-8">
        <h3 className="font-semibold mb-1">{t('publishCta')}</h3>
        <p className="text-muted-foreground text-sm mb-4">{t('publishCtaDescription')}</p>
        <Link href="/publications">
          <Button variant="outline">{t('publishCta')}</Button>
        </Link>
      </div>
    </div>
  );
}
