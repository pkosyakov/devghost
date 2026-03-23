import { Sidebar } from '@/components/layout/sidebar';
import { ErrorBoundaryWrapper } from '@/components/error-boundary';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <ErrorBoundaryWrapper>{children}</ErrorBoundaryWrapper>
      </main>
    </div>
  );
}
