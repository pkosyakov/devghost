import { redirect } from '@/i18n/navigation';
import { auth } from '@/lib/auth';
import { setRequestLocale } from 'next-intl/server';

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await auth();

  if (!session?.user || session.user.role !== 'ADMIN') {
    return redirect({ href: '/dashboard', locale });
  }

  return <>{children}</>;
}
