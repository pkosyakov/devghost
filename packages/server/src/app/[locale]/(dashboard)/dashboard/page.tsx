'use client';

import { useState, useEffect } from 'react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Plus,
  Loader2,
  ClipboardList,
  GitBranch,
  Users,
  TrendingUp,
  ArrowRight,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ghostColor } from '@devghost/shared';
import { ghostTextColors } from '@/lib/utils';

interface DashboardStats {
  totalOrders: number;
  completedOrders: number;
  totalRepos: number;
  totalDevelopers: number;
  avgGhostPercent: number | null;
  recentOrders: {
    id: string;
    name: string;
    status: string;
    repoCount: number;
    developerCount: number;
    createdAt: string;
    metrics: { avgGhostPercent: number; totalEffortHours: number; totalCommitsAnalyzed: number } | null;
  }[];
}

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  DEVELOPERS_LOADED: 'bg-blue-100 text-blue-700',
  READY_FOR_ANALYSIS: 'bg-yellow-100 text-yellow-700',
  PROCESSING: 'bg-purple-100 text-purple-700',
  COMPLETED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
};

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tStatus = useTranslations('status');
  const tOrders = useTranslations('orders');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/orders');
      const data = await response.json();

      if (response.ok) {
        const orders = data.data || [];

        // Calculate stats
        const completedOrders = orders.filter((o: { status: string }) => o.status === 'COMPLETED');
        const totalRepos = orders.reduce((sum: number, o: { repoCount: number }) => sum + (o.repoCount || 0), 0);
        const totalDevelopers = orders.reduce((sum: number, o: { developerCount: number }) => sum + (o.developerCount || 0), 0);

        const completedWithMetrics = orders.filter(
          (o: any) => o.status === 'COMPLETED' && o.metrics?.avgGhostPercent != null
        );
        const avgGhostPercent = completedWithMetrics.length > 0
          ? completedWithMetrics.reduce((sum: number, o: any) => sum + o.metrics.avgGhostPercent, 0) / completedWithMetrics.length
          : null;

        setStats({
          totalOrders: orders.length,
          completedOrders: completedOrders.length,
          totalRepos,
          totalDevelopers,
          avgGhostPercent,
          recentOrders: orders.slice(0, 5),
        });
      }
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              {t('stats.totalOrders')}
            </CardDescription>
            <CardTitle className="text-3xl">{stats?.totalOrders || 0}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('stats.totalOrdersSub', { count: stats?.completedOrders || 0 })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              {t('stats.repositories')}
            </CardDescription>
            <CardTitle className="text-3xl">{stats?.totalRepos || 0}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('stats.repositoriesSub')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              {t('stats.developers')}
            </CardDescription>
            <CardTitle className="text-3xl">{stats?.totalDevelopers || 0}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('stats.developersSub')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              {t('stats.avgGhost')}
            </CardDescription>
            <CardTitle className={`text-3xl ${ghostTextColors[ghostColor(stats?.avgGhostPercent ?? null)] ?? ''}`}>
              {stats?.avgGhostPercent != null
                ? `${Math.round(stats.avgGhostPercent)}%`
                : '—'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('stats.avgGhostSub')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Getting Started / Recent Orders */}
      {stats?.totalOrders === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('getStarted.title')}</CardTitle>
            <CardDescription>
              {t('getStarted.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold">
                1
              </div>
              <div>
                <h4 className="font-medium">{t('getStarted.step1')}</h4>
                <Link href="/settings">
                  <Button variant="link" className="px-0 text-primary">
                    Go to Settings <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </Link>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold">
                2
              </div>
              <div>
                <h4 className="font-medium">{t('getStarted.step2')}</h4>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold">
                3
              </div>
              <div>
                <h4 className="font-medium">{t('getStarted.step3')}</h4>
              </div>
            </div>

            <Link href="/orders/new">
              <Button className="w-full mt-4">
                <Plus className="h-4 w-4 mr-2" />
                {t('getStarted.cta')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>{t('recentOrders.title')}</CardTitle>
              <CardDescription>{t('recentOrders.description')}</CardDescription>
            </div>
            <Link href="/orders">
              <Button variant="outline" size="sm">
                {t('recentOrders.viewAll')}
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats?.recentOrders.map((order) => (
                <Link
                  key={order.id}
                  href={`/orders/${order.id}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <ClipboardList className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <span className="font-medium">{order.name}</span>
                      <p className="text-sm text-muted-foreground">
                        {tOrders('repos', { count: order.repoCount })} · {tOrders('developers', { count: order.developerCount })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={statusColors[order.status] || ''}>
                      {tStatus(order.status)}
                    </Badge>
                    {order.metrics && (
                      <span className={`text-sm font-medium ${ghostTextColors[ghostColor(order.metrics.avgGhostPercent)] ?? ''}`}>
                        {t('recentOrders.ghost', { percent: Math.round(order.metrics.avgGhostPercent * 10) / 10 })}
                      </span>
                    )}
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
