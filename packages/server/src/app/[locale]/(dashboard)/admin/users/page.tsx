'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, MoreHorizontal, Search, ChevronLeft, ChevronRight, Coins } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslations } from 'next-intl';

interface User {
  id: string;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  isBlocked: boolean;
  blockedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  orderCount: number;
  permanentCredits: number;
  subscriptionCredits: number;
}

interface UsersResponse {
  users: User[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export default function AdminUsersPage() {
  const t = useTranslations('admin.users');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<User | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  const { data, isLoading } = useQuery<UsersResponse>({
    queryKey: ['admin-users', page, search],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/admin/users?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  const updateUser = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; role?: string; isBlocked?: boolean }) => {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast({ title: t('userUpdated') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const deleteUser = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setDeleteTarget(null);
      toast({ title: t('userDeleted') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const resetPassword = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { tempPassword: string };
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const adjustCredits = useMutation({
    mutationFn: async ({ userId, amount, reason }: { userId: string; amount: number; reason: string }) => {
      const res = await fetch('/api/admin/credits/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, amount, reason }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setAdjustTarget(null);
      setAdjustAmount('');
      setAdjustReason('');
      toast({ title: t('creditsAdjusted') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const handleResetPassword = (user: User) => {
    resetPassword.mutate(user.id, {
      onSuccess: (data) => {
        setTempPassword({ email: user.email, password: data.tempPassword });
      },
    });
  };

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const handleAdjustCredits = () => {
    if (!adjustTarget) return;
    const amount = parseInt(adjustAmount);
    if (isNaN(amount) || amount === 0) {
      toast({ title: t('validationError'), description: t('amountNonZero'), variant: 'destructive' });
      return;
    }
    if (!adjustReason.trim()) {
      toast({ title: t('validationError'), description: t('reasonRequired'), variant: 'destructive' });
      return;
    }
    adjustCredits.mutate({ userId: adjustTarget.id, amount, reason: adjustReason.trim() });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-9"
          />
        </div>
        <Button variant="outline" onClick={handleSearch}>{t('search')}</Button>
      </div>

      {/* Users Table */}
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
                  <TableHead>{t('email')}</TableHead>
                  <TableHead>{t('name')}</TableHead>
                  <TableHead>{t('role')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead>{t('credits')}</TableHead>
                  <TableHead>{t('orders')}</TableHead>
                  <TableHead>{t('lastLogin')}</TableHead>
                  <TableHead>{t('created')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-mono text-sm">{user.email}</TableCell>
                    <TableCell>{user.name ?? '---'}</TableCell>
                    <TableCell>
                      <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>
                        {user.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.isBlocked ? 'destructive' : 'outline'}>
                        {user.isBlocked ? t('blocked') : t('active')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium tabular-nums">
                        {user.permanentCredits + user.subscriptionCredits}
                      </span>
                      {user.subscriptionCredits > 0 && (
                        <span className="text-xs text-muted-foreground ml-1">
                          ({user.permanentCredits}p + {user.subscriptionCredits}s)
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{user.orderCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : '---'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setAdjustTarget(user);
                              setAdjustAmount('');
                              setAdjustReason('');
                            }}
                          >
                            <Coins className="mr-2 h-4 w-4" />
                            {t('adjustCredits')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() =>
                              updateUser.mutate({
                                id: user.id,
                                role: user.role === 'ADMIN' ? 'USER' : 'ADMIN',
                              })
                            }
                          >
                            {user.role === 'ADMIN' ? t('demoteToUser') : t('promoteToAdmin')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              updateUser.mutate({ id: user.id, isBlocked: !user.isBlocked })
                            }
                          >
                            {user.isBlocked ? t('unblock') : t('block')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResetPassword(user)}>
                            {t('resetPassword')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(user)}
                          >
                            {t('deleteUser')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {data?.users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      {t('noUsers')}
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
          <p className="text-sm text-muted-foreground">
            {t('totalUsers', { count: data.pagination.total })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">
              {t('pageOf', { page, total: data.pagination.totalPages })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteUserTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteUserDescription', { email: deleteTarget?.email ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteUser.mutate(deleteTarget.id)}
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Temp Password Dialog */}
      <Dialog open={!!tempPassword} onOpenChange={() => setTempPassword(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('passwordResetTitle')}</DialogTitle>
            <DialogDescription>
              {t('passwordResetDescription', { email: tempPassword?.email ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted p-4 font-mono text-lg text-center select-all">
            {tempPassword?.password}
          </div>
        </DialogContent>
      </Dialog>

      {/* Adjust Credits Dialog */}
      <Dialog open={!!adjustTarget} onOpenChange={() => setAdjustTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('adjustCreditsTitle')}</DialogTitle>
            <DialogDescription>
              {t('adjustCreditsDescription', {
                email: adjustTarget?.email ?? '',
                total: adjustTarget ? adjustTarget.permanentCredits + adjustTarget.subscriptionCredits : 0,
                permanent: adjustTarget?.permanentCredits ?? 0,
                subscription: adjustTarget?.subscriptionCredits ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="adjustAmount">{t('amountLabel')}</Label>
              <Input
                id="adjustAmount"
                type="number"
                placeholder={t('amountPlaceholder')}
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adjustReason">{t('reasonLabel')}</Label>
              <Input
                id="adjustReason"
                placeholder={t('reasonPlaceholder')}
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustTarget(null)}>{t('cancel')}</Button>
            <Button onClick={handleAdjustCredits} disabled={adjustCredits.isPending}>
              {adjustCredits.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
