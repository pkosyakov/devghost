'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Eye, X, ChevronsUpDown, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

interface LookupUser {
  id: string;
  email: string;
  name: string | null;
}

export function ViewAsUserBanner() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('viewAs');

  const viewAsUserId = searchParams.get('viewAs');
  const isAdmin = session?.user?.role === 'ADMIN';

  // Strip viewAs from URL for non-admins
  useEffect(() => {
    if (viewAsUserId && !isAdmin && session) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete('viewAs');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }
  }, [viewAsUserId, isAdmin, session, searchParams, pathname, router]);

  // Resolve viewAs user email for display
  const [viewAsEmail, setViewAsEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!viewAsUserId) {
      setViewAsEmail(null);
      return;
    }
    fetch(`/api/admin/users/lookup?id=${encodeURIComponent(viewAsUserId)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        const user = json?.data?.users?.[0];
        setViewAsEmail(user?.email ?? viewAsUserId);
      })
      .catch(() => setViewAsEmail(viewAsUserId));
  }, [viewAsUserId]);

  // Combobox state
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<LookupUser[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchUsers = useCallback((search: string) => {
    abortRef.current?.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    setLoading(true);
    const delay = search.trim() ? 300 : 0;
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      const qs = search.trim()
        ? `?search=${encodeURIComponent(search)}`
        : '';
      fetch(`/api/admin/users/lookup${qs}`, {
        signal: controller.signal,
      })
        .then((r) => r.ok ? r.json() : null)
        .then((json) => {
          if (!controller.signal.aborted) {
            const all: LookupUser[] = json?.data?.users ?? [];
            setUsers(all.filter((u) => u.id !== session?.user?.id));
            setLoading(false);
          }
        })
        .catch((err) => {
          if (err.name !== 'AbortError') setLoading(false);
        });
    }, delay);
  }, []);

  // Load initial users when popover opens
  useEffect(() => {
    if (open) fetchUsers(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSelect = useCallback(
    (userId: string) => {
      setOpen(false);
      setQuery('');
      const next = new URLSearchParams(searchParams.toString());
      next.set('viewAs', userId);
      router.push(`${pathname}?${next.toString()}`);
    },
    [searchParams, pathname, router],
  );

  const handleExit = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('viewAs');
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, pathname, router]);

  if (!isAdmin) return null;

  // Active viewAs mode — show amber banner
  if (viewAsUserId) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
        <Eye className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          {t('viewing', { email: viewAsEmail ?? viewAsUserId })}
        </span>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1 border-amber-300 text-xs dark:border-amber-700">
              <ChevronsUpDown className="h-3 w-3" />
              {t('switchUser')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="end">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={t('searchPlaceholder')}
                value={query}
                onValueChange={(v) => {
                  setQuery(v);
                  fetchUsers(v);
                }}
              />
              <CommandList>
                <CommandEmpty>
                  {loading ? '...' : t('noResults')}
                </CommandEmpty>
                <CommandGroup>
                  {users.map((u) => (
                    <CommandItem
                      key={u.id}
                      value={u.id}
                      onSelect={() => handleSelect(u.id)}
                    >
                      <Check
                        className={`mr-2 h-4 w-4 ${u.id === viewAsUserId ? 'opacity-100' : 'opacity-0'}`}
                      />
                      <div className="flex flex-col">
                        <span className="text-sm">{u.email}</span>
                        {u.name && (
                          <span className="text-xs text-muted-foreground">{u.name}</span>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/50"
          onClick={handleExit}
        >
          <X className="h-3 w-3" />
          {t('exit')}
        </Button>
      </div>
    );
  }

  // No viewAs — show compact trigger button
  return (
    <div className="mb-4 flex justify-end">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
            <Eye className="h-3 w-3" />
            {t('label')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="end">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t('searchPlaceholder')}
              value={query}
              onValueChange={(v) => {
                setQuery(v);
                fetchUsers(v);
              }}
            />
            <CommandList>
              <CommandEmpty>
                {loading ? '...' : t('noResults')}
              </CommandEmpty>
              <CommandGroup>
                {users.map((u) => (
                  <CommandItem
                    key={u.id}
                    value={u.id}
                    onSelect={() => handleSelect(u.id)}
                  >
                    <div className="flex flex-col">
                      <span className="text-sm">{u.email}</span>
                      {u.name && (
                        <span className="text-xs text-muted-foreground">{u.name}</span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
