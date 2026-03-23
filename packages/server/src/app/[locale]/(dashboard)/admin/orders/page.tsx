'use client';

import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, MoreHorizontal, ChevronLeft, ChevronRight, ExternalLink, RotateCcw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslations } from 'next-intl';

const ORDER_STATUSES = ['', 'DRAFT', 'DEVELOPERS_LOADED', 'READY_FOR_ANALYSIS', 'PROCESSING', 'COMPLETED', 'FAILED'];

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  DEVELOPERS_LOADED: 'bg-blue-100 text-blue-700',
  READY_FOR_ANALYSIS: 'bg-yellow-100 text-yellow-700',
  PROCESSING: 'bg-purple-100 text-purple-700',
  COMPLETED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
};

interface AdminOrder {
  id: string;
  name: string;
  status: string;
  repoCount: number;
  totalCommits: number;
  ownerEmail: string;
  ownerName: string | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export default function AdminOrdersPage() {
  const t = useTranslations('admin.orders');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AdminOrder | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-orders', page, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/admin/orders?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { orders: AdminOrder[]; pagination: { page: number; totalPages: number; total: number } };
    },
  });

  const deleteOrder = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/orders/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orders'] });
      setDeleteTarget(null);
      toast({ title: t('orderDeleted') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const rerunOrder = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/orders/${id}/rerun`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orders'] });
      toast({ title: t('analysisRestarted') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
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
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v === 'ALL' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t('allStatuses')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('allStatuses')}</SelectItem>
            {ORDER_STATUSES.filter(Boolean).map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Orders Table */}
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
                  <TableHead>{t('name')}</TableHead>
                  <TableHead>{t('owner')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead>{t('repos')}</TableHead>
                  <TableHead>{t('commits')}</TableHead>
                  <TableHead>{t('created')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium max-w-[200px] truncate">
                      {order.name}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {order.ownerEmail}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[order.status] ?? ''}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{order.repoCount}</TableCell>
                    <TableCell>{order.totalCommits}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/orders/${order.id}`}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              {t('viewOrder')}
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={order.status === 'PROCESSING'}
                            onClick={() => rerunOrder.mutate(order.id)}
                          >
                            <RotateCcw className="mr-2 h-4 w-4" />
                            {t('rerunAnalysis')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(order)}
                          >
                            {t('deleteOrder')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {data?.orders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      {t('noOrders')}
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
          <p className="text-sm text-muted-foreground">{t('totalOrders', { count: data.pagination.total })}</p>
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

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteOrderTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteOrderDescription', { name: deleteTarget?.name ?? '', email: deleteTarget?.ownerEmail ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteOrder.mutate(deleteTarget.id)}
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
