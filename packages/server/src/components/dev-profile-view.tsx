'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  GitCommit,
  Calendar,
  Clock,
  TrendingUp,
} from 'lucide-react';
import { formatGhostPercent, ghostColor } from '@devghost/shared';

interface ProfileData {
  slug: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  githubUsername: string | null;
  viewCount: number;
  createdAt: string;
}

interface OrderMetricEntry {
  orderId: string;
  orderName: string;
  repos: string[];
  commitCount: number;
  workDays: number;
  totalEffortHours: number;
  avgDailyEffort: number;
  ghostPercent: number | null;
  share: number;
}

interface MetricsSummary {
  totalOrders: number;
  totalCommits: number;
  totalWorkDays: number;
  totalEffortHours: number;
  avgGhostPercent: number | null;
}

interface DevProfileViewProps {
  profile: ProfileData;
  summary: MetricsSummary;
  orders: OrderMetricEntry[];
}

const ghostBadgeStyles: Record<string, string> = {
  green: 'bg-green-100 text-green-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  red: 'bg-red-100 text-red-700',
  gray: 'bg-gray-100 text-gray-500',
};

export function DevProfileView({
  profile,
  summary,
  orders,
}: DevProfileViewProps) {
  return (
    <div className="space-y-8">
      {/* Profile Header */}
      <div className="flex items-start gap-6">
        {profile.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt={profile.displayName}
            className="h-20 w-20 rounded-full object-cover"
          />
        ) : (
          <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground">
            {profile.displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="text-3xl font-bold">{profile.displayName}</h1>
          {profile.githubUsername && (
            <a
              href={`https://github.com/${profile.githubUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              @{profile.githubUsername}
            </a>
          )}
          {profile.bio && (
            <p className="text-muted-foreground mt-2 max-w-2xl">
              {profile.bio}
            </p>
          )}
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Total Commits
                </p>
                <p className="text-2xl font-bold">
                  {summary.totalCommits.toLocaleString()}
                </p>
              </div>
              <div className="p-3 rounded-full bg-purple-50 text-purple-600">
                <GitCommit className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Work Days
                </p>
                <p className="text-2xl font-bold">
                  {summary.totalWorkDays.toLocaleString()}
                </p>
              </div>
              <div className="p-3 rounded-full bg-amber-50 text-amber-600">
                <Calendar className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Effort Hours
                </p>
                <p className="text-2xl font-bold">
                  {summary.totalEffortHours.toFixed(1)}
                </p>
              </div>
              <div className="p-3 rounded-full bg-blue-50 text-blue-600">
                <Clock className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Avg Ghost %
                </p>
                <p className="text-2xl font-bold">
                  {formatGhostPercent(summary.avgGhostPercent)}
                </p>
              </div>
              <div className="p-3 rounded-full bg-green-50 text-green-600">
                <TrendingUp className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-Order Breakdown */}
      {orders.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Project Breakdown</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {orders.map((order) => {
              const color = ghostColor(order.ghostPercent);
              return (
                <Card key={order.orderId}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base">
                        {order.orderName}
                      </CardTitle>
                      <Badge className={ghostBadgeStyles[color] ?? ghostBadgeStyles.gray}>
                        {formatGhostPercent(order.ghostPercent)}
                      </Badge>
                    </div>
                    {order.repos.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {order.repos.join(', ')}
                      </p>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">Commits:</span>{' '}
                        <span className="font-medium">{order.commitCount}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Work Days:</span>{' '}
                        <span className="font-medium">{order.workDays}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Effort:</span>{' '}
                        <span className="font-medium">
                          {order.totalEffortHours.toFixed(1)}h
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Avg/day:</span>{' '}
                        <span className="font-medium">
                          {order.avgDailyEffort.toFixed(2)}h
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {orders.length === 0 && (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No project analytics available for this developer yet.
          </p>
        </div>
      )}
    </div>
  );
}
