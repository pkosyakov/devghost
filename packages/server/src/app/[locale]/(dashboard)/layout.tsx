import { Suspense } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { ViewAsUserBanner } from '@/components/layout/view-as-user-banner';
import { GlobalContextBar } from '@/components/layout/global-context-bar';
import { ErrorBoundaryWrapper } from '@/components/error-boundary';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen bg-background">
      <Suspense>
        <Sidebar />
      </Suspense>
      <main className="flex-1 overflow-auto p-6">
        <ErrorBoundaryWrapper>
          <Suspense>
            <ViewAsUserBanner />
          </Suspense>
          <Suspense>
            <GlobalContextBar />
          </Suspense>
          {children}
        </ErrorBoundaryWrapper>
      </main>
    </div>
  );
}
