'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';

interface ContributorCommitEvidenceProps {
  contributorId: string;
}

export function ContributorCommitEvidence({ contributorId }: ContributorCommitEvidenceProps) {
  const t = useTranslations('contributorDetail.commits');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data, isLoading } = useQuery({
    queryKey: ['contributor-commits', contributorId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/v2/contributors/${contributorId}/commits?page=${page}&pageSize=${pageSize}`
      );
      const json = await res.json();
      return json.data;
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        {data?.pagination && (
          <span className="text-sm text-muted-foreground">
            {data.pagination.total} total
          </span>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !data?.commits?.length ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('sha')}</TableHead>
                  <TableHead>{t('message')}</TableHead>
                  <TableHead>{t('repo')}</TableHead>
                  <TableHead>{t('date')}</TableHead>
                  <TableHead>{t('effort')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.commits.map((commit: any) => (
                  <TableRow key={commit.sha}>
                    <TableCell className="font-mono text-xs">
                      {commit.sha?.slice(0, 7)}
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate">
                      {commit.message}
                    </TableCell>
                    <TableCell>{commit.repo}</TableCell>
                    <TableCell>
                      {commit.authoredAt
                        ? format(new Date(commit.authoredAt), 'MMM d, yyyy')
                        : '—'}
                    </TableCell>
                    <TableCell>
                      {commit.effortHours != null
                        ? Number(commit.effortHours).toFixed(1)
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {data.pagination.totalPages > 1 && (
              <div className="flex justify-end gap-2 mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.pagination.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
