'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search } from 'lucide-react';

interface RepositoryFiltersProps {
  search: string;
  freshness: string;
  language: string;
  languages: { language: string | null; count: number }[];
  onSearchChange: (value: string) => void;
  onFreshnessChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
}

export function RepositoryFilters({
  search,
  freshness,
  language,
  languages,
  onSearchChange,
  onFreshnessChange,
  onLanguageChange,
}: RepositoryFiltersProps) {
  const t = useTranslations('repositories.filters');

  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
      <Select value={freshness} onValueChange={onFreshnessChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder={t('freshness')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('all')}</SelectItem>
          <SelectItem value="fresh">{t('fresh')}</SelectItem>
          <SelectItem value="stale">{t('stale')}</SelectItem>
          <SelectItem value="never">{t('never')}</SelectItem>
        </SelectContent>
      </Select>
      {languages.length > 0 && (
        <Select value={language} onValueChange={onLanguageChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder={t('language')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('all')}</SelectItem>
            {languages.filter((l) => l.language).map((l) => (
              <SelectItem key={l.language!} value={l.language!}>
                {l.language} ({l.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
