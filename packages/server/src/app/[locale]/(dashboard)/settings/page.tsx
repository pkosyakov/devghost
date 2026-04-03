'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { User, Link, Loader2, Check, Database, Languages } from 'lucide-react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { GitHubConnectButton } from '@/components/github-connect-button';
import { useToast } from '@/hooks/use-toast';
import { useTranslations } from 'next-intl';

interface UserSettings {
  name: string;
  email: string;
}

interface CacheStats {
  totalMb: number;
  repos: number;
  diffs: number;
  llm: number;
}

function GitHubConnectFallback() {
  return (
    <div className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm text-muted-foreground">Loading...</span>
    </div>
  );
}

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const { data: session } = useSession();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Profile fields
  const [displayName, setDisplayName] = useState('');

  // Cache stats (read-only for all users)
  const { data: cacheStats, isLoading: cacheLoading } = useQuery<CacheStats>({
    queryKey: ['cache-stats'],
    queryFn: async () => {
      const res = await fetch('/api/cache');
      if (!res.ok) throw new Error('Failed to fetch cache stats');
      return res.json();
    },
  });

  // Load user settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await fetch('/api/user/profile');
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.data) {
            const data = result.data as UserSettings;
            setDisplayName(data.name || '');
          }
        }
      } catch {
        // Client-side: avoid console noise; user can retry via refresh
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: displayName }),
      });

      const result = await response.json();

      if (result.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        toast({
          title: t('settingsSaved'),
          description: t('settingsSavedDescription'),
        });
      } else {
        throw new Error(result.error || t('failedSave'));
      }
    } catch (error) {
      toast({
        title: tCommon('error'),
        description: error instanceof Error ? error.message : tCommon('error'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* Profile Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <CardTitle>{t('profile')}</CardTitle>
          </div>
          <CardDescription>{t('profileDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="email">{t('email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder="your@email.com"
                value={session?.user?.email || ''}
                disabled
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">{t('displayName')}</Label>
              <Input
                id="name"
                placeholder="Your name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Languages className="h-5 w-5" />
            <CardTitle>{t('language')}</CardTitle>
          </div>
          <CardDescription>{t('languageDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <LanguageSwitcher ariaLabel={t('language')} />
        </CardContent>
      </Card>

      {/* GitHub Integration */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Link className="h-5 w-5" />
            <CardTitle>{t('github')}</CardTitle>
          </div>
          <CardDescription>{t('githubDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<GitHubConnectFallback />}>
            <GitHubConnectButton />
          </Suspense>
        </CardContent>
      </Card>

      {/* Pipeline Cache — read-only stats */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            <CardTitle>{t('pipelineCache')}</CardTitle>
          </div>
          <CardDescription>
            {t('pipelineCacheDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cacheLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm text-muted-foreground">{t('loadingCache')}</span>
            </div>
          ) : cacheStats ? (
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{cacheStats.totalMb}</p>
                <p className="text-xs text-muted-foreground">{t('totalSize')}</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{cacheStats.repos}</p>
                <p className="text-xs text-muted-foreground">{t('repoClones')}</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{cacheStats.diffs}</p>
                <p className="text-xs text-muted-foreground">{t('diffCache')}</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-2xl font-bold">{cacheStats.llm}</p>
                <p className="text-xs text-muted-foreground">{t('llmCache')}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('failedCache')}</p>
          )}
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={loading || saving} size="lg" className="gap-2">
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('saving')}
            </>
          ) : saved ? (
            <>
              <Check className="h-4 w-4" />
              {t('saved')}
            </>
          ) : (
            t('saveSettings')
          )}
        </Button>
      </div>
    </div>
  );
}
