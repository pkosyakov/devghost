'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  LayoutDashboard,
  ClipboardList,
  Settings,
  LogOut,
  Plus,
  Circle,
  Shield,
  Users,
  ListOrdered,
  Activity,
  ScrollText,
  Settings2,
  CreditCard,
  Ticket,
  BarChart3,
  Share2,
  UserCircle,
  Globe,
} from 'lucide-react';
import { signOut, useSession } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { LanguageSwitcher } from '@/components/language-switcher';

const navigation = [
  { nameKey: 'dashboard', href: '/dashboard', icon: LayoutDashboard },
  { nameKey: 'orders', href: '/orders', icon: ClipboardList },
  { nameKey: 'publications', href: '/publications', icon: Share2 },
];

const adminNavigation = [
  { nameKey: 'admin.overview', href: '/admin', icon: Shield },
  { nameKey: 'admin.users', href: '/admin/users', icon: Users },
  { nameKey: 'admin.allOrders', href: '/admin/orders', icon: ListOrdered },
  { nameKey: 'admin.publications', href: '/admin/publications', icon: Globe },
  { nameKey: 'admin.promoCodes', href: '/admin/promo-codes', icon: Ticket },
  { nameKey: 'admin.billing', href: '/admin/billing', icon: BarChart3 },
  { nameKey: 'admin.monitoring', href: '/admin/monitoring', icon: Activity },
  { nameKey: 'admin.auditLog', href: '/admin/audit', icon: ScrollText },
  { nameKey: 'admin.settings', href: '/admin/settings', icon: Settings2 },
];

const statusColors: Record<string, string> = {
  COMPLETED: 'text-green-500',
  PROCESSING: 'text-blue-500',
  FAILED: 'text-red-500',
  DRAFT: 'text-muted-foreground/50',
  DEVELOPERS_LOADED: 'text-yellow-500',
  READY_FOR_ANALYSIS: 'text-orange-500',
};

interface RecentOrder {
  id: string;
  name: string | null;
  status: string;
}

const DEFAULT_USER_SECTION_RATIO = 0.68;
const MIN_USER_SECTION_HEIGHT = 180;
const MIN_ADMIN_SECTION_HEIGHT = 120;

