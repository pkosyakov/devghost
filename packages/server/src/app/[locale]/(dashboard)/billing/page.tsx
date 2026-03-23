'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  Coins,
  CreditCard,
  Clock,
  Lock,
  ChevronLeft,
  ChevronRight,
  Tag,
  Zap,
  Crown,
  Users,
  Copy,
  Check,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslations, useLocale } from 'next-intl';

// ==================== Types ====================

interface BalanceData {
  balance: {
    permanent: number;
    subscription: number;
    reserved: number;
    available: number;
    subscriptionExpiresAt: string | null;
  };
  subscription: {
    planName: string;
    creditsPerMonth: number;
    priceUsd: string;
    status: string;
    currentPeriodEnd: string;
  } | null;
}

interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceUsd: string;
  sortOrder: number;
}

interface SubscriptionPlan {
  id: string;
  name: string;
  creditsPerMonth: number;
  priceUsd: string;
  sortOrder: number;
}

interface Transaction {
  id: string;
  type: string;
  amount: number;
  wallet: string;
  balanceAfter: number;
  description: string | null;
  relatedOrderId: string | null;
  createdAt: string;
}

interface ReferralData {
  referralCode: string;
  stats: {
    invited: number;
    limit: number;
    creditsEarned: number;
    creditsPerReferral: number;
  };
  referrals: Array<{
    email: string;
    date: string;
    creditsAwarded: number;
  }>;
}

// ==================== Constants ====================

const TRANSACTION_TYPES = [
  'REGISTRATION',
  'PACK_PURCHASE',
  'SUBSCRIPTION_RENEWAL',
  'SUBSCRIPTION_EXPIRY',
  'PROMO_REDEMPTION',
  'REFERRAL_BONUS',
  'REFERRAL_REWARD',
  'ANALYSIS_RESERVE',
  'ANALYSIS_DEBIT',
  'ANALYSIS_RELEASE',
  'ADMIN_ADJUSTMENT',
];

// Transaction type labels are now in i18n: billing.txType_*

// ==================== Component ====================

