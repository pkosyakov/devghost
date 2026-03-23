'use client';

import { useTranslations } from 'next-intl';
import { useSession, signOut } from 'next-auth/react';
import { Link, useRouter } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Coins } from 'lucide-react';
import { LanguageSwitcher } from '@/components/language-switcher';

interface BalanceResponse {
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

interface HeaderProps {
  title?: string;
}

export function Header({ title }: HeaderProps) {
  const t = useTranslations('layout.header');
  const { data: session } = useSession();
  const router = useRouter();

  const { data: balanceData } = useQuery<BalanceResponse>({
    queryKey: ['billing-balance'],
    queryFn: async () => {
      const res = await fetch('/api/billing/balance');
      if (!res.ok) throw new Error('Failed to fetch balance');
      const json = await res.json();
      return json.data;
    },
    refetchInterval: 30000,
    enabled: !!session?.user,
  });

  const getInitials = (email: string) => {
    return email.slice(0, 2).toUpperCase();
  };

  return (
    <header className="h-16 border-b bg-card px-6 flex items-center justify-between">
      <div className="flex items-center gap-4">
        {title && <h1 className="text-xl font-semibold">{title}</h1>}
      </div>

      <div className="flex items-center gap-4">
        <LanguageSwitcher />
        {/* Credit Balance */}
        {balanceData && (
          <Link href="/billing">
            <Button variant="outline" size="sm" className="gap-2 h-9">
              <Coins className="h-4 w-4 text-yellow-500" />
              <span className="font-medium">{balanceData.balance.available}</span>
            </Button>
          </Link>
        )}

        {/* User Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-10 w-10 rounded-full">
              <Avatar>
                <AvatarFallback>
                  {session?.user?.email
                    ? getInitials(session.user.email)
                    : 'U'}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">{t('account')}</p>
                <p className="text-xs leading-none text-muted-foreground">
                  {session?.user?.email}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/billing')}>
              {t('billing')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/settings')}>
              {t('settings')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => signOut({ callbackUrl: '/' })}
            >
              {t('signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
