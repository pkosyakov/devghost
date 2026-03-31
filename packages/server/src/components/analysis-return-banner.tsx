'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ArrowLeft } from 'lucide-react';

export function AnalysisReturnBanner() {
  const searchParams = useSearchParams();
  const fromAnalysis = searchParams.get('fromAnalysis');
  const t = useTranslations('analysisResults');

  if (!fromAnalysis) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-muted bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
      <ArrowLeft className="h-4 w-4 shrink-0" />
      <span>{t('returnBanner.text')}</span>
      <Link
        href={`/orders/${fromAnalysis}`}
        className="ml-1 font-medium text-primary hover:underline"
      >
        {t('returnBanner.cta')}
      </Link>
    </div>
  );
}
