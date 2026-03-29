'use client';

import { useTranslations } from 'next-intl';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ArrowUpDown } from 'lucide-react';
import { PeopleTableRow } from './people-table-row';

interface PeopleTableProps {
  contributors: any[];
  sort: string;
  sortOrder: string;
  onSortChange: (field: string) => void;
  searchParams: string;
}

export function PeopleTable({
  contributors,
  sort,
  sortOrder,
  onSortChange,
  searchParams,
}: PeopleTableProps) {
  const t = useTranslations('people.table');

  const SortHeader = ({ field, children }: { field: string; children: React.ReactNode }) => (
    <TableHead>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => onSortChange(field)}
      >
        {children}
        <ArrowUpDown className="ml-1 h-3 w-3" />
      </Button>
    </TableHead>
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHeader field="displayName">{t('name')}</SortHeader>
          <SortHeader field="primaryEmail">{t('email')}</SortHeader>
          <TableHead>{t('classification')}</TableHead>
          <TableHead>{t('identity')}</TableHead>
          <TableHead>{t('repos')}</TableHead>
          <SortHeader field="lastActivityAt">{t('lastActivity')}</SortHeader>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {contributors.map((contributor) => (
          <PeopleTableRow
            key={contributor.id}
            contributor={contributor}
            searchParams={searchParams}
          />
        ))}
      </TableBody>
    </Table>
  );
}