export default function BillingPage() {
  const t = useTranslations('billing');
  const locale = useLocale();
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Promo code input
  const [promoCode, setPromoCode] = useState('');

  // Transaction filter & pagination
  const [txPage, setTxPage] = useState(1);
  const [txTypeFilter, setTxTypeFilter] = useState('');

  // Cancel subscription dialog
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  // Referral link copy state
  const [copied, setCopied] = useState(false);

  // SSR-safe origin
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // ==================== Queries ====================

  const { data: balanceData, isLoading: balanceLoading } = useQuery<BalanceData>({
    queryKey: ['billing-balance'],
    queryFn: async () => {
      const res = await fetch('/api/billing/balance');
      if (!res.ok) throw new Error('Failed to fetch balance');
      const json = await res.json();
      return json.data;
    },
    refetchInterval: 30000,
  });

  const { data: packsData, isLoading: packsLoading } = useQuery<{ packs: CreditPack[] }>({
    queryKey: ['billing-packs'],
    queryFn: async () => {
      const res = await fetch('/api/billing/packs');
      if (!res.ok) throw new Error('Failed to fetch packs');
      const json = await res.json();
      return json.data;
    },
  });

  const { data: subsData, isLoading: subsLoading } = useQuery<{ subscriptions: SubscriptionPlan[] }>({
    queryKey: ['billing-subscriptions'],
    queryFn: async () => {
      const res = await fetch('/api/billing/subscriptions');
      if (!res.ok) throw new Error('Failed to fetch subscriptions');
      const json = await res.json();
      return json.data;
    },
  });

  const { data: txData, isLoading: txLoading } = useQuery({
    queryKey: ['billing-transactions', txPage, txTypeFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(txPage), pageSize: '15' });
      if (txTypeFilter) params.set('type', txTypeFilter);
      const res = await fetch(`/api/billing/transactions?${params}`);
      if (!res.ok) throw new Error('Failed to fetch transactions');
      const json = await res.json();
      return json.data as {
        transactions: Transaction[];
        pagination: { page: number; pageSize: number; total: number; totalPages: number };
      };
    },
  });

  const { data: referralData, isLoading: referralLoading } = useQuery<ReferralData>({
    queryKey: ['referral'],
    queryFn: async () => {
      const res = await fetch('/api/referral');
      if (!res.ok) throw new Error('Failed to fetch referral data');
      const json = await res.json();
      return json.data;
    },
  });

  // ==================== Mutations ====================

  const buyPack = useMutation({
    mutationFn: async (packId: string) => {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { url: string };
    },
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
    onError: (err: Error) => {
      toast({ title: t('error'), description: err.message, variant: 'destructive' });
    },
  });

  const subscribePlan = useMutation({
    mutationFn: async (subscriptionId: string) => {
      const res = await fetch('/api/billing/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { url: string };
    },
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
    onError: (err: Error) => {
      toast({ title: t('error'), description: err.message, variant: 'destructive' });
    },
  });

  const cancelSubscription = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/billing/cancel-subscription', { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['billing-balance'] });
      setShowCancelDialog(false);
      toast({ title: t('subscriptionCancelled'), description: t('subscriptionCancelledDescription') });
    },
    onError: (err: Error) => {
      toast({ title: t('error'), description: err.message, variant: 'destructive' });
    },
  });

  const redeemCode = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch('/api/billing/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { creditsAwarded: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['billing-balance'] });
      queryClient.invalidateQueries({ queryKey: ['billing-transactions'] });
      setPromoCode('');
      toast({ title: t('codeRedeemed'), description: t('codeRedeemedDescription', { credits: data.creditsAwarded }) });
    },
    onError: (err: Error) => {
      toast({ title: t('error'), description: err.message, variant: 'destructive' });
    },
  });

  // ==================== Helpers ====================

  const hasActiveSubscription = balanceData?.subscription &&
    (balanceData.subscription.status === 'ACTIVE' || balanceData.subscription.status === 'PAST_DUE');

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString(dateLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatPrice = (price: string | number) => {
    const num = typeof price === 'string' ? parseFloat(price) : price;
    return `$${num.toFixed(2)}`;
  };

  const referralLink = referralData?.referralCode && origin
    ? `${origin}/register?ref=${referralData.referralCode}`
    : '';

  const copyReferralLink = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: t('error'), description: t('failedCopy'), variant: 'destructive' });
    }
  };

  // ==================== Render ====================

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* ==================== Balance Card ==================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            <CardTitle>{t('creditBalance')}</CardTitle>
          </div>
          <CardDescription>{t('creditBalanceDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {balanceLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : balanceData ? (
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-md border p-4 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-2xl font-bold">{balanceData.balance.permanent}</p>
                <p className="text-xs text-muted-foreground">{t('permanent')}</p>
              </div>
              <div className="rounded-md border p-4 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-2xl font-bold">{balanceData.balance.subscription}</p>
                <p className="text-xs text-muted-foreground">{t('subscription')}</p>
                {balanceData.balance.subscriptionExpiresAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('expires', { date: formatDate(balanceData.balance.subscriptionExpiresAt) })}
                  </p>
                )}
              </div>
              <div className="rounded-md border p-4 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Lock className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-2xl font-bold">{balanceData.balance.reserved}</p>
                <p className="text-xs text-muted-foreground">{t('reserved')}</p>
              </div>
              <div className="rounded-md border bg-primary/5 p-4 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Coins className="h-4 w-4 text-yellow-500" />
                </div>
                <p className="text-2xl font-bold text-primary">{balanceData.balance.available}</p>
                <p className="text-xs text-muted-foreground">{t('available')}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('failedBalance')}</p>
          )}
        </CardContent>
      </Card>

      {/* ==================== Active Subscription ==================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Crown className="h-5 w-5" />
            <CardTitle>{t('subscriptionSection')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {balanceLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : hasActiveSubscription && balanceData?.subscription ? (
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{balanceData.subscription.planName}</p>
                  <Badge variant={balanceData.subscription.status === 'ACTIVE' ? 'default' : 'secondary'}>
                    {balanceData.subscription.status === 'ACTIVE' ? t('statusActive') : balanceData.subscription.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('creditsPerMonth', { credits: balanceData.subscription.creditsPerMonth, price: formatPrice(balanceData.subscription.priceUsd) })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('nextRenewal', { date: formatDate(balanceData.subscription.currentPeriodEnd) })}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCancelDialog(true)}
                disabled={cancelSubscription.isPending}
              >
                {t('cancel')}
              </Button>
            </div>
          ) : balanceData?.subscription?.status === 'CANCELLED' ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="font-medium">{balanceData.subscription.planName}</p>
                <Badge variant="secondary">{t('cancelled')}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {t('accessUntil', { date: formatDate(balanceData.subscription.currentPeriodEnd) })}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noSubscription')}</p>
          )}
        </CardContent>
      </Card>

      {/* ==================== Credit Packs & Subscription Plans ==================== */}
      {(packsData?.packs?.length ?? 0) > 0 || (subsData?.subscriptions?.length ?? 0) > 0 ? (
        <>
          {/* ==================== Credit Packs ==================== */}
          <div>
            <h2 className="text-lg font-semibold mb-3">{t('creditPacks')}</h2>
            <p className="text-sm text-muted-foreground mb-4">{t('creditPacksDescription')}</p>
            {packsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : packsData?.packs && packsData.packs.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-3">
                {packsData.packs.map((pack) => (
                  <Card key={pack.id}>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{pack.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div>
                        <p className="text-3xl font-bold">{pack.credits}</p>
                        <p className="text-sm text-muted-foreground">{t('credits')}</p>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-lg font-semibold">{formatPrice(pack.priceUsd)}</p>
                        <Button
                          size="sm"
                          onClick={() => buyPack.mutate(pack.id)}
                          disabled={buyPack.isPending}
                        >
                          {buyPack.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Zap className="h-4 w-4 mr-1" />
                              {t('buy')}
                            </>
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noPacks')}</p>
            )}
          </div>

          {/* ==================== Subscription Plans ==================== */}
          <div>
            <h2 className="text-lg font-semibold mb-3">{t('subscriptionPlans')}</h2>
            <p className="text-sm text-muted-foreground mb-4">{t('subscriptionPlansDescription')}</p>
            {subsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : subsData?.subscriptions && subsData.subscriptions.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-3">
                {subsData.subscriptions.map((sub) => (
                  <Card key={sub.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">{sub.name}</CardTitle>
                        <Badge variant="secondary">{t('doubleValue')}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div>
                        <p className="text-3xl font-bold">{sub.creditsPerMonth}</p>
                        <p className="text-sm text-muted-foreground">{t('creditsMonth')}</p>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-lg font-semibold">{t('perMonth', { price: formatPrice(sub.priceUsd) })}</p>
                        <Button
                          size="sm"
                          onClick={() => subscribePlan.mutate(sub.id)}
                          disabled={subscribePlan.isPending || !!hasActiveSubscription}
                        >
                          {subscribePlan.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : hasActiveSubscription ? (
                            t('subscribed')
                          ) : (
                            <>
                              <Crown className="h-4 w-4 mr-1" />
                              {t('subscribe')}
                            </>
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noPlans')}</p>
            )}
          </div>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('freeMode')}</CardTitle>
            <CardDescription>{t('freeModeDescription')}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <Separator />

      {/* ==================== Promo Code ==================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            <CardTitle>{t('promoCode')}</CardTitle>
          </div>
          <CardDescription>{t('promoCodeDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 max-w-md">
            <Input
              placeholder={t('promoPlaceholder')}
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && promoCode.trim()) {
                  redeemCode.mutate(promoCode.trim());
                }
              }}
            />
            <Button
              onClick={() => redeemCode.mutate(promoCode.trim())}
              disabled={!promoCode.trim() || redeemCode.isPending}
            >
              {redeemCode.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('redeem')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ==================== Referral Program ==================== */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            <CardTitle>{t('referralProgram')}</CardTitle>
          </div>
          <CardDescription>
            {t('referralDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {referralLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : referralData ? (
            <>
              {/* Referral Link */}
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('yourReferralLink')}</p>
                <div className="flex gap-2 max-w-lg">
                  <Input
                    readOnly
                    value={referralLink}
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={copyReferralLink}
                    className="shrink-0"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Stats */}
              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">
                    {referralData.stats.invited} / {referralData.stats.limit}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('invited')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{referralData.stats.creditsEarned}</p>
                  <p className="text-xs text-muted-foreground">{t('creditsEarned')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{referralData.stats.creditsPerReferral}</p>
                  <p className="text-xs text-muted-foreground">{t('creditsPerReferral')}</p>
                </div>
              </div>

              {/* Referral List */}
              {referralData.referrals.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">{t('invitedUsers')}</p>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('referralEmail')}</TableHead>
                          <TableHead>{t('referralDate')}</TableHead>
                          <TableHead className="text-right">{t('referralCredits')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {referralData.referrals.map((ref, i) => (
                          <TableRow key={i}>
                            <TableCell className="text-sm font-mono">
                              {ref.email}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {formatDate(ref.date)}
                            </TableCell>
                            <TableCell className="text-right text-sm font-medium text-green-600">
                              +{ref.creditsAwarded}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('failedReferral')}</p>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* ==================== Transaction History ==================== */}
      <div>
        <h2 className="text-lg font-semibold mb-3">{t('transactionHistory')}</h2>

        {/* Filters */}
        <div className="flex gap-2 mb-4">
          <Select
            value={txTypeFilter || 'ALL'}
            onValueChange={(v) => {
              setTxTypeFilter(v === 'ALL' ? '' : v);
              setTxPage(1);
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder={t('allTypes')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('allTypes')}</SelectItem>
              {TRANSACTION_TYPES.map((txType) => (
                <SelectItem key={txType} value={txType}>
                  {t(`txType_${txType}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardContent className="p-0">
            {txLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('txDate')}</TableHead>
                    <TableHead>{t('txType')}</TableHead>
                    <TableHead>{t('txDescription')}</TableHead>
                    <TableHead>{t('txWallet')}</TableHead>
                    <TableHead className="text-right">{t('txAmount')}</TableHead>
                    <TableHead className="text-right">{t('txBalanceAfter')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {txData?.transactions.map((tx) => (
                    <TableRow key={tx.id}>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatDate(tx.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {t(`txType_${tx.type}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm max-w-[200px] truncate">
                        {tx.description || '--'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {tx.wallet === 'PERMANENT' ? t('walletPermanent') : t('walletSubscription')}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        <span className={tx.amount >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {tx.amount >= 0 ? '+' : ''}{tx.amount}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {tx.balanceAfter}
                      </TableCell>
                    </TableRow>
                  ))}
                  {txData?.transactions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        {t('noTransactions')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Transaction Pagination */}
        {txData && txData.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-muted-foreground">{t('totalTransactions', { count: txData.pagination.total })}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={txPage <= 1} onClick={() => setTxPage(txPage - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm">{t('pageOf', { page: txPage, total: txData.pagination.totalPages })}</span>
              <Button variant="outline" size="sm" disabled={txPage >= txData.pagination.totalPages} onClick={() => setTxPage(txPage + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ==================== Cancel Subscription Dialog ==================== */}
      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cancelDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cancelDialogDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('keepSubscription')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => cancelSubscription.mutate()}
            >
              {cancelSubscription.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {t('cancelSubscription')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
