'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

const actionColors: Record<string, string> = {
  'auth': 'bg-blue-100 text-blue-700',
  'admin.user': 'bg-orange-100 text-orange-700',
  'admin.order': 'bg-purple-100 text-purple-700',
  'admin.settings': 'bg-green-100 text-green-700',
  'admin.cache': 'bg-gray-100 text-gray-700',
};

function getActionColor(action: string): string {
  for (const [prefix, color] of Object.entries(actionColors)) {
    if (action.startsWith(prefix)) return color;
  }
  return '';
}

interface AuditEntry {
  id: string;
  action: string;
  userEmail: string | null;
  userId: string | null;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export default function AdminAuditPage() {
  const t = useTranslations('admin.audit');

  const ACTION_CATEGORIES = [
    { value: '', label: t('allActions') },
    { value: 'auth', label: t('categoryAuth') },
    { value: 'admin.user', label: t('categoryUser') },
    { value: 'admin.order', label: t('categoryOrder') },
    { value: 'admin.settings', label: t('categorySettings') },
    { value: 'admin.cache', label: t('categoryCache') },
  ];

  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-audit', page, actionFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '30' });
      if (actionFilter) params.set('action', actionFilter);
      const res = await fetch(`/api/admin/audit?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { entries: AuditEntry[]; pagination: { page: number; totalPages: number; total: number } };
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <Select value={actionFilter || 'ALL'} onValueChange={(v) => { setActionFilter(v === 'ALL' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t('allActions')} />
          </SelectTrigger>
          <SelectContent>
            {ACTION_CATEGORIES.map((cat) => (
              <SelectItem key={cat.value || 'ALL'} value={cat.value || 'ALL'}>
                {cat.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Audit Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('time')}</TableHead>
                  <TableHead>{t('user')}</TableHead>
                  <TableHead>{t('action')}</TableHead>
                  <TableHead>{t('target')}</TableHead>
                  <TableHead>{t('details')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.userEmail ?? <span className="text-muted-foreground">system</span>}
                    </TableCell>
                    <TableCell>
                      <Badge className={getActionColor(entry.action)} variant="outline">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.targetType && entry.targetId
                        ? `${entry.targetType}:${entry.targetId.slice(0, 8)}`
                        : '\u2014'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">
                      {Object.keys(entry.details).length > 0
                        ? JSON.stringify(entry.details)
                        : '\u2014'}
                    </TableCell>
                  </TableRow>
                ))}
                {data?.entries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      {t('noEntries')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t('totalEntries', { count: data.pagination.total })}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">{t('pageOf', { page, total: data.pagination.totalPages })}</span>
            <Button variant="outline" size="sm" disabled={page >= data.pagination.totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
