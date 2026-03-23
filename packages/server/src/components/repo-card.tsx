'use client';

import { Link } from '@/i18n/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Eye } from 'lucide-react';

interface RepoCardProps {
  slug: string;
  owner: string;
  repo: string;
  title: string | null;
  description: string | null;
  isFeatured: boolean;
  viewCount: number;
}

export function RepoCard({
  slug,
  owner,
  repo,
  title,
  description,
  isFeatured,
  viewCount,
}: RepoCardProps) {
  return (
    <Link href={`/explore/${slug}`}>
      <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <CardTitle className="text-lg">
              {title || `${owner}/${repo}`}
            </CardTitle>
            {isFeatured && <Badge variant="secondary">Featured</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            {owner}/{repo}
          </p>
        </CardHeader>
        <CardContent>
          {description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
              {description}
            </p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {viewCount}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
