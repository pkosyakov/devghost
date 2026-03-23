'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
  Loader2, MoreHorizontal, Search, Plus, Globe, Eye, ExternalLink,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslations, useLocale } from 'next-intl';

interface PublicationItem {
  id: string;
  slug: string;
  owner: string;
  repo: string;
  publishType: 'USER' | 'ADMIN';
  isActive: boolean;
  isFeatured: boolean;
  viewCount: number;
  title: string | null;
  description: string | null;
  sortOrder: number;
  shareToken: string;
  createdAt: string;
  publishedBy: { name: string | null; email: string } | null;
  order: { name: string | null; status: string } | null;
}

interface PublicationsResponse {
  items: PublicationItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface AdminOrder {
  id: string;
  name: string | null;
  status: string;
  repoCount: number;
  ownerEmail: string;
  ownerName: string | null;
}

function formatDate(d: string, locale: string = 'en-US'): string {
  return new Date(d).toLocaleDateString(locale, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function AdminPublicationsPage() {
  const t = useTranslations('admin.publications');
  const tc = useTranslations('common');
  const locale = useLocale();
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editTarget, setEditTarget] = useState<PublicationItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublicationItem | null>(null);

  // Create form state
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formFeatured, setFormFeatured] = useState(false);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSortOrder, setEditSortOrder] = useState('');

