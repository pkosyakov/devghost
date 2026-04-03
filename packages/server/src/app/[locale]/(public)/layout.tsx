import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { auth } from '@/lib/auth';

export default async function PublicLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('layout.public');
  const session = await auth();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold">
            DevGhost
          </Link>
          <nav className="flex items-center gap-4">
            <Link
              href="/explore"
              className="text-sm font-medium"
            >
              {t('explore')}
            </Link>
            {session?.user ? (
              <Link href="/dashboard" className="text-sm font-medium">{t('dashboard')}</Link>
            ) : (
              <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">{t('signIn')}</Link>
            )}
          </nav>
        </div>
      </header>
      <main className="container mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