export function Sidebar() {
  const t = useTranslations('layout.sidebar');
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [userSectionHeight, setUserSectionHeight] = useState<number | null>(null);

  const { data: recentOrders } = useQuery<RecentOrder[]>({
    queryKey: ['sidebar-recent-orders'],
    queryFn: async () => {
      const res = await fetch('/api/orders');
      if (!res.ok) return [];
      const json = await res.json();
      return (json.data ?? json).slice(0, 5);
    },
    staleTime: 30 * 1000,
  });

  const clampUserSectionHeight = useCallback((value: number) => {
    const container = splitContainerRef.current;
    if (!container) {
      return Math.max(value, MIN_USER_SECTION_HEIGHT);
    }
    const containerHeight = container.clientHeight;
    if (containerHeight <= 0) {
      return Math.max(value, MIN_USER_SECTION_HEIGHT);
    }
    const maxUserHeight = Math.max(
      MIN_USER_SECTION_HEIGHT,
      containerHeight - MIN_ADMIN_SECTION_HEIGHT,
    );
    return Math.min(Math.max(value, MIN_USER_SECTION_HEIGHT), maxUserHeight);
  }, []);

  const ensureInitialSplit = useCallback(() => {
    const container = splitContainerRef.current;
    if (!isAdmin || !container) {
      return;
    }
    const containerHeight = container.clientHeight;
    if (containerHeight <= 0) {
      return;
    }
    setUserSectionHeight((prev) => {
      if (prev == null) {
        return clampUserSectionHeight(
          Math.round(containerHeight * DEFAULT_USER_SECTION_RATIO),
        );
      }
      return clampUserSectionHeight(prev);
    });
  }, [clampUserSectionHeight, isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      setUserSectionHeight(null);
      return;
    }

    ensureInitialSplit();

    const container = splitContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      ensureInitialSplit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [ensureInitialSplit, isAdmin]);

  const handleDividerMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!isAdmin) return;
    const container = splitContainerRef.current;
    if (!container) return;

    event.preventDefault();

    const startY = event.clientY;
    const startHeight = userSectionHeight ?? Math.round(container.clientHeight * DEFAULT_USER_SECTION_RATIO);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      setUserSectionHeight(clampUserSectionHeight(startHeight + deltaY));
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [clampUserSectionHeight, isAdmin, userSectionHeight]);

  const primaryNavigation = (
    <nav className="h-full space-y-1 overflow-y-auto pr-1">
      {navigation.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <div key={item.nameKey}>
            <Link
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <item.icon className="h-5 w-5" />
              {t(item.nameKey)}
            </Link>

            {/* Recent orders under Orders nav item */}
            {item.nameKey === 'orders' && recentOrders && recentOrders.length > 0 && (
              <div className="ml-4 mt-1 space-y-0.5">
                {recentOrders.map((order) => {
                  const isOrderActive = pathname === `/orders/${order.id}` || pathname.startsWith(`/orders/${order.id}/`);
                  return (
                    <Link
                      key={order.id}
                      href={`/orders/${order.id}`}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors',
                        isOrderActive
                          ? 'bg-accent text-accent-foreground font-medium'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
                      )}
                      title={order.name || `${t('orderFallback')} ${order.id.slice(0, 8)}`}
                    >
                      <Circle className={cn('h-2 w-2 fill-current shrink-0', statusColors[order.status] || 'text-muted-foreground')} />
                      <span className="truncate">
                        {order.name || `${t('orderFallback')} ${order.id.slice(0, 8)}`}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  const adminSection = (
    <nav className="h-full space-y-1 overflow-y-auto pr-1 py-2">
      <p className="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('adminSection')}
      </p>
      {adminNavigation.map((item) => {
        const isActive = item.href === '/admin'
          ? pathname === '/admin'
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.nameKey}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <item.icon className="h-5 w-5" />
            {t(item.nameKey)}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-full w-64 flex-col border-r bg-card">
      {/* Logo */}
      <Link
        href="/dashboard"
        className="flex h-16 items-center gap-2 px-6 border-b transition-colors hover:bg-accent/40"
      >
        <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
          <span className="text-primary-foreground font-bold text-sm">DG</span>
        </div>
        <div className="flex flex-col">
          <span className="font-semibold text-sm">DevGhost</span>
          <span className="text-xs text-muted-foreground">
            {t('subtitle')}
          </span>
        </div>
      </Link>

      {/* New Order Button */}
      <div className="p-4">
        <Link href="/orders/new">
          <Button className="w-full gap-2">
            <Plus className="h-4 w-4" />
            {t('newAnalysis')}
          </Button>
        </Link>
      </div>

      {/* Navigation */}
      <div className="flex-1 min-h-0 px-4 pb-2">
        {isAdmin ? (
          <div ref={splitContainerRef} className="flex h-full min-h-0 flex-col">
            <div
              className={cn(
                'min-h-0 overflow-hidden shrink-0',
                userSectionHeight == null && 'basis-[68%]',
              )}
              style={userSectionHeight != null ? { height: `${userSectionHeight}px` } : undefined}
            >
              {primaryNavigation}
            </div>

            <button
              type="button"
              aria-label="Resize user/admin navigation sections"
              onMouseDown={handleDividerMouseDown}
              className="group my-1 flex cursor-row-resize select-none flex-col items-center py-1"
            >
              <span className="h-px w-full bg-border transition-colors group-hover:bg-primary/60" />
              <span className="mt-1 h-1.5 w-10 rounded-full bg-muted-foreground/30 transition-colors group-hover:bg-primary/60" />
            </button>

            <div className="min-h-0 flex-1 overflow-hidden border-t">
              {adminSection}
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0">
            {primaryNavigation}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 space-y-2">
        <Separator />
        <div className="px-3 py-1">
          <LanguageSwitcher className="w-full" />
        </div>
        <Link
          href="/billing"
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            pathname === '/billing'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <CreditCard className="h-5 w-5" />
          {t('billing')}
        </Link>
        <Link
          href="/profile"
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            pathname === '/profile'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <UserCircle className="h-5 w-5" />
          {t('profile')}
        </Link>
        <Link
          href="/settings"
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            pathname === '/settings'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <Settings className="h-5 w-5" />
          {t('settings')}
        </Link>
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive"
          onClick={() => signOut({ callbackUrl: '/' })}
        >
          <LogOut className="h-5 w-5" />
          {t('signOut')}
        </Button>
      </div>
    </div>
  );
}
