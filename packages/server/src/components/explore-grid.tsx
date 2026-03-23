'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Loader2 } from 'lucide-react';
import { RepoCard } from '@/components/repo-card';

interface ExploreItem {
  id: string;
  owner: string;
  repo: string;
  slug: string;
  publishType: string;
  isFeatured: boolean;
  title: string | null;
  description: string | null;
  viewCount: number;
  createdAt: string;
}

interface ExploreResponse {
  success: boolean;
  data: {
    items: ExploreItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

interface ExploreGridProps {
  initialData: ExploreResponse['data'];
}

async function fetchExplore(page: number, search: string): Promise<ExploreResponse['data']> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: '20',
  });
  if (search) params.set('search', search);
  const res = await fetch(`/api/explore?${params}`);
  const json: ExploreResponse = await res.json();
  if (!json.success) throw new Error('Failed to fetch');
  return json.data;
}

export function ExploreGrid({ initialData }: ExploreGridProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  // Debounce search input
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timeout);
  }, [search]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['explore', debouncedSearch, page],
    queryFn: () => fetchExplore(page, debouncedSearch),
    initialData: debouncedSearch === '' && page === 1 ? initialData : undefined,
    placeholderData: (prev) => prev,
  });

  const items = data?.items ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      {/* Search bar */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search repositories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-muted-foreground">
            {debouncedSearch
              ? `No repositories found for "${debouncedSearch}"`
              : 'No published repositories yet'}
          </p>
        </div>
      ) : (
        <>
          {/* Grid */}
          <div className="relative">
            {isFetching && (
              <div className="absolute top-0 right-0">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((item) => (
                <RepoCard
                  key={item.id}
                  slug={item.slug}
                  owner={item.owner}
                  repo={item.repo}
                  title={item.title}
                  description={item.description}
                  isFeatured={item.isFeatured}
                  viewCount={item.viewCount}
                />
              ))}
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
