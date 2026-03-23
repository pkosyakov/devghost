'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Loader2, ExternalLink, UserCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface DeveloperProfile {
  id: string;
  slug: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  includedOrderIds: string[] | null;
  createdAt: string;
  updatedAt: string;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/--+/g, '-');
}

export default function ProfilePage() {
  const t = useTranslations('profile');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [origin, setOrigin] = useState('');

  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const { data: profile, isLoading } = useQuery<DeveloperProfile | null>({
    queryKey: ['developer-profile'],
    queryFn: async () => {
      const res = await fetch('/api/profile');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  // Sync form state when profile loads
  useEffect(() => {
    if (profile) {
      setSlug(profile.slug);
      setDisplayName(profile.displayName);
      setBio(profile.bio || '');
      setIsActive(profile.isActive);
    }
  }, [profile]);

  const hasProfile = !!profile;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const method = hasProfile ? 'PATCH' : 'POST';
      const body: Record<string, unknown> = {
        slug,
        displayName,
        bio: bio || null,
        isActive,
      };

      const res = await fetch('/api/profile', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['developer-profile'] });
      toast({ title: hasProfile ? t('updated') : t('created') });
    },
    onError: (err: Error) => {
      toast({
        title: t('error'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const isValid = slug.length >= 3 && displayName.length >= 1;

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">
          {hasProfile ? t('manageDescription') : t('createDescription')}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('settings')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Slug */}
          <div className="space-y-2">
            <Label htmlFor="slug">{t('slug')}</Label>
            <div className="flex items-center gap-0">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 py-2 text-sm text-muted-foreground">
                /dev/
              </span>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(sanitizeSlug(e.target.value))}
                placeholder={t('slugPlaceholder')}
                className="rounded-l-none"
                maxLength={30}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('slugHint')}
            </p>
          </div>

          {/* Display Name */}
          <div className="space-y-2">
            <Label htmlFor="displayName">{t('displayName')}</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('displayNamePlaceholder')}
              maxLength={100}
            />
          </div>

          {/* Bio */}
          <div className="space-y-2">
            <Label htmlFor="bio">{t('bio')}</Label>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder={t('bioPlaceholder')}
              rows={3}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">
              {t('charCount', { current: bio.length })}
            </p>
          </div>

          {/* Active toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label>{t('visible')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('visibleHint')}
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !isValid}
            >
              {saveMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {hasProfile ? t('saveChanges') : t('createProfile')}
            </Button>

            {hasProfile && origin && (
              <Button variant="outline" asChild>
                <a
                  href={`${origin}/dev/${profile!.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('viewProfile')}
                </a>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
