'use client';

import { useState, useEffect } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus,
  Loader2,
  GitBranch,
  Users,
  Calendar,
  ChevronRight,
  Trash2,
  TrendingUp,
  Clock,
  Activity,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ghostColor } from '@devghost/shared';
import { ghostTextColors } from '@/lib/utils';

interface OrderMetrics {
  avgGhostPercent: number;
  totalEffortHours: number;
  totalCommitsAnalyzed: number;
}

interface Order {
  id: string;
  name: string;
  status: string;
  repoCount: number;
  developerCount: number;
  totalCommits: number;
  createdAt: string;
  analyzedAt: string | null;
  completedAt: string | null;
  metrics: OrderMetrics | null;
}

const statusVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  DEVELOPERS_LOADED: 'secondary',
  READY_FOR_ANALYSIS: 'secondary',
  PROCESSING: 'default',
  COMPLETED: 'default',
  FAILED: 'destructive',
};

export default function OrdersPage() {
  const t = useTranslations('orders');
  const tStatus = useTranslations('status');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    try {
      const response = await fetch('/api/orders');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch orders');
      }

      setOrders(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch orders');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const response = await fetch(`/api/orders/${deleteId}`, { method: 'DELETE' });
      if (response.ok) {
        setOrders((prev) => prev.filter((o) => o.id !== deleteId));
      } else {
        const data = await response.json().catch(() => null);
        setError(data?.error || t('deleteError'));
      }
    } catch {
      setError(t('networkError'));
    } finally {
      setDeleteId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive mb-4">{error}</p>
        <Button onClick={fetchOrders}>{tCommon('retry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <Link href="/orders/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            {t('newAnalysis')}
          </Button>
        </Link>
      </div>

      {orders.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <GitBranch className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">{t('noOrders')}</h3>
            <p className="text-muted-foreground text-center mb-4">
              {t('noOrdersDescription')}
            </p>
            <Link href="/orders/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                {t('createAnalysis')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {orders.map((order) => (
            <Card
              key={order.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => router.push(`/orders/${order.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-lg">{order.name}</CardTitle>
                    <Badge variant={statusVariants[order.status] || 'outline'}>
                      {tStatus(order.status)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteId(order.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </div>
                <CardDescription>
                  {t('created', { date: new Date(order.createdAt).toLocaleDateString() })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-6 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <GitBranch className="h-4 w-4" />
                    {t('repos', { count: order.repoCount })}
                  </div>
                  <div className="flex items-center gap-1">
                    <Users className="h-4 w-4" />
                    {t('developers', { count: order.developerCount })}
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="h-4 w-4" />
                    {t('commits', { count: order.totalCommits })}
                  </div>
                  {order.metrics && (
                    <>
                      <div className="h-4 border-l" />
                      <div className={`flex items-center gap-1 font-medium ${ghostTextColors[ghostColor(order.metrics.avgGhostPercent)] ?? ''}`}>
                        <TrendingUp className="h-4 w-4" />
                        {t('ghost', { percent: order.metrics.avgGhostPercent })}
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="h-4 w-4" />
                        {t('effort', { hours: order.metrics.totalEffortHours })}
                      </div>
                      <div className="flex items-center gap-1">
                        <Activity className="h-4 w-4" />
                        {t('analyzed', { count: order.metrics.totalCommitsAnalyzed })}
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{tCommon('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
