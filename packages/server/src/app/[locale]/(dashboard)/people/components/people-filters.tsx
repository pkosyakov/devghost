'use client';

import { useTranslations } from 'next-intl';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';

interface PeopleFiltersProps {
  search: string;
  classification: string;
  identityHealth: string;
  onSearchChange: (value: string) => void;
  onClassificationChange: (value: string) => void;
  onIdentityHealthChange: (value: string) => void;
}

export function PeopleFilters({
  search,
  classification,
  identityHealth,
  onSearchChange,
  onClassificationChange,
  onIdentityHealthChange,
}: PeopleFiltersProps) {
  const t = useTranslations('people.filters');
  const tSearch = useTranslations('people.search');

  return (
    <div className="flex items-center gap-3">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={tSearch('placeholder')}
          className="pl-9"
        />
      </div>

      <Select value={classification} onValueChange={onClassificationChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t('classification')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('all')}</SelectItem>
          <SelectItem value="INTERNAL">{t('internal')}</SelectItem>
          <SelectItem value="EXTERNAL">{t('external')}</SelectItem>
          <SelectItem value="BOT">{t('bot')}</SelectItem>
          <SelectItem value="FORMER_EMPLOYEE">{t('formerEmployee')}</SelectItem>
        </SelectContent>
      </Select>

      <Select value={identityHealth} onValueChange={onIdentityHealthChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t('identityHealth')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('all')}</SelectItem>
          <SelectItem value="healthy">{t('healthy')}</SelectItem>
          <SelectItem value="attention">{t('attention')}</SelectItem>
          <SelectItem value="unresolved">{t('unresolved')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
