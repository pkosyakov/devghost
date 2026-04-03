'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  LayoutDashboard,

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
  FolderGit2,
  UsersRound,
  FileStack,
} from 'lucide-react';
import { signOut, useSession } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { buildHrefWithActiveScope } from '@/lib/active-scope';
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

const navigation = [
  { nameKey: 'dashboard', href: '/dashboard', icon: LayoutDashboard },
  { nameKey: 'orders', href: '/orders', icon: Activity },
  { nameKey: 'people', href: '/people', icon: Users },
  { nameKey: 'repositories', href: '/repositories', icon: FolderGit2 },
  { nameKey: 'teams', href: '/teams', icon: UsersRound },
  { nameKey: 'reports', href: '/reports', icon: FileStack },
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

type AdminSidebarPanel = 'user' | 'admin';

export function Sidebar() {
  const t = useTranslations('layout.sidebar');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  // undefined stageData = not yet loaded → default to no dimming (avoids regressing mature users)
  const { data: stageData } = useWorkspaceStage();
  const isEarlyStage = stageData?.workspaceStage === 'empty' || stageData?.workspaceStage === 'first_data';
  const noSavedViews = stageData ? stageData.onboarding.savedViewCount === 0 : false;
  const deemphasizedKeys = new Set<string>();
  if (isEarlyStage) deemphasizedKeys.add('teams');
  if (isEarlyStage || noSavedViews) deemphasizedKeys.add('reports');

  const [activeAdminPanel, setActiveAdminPanel] = useState<AdminSidebarPanel>(() =>
    pathname.startsWith('/admin') ? 'admin' : 'user',
  );
  const prevPathnameForPanelRef = useRef(pathname);

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

  useEffect(() => {
    if (!isAdmin) return;
    if (prevPathnameForPanelRef.current === pathname) return;
    prevPathnameForPanelRef.current = pathname;
    setActiveAdminPanel(pathname.startsWith('/admin') ? 'admin' : 'user');
  }, [isAdmin, pathname]);

  const analyticalPaths = new Set(['/dashboard', '/people', '/repositories', '/teams', '/reports']);

  const primaryNavigation = (
    <nav className="h-full space-y-1 overflow-y-auto pr-1">
      {navigation.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        const itemHref = analyticalPaths.has(item.href)
          ? buildHrefWithActiveScope(item.href, searchParams)
          : item.href;
        const isDimmed = deemphasizedKeys.has(item.nameKey);
        return (
          <div key={item.nameKey}>
            <Link
              href={itemHref}
              onClick={() => {
                if (isAdmin) setActiveAdminPanel('user');
              }}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                isDimmed && !isActive && 'opacity-40',
              )}
            >
              <item.icon className="h-5 w-5" />
              {t(item.nameKey)}
            </Link>

            {/* Recent analyses under Analyses nav item */}
            {item.nameKey === 'orders' && recentOrders && recentOrders.length > 0 && (
              <div className="ml-4 mt-1 space-y-0.5">
                {recentOrders.map((order) => {
                  const isOrderActive = pathname === `/orders/${order.id}` || pathname.startsWith(`/orders/${order.id}/`);
                  return (
                    <Link
                      key={order.id}
                      href={`/orders/${order.id}`}
                      onClick={() => {
                        if (isAdmin) setActiveAdminPanel('user');
                      }}
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

  const adminNavLinks = adminNavigation.map((item) => {
    const isActive = item.href === '/admin'
      ? pathname === '/admin'
      : pathname.startsWith(item.href);
    return (
      <Link
        key={item.nameKey}
        href={item.href}
        onClick={() => {
          if (isAdmin) setActiveAdminPanel('admin');
        }}
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
  });

  const panelToggleButtonClass =
    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground';

  const adminPanelTransitionClass =
    'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none motion-reduce:transform-none';

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

      {/* New Analysis Button */}
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
          <div className="relative h-full min-h-0">
            <div
              className={cn(
                'absolute inset-0 flex min-h-0 flex-col',
                adminPanelTransitionClass,
                activeAdminPanel === 'user'
                  ? 'z-10 translate-y-0 opacity-100'
                  : 'pointer-events-none z-0 translate-y-1 opacity-0',
              )}
              aria-hidden={activeAdminPanel !== 'user'}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{primaryNavigation}</div>
              <div className="shrink-0 border-t pt-2">
                <Link
                  href="/admin"
                  className={panelToggleButtonClass}
                  onClick={() => setActiveAdminPanel('admin')}
                >
                  <Shield className="h-5 w-5 shrink-0" />
                  <span className="truncate text-xs font-semibold uppercase tracking-wider">
                    {t('adminSection')}
                  </span>
                </Link>
              </div>
            </div>

            <div
              className={cn(
                'absolute inset-0 flex min-h-0 flex-col',
                adminPanelTransitionClass,
                activeAdminPanel === 'admin'
                  ? 'z-10 translate-y-0 opacity-100'
                  : 'pointer-events-none z-0 -translate-y-1 opacity-0',
              )}
              aria-hidden={activeAdminPanel !== 'admin'}
            >
              <div className="shrink-0 border-b pb-2">
                <Link
                  href="/dashboard"
                  className={panelToggleButtonClass}
                  onClick={() => setActiveAdminPanel('user')}
                >
                  <LayoutDashboard className="h-5 w-5 shrink-0" />
                  <span className="truncate">{t('dashboard')}</span>
                </Link>
              </div>
              <nav className="flex min-h-0 flex-1 flex-col overflow-hidden pt-2">
                <p className="mb-1 shrink-0 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('adminSection')}
                </p>
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">{adminNavLinks}</div>
              </nav>
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
