'use client';

import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2, MoreHorizontal, Search, ChevronLeft, ChevronRight, ChevronDown, Plus, Ticket,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useTranslations, useLocale } from 'next-intl';

interface PromoRedemption {
  id: string;
  redeemedAt: string;
  user: { email: string; name: string | null };
}

interface PromoCode {
  id: string;
  code: string;
  credits: number;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  redemptions: PromoRedemption[];
}

interface PromoCodesResponse {
  promoCodes: PromoCode[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

function formatDate(d: string, locale: string = 'en-US'): string {
  return new Date(d).toLocaleDateString(locale, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function AdminPromoCodesPage() {
  const t = useTranslations('admin.promo');
  const tc = useTranslations('common');
  const locale = useLocale();
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editTarget, setEditTarget] = useState<PromoCode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PromoCode | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Create form state
  const [formCode, setFormCode] = useState('');
  const [formCredits, setFormCredits] = useState('');
  const [formMaxRedemptions, setFormMaxRedemptions] = useState('');
  const [formExpiresAt, setFormExpiresAt] = useState('');
  const [formDescription, setFormDescription] = useState('');

  const { data, isLoading } = useQuery<PromoCodesResponse>({
    queryKey: ['admin-promo-codes', page, search],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/admin/promo-codes?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  const createPromoCode = useMutation({
    mutationFn: async (data: {
      code: string;
      credits: number;
      maxRedemptions: number | null;
      expiresAt: string;
      description?: string;
    }) => {
      const res = await fetch('/api/admin/promo-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-promo-codes'] });
      setShowCreateDialog(false);
      resetForm();
      toast({ title: t('promoCreated') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const updatePromoCode = useMutation({
    mutationFn: async ({ id, ...data }: {
      id: string;
      isActive?: boolean;
      maxRedemptions?: number | null;
      expiresAt?: string;
      description?: string;
    }) => {
      const res = await fetch(`/api/admin/promo-codes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-promo-codes'] });
      setEditTarget(null);
      resetForm();
      toast({ title: t('promoUpdated') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const deletePromoCode = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/promo-codes/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-promo-codes'] });
      setDeleteTarget(null);
      toast({ title: t('promoDeleted') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const resetForm = () => {
    setFormCode('');
    setFormCredits('');
    setFormMaxRedemptions('');
    setFormExpiresAt('');
    setFormDescription('');
  };

  const handleCreate = () => {
    const credits = parseInt(formCredits);
    if (!formCode || isNaN(credits) || credits <= 0 || !formExpiresAt) {
      toast({ title: t('validationError'), description: t('fieldsRequired'), variant: 'destructive' });
      return;
    }
    const maxR = formMaxRedemptions ? parseInt(formMaxRedemptions) : null;
    createPromoCode.mutate({
      code: formCode.toUpperCase(),
      credits,
      maxRedemptions: maxR,
      expiresAt: new Date(formExpiresAt).toISOString(),
      description: formDescription || undefined,
    });
  };

  const handleEdit = () => {
    if (!editTarget) return;
    const data: Record<string, unknown> = { id: editTarget.id };
    if (formMaxRedemptions !== '') data.maxRedemptions = parseInt(formMaxRedemptions) || null;
    if (formExpiresAt) data.expiresAt = new Date(formExpiresAt).toISOString();
    if (formDescription !== editTarget.description) data.description = formDescription;
    updatePromoCode.mutate(data as Parameters<typeof updatePromoCode.mutate>[0]);
  };

  const openEditDialog = (promo: PromoCode) => {
    setEditTarget(promo);
    setFormMaxRedemptions(promo.maxRedemptions?.toString() ?? '');
    setFormExpiresAt(new Date(promo.expiresAt).toISOString().slice(0, 16));
    setFormDescription(promo.description ?? '');
  };

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const isExpired = (expiresAt: string) => new Date(expiresAt) < new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => { resetForm(); setShowCreateDialog(true); }}>
          <Plus className="h-4 w-4 mr-2" />
          {t('createPromoCode')}
        </Button>
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

      {/* Table */}
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
                  <TableHead>{t('code')}</TableHead>
                  <TableHead>{t('credits')}</TableHead>
                  <TableHead>{t('usedLimit')}</TableHead>
                  <TableHead>{t('expires')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead>{t('descriptionCol')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.promoCodes.map((promo) => (
                  <Fragment key={promo.id}>
                    <TableRow>
                      <TableCell className="font-mono font-medium">
                        <div className="flex items-center gap-2">
                          <Ticket className="h-4 w-4 text-muted-foreground" />
                          {promo.code}
                        </div>
                      </TableCell>
                      <TableCell>{promo.credits}</TableCell>
                      <TableCell>
                        {promo.redemptionCount > 0 ? (
                          <button
                            className="flex items-center gap-1 text-sm hover:underline"
                            onClick={() => setExpandedId(expandedId === promo.id ? null : promo.id)}
                          >
                            {promo.redemptionCount} / {promo.maxRedemptions ?? '\u221e'}
                            <ChevronDown className={cn('h-3 w-3 transition-transform', expandedId === promo.id && 'rotate-180')} />
                          </button>
                        ) : (
                          <span>0 / {promo.maxRedemptions ?? '\u221e'}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <span className={isExpired(promo.expiresAt) ? 'text-red-600' : ''}>
                          {formatDate(promo.expiresAt, dateLocale)}
                        </span>
                      </TableCell>
                      <TableCell>
                        {!promo.isActive ? (
                          <Badge variant="secondary">{t('inactive')}</Badge>
                        ) : isExpired(promo.expiresAt) ? (
                          <Badge variant="destructive">{t('expired')}</Badge>
                        ) : (promo.maxRedemptions && promo.redemptionCount >= promo.maxRedemptions) ? (
                          <Badge variant="secondary">{t('exhausted')}</Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-700">{t('active')}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {promo.description ?? '---'}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEditDialog(promo)}>
                              {t('edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                updatePromoCode.mutate({
                                  id: promo.id,
                                  isActive: !promo.isActive,
                                })
                              }
                            >
                              {promo.isActive ? t('deactivate') : t('activate')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteTarget(promo)}
                            >
                              {t('delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                    {expandedId === promo.id && promo.redemptions.length > 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/50 p-0">
                          <div className="px-6 py-3">
                            <p className="text-xs font-medium text-muted-foreground mb-2">{t('redemptions')}</p>
                            <div className="space-y-1">
                              {promo.redemptions.map((r) => (
                                <div key={r.id} className="flex items-center justify-between text-sm">
                                  <span>{r.user.email}{r.user.name ? ` (${r.user.name})` : ''}</span>
                                  <span className="text-muted-foreground text-xs">
                                    {new Date(r.redeemedAt).toLocaleString()}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
                {data?.promoCodes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      {t('noPromoCodes')}
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
          <p className="text-sm text-muted-foreground">{t('totalPromoCodes', { count: data.pagination.total })}</p>
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

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createPromoCode')}</DialogTitle>
            <DialogDescription>
              {t('createPromoDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">{t('code')}</Label>
              <Input
                id="code"
                placeholder={t('codePlaceholder')}
                value={formCode}
                onChange={(e) => setFormCode(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="credits">{t('credits')}</Label>
              <Input
                id="credits"
                type="number"
                min="1"
                placeholder={t('numberOfCredits')}
                value={formCredits}
                onChange={(e) => setFormCredits(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxRedemptions">{t('maxRedemptions')}</Label>
              <Input
                id="maxRedemptions"
                type="number"
                min="1"
                placeholder={t('leaveEmptyUnlimited')}
                value={formMaxRedemptions}
                onChange={(e) => setFormMaxRedemptions(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expiresAt">{t('expiresAt')}</Label>
              <Input
                id="expiresAt"
                type="datetime-local"
                value={formExpiresAt}
                onChange={(e) => setFormExpiresAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t('descriptionOptional')}</Label>
              <Input
                id="description"
                placeholder={t('internalNote')}
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>{t('cancel')}</Button>
            <Button onClick={handleCreate} disabled={createPromoCode.isPending}>
              {createPromoCode.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTarget} onOpenChange={() => setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editPromoCode')}</DialogTitle>
            <DialogDescription>
              {t('editPromoDescription')} <span className="font-mono font-medium">{editTarget?.code}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="editMaxRedemptions">{t('maxRedemptions')}</Label>
              <Input
                id="editMaxRedemptions"
                type="number"
                min="1"
                placeholder={t('leaveEmptyUnlimited')}
                value={formMaxRedemptions}
                onChange={(e) => setFormMaxRedemptions(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editExpiresAt">{t('expiresAt')}</Label>
              <Input
                id="editExpiresAt"
                type="datetime-local"
                value={formExpiresAt}
                onChange={(e) => setFormExpiresAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editDescription">{t('descriptionCol')}</Label>
              <Input
                id="editDescription"
                placeholder={t('internalNote')}
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>{t('cancel')}</Button>
            <Button onClick={handleEdit} disabled={updatePromoCode.isPending}>
              {updatePromoCode.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deletePromoTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deletePromoDescription', { code: deleteTarget?.code ?? '' })}
              {deleteTarget && deleteTarget.redemptionCount > 0
                ? ` ${t('deletePromoRedeemed')}`
                : ` ${t('deletePromoCannotUndo')}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deletePromoCode.mutate(deleteTarget.id)}
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
