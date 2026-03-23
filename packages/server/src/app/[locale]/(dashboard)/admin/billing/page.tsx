'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Loader2, Coins, TrendingDown, Users, Wallet,
} from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';

interface BillingStats {
  totalCreditsSold: number;
  totalCreditsConsumed: number;
  activeSubscriptions: number;
  creditsInCirculation: number;
  recentTransactions: {
    id: string;
    type: string;
    amount: number;
    wallet: string;
    balanceAfter: number;
    description: string | null;
    userEmail: string;
    createdAt: string;
  }[];
}

const typeColors: Record<string, string> = {
  REGISTRATION: 'bg-blue-100 text-blue-700',
  PACK_PURCHASE: 'bg-green-100 text-green-700',
  SUBSCRIPTION_RENEWAL: 'bg-emerald-100 text-emerald-700',
  SUBSCRIPTION_EXPIRY: 'bg-orange-100 text-orange-700',
  PROMO_REDEMPTION: 'bg-purple-100 text-purple-700',
  REFERRAL_BONUS: 'bg-cyan-100 text-cyan-700',
  REFERRAL_REWARD: 'bg-teal-100 text-teal-700',
  ANALYSIS_RESERVE: 'bg-yellow-100 text-yellow-700',
  ANALYSIS_DEBIT: 'bg-red-100 text-red-700',
  ANALYSIS_RELEASE: 'bg-lime-100 text-lime-700',
  ADMIN_ADJUSTMENT: 'bg-gray-100 text-gray-700',
};

function formatDate(d: string, locale: string = 'en-US'): string {
  return new Date(d).toLocaleString(locale, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function AdminBillingPage() {
  const t = useTranslations('admin.billing');
  const locale = useLocale();
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
  const { data: stats, isLoading } = useQuery<BillingStats>({
    queryKey: ['admin-billing-stats'],
    queryFn: async () => {
      const res = await fetch('/api/admin/billing/stats');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('creditsSold')}</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCreditsSold.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {t('creditsSoldDetail')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('creditsConsumed')}</CardTitle>
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCreditsConsumed.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {t('creditsConsumedDetail')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('activeSubscriptions')}</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.activeSubscriptions}</div>
            <p className="text-xs text-muted-foreground">
              {t('activeSubscriptionsDetail')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('creditsInCirculation')}</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.creditsInCirculation.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {t('creditsInCirculationDetail')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Transactions */}
      <Card>
        <CardHeader>
          <CardTitle>{t('recentTransactions')}</CardTitle>
          <CardDescription>{t('recentTransactionsDetail')}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('user')}</TableHead>
                <TableHead>{t('type')}</TableHead>
                <TableHead>{t('amount')}</TableHead>
                <TableHead>{t('wallet')}</TableHead>
                <TableHead>{t('balanceAfter')}</TableHead>
                <TableHead>{t('txDescription')}</TableHead>
                <TableHead>{t('date')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.recentTransactions.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell className="font-mono text-xs">{tx.userEmail}</TableCell>
                  <TableCell>
                    <Badge className={typeColors[tx.type] ?? 'bg-gray-100 text-gray-700'}>
                      {tx.type.replace(/_/g, ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className={`font-medium tabular-nums ${tx.amount >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {tx.amount >= 0 ? '+' : ''}{tx.amount}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {tx.wallet}
                  </TableCell>
                  <TableCell className="tabular-nums">{tx.balanceAfter}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                    {tx.description ?? '---'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(tx.createdAt, dateLocale)}
                  </TableCell>
                </TableRow>
              ))}
              {stats.recentTransactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {t('noTransactions')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