  // Available repos for selected order
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);

  const { data, isLoading } = useQuery<PublicationsResponse>({
    queryKey: ['admin-publications', page, search],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/admin/publications?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  // Fetch completed orders for create dialog
  const { data: ordersData } = useQuery<{ orders: AdminOrder[] }>({
    queryKey: ['admin-orders-completed'],
    queryFn: async () => {
      const res = await fetch('/api/admin/orders?status=COMPLETED&pageSize=100');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    enabled: showCreateDialog,
  });

  const createPublication = useMutation({
    mutationFn: async (data: {
      orderId: string;
      repository: string;
      title?: string;
      description?: string;
      isFeatured: boolean;
    }) => {
      const res = await fetch('/api/admin/publications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-publications'] });
      setShowCreateDialog(false);
      resetCreateForm();
      toast({ title: t('pubCreated') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const updatePublication = useMutation({
    mutationFn: async ({ id, ...data }: {
      id: string;
      isActive?: boolean;
      isFeatured?: boolean;
      title?: string;
      description?: string;
      sortOrder?: number;
    }) => {
      const res = await fetch(`/api/admin/publications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-publications'] });
      setEditTarget(null);
      toast({ title: t('pubUpdated') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const deletePublication = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/publications/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-publications'] });
      setDeleteTarget(null);
      toast({ title: t('pubDeleted') });
    },
    onError: (err: Error) => {
      toast({ title: tc('errorTitle'), description: err.message, variant: 'destructive' });
    },
  });

  const resetCreateForm = () => {
    setSelectedOrderId('');
    setSelectedRepo('');
    setFormTitle('');
    setFormDescription('');
    setFormFeatured(false);
    setAvailableRepos([]);
  };

  const handleOrderSelect = async (orderId: string) => {
    setSelectedOrderId(orderId);
    setSelectedRepo('');
    setAvailableRepos([]);

    if (!orderId) return;

    setLoadingRepos(true);
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      const json = await res.json();
      if (json.success && json.data?.selectedRepos) {
        const repos = (json.data.selectedRepos as Array<Record<string, unknown>>).map(
          (r) => (r.full_name ?? r.fullName ?? `${(r.owner as any)?.login}/${r.name}`) as string
        );
        setAvailableRepos(repos);
      }
    } catch {
      toast({ title: tc('errorTitle'), description: t('failedLoadRepos'), variant: 'destructive' });
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleCreate = () => {
    if (!selectedOrderId || !selectedRepo) {
      toast({ title: tc('validationError'), description: t('validationRequired'), variant: 'destructive' });
      return;
    }
    createPublication.mutate({
      orderId: selectedOrderId,
      repository: selectedRepo,
      title: formTitle || undefined,
      description: formDescription || undefined,
      isFeatured: formFeatured,
    });
  };

  const openEditDialog = (pub: PublicationItem) => {
    setEditTarget(pub);
    setEditTitle(pub.title ?? '');
    setEditDescription(pub.description ?? '');
    setEditSortOrder(String(pub.sortOrder));
  };

  const handleEdit = () => {
    if (!editTarget) return;
    const data: Record<string, unknown> = { id: editTarget.id };
    if (editTitle !== (editTarget.title ?? '')) data.title = editTitle || null;
    if (editDescription !== (editTarget.description ?? '')) data.description = editDescription || null;
    const order = parseInt(editSortOrder);
    if (!isNaN(order) && order !== editTarget.sortOrder) data.sortOrder = order;
    updatePublication.mutate(data as Parameters<typeof updatePublication.mutate>[0]);
  };

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => { resetCreateForm(); setShowCreateDialog(true); }}>
          <Plus className="h-4 w-4 mr-2" />
          {t('createPublication')}
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
          ) : !data?.items.length ? (
            <div className="py-12 text-center text-muted-foreground">
              <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>{t('noPublications')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('slug')}</TableHead>
                  <TableHead>{t('type')}</TableHead>
                  <TableHead>{t('publisher')}</TableHead>
                  <TableHead>{t('featured')}</TableHead>
                  <TableHead>{t('active')}</TableHead>
                  <TableHead>{t('views')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((pub) => (
                  <TableRow key={pub.id}>
                    <TableCell>
                      <div className="font-medium">{pub.slug}</div>
                      {pub.title && (
                        <div className="text-xs text-muted-foreground truncate max-w-[200px]">{pub.title}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={pub.publishType === 'ADMIN' ? 'default' : 'secondary'}>
                        {pub.publishType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {pub.publishedBy?.name || pub.publishedBy?.email || '--'}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={pub.isFeatured}
                        onCheckedChange={(checked) =>
                          updatePublication.mutate({ id: pub.id, isFeatured: checked })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={pub.isActive}
                        onCheckedChange={(checked) =>
                          updatePublication.mutate({ id: pub.id, isActive: checked })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm">
                        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                        {pub.viewCount}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(pub)}>
                            {t('edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <a
                              href={`/explore/${pub.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-2"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              {t('viewPublicPage')}
                            </a>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(pub)}
                          >
                            {t('delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('totalPublications', { count: data.total })}
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
              {t('pageOf', { page, total: data.totalPages })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('createPublication')}</DialogTitle>
            <DialogDescription>
              {t('createPublicationDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Order select */}
            <div className="space-y-2">
              <Label>{t('order')}</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selectedOrderId}
                onChange={(e) => handleOrderSelect(e.target.value)}
              >
                <option value="">{t('selectOrder')}</option>
                {ordersData?.orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || `Order ${o.id.slice(0, 8)}`} ({o.ownerEmail}, {o.repoCount} repo{o.repoCount !== 1 ? 's' : ''})
                  </option>
                ))}
              </select>
            </div>

            {/* Repository select */}
            <div className="space-y-2">
              <Label>{t('repository')}</Label>
              {loadingRepos ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('loadingRepos')}
                </div>
              ) : availableRepos.length > 0 ? (
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={selectedRepo}
                  onChange={(e) => setSelectedRepo(e.target.value)}
                >
                  <option value="">{t('selectRepository')}</option>
                  {availableRepos.map((repo) => (
                    <option key={repo} value={repo}>{repo}</option>
                  ))}
                </select>
              ) : selectedOrderId ? (
                <p className="text-sm text-muted-foreground">{t('noReposForOrder')}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('selectOrderFirst')}</p>
              )}
            </div>

            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="create-title">{t('titleOptional')}</Label>
              <Input
                id="create-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder={t('publicationTitle')}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="create-description">{t('descriptionOptional')}</Label>
              <Textarea
                id="create-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder={t('briefDescription')}
                rows={3}
              />
            </div>

            {/* Featured toggle */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label>{t('featured')}</Label>
              <Switch checked={formFeatured} onCheckedChange={setFormFeatured} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createPublication.isPending || !selectedOrderId || !selectedRepo}
            >
              {createPublication.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editPublication')}</DialogTitle>
            <DialogDescription>
              {t('editPublicationDescription', { slug: editTarget?.slug ?? '' })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-title">{t('titleLabel')}</Label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder={t('publicationTitle')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">{t('descriptionLabel')}</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t('briefDescription')}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-sort-order">{t('sortOrder')}</Label>
              <Input
                id="edit-sort-order"
                type="number"
                value={editSortOrder}
                onChange={(e) => setEditSortOrder(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleEdit} disabled={updatePublication.isPending}>
              {updatePublication.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deletePublicationTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deletePublicationDescription', { slug: deleteTarget?.slug ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deletePublication.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletePublication.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
