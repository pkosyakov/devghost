'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react';

type HealthStatus = 'healthy' | 'attention' | 'unresolved';

interface IdentityHealthBadgeProps {
  status: HealthStatus;
  unresolvedCount?: number;
}

const config: Record<HealthStatus, {
  icon: typeof CheckCircle2;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  className: string;
}> = {
  healthy: {
    icon: CheckCircle2,
    variant: 'outline',
    className: 'border-green-500/50 text-green-700 dark:text-green-400',
  },
  attention: {
    icon: AlertTriangle,
    variant: 'outline',
    className: 'border-yellow-500/50 text-yellow-700 dark:text-yellow-400',
  },
  unresolved: {
    icon: AlertCircle,
    variant: 'outline',
    className: 'border-red-500/50 text-red-700 dark:text-red-400',
  },
};

export function IdentityHealthBadge({ status, unresolvedCount }: IdentityHealthBadgeProps) {
  const t = useTranslations('people.filters');
  const { icon: Icon, variant, className } = config[status];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className={`gap-1 ${className}`}>
          <Icon className="h-3 w-3" />
          {t(status)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {status === 'healthy' && t('healthy')}
        {status === 'attention' && `${unresolvedCount ?? 0} unresolved`}
        {status === 'unresolved' && t('unresolved')}
      </TooltipContent>
    </Tooltip>
  );
}
